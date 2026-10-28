import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { CliError } from "./errors.ts";

export async function withLease<T>(path: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const ownership = new AbortController();
	let release: () => Promise<void>;
	try {
		release = await lockfile.lock(path, {
			realpath: false,
			stale: 120000,
			update: 10000,
			retries: 0,
			onCompromised: (cause) => ownership.abort(new CliError("busy", "Workspace lock ownership was lost", { cause })),
		});
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ELOCKED")
			throw new CliError("busy", "Another command owns this workspace", { hint: "Wait for that command to finish." });
		throw error;
	}
	try {
		const result = await run(ownership.signal);
		ownership.signal.throwIfAborted();
		return result;
	} finally {
		await release().catch(() => undefined);
	}
}
