CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
 id TEXT PRIMARY KEY,
 payload TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 available_at INTEGER NOT NULL,
 lease_until INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_pending ON events(status, available_at);
CREATE TABLE IF NOT EXISTS workflows (
 comment_id TEXT PRIMARY KEY,
 sender_id TEXT,
 media_id TEXT NOT NULL,
 resource_url TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'awaiting',
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workflows_sender ON workflows(sender_id, status, created_at);
CREATE TABLE IF NOT EXISTS actions (
 id TEXT PRIMARY KEY,
 status TEXT NOT NULL DEFAULT 'pending',
 response TEXT,
 updated_at INTEGER NOT NULL,
 error TEXT
);
CREATE TABLE IF NOT EXISTS imported_comments (
 comment_id TEXT PRIMARY KEY,
 dm_sent INTEGER NOT NULL,
 public_reply_sent INTEGER NOT NULL
);
