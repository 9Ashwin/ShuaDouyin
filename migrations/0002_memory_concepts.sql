ALTER TABLE memory_nodes ADD COLUMN type TEXT NOT NULL DEFAULT 'memory';
ALTER TABLE memory_nodes ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE memory_nodes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memory_nodes ADD COLUMN profile_ref TEXT NOT NULL DEFAULT '';
CREATE INDEX memory_profile_ref ON memory_nodes(bot_id,profile_ref);
CREATE INDEX memory_topic ON memory_nodes(bot_id,topic);
CREATE INDEX memory_created_day ON memory_nodes(bot_id,substr(created_at,1,10));
CREATE TABLE memory_edges_v2 (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY(bot_id,source_id,target_id,relation)
);
INSERT INTO memory_edges_v2(bot_id,source_id,target_id,relation,weight)
  SELECT bot_id,source_id,target_id,relation,1.0 FROM memory_edges;
DROP TABLE memory_edges;
ALTER TABLE memory_edges_v2 RENAME TO memory_edges;
CREATE INDEX memory_edges_target ON memory_edges(bot_id,target_id,relation);
