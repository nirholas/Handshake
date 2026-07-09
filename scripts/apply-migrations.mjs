#!/usr/bin/env node
/**
 * Migrations runner for api/_lib/migrations/*.sql.
 *
 * Designed to be SAFE BY DEFAULT: dry-run unless --apply is passed.
 *
 * Usage:
 *   node scripts/apply-migrations.mjs                  # list pending, no DB writes
 *   node scripts/apply-migrations.mjs --check          # like the dry run, but exit 4 if anything is pending (deploy gate)
 *   node scripts/apply-migrations.mjs --apply          # apply pending migrations
 *   node scripts/apply-migrations.mjs --apply --file 2026-04-29-onchain-unified.sql
 *
 * Tracking: each applied migration is recorded in `schema_migrations`
 * (filename + sha256 + applied_at). Re-running is a no-op for already-applied
 * files (and refuses if the file's hash drifted since application).
 *
 * Auth: reads DATABASE_URL from env. No interactive prompts.
 */

import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { neon, Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
neonConfig.webSocketConstructor = ws;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const MIG_DIR = path.resolve(REPO_ROOT, 'api', '_lib', 'migrations');

// Load .env.local if present (same pattern as seed-skills.js)
for (const envFile of ['.env.local', '.env']) {
	try {
		const raw = readFileSync(path.resolve(REPO_ROOT, envFile), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
			if (!m || process.env[m[1]]) continue;
			let val = m[2].trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			process.env[m[1]] = val;
		}
		break;
	} catch { /* file not present */ }
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CHECK = args.includes('--check');
const fileArgIdx = args.indexOf('--file');
const ONLY = fileArgIdx >= 0 ? args[fileArgIdx + 1] : null;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL is not set. Add it to .env.local or export it in your shell.');
	process.exit(2);
}

const sql = neon(process.env.DATABASE_URL);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function ensureTrackingTable() {
	await sql`
		create table if not exists schema_migrations (
			filename     text primary key,
			sha256       text not null,
			applied_at   timestamptz not null default now()
		)
	`;
}

async function listPending() {
	const all = (await readdir(MIG_DIR)).filter((f) => f.endsWith('.sql')).sort();
	const applied = await sql`select filename, sha256 from schema_migrations`;
	const appliedMap = new Map(applied.map((r) => [r.filename, r.sha256]));

	const out = [];
	for (const fname of all) {
		if (ONLY && fname !== ONLY) continue;
		const body = await readFile(path.join(MIG_DIR, fname), 'utf-8');
		const hash = createHash('sha256').update(body).digest('hex');
		const prior = appliedMap.get(fname);
		out.push({
			fname,
			body,
			hash,
			status: !prior ? 'pending' : prior === hash ? 'applied' : 'drift',
		});
	}
	return out;
}

async function applyOne({ fname, body, hash }) {
	process.stdout.write(`→ applying ${fname} … `);
	// Run the whole file in one round trip via the websocket `Pool`. The Neon HTTP
	// driver is single-statement only, but `pg`'s simple-query protocol (what
	// Pool.query uses for a text-only call) executes a multi-statement string —
	// and, crucially, parses `DO $$ … $$` / dollar-quoted bodies correctly, so
	// migrations may contain procedural blocks and embedded semicolons without any
	// client-side `;` splitting.
	//
	// Transaction semantics (Postgres simple query): a string with two or more
	// commands and no explicit BEGIN/COMMIT runs in one implicit transaction —
	// any failure rolls the whole file back, so a half-applied file can't poison
	// the schema_migrations ledger below. A single-command file autocommits. A
	// file with its own BEGIN/COMMIT manages its own transaction.
	//
	// Footgun for migration authors: CREATE INDEX CONCURRENTLY cannot run inside
	// a transaction, so it must be the *only* command in its file (then it
	// autocommits). Pairing it with any other statement wraps it in the implicit
	// transaction and Postgres rejects it.
	await pool.query(body);
	await sql`
		insert into schema_migrations (filename, sha256)
		values (${fname}, ${hash})
		on conflict (filename) do update set sha256 = excluded.sha256, applied_at = now()
	`;
	console.log('ok');
}

async function main() {
	await ensureTrackingTable();
	const items = await listPending();

	if (!items.length) {
		console.log('No migration files found in', MIG_DIR);
		return;
	}

	const pending = items.filter((i) => i.status === 'pending');
	const drift = items.filter((i) => i.status === 'drift');

	console.log('Migration status:');
	for (const i of items) {
		console.log(`  [${i.status.padEnd(7)}] ${i.fname}`);
	}

	if (drift.length) {
		console.error(
			`\nERROR: ${drift.length} migration(s) have drifted (file changed after apply):`,
		);
		for (const d of drift) console.error(`  - ${d.fname}`);
		console.error('Refusing to proceed. Roll forward with a new migration instead.');
		process.exit(3);
	}

	if (!pending.length) {
		console.log('\nAll migrations already applied.');
		return;
	}

	if (CHECK) {
		console.error(
			`\nERROR: ${pending.length} migration(s) pending — the database is behind the code.`,
		);
		console.error('Run `npm run db:migrate` before deploying.');
		process.exit(4);
	}

	if (!APPLY) {
		console.log(
			`\n${pending.length} pending. Re-run with --apply to execute against ${maskUrl(process.env.DATABASE_URL)}.`,
		);
		return;
	}

	console.log(
		`\nApplying ${pending.length} migration(s) to ${maskUrl(process.env.DATABASE_URL)} …`,
	);
	for (const i of pending) await applyOne(i);
	console.log('Done.');
}

function maskUrl(url) {
	try {
		const u = new URL(url);
		if (u.password) u.password = '***';
		return u.toString();
	} catch {
		return '<DATABASE_URL>';
	}
}

main()
	.catch((e) => {
		console.error('FAILED:', e.message);
		process.exitCode = 1;
	})
	.finally(() => pool.end());
