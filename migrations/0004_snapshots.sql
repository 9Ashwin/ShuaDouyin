-- Snapshots of a document before a derived rewrite.
--
-- The revisions table keys a document by the hash of its content, which answers
-- "have I seen these exact bytes" but not "which version is this, in order".
-- A persona that rewrites itself needs the second question: a version number
-- that only ever increases, so a rollback can name a specific past state and a
-- rejected candidate can never reuse its number.
CREATE TABLE IF NOT EXISTS snapshots (
	bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
	resource TEXT NOT NULL,
	version INTEGER NOT NULL,
	revision TEXT NOT NULL,
	content TEXT NOT NULL,
	at TEXT NOT NULL,
	PRIMARY KEY (bot_id, resource, version)
);
CREATE INDEX IF NOT EXISTS snapshots_resource ON snapshots(bot_id, resource, version DESC);
