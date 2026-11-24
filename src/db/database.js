import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

// Converte BIGINT (OID 20) do Postgres para Number JS (IDs do Telegram e centavos cabem com folga em Number.MAX_SAFE_INTEGER)
pg.types.setTypeParser(20, (val) => (val === null ? null : Number(val)));

const SQLITE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT NOT NULL DEFAULT 'Cliente',
  last_name TEXT,
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  total_deposited_cents INTEGER NOT NULL DEFAULT 0,
  total_spent_cents INTEGER NOT NULL DEFAULT 0,
  referred_by INTEGER,
  referral_earnings_cents INTEGER NOT NULL DEFAULT 0,
  referrals_count INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  emoji TEXT NOT NULL DEFAULT '📦',
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  warranty TEXT NOT NULL DEFAULT 'Garantia de acesso e suporte pós-venda',
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(telegram_id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  cashback_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  coupon_code TEXT,
  delivered_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS stock_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  credential TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'sold')),
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  sold_at TEXT
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(telegram_id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('syncpay_pix', 'mercadopago_pix', 'manual_pix')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  txid TEXT NOT NULL UNIQUE,
  provider_payment_id TEXT,
  pix_code TEXT NOT NULL,
  status_checks_count INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  target_product_id INTEGER,
  target_quantity INTEGER NOT NULL DEFAULT 1,
  target_coupon_code TEXT,
  proof_file_id TEXT,
  proof_type TEXT,
  proof_note TEXT,
  reviewed_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  expires_at TEXT,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(telegram_id),
  type TEXT NOT NULL CHECK (type IN ('deposit', 'purchase', 'admin_credit', 'admin_debit', 'coupon_credit', 'cashback', 'referral_bonus', 'refund')),
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  reference_id TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('balance', 'percent_discount')),
  value INTEGER NOT NULL CHECK (value > 0),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(telegram_id),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE (coupon_id, user_id)
);

CREATE TABLE IF NOT EXISTS stock_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE (product_id, user_id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(telegram_id),
  product_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id, is_active);
CREATE INDEX IF NOT EXISTS idx_stock_product_status ON stock_items(product_id, status, id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status, method);
CREATE INDEX IF NOT EXISTS idx_deposits_provider ON deposits(provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_prod ON stock_alerts(product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_created ON reviews(id DESC);
`;

const DEMO_CATEGORIES = [
  {
    name: 'Planos Gemini Pro & Ultra',
    emoji: '💎',
    description: 'Planos oficiais Gemini Pro e Gemini Ultra com liberação imediata no chat.',
    sortOrder: 1,
    products: [
      {
        name: 'Gemini Pro — Acesso 30 Dias',
        description:
          'Acesso completo ao plano Gemini Pro com recursos avançados de IA, janela de contexto expandida e entrega imediata.',
        warranty: '30 dias de garantia e suporte Gemini Hub',
        priceCents: 2990,
      },
      {
        name: 'Gemini Ultra — Acesso 30 Dias',
        description:
          'Plano máximo Gemini Ultra com performance de ponta, limites ampliados e prioridade máxima.',
        warranty: '30 dias de garantia total e suporte VIP',
        priceCents: 5990,
      },
    ],
  },
];

function toPgPlaceholders(sql) {
  let idx = 0;
  let inSingleQuote = false;
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && sql[i - 1] !== '\\') {
      inSingleQuote = !inSingleQuote;
      out += ch;
    } else if (ch === '?' && !inSingleQuote) {
      idx++;
      out += `$${idx}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function createSqliteAdapter(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec(SQLITE_SCHEMA_SQL);

  const makeRunner = () => ({
    async queryOne(sql, params = []) {
      return sqlite.prepare(sql).get(...params) || null;
    },
    async queryAll(sql, params = []) {
      return sqlite.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      const res = sqlite.prepare(sql).run(...params);
      return {
        changes: Number(res.changes || 0),
        lastInsertRowid: res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : null,
      };
    },
    async insertReturningId(sql, params = []) {
      const res = sqlite.prepare(sql).run(...params);
      return Number(res.lastInsertRowid);
    },
  });

  const base = makeRunner();
  return {
    dialect: 'sqlite',
    ...base,
    async transaction(fn) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(base);
        sqlite.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          sqlite.exec('ROLLBACK');
        } catch {
          // ignore
        }
        throw err;
      }
    },
    async close() {
      sqlite.close();
    },
  };
}

function createPostgresAdapter(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  const makeRunner = (executor) => ({
    async queryOne(sql, params = []) {
      const res = await executor.query(toPgPlaceholders(sql), params);
      return res.rows[0] || null;
    },
    async queryAll(sql, params = []) {
      const res = await executor.query(toPgPlaceholders(sql), params);
      return res.rows;
    },
    async run(sql, params = []) {
      const res = await executor.query(toPgPlaceholders(sql), params);
      return {
        changes: Number(res.rowCount || 0),
        lastInsertRowid: res.rows?.[0]?.id !== undefined ? Number(res.rows[0].id) : null,
      };
    },
    async insertReturningId(sql, params = []) {
      const pgSql = /\bRETURNING\b/i.test(sql) ? sql : `${sql.trim()} RETURNING id`;
      const res = await executor.query(toPgPlaceholders(pgSql), params);
      return Number(res.rows[0].id);
    },
  });

  const base = makeRunner(pool);
  return {
    dialect: 'postgres',
    ...base,
    async transaction(fn) {
      const client = await pool.connect();
      const txRunner = makeRunner(client);
      try {
        await client.query('BEGIN');
        const result = await fn(txRunner);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function seedInitialCatalog(db) {
  const existing = await db.queryOne('SELECT COUNT(*) AS total FROM categories');
  if (existing && Number(existing.total) > 0) {
    return;
  }

  await db.transaction(async (tx) => {
    const checkAgain = await tx.queryOne('SELECT COUNT(*) AS total FROM categories');
    if (checkAgain && Number(checkAgain.total) > 0) return;

    for (const cat of DEMO_CATEGORIES) {
      const categoryId = await tx.insertReturningId(
        'INSERT INTO categories (name, emoji, description, sort_order) VALUES (?, ?, ?, ?)',
        [cat.name, cat.emoji, cat.description, cat.sortOrder]
      );
      for (const prod of cat.products) {
        await tx.run(
          'INSERT INTO products (category_id, name, description, warranty, price_cents) VALUES (?, ?, ?, ?, ?)',
          [categoryId, prod.name, prod.description, prod.warranty, prod.priceCents]
        );
      }
    }
  });
}

export async function initDatabase(pathOrOptions = ':memory:', maybeOpts = {}) {
  let databaseUrl = '';
  let dbPath = ':memory:';
  let seedDemoData = false;

  if (typeof pathOrOptions === 'string') {
    dbPath = pathOrOptions;
    seedDemoData = Boolean(maybeOpts.seedDemoData);
    databaseUrl = maybeOpts.databaseUrl || '';
  } else if (pathOrOptions && typeof pathOrOptions === 'object') {
    databaseUrl = pathOrOptions.databaseUrl || '';
    dbPath = pathOrOptions.dbPath || ':memory:';
    seedDemoData = Boolean(pathOrOptions.seedDemoData);
  }

  const db = databaseUrl ? createPostgresAdapter(databaseUrl) : createSqliteAdapter(dbPath);

  if (databaseUrl) {
    // Valida conexão no Postgres (Supabase) antes de prosseguir
    await db.queryOne('SELECT 1 AS ok');
  }

  if (seedDemoData) {
    await seedInitialCatalog(db);
  }

  return db;
}
