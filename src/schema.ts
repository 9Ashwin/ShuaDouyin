import { integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const bots = sqliteTable("bots", {
	id: text().primaryKey(),
	name: text().notNull(),
	account: text().notNull(),
	preset: text(),
	created_at: text().notNull(),
});

export const memories = sqliteTable(
	"memory_nodes",
	{
		id: text().notNull(),
		bot_id: text()
			.notNull()
			.references(() => bots.id, { onDelete: "cascade" }),
		path: text().notNull(),
		type: text().notNull().default("memory"),
		title: text().notNull().default(""),
		layer: text().notNull(),
		subject: text().notNull(),
		topic: text().notNull(),
		tags: text({ mode: "json" }).$type<string[]>().notNull(),
		profile_ref: text().notNull().default(""),
		certainty: text().notNull(),
		confidence: real().notNull(),
		sources: text({ mode: "json" }).$type<string[]>().notNull(),
		links: text({ mode: "json" }).$type<string[]>().notNull(),
		body: text().notNull(),
		revision: text().notNull(),
		created_at: text().notNull(),
		updated_at: text().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.bot_id, table.id] }),
		uniqueIndex("memory_path").on(table.bot_id, table.path),
	],
);

export const edges = sqliteTable(
	"memory_edges",
	{
		bot_id: text()
			.notNull()
			.references(() => bots.id, { onDelete: "cascade" }),
		source_id: text().notNull(),
		target_id: text().notNull(),
		relation: text().notNull(),
		weight: real().notNull().default(1),
	},
	(table) => [primaryKey({ columns: [table.bot_id, table.source_id, table.target_id, table.relation] })],
);

export const revisions = sqliteTable(
	"revisions",
	{
		bot_id: text()
			.notNull()
			.references(() => bots.id, { onDelete: "cascade" }),
		resource: text().notNull(),
		revision: text().notNull(),
		content: text().notNull(),
		at: text().notNull(),
	},
	(table) => [primaryKey({ columns: [table.bot_id, table.resource, table.revision] })],
);

// A versioned snapshot of a document a derived rewrite is about to replace.
// Versions only increase, so a rejected attempt cannot reuse a number.
export const snapshots = sqliteTable(
	"snapshots",
	{
		bot_id: text()
			.notNull()
			.references(() => bots.id, { onDelete: "cascade" }),
		resource: text().notNull(),
		version: integer().notNull(),
		revision: text().notNull(),
		content: text().notNull(),
		at: text().notNull(),
	},
	(table) => [primaryKey({ columns: [table.bot_id, table.resource, table.version] })],
);

export const migrations = sqliteTable("schema_migrations", {
	version: integer().primaryKey(),
});
