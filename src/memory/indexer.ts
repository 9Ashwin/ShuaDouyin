import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { withDatabase } from "../database.ts";
import { CliError, isMissing } from "../errors.ts";
import { edges, memories, revisions } from "../schema.ts";
import { decode, type Entry, LAYERS } from "./concept.ts";
import { relations } from "./graph.ts";

// Filesystem scan and SQLite projection. Markdown stays authoritative; the
// index is always rebuildable, while revision archives are durable state.

export interface Scan {
	entries: Entry[];
	failed: { file: string; reason: string }[];
}

// Parse every source before replacing the index. A malformed file never clears valid entries.
export function strictScan(scan: Scan): Entry[] {
	if (scan.failed.length) throw new CliError("state_corrupt", `Memory file is malformed: ${scan.failed[0].file}`);
	return scan.entries;
}

// Reads every layer and reports unreadable files instead of stopping, so a
// caller can show what is broken while keeping valid entries usable.
export async function scan(bot: string, root: string): Promise<Scan> {
	const entries: Entry[] = [];
	const failed: { file: string; reason: string }[] = [];
	const ids = new Map<string, string>();
	for (const layer of LAYERS) {
		const directory = join(root, "memory", layer);
		let names: string[];
		try {
			const info = await lstat(directory);
			if (!info.isDirectory() || info.isSymbolicLink())
				throw new CliError("state_corrupt", "Memory layers must be regular directories");
			names = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
		} catch (error) {
			if (isMissing(error)) continue;
			if (error instanceof CliError) {
				failed.push({ file: `memory/${layer}`, reason: error.code });
				continue;
			}
			throw error;
		}
		for (const file of names) {
			const relative = `memory/${layer}/${file}`;
			try {
				const path = join(directory, file);
				const info = await lstat(path);
				if (!info.isFile() || info.isSymbolicLink() || info.size > 262144)
					throw new CliError("state_corrupt", `Memory must be a bounded regular file: ${file}`);
				const entry = decode(bot, relative, await readFile(path, "utf8"));
				const duplicate = ids.get(entry.row.id);
				if (duplicate) throw new CliError("state_corrupt", `Two memory files contain the same ID: ${duplicate}`);
				ids.set(entry.row.id, relative);
				entries.push(entry);
			} catch (error) {
				if (!(error instanceof CliError)) throw error;
				failed.push({ file: relative, reason: error.code });
			}
		}
	}
	const active: Entry[] = [];
	for (const entry of entries) {
		try {
			await lstat(join(root, "memory", "superseded", `${entry.row.id}.json`));
			failed.push({ file: entry.row.path, reason: "state_corrupt" });
		} catch (error) {
			if (!isMissing(error)) throw error;
			active.push(entry);
		}
	}
	return { entries: active, failed };
}

export function writeIndex(base: string, bot: string, entries: Entry[]): void {
	const derived = relations(entries);
	withDatabase(base, (db, sqlite) =>
		db.transaction((tx) => {
			tx.delete(edges).where(eq(edges.bot_id, bot)).run();
			tx.delete(memories).where(eq(memories.bot_id, bot)).run();
			sqlite.prepare("DELETE FROM memory_fts WHERE bot_id = ?").run(bot);
			const insert = sqlite.prepare("INSERT INTO memory_fts(id,bot_id,body,subject,topic) VALUES(?,?,?,?,?)");
			for (const { row, content } of entries) {
				tx.insert(memories).values(row).run();
				insert.run(row.id, bot, `${row.title}\n${row.tags.join(" ")}\n${row.body}`, row.subject, row.topic);
				tx.insert(revisions)
					.values({ bot_id: bot, resource: row.id, revision: row.revision, content, at: row.updated_at })
					.onConflictDoNothing()
					.run();
			}
			for (const edge of derived)
				tx.insert(edges)
					.values({ bot_id: bot, ...edge })
					.onConflictDoNothing()
					.run();
		}),
	);
}
