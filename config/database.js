const { Pool } = require('pg');
require('dotenv').config();

const logger = require('../utils/logger');

// Supabase gives two connection strings:
//   DATABASE_URL — Supavisor pooler (port 6543). Use this for the app.
//   DIRECT_URL   — direct (port 5432). Use this for migrations only; direct
//                  connections are capped low and migrations need session state.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  logger.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  // Supabase requires TLS. Its certificate chain is not in Node's default
  // trust store, hence rejectUnauthorized: false.
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  // The pooler is a shared resource — keep our slice modest.
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Don't let one wedged query hold a pooled connection forever.
  statement_timeout: 15_000,
});

// The old implementation called process.exit(-1) here, so a single transient
// idle-client error from a managed database killed the whole server.
pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle database client');
});

/** Run a single query. */
async function query(text, params) {
  const started = Date.now();
  const result = await pool.query(text, params);
  const ms = Date.now() - started;
  if (ms > 500) {
    logger.warn({ ms, text: text.slice(0, 120) }, 'Slow query');
  }
  return result;
}

/**
 * Run `fn` inside a transaction, with the client passed in.
 * Territory capture depends on this: the steal and every stats update must
 * commit or roll back together.
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Used by /api/health so a dead database fails the check instead of reporting healthy. */
async function healthCheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

module.exports = { pool, query, transaction, healthCheck };
