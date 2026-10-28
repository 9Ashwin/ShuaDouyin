import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError, isMissing } from "../errors.ts";
import { withLease } from "../lease.ts";
import { MemoryStore } from "../memory.ts";
import type { Input } from "../operations/validate.ts";
import { atomicCreate, atomicWrite, Store } from "../store.ts";
import type { Workspaces } from "../workspace.ts";
import { checkedMarkdown, type Entry, memoryId, metadata, nodeSlug, validateMemoryInput } from "./concept.ts";
import { possiblySamePath, resolveReferences } from "./graph.ts";
import { scan, strictScan } from "./indexer.ts";
import { recall } from "./recall.ts";

interface Fact {
	text: string;
	sources: string[];
	keywords: string[];
	profile_ref?: string;
}
type Action = "ADD" | "UPDATE" | "DELETE" | "NOOP";
interface Decision {
	action: Action;
	source_fact_indices: number[];
	id?: string;
	revision?: string;
	text?: string;
	layer?: string;
	subject?: string;
	topic?: string;
	profile_ref?: string;
	tags?: string;
	certainty?: string;
	confidence?: number;
	links?: string;
}
interface Request {
	facts: Fact[];
	decision?: Decision;
}
interface Receipt {
	version: 1;
	fingerprint: string;
	status: "prepared" | "completed";
	action: Action;
	sources: string[];
	source_fact_indices: number[];
	source_checks?: SourceCheck[];
	source_checks_scope?: "decision_snapshot";
	source_check_note?: string;
	id?: string;
	result?: { id: string; revision?: string; deleted?: boolean };
}
interface SourceCheck {
	source: string;
	kind: "receipt" | "event" | "caller_provided";
	attribution_verified: boolean;
	status_at_check?: "prepared" | "dispatching" | "confirmed" | "not_sent";
}
const referencePattern = /^(?:user|group):[^\s:\r\n]{1,200}$/;
const eventPattern =
	/^event:([A-Za-z0-9][A-Za-z0-9_-]{0,63}):([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const receiptPattern = /^receipt:([A-Za-z0-9][A-Za-z0-9_-]{0,63}):(.+)$/;

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CliError("invalid_argument", `${label} must be an object`);
	return value as Record<string, unknown>;
}
function knownKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) throw new CliError("invalid_argument", `Unknown ${label} field: ${key}`);
}
function nonempty(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new CliError("invalid_argument", `${label} must contain 1..${max} characters`);
	return value;
}
function parseRequest(text: string, withDecision: boolean): Request {
	if (text.length > 65536) throw new CliError("invalid_argument", "Formation request is too large");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		throw new CliError("invalid_argument", "Formation input must be valid JSON", { cause });
	}
	const root = record(parsed, "formation request");
	knownKeys(root, withDecision ? ["facts", "decision"] : ["facts"], "request");
	if (!Array.isArray(root.facts) || root.facts.length < 1 || root.facts.length > 12)
		throw new CliError("invalid_argument", "facts must contain 1..12 items");
	const facts = root.facts.map((item, index): Fact => {
		const raw = record(item, `fact ${index}`);
		knownKeys(raw, ["text", "sources", "keywords", "profile_ref"], "fact");
		const factText = nonempty(raw.text, `fact ${index} text`, 3000);
		if (!Array.isArray(raw.sources) || !raw.sources.length || raw.sources.length > 8)
			throw new CliError("invalid_argument", `fact ${index} needs 1..8 sources`);
		const sources = [
			...new Set(
				raw.sources.map((source) => {
					const value = nonempty(source, "source", 2048);
					if (/[\r\n]/.test(value)) throw new CliError("invalid_argument", "Source must be a single line");
					return value;
				}),
			),
		];
		if (raw.keywords !== undefined && (!Array.isArray(raw.keywords) || raw.keywords.length > 8))
			throw new CliError("invalid_argument", "keywords must be an array of up to 8 strings");
		const keywords = ((raw.keywords as unknown[] | undefined) ?? []).map((word) => nonempty(word, "keyword", 200));
		const profile = raw.profile_ref;
		if (profile !== undefined && (typeof profile !== "string" || !referencePattern.test(profile)))
			throw new CliError("invalid_argument", "profile_ref must be user:<id> or group:<id>");
		return { text: factText, sources, keywords, ...(typeof profile === "string" ? { profile_ref: profile } : {}) };
	});
	if (!withDecision) return { facts };
	const raw = record(root.decision, "decision");
	knownKeys(
		raw,
		[
			"action",
			"source_fact_indices",
			"id",
			"revision",
			"text",
			"layer",
			"subject",
			"topic",
			"profile_ref",
			"tags",
			"certainty",
			"confidence",
			"links",
		],
		"decision",
	);
	if (typeof raw.action !== "string" || !["ADD", "UPDATE", "DELETE", "NOOP"].includes(raw.action))
		throw new CliError("invalid_argument", "decision.action must be ADD, UPDATE, DELETE or NOOP");
	const action = raw.action as Action;
	const rawIndices = raw.source_fact_indices ?? [];
	if (
		!Array.isArray(rawIndices) ||
		rawIndices.some((n) => !Number.isInteger(n) || n < 0 || n >= facts.length) ||
		new Set(rawIndices).size !== rawIndices.length
	)
		throw new CliError("invalid_argument", "source_fact_indices must contain distinct valid zero-based fact indices");
	if (action !== "NOOP" && rawIndices.length === 0)
		throw new CliError("invalid_argument", "A mutating decision must reference at least one source fact");
	const decision: Decision = { action, source_fact_indices: rawIndices as number[] };
	for (const key of [
		"id",
		"revision",
		"text",
		"layer",
		"subject",
		"topic",
		"profile_ref",
		"tags",
		"certainty",
		"links",
	] as const) {
		if (raw[key] !== undefined) {
			if (key === "links" && raw[key] === "") decision[key] = "";
			else decision[key] = nonempty(raw[key], `decision.${key}`, key === "text" ? 65536 : 2048);
		}
	}
	if (raw.confidence !== undefined) {
		if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence))
			throw new CliError("invalid_argument", "decision.confidence must be a number");
		decision.confidence = raw.confidence;
	}
	if (action === "NOOP" && Object.keys(raw).some((key) => !["action", "source_fact_indices"].includes(key)))
		throw new CliError("invalid_argument", "NOOP does not accept mutation fields");
	if (action === "ADD" && (decision.id || decision.revision))
		throw new CliError("invalid_argument", "ADD creates a new ID and does not accept id or revision");
	if (
		["UPDATE", "DELETE"].includes(action) &&
		(!decision.id || !memoryId.test(decision.id) || !/^[a-f0-9]{64}$/.test(decision.revision ?? ""))
	)
		throw new CliError("invalid_argument", "UPDATE and DELETE require a memory ID and revision");
	if (["ADD", "UPDATE"].includes(action) && !decision.text)
		throw new CliError("invalid_argument", "ADD and UPDATE require the complete memory text");
	if (
		action === "DELETE" &&
		Object.keys(raw).some((key) => !["action", "source_fact_indices", "id", "revision"].includes(key))
	)
		throw new CliError("invalid_argument", "DELETE accepts only an ID, revision and source facts");
	return { facts, decision };
}

async function verifySources(base: string, facts: Fact[]) {
	const checks: SourceCheck[] = [];
	// There is one store, so an account segment in a source either names the one
	// account or it is a stale or foreign reference that must not resolve.
	const store = new Store(base);
	let receipts: Awaited<ReturnType<Store["receipts"]>> | undefined;
	let events: Awaited<ReturnType<Store["events"]>> | undefined;
	for (const source of new Set(facts.flatMap((fact) => fact.sources))) {
		if (source.startsWith("receipt:")) {
			const match = receiptPattern.exec(source);
			if (
				!match ||
				match[2].length < 8 ||
				match[2].length > 128 ||
				/\s/.test(match[2]) ||
				[...match[2]].some((character) => character.charCodeAt(0) < 32)
			)
				throw new CliError("invalid_argument", "Receipt source must be receipt:<account>:<request-id>");
			// Callers hold the workspace lease already; reading directly avoids
			// waiting on the same lock a second time.
			receipts ??= await store.receipts();
			const receipt = Object.hasOwn(receipts, match[2]) ? receipts[match[2]] : undefined;
			if (match[1] !== store.profile || !receipt || receipt.request_id !== match[2] || receipt.bot_id !== store.bot_id)
				throw new CliError("not_found", "Receipt source is not attributed to this bot and account");
			checks.push({ source, kind: "receipt", attribution_verified: true, status_at_check: receipt.status });
			continue;
		}
		if (!source.startsWith("event:")) {
			checks.push({ source, kind: "caller_provided", attribution_verified: false });
			continue;
		}
		const match = eventPattern.exec(source);
		if (!match) throw new CliError("invalid_argument", "Event source must be event:<account>:<id>");
		events ??= await store.events();
		if (match[1] !== store.profile || !events.some((event) => event.id === match[2] && event.bot_id === store.bot_id))
			throw new CliError("not_found", "Event source is not attributed to this bot and account");
		checks.push({ source, kind: "event", attribution_verified: true });
	}
	return checks;
}

function bounded(text: string, remaining: number): { text: string; truncated: boolean; used: number } {
	const chars = Array.from(text);
	const slice = chars.slice(0, Math.max(0, Math.min(360, remaining)));
	return { text: slice.join(""), truncated: slice.length < chars.length, used: slice.length };
}

export class Formation {
	readonly workspaces: Workspaces;
	constructor(workspaces: Workspaces) {
		this.workspaces = workspaces;
	}
	// Events, receipts and memories all live under one identity, so every
	// attribution check compares against this one value.
	private bot(): string {
		return new Store(this.workspaces.base).bot_id;
	}
	private async entries(): Promise<Entry[]> {
		return strictScan(await scan(this.bot(), this.workspaces.root()));
	}
	async candidates(text: string, limit: number, budget: number) {
		return this.workspaces.lock(() => this.prepareCandidates(text, limit, budget));
	}
	private async prepareCandidates(text: string, limit: number, budget: number) {
		if (!Number.isInteger(budget) || budget < 100 || budget > 20000)
			throw new CliError("invalid_argument", "--budget must be 100..20000 characters");
		const { facts } = parseRequest(text, false);
		const sourceChecks = await verifySources(this.workspaces.base, facts);
		const entries = await this.entries();
		const result = recall(entries, facts, Math.min(limit, 30), true);
		const ranked = result.hits;
		let remaining = budget;
		const candidates = ranked
			.slice(0, Math.min(limit, 30))
			.map(({ entry, score, factIndices, reasons, depth, path }) => {
				const excerpt = bounded(entry.row.body, remaining);
				remaining -= excerpt.used;
				const title = bounded(entry.row.title, 200);
				const subject = bounded(entry.row.subject, 200);
				const topic = bounded(entry.row.topic, 200);
				const safeSources = entry.row.sources.filter((source) => Array.from(source).length <= 256).slice(0, 8);
				return {
					id: entry.row.id,
					revision: entry.row.revision,
					title: title.text,
					layer: entry.row.layer,
					subject: subject.text,
					topic: topic.text,
					profile_ref: entry.row.profile_ref,
					certainty: entry.row.certainty,
					confidence: entry.row.confidence,
					sources: safeSources,
					sources_truncated: safeSources.length !== entry.row.sources.length,
					metadata_truncated: title.truncated || subject.truncated || topic.truncated,
					excerpt: excerpt.text,
					truncated: excerpt.truncated,
					reasons: [...new Set(reasons.length ? reasons : ["recent_fallback"])],
					score,
					relation_depth: depth,
					relation_path: path,
					fact_indices: factIndices,
				};
			});
		return {
			facts,
			source_checks: sourceChecks,
			source_checks_scope: "current_check",
			candidates,
			limit: Math.min(limit, 30),
			body_budget: budget,
			body_characters: budget - remaining,
			more_candidates: ranked.length > candidates.length || result.fallbackTruncated || result.seedsTruncated,
			graph_truncated: result.graphTruncated,
			seeds_truncated: result.seedsTruncated,
			limitations: [
				"Lexical and relation matches are approximate, not semantic search; fallback candidates may be unrelated.",
				"Event and receipt attribution is checked; it does not establish truth or delivery. Other sources are caller-provided.",
				"Snapshot is not a transaction; check the revision before applying a decision.",
			],
		};
	}

	private receiptPath(requestID: string): string {
		return join(this.workspaces.root(), "decisions", `${createHash("sha256").update(requestID).digest("hex")}.json`);
	}

	private async receipt(requestID: string): Promise<Receipt | undefined> {
		const path = this.receiptPath(requestID);
		try {
			const directory = await lstat(join(this.workspaces.root(), "decisions"));
			if (!directory.isDirectory() || directory.isSymbolicLink())
				throw new CliError("state_corrupt", "Invalid decision receipt directory");
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
				throw new CliError("state_corrupt", "Invalid decision receipt");
			const item: unknown = JSON.parse(await readFile(path, "utf8"));
			if (
				!item ||
				typeof item !== "object" ||
				!("version" in item) ||
				item.version !== 1 ||
				!("fingerprint" in item) ||
				typeof item.fingerprint !== "string" ||
				!/^[a-f0-9]{64}$/.test(item.fingerprint) ||
				!("status" in item) ||
				typeof item.status !== "string" ||
				!["prepared", "completed"].includes(item.status) ||
				!("action" in item) ||
				typeof item.action !== "string" ||
				!["ADD", "UPDATE", "DELETE"].includes(item.action) ||
				!("sources" in item) ||
				!Array.isArray(item.sources) ||
				item.sources.length === 0 ||
				item.sources.some((source: unknown) => typeof source !== "string" || !source.trim()) ||
				!("source_fact_indices" in item) ||
				!Array.isArray(item.source_fact_indices) ||
				item.source_fact_indices.length === 0 ||
				item.source_fact_indices.some((index: unknown) => !Number.isInteger(index) || Number(index) < 0)
			)
				throw new CliError("state_corrupt", "Invalid decision receipt");
			const receipt = item as Receipt;
			if (
				receipt.source_checks !== undefined &&
				(!Array.isArray(receipt.source_checks) ||
					receipt.source_checks_scope !== "decision_snapshot" ||
					receipt.source_check_note !== "Attribution does not prove truth or delivery." ||
					new Set(receipt.sources).size !== receipt.sources.length ||
					receipt.source_checks.length !== new Set(receipt.sources).size ||
					new Set(receipt.source_checks.map((check) => check?.source)).size !== receipt.source_checks.length ||
					receipt.source_checks.some(
						(check) =>
							!check ||
							typeof check.source !== "string" ||
							!receipt.sources.includes(check.source) ||
							(check.kind === "receipt"
								? !check.source.startsWith("receipt:") ||
									check.attribution_verified !== true ||
									!["prepared", "dispatching", "confirmed", "not_sent"].includes(check.status_at_check ?? "")
								: check.kind === "event"
									? !check.source.startsWith("event:") ||
										check.attribution_verified !== true ||
										check.status_at_check !== undefined
									: check.kind === "caller_provided"
										? check.source.startsWith("event:") ||
											check.source.startsWith("receipt:") ||
											check.attribution_verified !== false ||
											check.status_at_check !== undefined
										: true),
					))
			)
				throw new CliError("state_corrupt", "Invalid decision source checks");
			if (typeof receipt.id !== "string" || !memoryId.test(receipt.id))
				throw new CliError("state_corrupt", "Decision receipt has no valid target ID");
			if (
				receipt.status === "completed" &&
				(!receipt.result ||
					receipt.result.id !== receipt.id ||
					(receipt.action === "DELETE"
						? receipt.result.deleted !== true
						: typeof receipt.result.revision !== "string" || !/^[a-f0-9]{64}$/.test(receipt.result.revision)))
			)
				throw new CliError("state_corrupt", "Completed decision has an invalid result");
			return receipt;
		} catch (error) {
			if (isMissing(error)) return undefined;
			if (error instanceof SyntaxError)
				throw new CliError("state_corrupt", "Invalid decision receipt", { cause: error });
			throw error;
		}
	}

	async decisionStatus(requestID: string) {
		if (!requestID || requestID.length < 8 || requestID.length > 128 || /\s/.test(requestID))
			throw new CliError("invalid_argument", "Use the request ID supplied to memory decide");
		return this.workspaces.lock(async () => {
			const receipt = await this.receipt(requestID);
			if (!receipt) throw new CliError("not_found", "Decision receipt not found");
			return { request_id: requestID, ...receipt };
		});
	}

	private async draft(request: Request) {
		const sourceChecks = await verifySources(this.workspaces.base, request.facts);
		const entries = await this.entries();
		const decision = request.decision;
		if (!decision) throw new CliError("invalid_argument", "Decision is required");
		if (decision.action === "NOOP")
			return {
				action: "NOOP" as const,
				sources: [] as string[],
				source_checks: sourceChecks,
				source_checks_scope: "decision_snapshot" as const,
				source_check_note: "Attribution does not prove truth or delivery.",
				input: {} as Input,
			};
		const facts = decision.source_fact_indices.map((index) => request.facts[index]);
		const sources = [...new Set(facts.flatMap((fact) => fact.sources))];
		const profiles = [...new Set(facts.map((fact) => fact.profile_ref).filter((value): value is string => !!value))];
		if (profiles.length > 1)
			throw new CliError("invalid_argument", "One decision cannot combine different profile references");
		const target = decision.id ? entries.find((entry) => entry.row.id === decision.id) : undefined;
		if (decision.id && !target) throw new CliError("not_found", "Memory not found in this bot");
		if (target && target.row.revision !== decision.revision)
			throw new CliError("revision_conflict", "The memory changed since it was read", {
				details: { revision: target.row.revision },
			});
		const profile = decision.profile_ref ?? target?.row.profile_ref ?? profiles[0];
		if (profiles.length && profile !== profiles[0])
			throw new CliError("invalid_argument", "Decision profile does not match its source facts");
		if (target && decision.profile_ref !== undefined && decision.profile_ref !== target.row.profile_ref)
			throw new CliError("invalid_argument", "A formation decision cannot move an existing memory to another person");
		if (target && decision.layer !== undefined && decision.layer !== target.row.layer) {
			const found = resolveReferences(entries);
			const references = found.resolved.filter(
				(reference) => reference.kind === "path" && reference.target_id === target.row.id,
			);
			const uncertain = found.unresolved.filter(
				(issue) =>
					issue.kind === "path" &&
					issue.source_id !== target.row.id &&
					(issue.reason === "unverified" ||
						(issue.reason === "not_active" && possiblySamePath(issue.target, target.row.path))),
			);
			if (references.length || uncertain.length)
				throw new CliError("revision_conflict", "Memory cannot change layers while other memories link to its path", {
					details: {
						referenced_by: [
							...new Set([
								...references.map((reference) => reference.source_id),
								...uncertain.map((issue) => issue.source_id),
							]),
						],
					},
				});
		}
		const input: Input = {
			resource: decision.id,
			if_match: decision.revision,
			text: decision.text,
			source: sources[0],
			layer: decision.layer,
			subject: decision.subject,
			topic: decision.topic,
			...(profile ? { profile_ref: profile } : {}),
			tags: decision.tags,
			certainty: decision.certainty,
			confidence: decision.confidence,
			links: decision.links,
		};
		const op =
			decision.action === "ADD" ? "memory.add" : decision.action === "UPDATE" ? "memory.update" : "memory.delete";
		validateMemoryInput(op, input);
		const certainty = decision.certainty ?? target?.row.certainty ?? "inferred";
		const allSources = [...new Set([...(target?.row.sources ?? []), ...sources])];
		if (certainty === "user-stated" && allSources.some((source) => !source.startsWith("user:")))
			throw new CliError("invalid_argument", "user-stated memory requires user: sources");
		if (
			decision.links?.trim() &&
			decision.links.split(",").some((id) => !entries.some((entry) => entry.row.id === id.trim()))
		)
			throw new CliError("not_found", "A linked memory is not present in this bot");
		if (decision.action === "ADD" || decision.action === "UPDATE") {
			const header = metadata(input, input.text ?? "", target?.row);
			if (decision.action === "ADD") header.id = `mem_${"0".repeat(40)}`;
			header.sources = [...new Set([...header.sources, ...sources])];
			checkedMarkdown(this.bot(), `memory/${header.layer}/preview.md`, header, input.text ?? "", target);
		}
		const before = target ? bounded(target.row.body, 360) : undefined;
		return {
			action: decision.action,
			sources,
			source_checks: sourceChecks.filter((check) => sources.includes(check.source)),
			source_checks_scope: "decision_snapshot" as const,
			source_check_note: "Attribution does not prove truth or delivery.",
			input,
			...(target
				? {
						before: {
							id: target.row.id,
							revision: target.row.revision,
							excerpt: before?.text ?? "",
							truncated: before?.truncated ?? false,
						},
					}
				: {}),
		};
	}

	async decide(text: string, apply: boolean, requestID?: string, parentSignal?: AbortSignal) {
		parentSignal?.throwIfAborted();
		const request = parseRequest(text, true);
		const decision = request.decision;
		if (!decision) throw new CliError("invalid_argument", "Decision is required");
		if (!apply || decision.action === "NOOP") {
			return this.workspaces.lock(async () => {
				const plan = await this.draft(request);
				parentSignal?.throwIfAborted();
				return {
					applied: false,
					preview: true,
					...plan,
					...(decision.action === "DELETE"
						? { warning: "DELETE removes the memory, superseded archives and saved revisions." }
						: {}),
				};
			});
		}
		if (!requestID || requestID.length < 8 || requestID.length > 128 || /\s/.test(requestID))
			throw new CliError("invalid_argument", "An applied decision requires --request-id of 8..128 characters");
		const bot = this.bot();
		const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
		const lock = join(this.workspaces.base, `.decision-${createHash("sha256").update(requestID).digest("hex")}`);
		return withLease(lock, async (leaseSignal) =>
			this.workspaces.lock(async (botSignal) => {
				const signal = AbortSignal.any([leaseSignal, botSignal, ...(parentSignal ? [parentSignal] : [])]);
				signal.throwIfAborted();
				const existing = await this.receipt(requestID);
				if (existing) {
					if (existing.fingerprint !== fingerprint)
						throw new CliError("idempotency_conflict", "Request ID was used for a different decision");
					if (existing.status === "completed")
						return { applied: true, replayed: true, request_id: requestID, ...existing };
					throw new CliError(
						"decision_uncertain",
						"A previous decision was interrupted before its result was recorded",
						{
							hint: "Use memory decision-status and inspect the memory before choosing a new request ID.",
							details: { request_id: requestID, action: existing.action, id: existing.id },
						},
					);
				}
				const plan = await this.draft(request);
				signal.throwIfAborted();
				const id =
					decision.action === "ADD"
						? `mem_${createHash("sha256").update(`${bot}\0${requestID}`).digest("hex").slice(0, 40)}`
						: decision.id;
				if ((decision.action === "ADD" || decision.action === "UPDATE") && id) {
					const entries = await this.entries();
					const target = entries.find((entry) => entry.row.id === id);
					const header = metadata(plan.input, plan.input.text ?? "", target?.row);
					header.id = id;
					const path =
						target && target.row.layer === header.layer
							? target.row.path
							: `memory/${header.layer}/${nodeSlug(id, header.subject, header.topic) || "memory"}-${id}.md`;
					if (!target || target.row.path !== path) {
						try {
							await lstat(join(this.workspaces.root(), path));
							throw new CliError("revision_conflict", "Memory target path already exists; no file was overwritten", {
								details: { path },
							});
						} catch (error) {
							if (!isMissing(error)) throw error;
						}
					}
				}
				const receipt: Receipt = {
					version: 1,
					fingerprint,
					status: "prepared",
					action: decision.action,
					id,
					sources: plan.sources,
					source_fact_indices: decision.source_fact_indices,
					source_checks: plan.source_checks,
					source_checks_scope: plan.source_checks_scope,
					source_check_note: plan.source_check_note,
				};
				if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > 64000)
					throw new CliError("invalid_argument", "Decision source references exceed the receipt size limit");
				const directory = join(this.workspaces.root(), "decisions");
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const info = await lstat(directory);
				if (!info.isDirectory() || info.isSymbolicLink())
					throw new CliError("state_corrupt", "Invalid decision receipt directory");
				signal.throwIfAborted();
				try {
					await atomicCreate(this.receiptPath(requestID), `${JSON.stringify(receipt)}\n`);
					signal.throwIfAborted();
					const memory = new MemoryStore(this.workspaces);
					let result: Receipt["result"];
					if (decision.action === "DELETE")
						result = await memory.remove(decision.id ?? "", decision.revision, signal, true);
					else {
						const saved = await memory.put(plan.input, decision.action === "UPDATE", {
							id,
							sources: plan.sources,
							signal,
							lockHeld: true,
						});
						result = { id: saved.id, revision: saved.revision };
					}
					signal.throwIfAborted();
					const completed: Receipt = { ...receipt, status: "completed", result };
					await atomicWrite(this.receiptPath(requestID), `${JSON.stringify(completed)}\n`);
					return { applied: true, replayed: false, request_id: requestID, ...completed };
				} catch (cause) {
					throw new CliError("decision_uncertain", "The decision did not complete after receipt preparation began", {
						hint: "Use memory decision-status and inspect the target before deciding whether to use a new request ID.",
						details: { request_id: requestID, action: receipt.action, id: receipt.id },
						cause,
					});
				}
			}),
		);
	}
}
