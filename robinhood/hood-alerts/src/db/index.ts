import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = Database.Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('telegram', 'discord', 'console', 'x')),
  chat_id TEXT NOT NULL,
  title TEXT,
  digest INTEGER NOT NULL DEFAULT 0,
  digest_interval_s INTEGER NOT NULL DEFAULT 3600,
  quiet_start INTEGER,
  quiet_end INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (platform, chat_id)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  threshold REAL,
  created_at INTEGER NOT NULL,
  UNIQUE (subscriber_id, topic)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_topic ON subscriptions(topic);
CREATE TABLE IF NOT EXISTS entitlements (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'premium',
  activated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  payment_tx TEXT,
  payer TEXT,
  UNIQUE (platform, chat_id)
);
CREATE TABLE IF NOT EXISTS dedup (
  fingerprint TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dedup_expires ON dedup(expires_at);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY,
  subscriber_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  delivered_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_subscriber ON deliveries(subscriber_id, delivered_at);
`

/** Open (and migrate) the SQLite database. `:memory:` works for tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
