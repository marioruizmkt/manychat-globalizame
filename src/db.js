import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    external_id TEXT NOT NULL,
    name TEXT,
    username TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    fields TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT '{}',
    paused INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_inbound_at INTEGER,
    last_activity_at INTEGER,
    UNIQUE (channel, external_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    direction TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    text TEXT,
    meta TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_contact ON messages (contact_id, id);

  CREATE TABLE IF NOT EXISTS flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    steps TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS triggers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    name TEXT,
    channels TEXT NOT NULL DEFAULT '[]',
    match_type TEXT NOT NULL DEFAULT 'contains',
    keywords TEXT NOT NULL DEFAULT '[]',
    post_id TEXT,
    public_replies TEXT NOT NULL DEFAULT '[]',
    cooldown_hours REAL NOT NULL DEFAULT 24,
    flow_id INTEGER REFERENCES flows(id) ON DELETE CASCADE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    flow_id INTEGER NOT NULL,
    step_index INTEGER NOT NULL,
    run_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS processed_events (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
`);

const JSON_COLUMNS = ['tags', 'fields', 'state', 'steps', 'channels', 'keywords', 'public_replies', 'meta'];

export function parseRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const key of JSON_COLUMNS) {
    if (typeof out[key] === 'string') {
      try {
        out[key] = JSON.parse(out[key]);
      } catch {
        // valor no JSON: se deja tal cual
      }
    }
  }
  return out;
}

export const now = () => Date.now();

/** Devuelve true la primera vez que se ve un id (Meta reintenta webhooks). */
export function markProcessed(id) {
  if (!id) return true;
  const res = db.prepare('INSERT OR IGNORE INTO processed_events (id, created_at) VALUES (?, ?)').run(id, now());
  return res.changes > 0;
}

export function pruneProcessed(maxAgeMs = 7 * 24 * 3600 * 1000) {
  db.prepare('DELETE FROM processed_events WHERE created_at < ?').run(now() - maxAgeMs);
}
