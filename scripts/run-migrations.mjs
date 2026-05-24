#!/usr/bin/env node
// One-shot migration runner. Applies all .sql files in api/_lib/migrations/ in
// alphabetical order, tracking applied migrations in a schema_migrations table.

import { neon } from '@neondatabase/serverless';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('DATABASE_URL env var is required.');
	process.exit(1);
}

const sql = neon(DB_URL);

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const CHECK = args.has('--check');

// Split SQL text into individual statements, respecting dollar-quoted blocks
// and single-line (--) comments.
function splitSql(text) {
  const stmts = [];
  let current = '';
  let inDollarQuote = null;
  let i = 0;
  while (i < text.length) {
    if (inDollarQuote === null) {
      // Skip single-line comments (copy them verbatim up to the newline).
      if (text[i] === '-' && text[i + 1] === '-') {
        const end = text.indexOf('\n', i);
        const line = end === -1 ? text.slice(i) : text.slice(i, end + 1);
        current += line;
        i += line.length;
        continue;
      }
      // Detect dollar-quote opening tag.
      const dollarMatch = text.slice(i).match(/^(\$[^$]*\$)/);
      if (dollarMatch) {
        inDollarQuote = dollarMatch[1];
        current += inDollarQuote;
        i += inDollarQuote.length;
        continue;
      }
      if (text[i] === ';') {
        const stmt = current.trim();
        if (stmt) stmts.push(stmt + ';');
        current = '';
        i++;
        continue;
      }
    } else {
      if (text.slice(i).startsWith(inDollarQuote)) {
        current += inDollarQuote;
        i += inDollarQuote.length;
        inDollarQuote = null;
        continue;
      }
    }
    current += text[i++];
  }
  const last = current.trim();
  if (last) stmts.push(last);
  return stmts;
}

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
      // Split on semicolons that are not inside dollar-quoted blocks ($$...$$).
      const statements = splitSql(sqlText);

      for (const stmt of statements) {
        const body = stmt.replace(/--[^\n]*/g, '').trim();
        if (body) {
          await sql(stmt);
        }
      }
      const sha256 = createHash('sha256').update(sqlText).digest('hex');
      await sql`INSERT INTO schema_migrations (filename, sha256) VALUES (${file}, ${sha256})`;
      console.log(`     ✓ done`);
    } catch (err) {
      console.error(`     ✗ FAILED: ${err.message}`);
      process.exit(1);
    }
  }

  console.log(`\nAll migrations applied.`);
}

main().catch(err => { console.error(err); process.exit(1); });
