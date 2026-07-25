-- Migration 0001: Create entries table
-- Stores all key-value entries (cookies, discord tokens, config)

CREATE TABLE IF NOT EXISTS entries (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Index for prefix-based listing (cookies: *_cookie_*, discord tokens: discord_token_*)
CREATE INDEX IF NOT EXISTS idx_entries_key_prefix ON entries(key);