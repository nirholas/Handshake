#!/usr/bin/env node
// One-shot migration runner. Applies all .sql files in api/_lib/migrations/ in
// alphabetical order, tracking applied migrations in a schema_migrations table.

import { neon } from '@neondatabase/serverless';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const DB_URL = process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_GnQ0R4LJkZOg@ep-gentle-hill-akxaw862-pooler.c-3.us-west-2.aws.neon.tech/neondb?channel_binding=require&sslmode=require';

const sql = neon(DB_URL);

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dir, '../api/_lib/migrations');

async function main() {
  // Ensure tracking table exists.
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const applied = new Set(
    (await sql`SELECT filename FROM schema_migrations`).map(r => r.filename)
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort();

  const pending = files.filter(f => !applied.has(f));

  if (pending.length === 0) {
    console.log('DB is up to date — no pending migrations.');
    return;
  }

  console.log(`Found ${pending.length} pending migration(s):\n`);

  for (const file of pending) {
    const path = join(MIGRATIONS_DIR, file);
    const sqlText = await readFile(path, 'utf8');
    console.log(`  → applying ${file} ...`);
    try {
      // Neon HTTP client doesn't support multi-statement strings natively;
      // split on statement boundaries and execute each one.
      const statements = sqlText
        .split(/;(?=\s*(?:--|$|\n))/gm)  // split on ; followed by newline/comment/EOF
        .map(s => s.trim())
        .filter(Boolean);

      for (const stmt of statements) {
        if (stmt.replace(/--[^\n]*/g, '').trim()) {
          await sql.unsafe(stmt + ';');
        }
      }
      await sql`INSERT INTO schema_migrations (filename) VALUES (${file})`;
      console.log(`     ✓ done`);
    } catch (err) {
      console.error(`     ✗ FAILED: ${err.message}`);
      process.exit(1);
    }
  }

  console.log(`\nAll migrations applied.`);
}

main().catch(err => { console.error(err); process.exit(1); });
