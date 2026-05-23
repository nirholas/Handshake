// One-shot migration runner for the asset marketplace tables. The repo's
// older scripts/run-migrations.js targets a pg-style client that this project
// no longer exports, so this script speaks the Neon HTTP driver directly.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { neon } from '@neondatabase/serverless';
import 'dotenv/config';

const MIGRATION = resolve('migrations/20260523140000_create_asset_prices_and_purchases.sql');

const connStr = process.env.DATABASE_URL;
if (!connStr) {
	console.error('DATABASE_URL not set — load .env.local first or pass it inline.');
	process.exit(1);
}

const sql = neon(connStr);
const raw = readFileSync(MIGRATION, 'utf-8');

// Strip /* */ comments first, then split on `;` followed by newline. Statements
// in this migration don't embed semicolons inside string literals.
const cleaned = raw.replace(/--[^\n]*/g, '');
const statements = cleaned
	.split(/;\s*\n/)
	.map((s) => s.trim())
	.filter((s) => s.length);

console.log(`Found ${statements.length} statements.`);
for (const stmt of statements) {
	const preview = stmt.split('\n')[0].slice(0, 80);
	try {
		await sql(stmt);
		console.log(`✓ ${preview}…`);
	} catch (err) {
		// IF NOT EXISTS makes most of these idempotent; if it still fails, surface why.
		console.error(`✗ ${preview}…`);
		console.error('  ', err.message);
		process.exit(1);
	}
}

const [p] = await sql`SELECT to_regclass('public.asset_prices') AS t`;
const [u] = await sql`SELECT to_regclass('public.asset_purchases') AS t`;
const [r] = await sql`SELECT to_regclass('public.asset_purchase_receipts') AS t`;
console.log('asset_prices:', p.t, '| asset_purchases:', u.t, '| asset_purchase_receipts:', r.t);
