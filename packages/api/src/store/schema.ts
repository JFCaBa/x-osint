export const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  handle           TEXT PRIMARY KEY,
  display_name     TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  added_at         TEXT NOT NULL,
  last_fetched_at  TEXT,
  last_status      TEXT
);
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  handle      TEXT NOT NULL,
  text        TEXT NOT NULL,
  url         TEXT,
  media_url   TEXT,
  posted_at   TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_posted_at ON posts(posted_at);
CREATE INDEX IF NOT EXISTS idx_posts_handle    ON posts(handle);
CREATE TABLE IF NOT EXISTS exports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  exported_at   TEXT NOT NULL,
  covered_upto  TEXT,
  row_count     INTEGER NOT NULL
);
`;
