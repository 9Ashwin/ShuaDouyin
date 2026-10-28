import { lstat, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CliError, isMissing } from "../errors.ts";
import { atomicCreate, atomicWrite, checkFileUnchanged } from "../store.ts";
import { checkedMarkdown, decode, type Entry, type Header, memoryId, nodeSlug } from "./concept.ts";
import { possiblySamePath, relations, resolveReferences } from "./graph.ts";

const MAX_ARCHIVE_BYTES = 1024 * 1024;

// Maintenance is deterministic. It never invents, rewrites or semantically
// merges content; semantic consolidation stays the calling agent's decision.

export interface CompactPlan {
	keep: Entry;
	superseded: Entry[];
}

function originalBody(entry: Entry): string {
	const header = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(entry.content);
	if (!header) throw new CliError("state_corrupt", "Memory frontmatter is incomplete");
	return entry.content.slice(header[0].length);
}

export function planCompact(entries: Entry[]): CompactPlan[] {
	const buckets = new Map<string, Entry[]>();
	for (const entry of entries) {
		const { row } = entry;
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(entry.content)?.[1] ?? "";
		const key = JSON.stringify([
			originalBody(entry),
			row.type,
			row.layer,
			row.subject,
			row.topic,
			row.title,
			row.profile_ref,
			row.certainty,
			row.confidence,
			/(?:^|\s)#/m.test(frontmatter) ? frontmatter : null,
			entry.frontmatter?.metadata ?? null,
			Object.fromEntries(
				Object.entries(entry.frontmatter ?? {}).filter(
					([key]) =>
						![
							"type",
							"title",
							"id",
							"layer",
							"subject",
							"topic",
							"tags",
							"profile_ref",
							"certainty",
							"confidence",
							"sources",
							"links",
							"created_at",
							"updated_at",
							"timestamp",
							"hash",
						].includes(key),
				),
			),
		]);
		const bucket = buckets.get(key) ?? [];
		bucket.push(entry);
		buckets.set(key, bucket);
	}
	const references = relations(entries).filter((edge) => edge.relation === "refs");
	const unresolved = resolveReferences(entries).unresolved;
	return [...buckets.values()]
		.filter((bucket) => bucket.length > 1)
		.map((bucket) => {
			const ordered = [...bucket].sort(
				(left, right) =>
					left.row.created_at.localeCompare(right.row.created_at) || left.row.id.localeCompare(right.row.id),
			);
			return { keep: ordered[0], superseded: ordered.slice(1) };
		})
		.filter((group) => {
			const removed = new Set(group.superseded.map((entry) => entry.row.id));
			// Keep all IDs when another active memory refers to a candidate.
			return (
				!references.some((edge) => !removed.has(edge.source_id) && removed.has(edge.target_id)) &&
				!unresolved.some(
					(issue) =>
						issue.kind === "path" &&
						!removed.has(issue.source_id) &&
						(issue.reason === "unverified" ||
							(issue.reason === "not_active" &&
								group.superseded.some((entry) => possiblySamePath(entry.row.path, issue.target)))),
				) &&
				!unresolved.some(
					(issue) =>
						issue.kind === "wiki" &&
						issue.reason === "ambiguous" &&
						!removed.has(issue.source_id) &&
						group.superseded.some(
							(entry) => nodeSlug(entry.row.id, entry.row.subject, entry.row.topic) === issue.target,
						),
				)
			);
		});
}

export function compactSummary(entries: Entry[], groups: CompactPlan[], dryRun: boolean) {
	const merged = groups.reduce((sum, group) => sum + group.superseded.length, 0);
	return {
		before: entries.length,
		after: entries.length - merged,
		groups: groups.length,
		merged,
		...(dryRun
			? {
					plan: groups.map((group) => ({
						keep: group.keep.row.id,
						superseded: group.superseded.map((entry) => entry.row.id),
					})),
				}
			: {}),
	};
}

// The survivor keeps its ID and absorbs the sources, tags and links of the
// duplicates, so no provenance is lost with the removed files.
export async function applyCompact(root: string, groups: CompactPlan[]): Promise<void> {
	const updates = groups.map((group) => {
		const keep = group.keep;
		const header: Header = {
			type: keep.row.type,
			title: keep.row.title,
			id: keep.row.id,
			layer: keep.row.layer,
			subject: keep.row.subject,
			topic: keep.row.topic,
			tags: [...new Set(group.superseded.flatMap((entry) => entry.row.tags).concat(keep.row.tags))],
			profile_ref: keep.row.profile_ref,
			certainty: keep.row.certainty,
			confidence: keep.row.confidence,
			sources: [...new Set(keep.row.sources.concat(group.superseded.flatMap((entry) => entry.row.sources)))],
			links: [...new Set(keep.row.links.concat(group.superseded.flatMap((entry) => entry.row.links)))].filter(
				(id) => id !== keep.row.id && !group.superseded.some((entry) => entry.row.id === id),
			),
			created_at: keep.row.created_at,
			updated_at: new Date().toISOString(),
		};
		let content: string;
		try {
			content = checkedMarkdown(keep.row.bot_id, keep.row.path, header, originalBody(keep), keep);
		} catch (cause) {
			if (cause instanceof CliError && cause.code === "invalid_argument")
				throw new CliError("state_corrupt", "Compacted memory would exceed the supported size; files were preserved", {
					cause,
				});
			throw cause;
		}
		return { group, content };
	});
	const directory = join(root, "memory", "superseded");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new CliError("state_corrupt", "Invalid memory archive directory");
	const archives = groups.flatMap((group) =>
		group.superseded.map((entry) => ({
			path: join(directory, `${entry.row.id}.json`),
			activePath: join(root, entry.row.path),
			id: entry.row.id,
			bot: entry.row.bot_id,
			relativePath: entry.row.path,
			content: `${JSON.stringify({ version: 1, id: entry.row.id, path: entry.row.path, content: entry.content, superseded_by: group.keep.row.id })}\n`,
			exists: false,
		})),
	);
	for (const archive of archives) {
		if (Buffer.byteLength(archive.content) > MAX_ARCHIVE_BYTES)
			throw new CliError("state_corrupt", "Memory archive exceeds the supported size");
		try {
			const current = await lstat(archive.path);
			if (!current.isFile() || current.isSymbolicLink() || current.size > MAX_ARCHIVE_BYTES)
				throw new CliError("state_corrupt", "Invalid memory archive");
			if ((await readFile(archive.path, "utf8")) !== archive.content)
				throw new CliError("state_corrupt", "Memory archive already contains a different record");
			archive.exists = true;
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}
	const created: typeof archives = [];
	try {
		for (const archive of archives) {
			if (archive.exists) {
				if ((await readFile(archive.path, "utf8")) !== archive.content)
					throw new CliError("state_corrupt", "Memory archive changed during compaction");
				continue;
			}
			try {
				await atomicCreate(archive.path, archive.content);
				created.push(archive);
			} catch (cause) {
				if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")
					throw new CliError("state_corrupt", "Memory archive appeared during compaction; originals were preserved", {
						cause,
						details: { path: archive.path },
						hint: "Inspect the conflicting archive and active memory before continuing.",
					});
				throw cause;
			}
		}
		for (const { group, content } of updates) {
			await atomicWrite(join(root, group.keep.row.path), content, group.keep.content);
			for (const entry of group.superseded) {
				const path = join(root, entry.row.path);
				await checkFileUnchanged(path, entry.content);
				await unlink(path);
			}
		}
	} catch (cause) {
		const unresolved: string[] = [];
		for (const archive of created) {
			try {
				const active = await lstat(archive.activePath).catch((error: unknown) => {
					if (isMissing(error)) return undefined;
					throw error;
				});
				if (!active) continue; // Archive is the only remaining copy.
				if (!active.isFile() || active.isSymbolicLink()) throw new Error("Active memory path changed");
				const activeEntry = decode(archive.bot, archive.relativePath, await readFile(archive.activePath, "utf8"));
				if (activeEntry.row.id !== archive.id) continue; // The original ID survives only in the archive.
				await checkFileUnchanged(archive.path, archive.content);
				await unlink(archive.path);
			} catch {
				unresolved.push(archive.path);
			}
		}
		if (unresolved.length)
			throw new CliError("state_corrupt", "Compaction stopped; some archive conflicts require inspection", {
				cause,
				details: { archives: unresolved },
				hint: "Preserve the active memories and listed archives while inspecting them.",
			});
		throw cause;
	}
}

export async function supersededBy(root: string, bot: string, id: string) {
	const directory = join(root, "memory", "superseded");
	let names: string[];
	try {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new CliError("state_corrupt", "Invalid memory archive directory");
		names = await readdir(directory);
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	const records = [];
	for (const name of names.filter((name) => name.endsWith(".json"))) {
		const archiveId = name.slice(0, -5);
		if (!memoryId.test(archiveId)) throw new CliError("state_corrupt", "Invalid memory archive filename");
		const record = await readSuperseded(root, bot, archiveId);
		if (!record) throw new CliError("state_corrupt", "Memory archive disappeared");
		records.push(record);
	}
	const targets = new Set([id]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const record of records)
			if (targets.has(record.superseded_by) && !targets.has(record.id)) {
				targets.add(record.id);
				changed = true;
			}
	}
	return records.filter((record) => targets.has(record.id));
}

export async function readSuperseded(root: string, bot: string, id: string) {
	if (!memoryId.test(id)) return undefined;
	const path = join(root, "memory", "superseded", `${id}.json`);
	try {
		const directory = await lstat(join(root, "memory", "superseded"));
		if (!directory.isDirectory() || directory.isSymbolicLink())
			throw new CliError("state_corrupt", "Invalid memory archive directory");
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ARCHIVE_BYTES)
			throw new CliError("state_corrupt", "Invalid memory archive");
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			!value ||
			typeof value !== "object" ||
			!("version" in value) ||
			value.version !== 1 ||
			!("id" in value) ||
			value.id !== id ||
			!("path" in value) ||
			typeof value.path !== "string" ||
			!("content" in value) ||
			typeof value.content !== "string" ||
			!("superseded_by" in value) ||
			typeof value.superseded_by !== "string" ||
			!memoryId.test(value.superseded_by)
		)
			throw new CliError("state_corrupt", "Invalid memory archive");
		const entry = decode(bot, value.path, value.content);
		if (entry.row.id !== id) throw new CliError("state_corrupt", "Memory archive ID does not match");
		return { ...entry.row, file: path, superseded_by: value.superseded_by };
	} catch (error) {
		if (isMissing(error)) return undefined;
		if (error instanceof SyntaxError) throw new CliError("state_corrupt", "Invalid memory archive", { cause: error });
		throw error;
	}
}
