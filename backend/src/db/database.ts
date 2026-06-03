import knex, { Knex } from 'knex';
import path from 'path';
import fs from 'fs';

let db: Knex | null = null;

export function getDb(): Knex {
  if (db) return db;

  const dbPath = process.env.DATABASE_PATH || './data/iptv.db';
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = knex({
    client: 'sqlite3',
    connection: { filename: dbPath },
    useNullAsDefault: true,
  });

  return db;
}

// Simple synchronous-style query helper using raw knex
export function dbRun(sql: string, params: unknown[] = []): Promise<unknown> {
  return getDb().raw(sql, params);
}

export async function dbGet(sql: string, params: unknown[] = []): Promise<Record<string, unknown> | undefined> {
  const result = await getDb().raw(sql, params);
  return result[0] ?? undefined;
}

export async function dbAll(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const result = await getDb().raw(sql, params);
  return result;
}

export async function initDatabase(): Promise<Knex> {
  const database = getDb();

  await database.raw('PRAGMA foreign_keys = ON;');
  await database.raw('PRAGMA journal_mode = WAL;');

  await database.raw(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      api_key TEXT UNIQUE,
      subscription_status TEXT,
      subscription_id TEXT,
      subscription_period TEXT,
      subscription_expires_at TEXT,
      trial_expires_at TEXT,
      coupon_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await database.raw(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      key TEXT UNIQUE NOT NULL,
      name TEXT,
      is_active INTEGER DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await database.raw(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      logo TEXT,
      group_name TEXT,
      country TEXT,
      language TEXT,
      category TEXT,
      content_type TEXT DEFAULT 'live',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await database.raw(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      stripe_payment_intent_id TEXT,
      stripe_customer_id TEXT,
      amount INTEGER NOT NULL,
      currency TEXT DEFAULT 'usd',
      status TEXT,
      period TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await database.raw(`
    CREATE TABLE IF NOT EXISTS media_files (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      media_type TEXT DEFAULT 'music',
      title TEXT,
      artist TEXT,
      album TEXT,
      duration_sec REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await database.raw(`
    CREATE TABLE IF NOT EXISTS coupons (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      description TEXT,
      discount_type TEXT DEFAULT 'percentage',
      discount_value INTEGER NOT NULL,
      max_uses INTEGER,
      used_count INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT
    )
  `);

  await database.raw('CREATE INDEX IF NOT EXISTS idx_channels_user_id ON channels(user_id)');
  await database.raw('CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key)');
  await database.raw('CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)');
  await database.raw('CREATE INDEX IF NOT EXISTS idx_media_files_user_id ON media_files(user_id)');
  await database.raw('CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code)');

  console.log('Database initialized successfully');
  return database;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
  }
}
