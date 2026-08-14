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
 *   node scripts/apply-migrations.mjs --restamp --file <drifted file>  # comment-only edit, see below
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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { neon, Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
neonConfig.webSocketConstructor = ws;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const MIG_DIR = path.resolve(REPO_ROOT, 'api', '_lib', 'migrations');

// Load .env.local then .env; first definition wins, so .env.local overrides
// .env without shadowing keys it doesn't define (a sparse .env.local used to
// stop .env from being read at all, which broke db:check in deploy worktrees).
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
	} catch { /* file not present */ }
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CHECK = args.includes('--check');
const RESTAMP = args.includes('--restamp');
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
			prior,
			status: !prior ? 'pending' : prior === hash ? 'applied' : 'drift',
		});
	}
	return out;
}

// Everything in a migration except its whole-line comments: the part a drift
// check is actually protecting. Only leading `--` lines are dropped, never a
// trailing comment, because `--` can live inside a string literal and stripping
// it there would let a real statement change pass as "comments only".
function schemaBytes(body) {
	return body
		.split('\n')
		.filter((l) => !/^\s*--/.test(l))
		.map((l) => l.trimEnd())
		.filter((l) => l.trim() !== '')
		.join('\n');
}

// The exact bytes that were applied, recovered from git by hash. The ledger
// stores only a sha256, so the file's own history is the one place the applied
// text still exists. Returns null when no committed version matches, which is
// the honest answer for a file edited before it was ever committed.
function appliedBytesFromGit(fname, sha256) {
	const rel = path.posix.join('api/_lib/migrations', fname);
	let commits;
	try {
		commits = execFileSync('git', ['log', '--format=%H', '--', rel], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			maxBuffer: 32 * 1024 * 1024,
		})
			.split('\n')
			.filter(Boolean);
	} catch {
		return null;
	}
	for (const commit of commits) {
		let body;
		try {
			body = execFileSync('git', ['show', `${commit}:${rel}`], {
				cwd: REPO_ROOT,
				encoding: 'utf8',
				maxBuffer: 32 * 1024 * 1024,
			});
		} catch {
			continue;
		}
		if (createHash('sha256').update(body).digest('hex') === sha256) return { body, commit };
	}
	return null;
}

// Accept a comment-only edit to an already-applied migration by re-recording its
// hash, instead of demanding the prose be reverted.
//
// Drift exists to catch a schema change smuggled into a file Postgres already
// ran. A reworded comment is not that, and the repo has rules that force such
// edits (the banned-dash rule rewrote one applied migration's header), so
// "restore the applied bytes" and "obey the style rules" were a standoff that
// left `db:check` red and blocked every deploy. This resolves it without
// weakening the check: the applied text is recovered from git by its recorded
// hash and compared statement-for-statement, and anything short of an exact
// match is refused.
async function restampOne(item) {
	const found = appliedBytesFromGit(item.fname, item.prior);
	if (!found) {
		console.error(`  - ${item.fname}: no committed version matches the applied hash, cannot verify. Not restamped.`);
		return false;
	}
	if (schemaBytes(found.body) !== schemaBytes(item.body)) {
		console.error(`  - ${item.fname}: statements differ from what was applied (${found.commit.slice(0, 9)}). Roll forward with a NEW migration.`);
		return false;
	}
	await sql`update schema_migrations set sha256 = ${item.hash} where filename = ${item.fname}`;
	console.log(`  - ${item.fname}: comments only vs ${found.commit.slice(0, 9)}, hash re-recorded.`);
	return true;
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

	if (drift.length && RESTAMP) {
		console.log(`\nRestamping ${drift.length} drifted migration(s) whose statements are unchanged:`);
		let done = 0;
		for (const d of drift) if (await restampOne(d)) done += 1;
		if (done !== drift.length) {
			console.error(`\n${drift.length - done} migration(s) could not be restamped. See above.`);
			process.exit(3);
		}
		console.log('Done. Re-run without --restamp to see the status.');
		return;
	}

	if (drift.length) {
		console.error(
			`\nERROR: ${drift.length} migration(s) have drifted (file changed after apply):`,
		);
		for (const d of drift) console.error(`  - ${d.fname}`);
		console.error(
			'Refusing to proceed. An applied migration is an immutable record of what ran,\n' +
			'so do NOT edit its statements. If the edit was comment-only, re-record the\n' +
			'hash:  node scripts/apply-migrations.mjs --restamp   (it recovers the applied\n' +
			'bytes from git and refuses if a single statement differs).\n' +
			'If the schema genuinely needs to change, roll forward with a NEW migration.',
		);
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
