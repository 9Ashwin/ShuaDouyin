import { randomUUID } from "node:crypto";
import { appendFile, chmod, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CliError, isMissing } from "./errors.ts";
import { withLease } from "./lease.ts";
import { checkStateRoot } from "./workspace-layout.ts";

export interface BrowserConfig {
	chrome?: string;
	headless?: boolean;
}
export interface Event {
	bot_id?: string;
	id: string;
	at: string;
	operation: string;
	data: unknown;
}
export interface Receipt {
	bot_id?: string;
	request_id: string;
	fingerprint: string;
	operation: string;
	status: "prepared" | "dispatching" | "confirmed" | "not_sent";
	created_at: string;
	updated_at: string;
	result?: unknown;
	uncertainty_reason?: string;
	observation?: {
		candidate_id: string | null;
		kind: "matching_loaded_row";
		loaded_matching_rows: number;
		baseline_matching_text_rows: number;
		delivery_verified: false;
	};
	target?: {
		video_id?: string;
		comment_id?: string;
		user_id?: string;
		recipient_id?: string;
		conversation_id?: string;
	};
	media?: { sha256: string; mime: string; bytes: number };
	media_stage?:
		| "selection_attempted"
		| "selection_dispatched"
		| "confirmation_ready"
		| "send_attempted"
		| "send_dispatched";
	media_observation?: {
		preview_verified: boolean;
		confirm_dispatched: boolean;
		dialog_closed: boolean;
		// True when a new image appeared in the conversation after the click. It
		// used to be typed `false` because no such evidence was collected, which
		// made every image send report uncertain by construction.
		new_media?: number;
		delivery_verified: boolean;
	};
	comment_observation?: { preview_verified: boolean; publish_dispatched: boolean; delivery_verified: false };
}

export function stateDirectory(): string {
	if (process.env.DY_STATE_DIR) return resolve(process.env.DY_STATE_DIR);
	return join(homedir(), ".dy");
}

export async function checkFileUnchanged(path: string, expected: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || (await readFile(path, "utf8")) !== expected)
			throw new CliError("revision_conflict", "The file changed before the operation could finish");
	} catch (cause) {
		if (isMissing(cause))
			throw new CliError("revision_conflict", "The file disappeared before the operation could finish", { cause });
		throw cause;
	}
}

export async function atomicWrite(path: string, data: string | Buffer, expected?: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(data);
			await file.sync();
		} finally {
			await file.close();
		}
		if (expected !== undefined) await checkFileUnchanged(path, expected);
		await rename(temporary, path);
		await chmod(path, 0o600);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

// Publish a fully written file only if its destination does not already exist.
export async function atomicCreate(path: string, data: string | Buffer): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(data);
			await file.sync();
		} finally {
			await file.close();
		}
		await link(temporary, path);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

export class Store {
	readonly base: string;
	readonly directory: string;
	// Kept as fixed values rather than removed: they appear in every recorded
	// event and receipt, and those records must stay readable. A single
	// installation has exactly one of each.
	readonly profile = "default";
	readonly bot_id = "default";

	// One installation owns one browser session and one bot. Everything a
	// command needs — the operation log, the receipts, the persona and the
	// memories — lives in the same directory, so no identifier has to be chosen
	// before a command can run.
	constructor(base = stateDirectory()) {
		this.base = resolve(base);
		checkStateRoot(this.base);
		this.directory = this.base;
	}

	path(name: string): string {
		checkStateRoot(this.base);
		return join(this.directory, name);
	}

	async withLock<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		return withLease(this.path("operation"), run);
	}

	async read<T>(name: string, fallback: T): Promise<T> {
		try {
			return JSON.parse(await readFile(this.path(name), "utf8")) as T;
		} catch (error) {
			if (isMissing(error)) return fallback;
			if (error instanceof SyntaxError)
				throw new CliError("state_corrupt", `Invalid JSON in ${name}`, {
					hint: "The file has been preserved. Back up the profile before repairing it.",
					cause: error,
				});
			throw error;
		}
	}

	async write(name: string, value: unknown): Promise<void> {
		await atomicWrite(this.path(name), `${JSON.stringify(value, null, 2)}\n`);
	}
	async config(): Promise<BrowserConfig> {
		const value = await this.read<BrowserConfig>("config.json", {});
		if (
			typeof value !== "object" ||
			value === null ||
			(value.chrome !== undefined && typeof value.chrome !== "string") ||
			(value.headless !== undefined && typeof value.headless !== "boolean")
		)
			throw new CliError("state_corrupt", "Invalid browser config");
		return value;
	}

	// A failed read or navigation left no trace, so nothing could ever show that a
	// command is unreliable. Failures are recorded with their stable code and the
	// elapsed time; the message is kept short and never contains page text.
	async appendFailure(operation: string, error: { code: string; message: string }, elapsed_ms: number) {
		return this.append(operation, {
			ok: false,
			error_code: error.code,
			error_message: Array.from(error.message).slice(0, 200).join(""),
			elapsed_ms: Math.max(0, Math.round(elapsed_ms)),
		});
	}

	async append(operation: string, data: unknown): Promise<Event> {
		const event = {
			id: randomUUID(),
			at: new Date().toISOString(),
			operation,
			...(this.bot_id ? { bot_id: this.bot_id } : {}),
			data,
		};
		await appendFile(this.path("history.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600, flush: true });
		return event;
	}

	async events(): Promise<Event[]> {
		let text: string;
		try {
			text = await readFile(this.path("history.jsonl"), "utf8");
		} catch (error) {
			if (isMissing(error)) return [];
			throw error;
		}
		return text
			.split("\n")
			.filter(Boolean)
			.map((line, index) => {
				try {
					const event = JSON.parse(line) as Event;
					if (!event.id || !event.at || !event.operation || Number.isNaN(Date.parse(event.at)))
						throw new Error("Invalid event");
					return event;
				} catch (cause) {
					throw new CliError("state_corrupt", `Invalid history record at line ${index + 1}`, { cause });
				}
			});
	}

	async receipts(): Promise<Record<string, Receipt>> {
		const receipts = await this.read<Record<string, Receipt>>("receipts.json", {});
		if (!receipts || typeof receipts !== "object" || Array.isArray(receipts))
			throw new CliError("state_corrupt", "Invalid receipts file");
		for (const receipt of Object.values(receipts)) {
			if (
				!receipt ||
				!receipt.request_id ||
				!receipt.fingerprint ||
				!["prepared", "dispatching", "confirmed", "not_sent"].includes(receipt.status)
			)
				throw new CliError("state_corrupt", "Invalid receipt record");
		}
		return receipts;
	}

	async saveReceipt(receipt: Receipt): Promise<void> {
		const receipts = await this.receipts();
		Object.defineProperty(receipts, receipt.request_id, {
			value: receipt,
			enumerable: true,
			configurable: true,
			writable: true,
		});
		await this.write("receipts.json", receipts);
	}
}
