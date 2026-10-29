import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { CliError } from "./errors.ts";
import * as schema from "./schema.ts";

export type WorkspaceDB = BetterSQLite3Database<typeof schema>;

// Ordered migration file names; index + 1 is the schema version they produce.
const MIGRATIONS = ["0001_workspace.sql", "0002_memory_concepts.sql", "0003_bot_preset.sql", "0004_snapshots.sql"];

// Connections are invocation-local; native handles are always closed, including on Windows.
export function withDatabase<T>(
	base: string,
	run: (db: WorkspaceDB, sqlite: Database.Database) => T,
	create = true,
): T {
	const path = join(base, "state.sqlite");
	if (!create && !existsSync(path))
		throw new CliError("not_found", "No bots have been created", {
			hint: "Run dy bot create <id> --account <account>.",
		});
	mkdirSync(base, { recursive: true, mode: 0o700 });
	const sqlite = new Database(path, { timeout: 5000 });
	try {
		chmodSync(path, 0o600);
		sqlite.pragma("foreign_keys = ON");
		sqlite.pragma("journal_mode = WAL");
		sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)");
		sqlite.transaction(() => {
			const current = sqlite.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
				version: number | null;
			};
			let version = current.version ?? 0;
			if (version > MIGRATIONS.length) throw new CliError("state_corrupt", "Database schema is newer than this CLI");
			while (version < MIGRATIONS.length) {
				const next = version + 1;
				sqlite.exec(readFileSync(new URL(`../migrations/${MIGRATIONS[version]}`, import.meta.url), "utf8"));
				sqlite.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(next);
				version = next;
			}
		})();
		return run(drizzle(sqlite, { schema }), sqlite);
	} finally {
		sqlite.close();
	}
}
