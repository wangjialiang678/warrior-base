import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function openDatabase(dataDir, filename = 'warrior-base.sqlite') {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(dataDir, filename))
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  migrate(db)
  return db
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      nickname TEXT NOT NULL,
      phone_hash TEXT,
      phone_last4 TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
      avatar_id TEXT,
      pending_nickname TEXT,
      pending_avatar_id TEXT,
      profile_moderation_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      disk_path TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS works (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lesson INTEGER NOT NULL CHECK (lesson BETWEEN 1 AND 3),
      status TEXT NOT NULL CHECK (status IN ('published','pending','rejected','draft','hidden')),
      approved_version_id TEXT,
      current_version_id TEXT NOT NULL,
      pending_version_id TEXT,
      moderation_reason TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, lesson)
    );
    CREATE TABLE IF NOT EXISTS work_versions (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      nickname TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      url TEXT NOT NULL,
      cover_id TEXT REFERENCES uploads(id),
      decision TEXT NOT NULL CHECK (decision IN ('draft','pending','allow','reject','review')),
      moderation_reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS work_versions_work ON work_versions(work_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS likes (
      work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(work_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      reason TEXT NOT NULL CHECK (reason IN ('link','content')),
      detail TEXT NOT NULL,
      reporter_ip_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reports_work ON reports(work_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS login_failures (
      username_key TEXT PRIMARY KEY,
      window_started_at INTEGER NOT NULL,
      failures INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS moderation_user_usage (
      day TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requests INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, user_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      official_account_name TEXT NOT NULL DEFAULT '',
      official_qr_id TEXT REFERENCES uploads(id),
      group_name TEXT NOT NULL DEFAULT '',
      group_qr_id TEXT REFERENCES uploads(id),
      group_expires_at TEXT,
      group_enabled INTEGER NOT NULL DEFAULT 0,
      announcement TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `)
  ensureColumn(db, 'users', 'profile_revision', 'INTEGER NOT NULL DEFAULT 0')
  db.prepare(`INSERT OR IGNORE INTO settings(singleton, updated_at) VALUES(1, ?)`).run(new Date().toISOString())
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

export function resolveDataDir(value) {
  return value || join(process.cwd(), 'data')
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
