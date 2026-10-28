CREATE TABLE bots (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  account TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE memory_nodes (
  id TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  layer TEXT NOT NULL,
  subject TEXT NOT NULL,
  topic TEXT NOT NULL,
  certainty TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  sources TEXT NOT NULL,
  links TEXT NOT NULL,
  body TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bot_id,id)
);
CREATE UNIQUE INDEX memory_path ON memory_nodes(bot_id,path);
CREATE INDEX memory_layer ON memory_nodes(bot_id,layer);
CREATE TABLE memory_edges (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY(bot_id,source_id,target_id,relation)
);
CREATE TABLE revisions (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  revision TEXT NOT NULL,
  content TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY(bot_id,resource,revision)
);
CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED,bot_id UNINDEXED,body,subject,topic,tokenize='trigram');
