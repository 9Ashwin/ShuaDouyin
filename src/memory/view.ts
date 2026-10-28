import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { withDatabase } from "../database.ts";
import { isMissing } from "../errors.ts";
import { memories } from "../schema.ts";
import { type Entry, LAYERS, nodeSlug } from "./concept.ts";
import { relations, resolveReferences } from "./graph.ts";

// Read-only surfaces: the generated overview plus health and usage counters.
// None of them rewrites memory content.

const OVERVIEW_LIMIT = 200;

// MEMORY.md is a navigation surface: numbering, relative link, short body.
export function renderOverview(entries: Entry[]): string {
	const navigation = [...entries]
		.sort(
			(left, right) =>
				right.row.updated_at.localeCompare(left.row.updated_at) || left.row.id.localeCompare(right.row.id),
		)
		.slice(0, OVERVIEW_LIMIT);
	const lines = ["# Memory", ""];
	if (!navigation.length) lines.push("暂无长期记忆。", "");
	else {
		lines.push(`共 ${entries.length} 条长期记忆，导航展示最近 ${navigation.length} 条。`, "");
		navigation.forEach(({ row }, index) => {
			const label = (row.title || row.subject || row.topic || row.id).replace(/[[\]\r\n]/g, " ").trim();
			const summary = row.body.replace(/\s+/g, " ").trim();
			const excerpt = summary.length > 400 ? `${summary.slice(0, 400)}...` : summary;
			lines.push(`${index + 1}. [${label}](${row.path}) ${excerpt}`);
		});
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

// The overview is stale whenever the files would render different bytes.
export async function overviewStale(root: string, entries: Entry[]): Promise<boolean> {
	try {
		return (await readFile(join(root, "MEMORY.md"), "utf8")) !== renderOverview(entries);
	} catch (error) {
		if (isMissing(error)) return true;
		throw error;
	}
}

export function graph(entries: Entry[]) {
	const nodes = entries
		.map(({ row }) => ({
			id: row.id,
			slug: nodeSlug(row.id, row.subject, row.topic),
			title: row.title,
			layer: row.layer,
			subject: row.subject,
			topic: row.topic,
			tags: row.tags,
			profile_ref: row.profile_ref,
			confidence: row.confidence,
			path: row.path,
		}))
		.sort((left, right) => left.slug.localeCompare(right.slug) || left.id.localeCompare(right.id));
	return { nodes, edges: relations(entries), unresolved: resolveReferences(entries).unresolved };
}

export async function status(
	base: string,
	bot: string,
	root: string,
	entries: Entry[],
	files: number,
): Promise<Record<string, unknown>> {
	const derived = relations(entries);
	const indexedRows = withDatabase(
		base,
		(db) =>
			db.select({ id: memories.id, revision: memories.revision }).from(memories).where(eq(memories.bot_id, bot)).all(),
		false,
	);
	const indexed = new Map(indexedRows.map((row) => [row.id, row.revision]));
	const indexStale = indexed.size !== entries.length || entries.some(({ row }) => indexed.get(row.id) !== row.revision);
	const schema = withDatabase(
		base,
		(_db, sqlite) =>
			(sqlite.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null })
				.version ?? 0,
		false,
	);
	return {
		bot,
		workspace: root,
		memory_files: files,
		memories: entries.length,
		edges: derived.length,
		indexed: indexed.size,
		index_stale: indexStale,
		overview_stale: await overviewStale(root, entries),
		schema_version: schema,
		layers: Object.fromEntries(
			LAYERS.map((layer) => [layer, entries.filter((entry) => entry.row.layer === layer).length]),
		),
	};
}

export function usage(bot: string, entries: Entry[]) {
	const total = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.row.body, "utf8"), 0);
	return {
		bot,
		count: entries.length,
		total_text_bytes: total,
		avg_text_bytes: entries.length ? Math.round(total / entries.length) : 0,
		profiles: new Set(entries.map((entry) => entry.row.profile_ref).filter(Boolean)).size,
		topics: new Set(entries.map((entry) => entry.row.topic).filter(Boolean)).size,
	};
}
