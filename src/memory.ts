import { lstat, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { withDatabase } from "./database.ts";
import { CliError, isMissing } from "./errors.ts";
import { checkedMarkdown, decode, type Entry, type Memory, metadata, nodeSlug } from "./memory/concept.ts";
import { possiblySamePath, resolveReferences } from "./memory/graph.ts";
import { scan, strictScan, writeIndex } from "./memory/indexer.ts";
import { applyCompact, compactSummary, planCompact, readSuperseded, supersededBy } from "./memory/maintain.ts";
import { recall } from "./memory/recall.ts";
import { graph, renderOverview, status, usage } from "./memory/view.ts";
import type { Input } from "./operations/validate.ts";
import { memories, revisions } from "./schema.ts";
import { atomicCreate, atomicWrite, checkFileUnchanged } from "./store.ts";
import { checkRevision, type Document, type Workspaces } from "./workspace.ts";

// One installation, one workspace. The shelves below still key their rows by a
// BOT_ID id, because that is how the database and the archived files were written;
// this is the single value those keys carry now.
const BOT_ID = "default";

export { LAYERS, nodeSlug, parseLinks, slugify, validateMemoryInput } from "./memory/concept.ts";

// MemoryStore is the only entry point to BOT_ID memory. Each method takes the
// per-BOT_ID lock, then delegates to the concept, index, graph, view or
// maintenance module, so no call site needs to know the storage split.

function document(root: string, entry: Entry): Document {
	return {
		file: entry.row.path,
		path: join(root, entry.row.path),
		content: entry.content,
		revision: entry.row.revision,
		updated_at: entry.row.updated_at,
	};
}

export class MemoryStore {
	readonly workspaces: Workspaces;
	constructor(workspaces: Workspaces) {
		this.workspaces = workspaces;
	}

	private async collect(): Promise<Entry[]> {
		return strictScan(await scan(BOT_ID, this.workspaces.root()));
	}

	private async settle(entries: Entry[]): Promise<Entry[]> {
		writeIndex(this.workspaces.base, BOT_ID, entries);
		await atomicWrite(join(this.workspaces.root(), "MEMORY.md"), renderOverview(entries));
		return entries;
	}

	async reconcile(): Promise<Entry[]> {
		return this.settle(await this.collect());
	}

	async graph() {
		return this.workspaces.lock(async () => graph(await this.reconcile()));
	}

	async read(id: string): Promise<Memory & { file: string }> {
		return this.workspaces.lock(async () => {
			const entries = await this.reconcile();
			const entry = entries.find((entry) => entry.row.id === id);
			if (!entry) {
				const archived = await readSuperseded(this.workspaces.root(), BOT_ID, id);
				if (archived) return archived;
				throw new CliError("not_found", "Memory not found in this BOT_ID");
			}
			return { ...entry.row, file: join(this.workspaces.root(), entry.row.path) };
		});
	}

	async search(input: Input = {}): Promise<(Memory & { file: string })[]> {
		return this.workspaces.lock(async () => {
			await this.reconcile();
			return withDatabase(this.workspaces.base, (db, sqlite) => {
				let rows = db
					.select()
					.from(memories)
					.where(eq(memories.bot_id, BOT_ID))
					.orderBy(desc(memories.updated_at), memories.id)
					.all();
				if (input.query?.trim()) {
					const query = input.query.trim();
					if ([...query].length >= 3) {
						const quoted = `"${query.replaceAll('"', '""')}"`;
						const matches = sqlite
							.prepare("SELECT id FROM memory_fts WHERE memory_fts MATCH ? AND bot_id = ? ORDER BY rank")
							.all(quoted, BOT_ID) as { id: string }[];
						const rank = new Map(matches.map((row, index) => [row.id, index]));
						rows = rows.filter((row) => rank.has(row.id)).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
					} else
						rows = rows.filter((row) =>
							`${row.title} ${row.body} ${row.subject} ${row.topic} ${row.tags.join(" ")}`
								.toLocaleLowerCase()
								.includes(query.toLocaleLowerCase()),
						);
				}
				return rows
					.filter(
						(row) =>
							(!input.layer || row.layer === input.layer) &&
							(!input.subject || row.subject === input.subject) &&
							(!input.profile_ref || row.profile_ref === input.profile_ref),
					)
					.slice(0, input.limit ?? 20)
					.map((row) => ({ ...row, file: join(this.workspaces.root(), row.path) }));
			});
		});
	}

	async recall(input: Input = {}) {
		const entries = (await this.collect()).filter(
			({ row }) => (!input.layer || row.layer === input.layer) && (!input.subject || row.subject === input.subject),
		);
		const result = recall(
			entries,
			[{ text: input.query ?? "", profile_ref: input.profile_ref }],
			input.limit ?? 20,
			false,
		);
		return {
			...result,
			hits: result.hits.slice(0, input.limit ?? 20),
			more: result.hits.length > (input.limit ?? 20) || result.seedsTruncated,
		};
	}

	async put(
		input: Input,
		update = false,
		formation?: { id?: string; sources: string[]; signal?: AbortSignal; lockHeld?: boolean },
	): Promise<Memory & { file: string }> {
		const run = async () => {
			formation?.signal?.throwIfAborted();
			const entries = await this.reconcile();
			formation?.signal?.throwIfAborted();
			const old = update ? entries.find((entry) => entry.row.id === input.resource) : undefined;
			if (update && !old) throw new CliError("not_found", "Memory not found in this BOT_ID");
			if (old) checkRevision(document(this.workspaces.root(), old), input.if_match);
			const header = metadata(input, input.text ?? "", old?.row);
			if (!update && formation?.id) {
				if (entries.some((entry) => entry.row.id === formation.id))
					throw new CliError("idempotency_conflict", "The decision memory ID is already in use");
				try {
					await lstat(join(this.workspaces.root(), "memory", "superseded", `${formation.id}.json`));
					throw new CliError("idempotency_conflict", "The decision memory ID has been archived");
				} catch (error) {
					if (!isMissing(error)) throw error;
				}
				header.id = formation.id;
			}
			if (formation) header.sources = [...new Set([...header.sources, ...formation.sources])];
			if (header.certainty === "user-stated" && !header.sources.every((source) => source.startsWith("user:")))
				throw new CliError("invalid_argument", "user-stated memory requires a user: source reference");
			if (header.links.some((id) => !entries.some((entry) => entry.row.id === id)))
				throw new CliError("not_found", "A linked memory is not present in this BOT_ID");
			const slug = nodeSlug(header.id, header.subject, header.topic) || "memory";
			const path =
				old && old.row.layer === header.layer ? old.row.path : `memory/${header.layer}/${slug}-${header.id}.md`;
			if (old && old.row.path !== path) {
				const found = resolveReferences(entries);
				const references = found.resolved.filter(
					(reference) => reference.kind === "path" && reference.target_id === old.row.id,
				);
				const uncertain = found.unresolved.filter(
					(issue) =>
						issue.kind === "path" &&
						issue.source_id !== old.row.id &&
						(issue.reason === "unverified" ||
							(issue.reason === "not_active" && possiblySamePath(issue.target, old.row.path))),
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
			const content = checkedMarkdown(BOT_ID, path, header, input.text ?? "", old);
			await mkdir(join(this.workspaces.root(), "memory", header.layer), { recursive: true, mode: 0o700 });
			formation?.signal?.throwIfAborted();
			if (old && old.row.path === path) await atomicWrite(join(this.workspaces.root(), path), content, old.content);
			else {
				try {
					if (old) await checkFileUnchanged(join(this.workspaces.root(), old.row.path), old.content);
					await atomicCreate(join(this.workspaces.root(), path), content);
				} catch (cause) {
					if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")
						throw new CliError("revision_conflict", "Memory target path already exists; no file was overwritten", {
							cause,
							details: { path },
						});
					throw cause;
				}
			}
			if (old && old.row.path !== path) {
				const previous = join(this.workspaces.root(), old.row.path);
				try {
					await checkFileUnchanged(previous, old.content);
				} catch (cause) {
					throw new CliError("revision_conflict", "Memory changed during the move; both files were preserved", {
						cause,
						details: { previous_path: old.row.path, new_path: path },
						hint: "Inspect both files and resolve their duplicate memory ID before retrying.",
					});
				}
				await unlink(previous);
			}
			const saved = (await this.reconcile()).find((entry) => entry.row.id === header.id);
			if (!saved) throw new CliError("state_corrupt", "Saved memory could not be indexed");
			return { ...saved.row, file: join(this.workspaces.root(), saved.row.path) };
		};
		return formation?.lockHeld ? run() : this.workspaces.lock(run);
	}

	async remove(
		id: string,
		expected?: string,
		signal?: AbortSignal,
		lockHeld = false,
	): Promise<{
		id: string;
		deleted: boolean;
		dependents: { id: string; title: string; type: string }[];
	}> {
		const run = async () => {
			signal?.throwIfAborted();
			const entries = await this.reconcile();
			signal?.throwIfAborted();
			const current = entries.find((entry) => entry.row.id === id);
			if (!current) throw new CliError("not_found", "Memory not found in this BOT_ID");
			checkRevision(document(this.workspaces.root(), current), expected);
			const archived = await supersededBy(this.workspaces.root(), BOT_ID, id);
			signal?.throwIfAborted();
			await checkFileUnchanged(join(this.workspaces.root(), current.row.path), current.content);
			// Which other memories cited this one. A conclusion that borrowed its
			// support from a deleted observation is still readable, but it is no
			// longer supported, and the caller has to be told which ones those are.
			const dependents = entries
				.filter((entry) => entry.row.id !== id && entry.row.links.includes(id))
				.map((entry) => ({ id: entry.row.id, title: entry.row.title, type: entry.row.type }));
			await unlink(join(this.workspaces.root(), current.row.path));
			for (const entry of archived) await unlink(entry.file);
			await this.reconcile();
			withDatabase(this.workspaces.base, (db) =>
				db.transaction((tx) => {
					for (const resource of [id, ...archived.map((entry) => entry.id)])
						tx.delete(revisions)
							.where(and(eq(revisions.bot_id, BOT_ID), eq(revisions.resource, resource)))
							.run();
				}),
			);
			return { id, deleted: true, dependents };
		};
		return lockHeld ? run() : this.workspaces.lock(run);
	}

	history(id: string) {
		return withDatabase(this.workspaces.base, (db) =>
			db
				.select({ revision: revisions.revision, at: revisions.at })
				.from(revisions)
				.where(and(eq(revisions.bot_id, BOT_ID), eq(revisions.resource, id)))
				.orderBy(desc(revisions.at))
				.all(),
		);
	}

	async status() {
		return this.workspaces.lock(async () => {
			// Compare the overview with the files as they are, without rewriting
			// it first: reconcile() would make every stale overview look clean.
			const root = this.workspaces.root();
			const { entries, failed } = await scan(BOT_ID, root);
			const files = entries.length + failed.filter(({ file }) => file.endsWith(".md")).length;
			const current = await status(this.workspaces.base, BOT_ID, root, entries, files);
			const unresolved = resolveReferences(entries).unresolved;
			return {
				...current,
				failed,
				unresolved,
				healthy:
					failed.length === 0 &&
					!unresolved.some(
						(issue) => issue.kind !== "wiki" && (issue.reason === "not_active" || issue.reason === "unverified"),
					) &&
					current.index_stale === false &&
					current.overview_stale === false,
			};
		});
	}

	async usage() {
		return this.workspaces.lock(async () => {
			const { entries, failed } = await scan(BOT_ID, this.workspaces.root());
			return { ...usage(BOT_ID, entries), failed };
		});
	}

	// Deterministic dedupe only: identical bodies merge, semantic near-matches do not.
	async compact(input: Input) {
		const dryRun = input.dry_run === true;
		return this.workspaces.lock(async () => {
			// A dry run reports the plan from the files alone; it must not rewrite
			// the index or overview that reconcile() would touch.
			const entries = dryRun ? await this.collect() : await this.reconcile();
			const groups = planCompact(entries);
			const summary = compactSummary(entries, groups, dryRun);
			if (dryRun || !groups.length) return summary;
			await applyCompact(this.workspaces.root(), groups);
			const remaining = await this.reconcile();
			return { ...summary, after: remaining.length };
		});
	}

	// Incremental ingest reports counts instead of rebuilding silently. Valid
	// files are indexed and malformed ones are listed without clearing the rest.
	async ingest() {
		return this.workspaces.lock(async () => {
			const { entries, failed } = await scan(BOT_ID, this.workspaces.root());
			const old = withDatabase(this.workspaces.base, (db) =>
				db.select().from(memories).where(eq(memories.bot_id, BOT_ID)).all(),
			);
			const previous = new Map(old.map((row) => [row.path, row]));
			const ingested = entries.filter((entry) => previous.get(entry.row.path)?.revision !== entry.row.revision).length;
			const ids = new Set(entries.map((entry) => entry.row.id));
			const preserved = old.filter((row) =>
				failed.some(({ file }) => row.path === file || row.path.startsWith(`${file}/`)),
			);
			for (const row of preserved) {
				if (ids.has(row.id)) throw new CliError("state_corrupt", "Damaged memory conflicts with an existing ID");
				const archived = withDatabase(this.workspaces.base, (db) =>
					db
						.select()
						.from(revisions)
						.where(
							and(eq(revisions.bot_id, BOT_ID), eq(revisions.resource, row.id), eq(revisions.revision, row.revision)),
						)
						.get(),
				);
				if (!archived)
					throw new CliError("state_corrupt", "Cannot preserve damaged memory without its indexed revision");
				entries.push(decode(BOT_ID, row.path, archived.content));
				ids.add(row.id);
			}
			if (failed.length) writeIndex(this.workspaces.base, BOT_ID, entries);
			else await this.settle(entries);
			return {
				ingested,
				skipped: entries.length - preserved.length - ingested + failed.length,
				indexed: entries.length,
				failed,
			};
		});
	}
}
