#!/usr/bin/env node
/**
 * cron-local-proof: invoke real /api/cron/* handlers against a real Postgres.
 *
 * Cron audits kept stalling on the same wall: the handlers are only reachable
 * through the deployed service, so "does this cron actually run" could not be
 * answered without production credentials. This harness answers it locally, with
 * no mocks in the request path: the real server (server/index.mjs), the real
 * vercel.json route table, the real cron auth gate (api/_lib/cron-auth.js), and
 * the real handler bodies, all talking to a real Postgres.
 *
 * The one shim is at the wire level, not the logic level. api/_lib/db.js speaks
 * Neon's SQL-over-HTTP protocol, which a plain Postgres does not serve, so a
 * tiny local endpoint translates those POSTs onto `pg` and returns rows in
 * Neon's exact wire shape (every column raw text, driver-side parsing). This is
 * the same bridge scripts/a2a-spend-hardening-proof.mjs and
 * scripts/genome-endpoints-proof.mjs already use; the SQL that runs is the SQL
 * the handler wrote.
 *
 * What it proves, per cron:
 *   auth      unauthenticated GET is rejected (401 or 403, or 503 when
 *             CRON_SECRET is unset) and never executes the body
 *   run       an authenticated GET completes without an unhandled error
 *   idempotent a second authenticated GET behaves the same as the first
 *
 * Setup (one time):
 *   docker run -d --name cronb05-pg -e POSTGRES_PASSWORD=b05 \
 *     -e POSTGRES_USER=b05 -e POSTGRES_DB=b05 -p 55705:5432 postgres:16-alpine
 *   node scripts/cron-local-proof.mjs --bootstrap
 *
 * Usage:
 *   node scripts/cron-local-proof.mjs                      # the default batch
 *   node scripts/cron-local-proof.mjs --crons irl-reap,uptime-check
 *   node scripts/cron-local-proof.mjs --crons /api/llm/health   # non-cron path
 *   node scripts/cron-local-proof.mjs --bootstrap          # apply schema first
 *   node scripts/cron-local-proof.mjs --keep               # leave the server up
 *
 * CRON_PROOF_DATABASE_URL overrides the local Postgres URL. Point it ONLY at a
 * throwaway database: these handlers DELETE and UPDATE rows for real.
 */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PG_URL = process.env.CRON_PROOF_DATABASE_URL
	|| 'postgresql://b05:b05@127.0.0.1:55705/b05';

// A local-only secret, unique per run. The gate compares it in constant time
// against whatever the caller presents, so a value generated here exercises the
// identical path a Cloud Scheduler OIDC bearer takes in production.
//
// Unique per run, not a fixed string, because several audits run this harness at
// once in a shared worktree. A constant secret let a run whose port had been
// taken by a NEIGHBOUR's server probe that server and read its answers as its
// own: the neighbour's crons, the neighbour's database. With a per-run secret a
// stray server can only ever answer 401, which the identity check below turns
// into a loud failure instead of a plausible-looking result.
const CRON_SECRET = process.env.CRON_PROOF_SECRET
	|| `local-cron-proof-${process.pid}-${randomUUID()}`;

const DEFAULT_CRONS = [
	'irl-reap',
	'settlement-verify',
	'expire-pending-purchases',
	'confirm-pending-purchases',
	'uptime-check',
	'world-health',
	'forge-smoke',
	'forge-finalize',
];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
function opt(name, fallback) {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const CRONS = opt('crons', DEFAULT_CRONS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-proof-'));

const cleanup = [];
async function shutdown() {
	for (const fn of cleanup.splice(0).reverse()) {
		try { await fn(); } catch { /* best effort */ }
	}
}
process.on('SIGINT', async () => { await shutdown(); process.exit(130); });

// Probing a port frees it again before the caller can bind it, so two runs that
// probe at the same moment both get the same "free" port. Spreading the scan
// start across runs makes that collision vanishingly unlikely; the identity
// check on the started server catches the remainder.
function scanStart(base, span = 200) {
	return base + ((process.pid * 7) % span);
}

async function freePort(start, span = 200) {
	for (let p = start; p < start + span; p++) {
		const ok = await new Promise((resolve) => {
			const s = net.createServer();
			s.once('error', () => resolve(false));
			s.once('listening', () => s.close(() => resolve(true)));
			s.listen(p, '127.0.0.1');
		});
		if (ok) return p;
	}
	throw new Error(`no free port near ${start}`);
}

async function waitFor(fn, { tries = 120, delayMs = 500, label = 'dependency' } = {}) {
	let last;
	for (let i = 0; i < tries; i++) {
		try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
		await new Promise((r) => setTimeout(r, delayMs));
	}
	throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

// ── Neon HTTP bridge ─────────────────────────────────────────────────────────
// Neon's endpoint hands every column back as raw text and lets the driver's own
// pg-types parsers build the JS value. Parsing here as well would double-parse:
// a boolean re-entering parseBool as a non-string comes back false, and a
// pre-parsed jsonb object makes JSON.parse throw on "[object Object]". Only the
// types the driver cannot recover from text alone are coerced.
const NUMERIC_OIDS = new Set([700, 701, 1700]);
const INT_OIDS = new Set([20, 21, 23, 26]);
function coerce(value, oid) {
	if (value === null || value === undefined) return null;
	if (oid === 16) return value === 't' || value === 'true';
	if (INT_OIDS.has(oid)) {
		const n = BigInt(value);
		return n <= 9007199254740991n && n >= -9007199254740991n ? Number(n) : value;
	}
	if (NUMERIC_OIDS.has(oid)) return Number(value);
	return value;
}

// Run one parameterized query and shape the reply exactly as Neon's endpoint
// does. `client` is either the pool (single query) or a checked-out client
// pinned inside a transaction.
async function runOne(client, { query, params }) {
	const r = await client.query({
		text: query,
		values: params || [],
		rowMode: 'array',
		types: { getTypeParser: () => (v) => v },
	});
	return {
		fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
		rows: r.rows.map((row) => row.map((v, i) => coerce(v, r.fields[i].dataTypeID))),
		rowCount: r.rowCount,
		command: r.command,
	};
}

// sql.transaction() posts { queries: [...] } instead of a single { query },
// answers with { results: [...] }, and carries its isolation level, read-only
// and deferrable settings in Neon-Batch-* headers. A shim that understood only
// the single-query shape handed `text: undefined` to pg, which threw "A query
// must have either text or a name" - surfacing as a 500 from any handler that
// writes atomically (custody-attest was the one that caught it) and reading
// like a bug in the handler rather than in this bridge.
async function runBatch(pool, queries, headers) {
	const client = await pool.connect();
	try {
		const isolation = headers['neon-batch-isolation-level'];
		const readOnly = headers['neon-batch-read-only'] === 'true';
		const deferrable = headers['neon-batch-deferrable'] === 'true';
		let begin = 'BEGIN';
		if (isolation) begin += ` ISOLATION LEVEL ${isolation.replace(/[^A-Za-z ]/g, '')}`;
		begin += readOnly ? ' READ ONLY' : ' READ WRITE';
		// DEFERRABLE is only legal on a serializable read-only transaction.
		if (deferrable && readOnly) begin += ' DEFERRABLE';
		await client.query(begin);
		try {
			const results = [];
			for (const q of queries) results.push(await runOne(client, q));
			await client.query('COMMIT');
			return results;
		} catch (e) {
			await client.query('ROLLBACK').catch(() => {});
			throw e;
		}
	} finally {
		client.release();
	}
}

async function startShim(pool) {
	const port = await freePort(scanStart(54800, 400), 400);
	const server = http.createServer(async (req, res) => {
		if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
		let body = '';
		for await (const c of req) body += c;
		try {
			const parsed = JSON.parse(body || '{}');
			const payload = Array.isArray(parsed.queries)
				? { results: await runBatch(pool, parsed.queries, req.headers) }
				: await runOne(pool, parsed);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(payload));
		} catch (e) {
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ message: String(e?.message || e), code: e?.code, constraint: e?.constraint }));
		}
	});
	await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
	cleanup.push(() => new Promise((r) => server.close(r)));

	const preload = path.join(TMP, 'preload.mjs');
	fs.writeFileSync(preload, `
import { neonConfig } from ${JSON.stringify(path.join(root, 'node_modules/@neondatabase/serverless/index.mjs'))};
neonConfig.fetchEndpoint = () => ${JSON.stringify(`http://127.0.0.1:${port}/sql`)};
`);
	return { port, preload };
}

// ── schema ───────────────────────────────────────────────────────────────────
// Split a .sql file into individual statements. Postgres' simple-query protocol
// runs a whole multi-statement string in one implicit transaction, so a single
// unsatisfiable statement rolls back every table the file would have created.
// Applying statement by statement keeps the 90% that does apply. Dollar-quoted
// bodies ($$ … $$, $tag$ … $tag$), single/double-quoted literals, and both
// comment styles are skipped so a semicolon inside one never splits a statement.
export function splitStatements(text) {
	const out = [];
	let buf = '';
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const rest = text.slice(i);
		if (ch === '-' && text[i + 1] === '-') {
			const nl = text.indexOf('\n', i);
			i = nl === -1 ? text.length : nl;
			continue;
		}
		if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? text.length : end + 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			const quote = ch;
			let j = i + 1;
			while (j < text.length) {
				if (text[j] === quote && text[j + 1] === quote) { j += 2; continue; }
				if (text[j] === quote) break;
				j++;
			}
			buf += text.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
		if (dollar) {
			const tag = dollar[0];
			const end = text.indexOf(tag, i + tag.length);
			const stop = end === -1 ? text.length : end + tag.length;
			buf += text.slice(i, stop);
			i = stop;
			continue;
		}
		if (ch === ';') {
			if (buf.trim()) out.push(buf.trim());
			buf = '';
			i++;
			continue;
		}
		buf += ch;
		i++;
	}
	if (buf.trim()) out.push(buf.trim());
	return out;
}

// Same order db-bootstrap.mjs uses: the three base files create the tables the
// incremental migrations then ALTER, so migrations must come last. Repeated
// passes resolve forward references (a migration that ALTERs a table a
// later-sorted file creates) without needing a dependency graph: each pass
// retries only what is still failing, and the loop stops as soon as a pass
// fixes nothing new.
async function bootstrapSchema(pool, { passes = 4 } = {}) {
	const base = [
		'api/_lib/schema.sql',
		'specs/schema/indexer_state.sql',
		'specs/schema/agent_delegations.sql',
	];
	const migrationsDir = path.join(root, 'api/_lib/migrations');
	const migrations = fs.readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort()
		.map((f) => path.join('api/_lib/migrations', f));

	// Transaction-control statements are dropped so each statement autocommits on
	// its own. Many migrations wrap their body in `begin; … commit;`, and inside
	// an explicit transaction the FIRST unsatisfiable statement aborts the whole
	// block: every statement that already succeeded is rolled back and every one
	// after it fails with "current transaction is aborted". That is how
	// forge_creations.user_id went missing here while its own ALTER was fine, and
	// it made a local-only schema gap look like a handler bug.
	const TX_CONTROL = /^(begin|start\s+transaction|commit|end|rollback)\b/i;

	let pending = [];
	for (const rel of [...base, ...migrations]) {
		const abs = path.join(root, rel);
		if (!fs.existsSync(abs)) continue;
		for (const stmt of splitStatements(fs.readFileSync(abs, 'utf8'))) {
			if (TX_CONTROL.test(stmt)) continue;
			pending.push({ file: rel, stmt });
		}
	}

	const total = pending.length;
	let applied = 0;
	for (let pass = 0; pass < passes && pending.length; pass++) {
		const stillFailing = [];
		for (const item of pending) {
			try {
				await pool.query(item.stmt);
				applied++;
			} catch (e) {
				item.message = String(e?.message || e).split('\n')[0];
				stillFailing.push(item);
			}
		}
		if (stillFailing.length === pending.length) { pending = stillFailing; break; }
		pending = stillFailing;
	}
	return { total, applied, failed: pending };
}

// ── server ───────────────────────────────────────────────────────────────────
async function startServer(preload) {
	const port = await freePort(scanStart(8410, 400), 400);
	let exited = null;
	const child = spawn('node', [path.join(root, 'server/index.mjs')], {
		cwd: root,
		env: {
			...process.env,
			NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${JSON.stringify(preload)}`.trim(),
			PORT: String(port),
			DATABASE_URL: PG_URL,
			CRON_SECRET,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const logPath = path.join(TMP, 'server.log');
	const log = fs.createWriteStream(logPath);
	child.stdout.pipe(log);
	child.stderr.pipe(log);
	cleanup.push(() => { child.kill('SIGKILL'); });
	// A server that loses the bind (port taken between the probe and the spawn)
	// or dies on boot must stop the run here. Without this the readiness probe
	// below is answered by whoever DOES hold the port, and every cron result
	// afterwards describes a server this run never started.
	child.on('exit', (code, signal) => { exited = signal ? `signal ${signal}` : `code ${code}`; });

	const base = `http://127.0.0.1:${port}`;
	await waitFor(async () => {
		if (exited) throw new Error(`server exited (${exited}), see ${logPath}`);
		const r = await fetch(`${base}/api/healthz`).catch(() => null);
		return r && r.status < 600;
	}, { label: `server on :${port}`, tries: 120 });
	if (exited) throw new Error(`server exited (${exited}), see ${logPath}`);

	// Identity check. Our child binds the wildcard address, but a process already
	// bound to 127.0.0.1 specifically keeps winning loopback connections, so
	// "the child started" does not prove the child is who answers. The per-run
	// CRON_SECRET is known only to this run's server: anyone else returns 401,
	// which must read as a harness fault, never as "the cron refused the
	// scheduler". Costs one real tick of the probe cron against this run's own
	// throwaway database.
	const probe = await fetch(`${base}/api/cron/uptime-check`, {
		headers: { authorization: `Bearer ${CRON_SECRET}` },
	}).catch(() => null);
	if (probe && probe.status === 401) {
		throw new Error(
			`port ${port} is served by a different process (it rejects this run's cron secret). `
			+ 'Another cron-local-proof run is probably using it; re-run to pick a new port.',
		);
	}
	return { base, logPath, child };
}

// ── probes ───────────────────────────────────────────────────────────────────

/**
 * The route a named cron is invoked on. A bare name is an /api/cron/* handler,
 * which is nearly all of them; a name given as a full path lets the harness
 * cover the scheduled endpoints that live outside that prefix (vercel.json
 * drives /api/llm/health on the same cron secret, for one) without a second
 * copy of the server, shim and auth plumbing.
 * @param {string} name
 * @returns {string}
 */
export function cronRoute(name) {
	return name.startsWith('/') ? name : `/api/cron/${name}`;
}

async function call(base, name, { auth }) {
	const t0 = Date.now();
	const res = await fetch(`${base}${cronRoute(name)}`, {
		headers: auth ? { authorization: `Bearer ${CRON_SECRET}` } : {},
	}).catch((e) => ({ status: 0, _err: e }));
	if (!res || res.status === 0) {
		return { status: 0, ms: Date.now() - t0, body: String(res?._err?.message || 'fetch failed') };
	}
	const text = await res.text();
	let body;
	try { body = JSON.parse(text); } catch { body = text.slice(0, 400); }
	return { status: res.status, ms: Date.now() - t0, body };
}

function summarize(body) {
	if (body && typeof body === 'object') {
		const s = JSON.stringify(body);
		return s.length > 300 ? `${s.slice(0, 300)}…` : s;
	}
	return String(body).slice(0, 300);
}

async function main() {
	console.log(`cron-local-proof: ${CRONS.length} cron(s)`);
	console.log(`  postgres : ${PG_URL.replace(/:[^:@/]+@/, ':***@')}`);

	const pgMod = await import('pg').catch(() => null);
	if (!pgMod) {
		console.error('\n`pg` is not installed. Run: npm i --no-save pg');
		process.exit(2);
	}
	const pool = new (pgMod.default || pgMod).Pool({ connectionString: PG_URL, max: 8 });
	cleanup.push(() => pool.end());
	await waitFor(() => pool.query('SELECT 1').then(() => true), { label: 'postgres', tries: 30 });

	if (flag('bootstrap')) {
		console.log('\n━━ schema ━━');
		const { total, applied, failed } = await bootstrapSchema(pool);
		console.log(`  applied ${applied}/${total} statement(s)`);
		if (failed.length) {
			const byFile = new Map();
			for (const f of failed) byFile.set(f.file, (byFile.get(f.file) || 0) + 1);
			console.log(`  ${failed.length} statement(s) across ${byFile.size} file(s) did not apply from scratch:`);
			for (const f of failed.slice(0, 10)) console.log(`    ${f.file}: ${f.message}`);
			if (failed.length > 10) console.log(`    …and ${failed.length - 10} more`);
		}
	}

	const { port: shimPort, preload } = await startShim(pool);
	console.log(`  neon shim: http://127.0.0.1:${shimPort}/sql`);

	const { base, logPath } = await startServer(preload);
	console.log(`  server   : ${base}`);
	console.log(`  log      : ${logPath}`);

	const results = [];
	for (const name of CRONS) {
		const unauth = await call(base, name, { auth: false });
		const first = await call(base, name, { auth: true });
		const second = await call(base, name, { auth: true });

		// 401 from the shared gate, 403 from the handlers that answer an unknown
		// caller without conceding that a credential would have helped
		// (/api/llm/health names providers and quota detail behind it), 503 when
		// CRON_SECRET is unset. All three are a closed door; anything else ran the
		// body for an anonymous caller.
		const authOk = [401, 403, 503].includes(unauth.status);
		const runOk = first.status >= 200 && first.status < 500 && first.status !== 0;
		const idemOk = runOk && second.status === first.status;

		results.push({ name, unauth, first, second, authOk, runOk, idemOk });

		const mark = (ok) => (ok ? 'PASS' : 'FAIL');
		console.log(`\n── ${name}`);
		console.log(`   auth       ${mark(authOk)}  unauthenticated → ${unauth.status}`);
		console.log(`   run        ${mark(runOk)}  ${first.status} in ${first.ms}ms  ${summarize(first.body)}`);
		console.log(`   idempotent ${mark(idemOk)}  ${second.status} in ${second.ms}ms  ${summarize(second.body)}`);
	}

	const failures = results.filter((r) => !r.authOk || !r.runOk || !r.idemOk);
	console.log('\n━━ summary ━━');
	for (const r of results) {
		console.log(`  ${(!r.authOk || !r.runOk || !r.idemOk) ? 'FAIL' : 'PASS'}  ${r.name}  (auth ${r.unauth.status}, run ${r.first.status}, again ${r.second.status})`);
	}
	console.log(`\n${results.length - failures.length}/${results.length} cron(s) clean.`);

	if (flag('keep')) {
		console.log(`\nServer left running at ${base}. Ctrl-C to stop.`);
		await new Promise(() => {});
	}
	await shutdown();
	process.exit(failures.length ? 1 : 0);
}

main().catch(async (err) => {
	console.error(`\ncron-local-proof failed: ${err?.stack || err}`);
	await shutdown();
	process.exit(2);
});
