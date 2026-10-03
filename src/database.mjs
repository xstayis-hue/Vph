import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createDatabase(databasePath) {
  const resolvedPath = databasePath === ':memory:' ? databasePath : resolve(databasePath);
  if (resolvedPath !== ':memory:') mkdirSync(dirname(resolvedPath), { recursive: true });
  const db = new DatabaseSync(resolvedPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      vpn_username TEXT NOT NULL UNIQUE,
      subscription_url TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crypto_customers (
      account_id TEXT PRIMARY KEY,
      vpn_username TEXT NOT NULL UNIQUE,
      session_token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('stars', 'crypto')),
      account_id TEXT NOT NULL,
      telegram_user_id TEXT,
      vpn_username TEXT NOT NULL,
      plan_days INTEGER NOT NULL CHECK (plan_days IN (30, 90, 180)),
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      provider_invoice_id TEXT UNIQUE,
      provider_charge_id TEXT UNIQUE,
      invoice_payload TEXT UNIQUE,
      checkout_url TEXT,
      terms_version TEXT NOT NULL,
      terms_accepted_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'paid', 'provisioning', 'provisioning_failed',
        'fulfilled', 'expired', 'failed'
      )),
      target_expires_at INTEGER,
      subscription_url TEXT,
      created_at INTEGER NOT NULL,
      paid_at INTEGER,
      error_code TEXT
    );

    CREATE TABLE IF NOT EXISTS telegram_updates (
      update_id INTEGER PRIMARY KEY,
      received_at INTEGER NOT NULL
    );
  `);

  const orderColumns = new Set(db.prepare('PRAGMA table_info(orders)').all().map((column) => column.name));
  if (!orderColumns.has('terms_version')) {
    db.exec("ALTER TABLE orders ADD COLUMN terms_version TEXT NOT NULL DEFAULT ''");
  }
  if (!orderColumns.has('terms_accepted_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN terms_accepted_at INTEGER NOT NULL DEFAULT 0');
  }

  return db;
}
