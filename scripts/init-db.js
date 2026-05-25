#!/usr/bin/env node
/**
 * Apply schema.sql then functions.sql, idempotently.
 *
 * Uses DIRECT_URL (port 5432), not the pooler: CREATE EXTENSION, CREATE
 * TRIGGER on auth.users and multi-statement DDL need a real session.
 *
 *   npm run init-db
 *
 * Replaces the old setup-db.js, which ran DROP DATABASE — meaningless against
 * a managed database and destructive everywhere else.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DIRECT_URL (or DATABASE_URL) is not set. Copy .env.example to .env first.');
  process.exit(1);
}

if (process.env.DIRECT_URL && /:6543\//.test(process.env.DIRECT_URL)) {
  console.warn(
    'Warning: DIRECT_URL points at port 6543 (the pooler). Migrations need the\n' +
    '         direct connection on port 5432 or CREATE EXTENSION may fail.'
  );
}

const files = ['schema.sql', 'functions.sql'];

(async () => {
  const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
  const client = new Client({
    connectionString,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    console.log('Connected.');

    for (const file of files) {
      const full = path.join(__dirname, '..', 'config', file);
      const sql = fs.readFileSync(full, 'utf8');
      process.stdout.write(`Applying ${file} ... `);
      await client.query(sql);
      console.log('ok');
    }

    const { rows } = await client.query('SELECT postgis_version() AS v');
    console.log(`PostGIS ${rows[0].v}`);

    const { rows: tables } = await client.query(
      `SELECT tablename, rowsecurity
         FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename`
    );
    console.log('\nTables:');
    for (const t of tables) {
      console.log(`  ${t.tablename.padEnd(22)} RLS ${t.rowsecurity ? 'on' : 'OFF'}`);
    }

    const unprotected = tables.filter((t) => !t.rowsecurity);
    if (unprotected.length) {
      console.warn(
        `\nWarning: RLS is off for: ${unprotected.map((t) => t.tablename).join(', ')}`
      );
    }

    console.log('\nSchema applied successfully.');
  } catch (err) {
    console.error('\nFailed:', err.message);
    if (/postgis/i.test(err.message)) {
      console.error(
        'Enable the PostGIS extension first:\n' +
        '  Supabase dashboard -> Database -> Extensions -> search "postgis" -> enable'
      );
    }
    if (/auth\.users/i.test(err.message)) {
      console.error(
        'The auth.users table is missing. This schema targets a Supabase project;\n' +
        'against plain Postgres you would need to create an auth schema yourself.'
      );
    }
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
