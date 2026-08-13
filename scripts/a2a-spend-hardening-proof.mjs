#!/usr/bin/env node
// a2a-spend-hardening-proof: prove, on a real Postgres with real advisory locks
// and a live local HTTP surface, that the per-agent spend policy actually blocks
// what it claims to block. No real funds move anywhere in this run: every spend
// stops at the reservation layer (the same layer that runs BEFORE any key is
// touched or any payment is signed in production), and the database is a
// throwaway local container.
//
// Why this exists: tests/a2a-payment-hardening.test.js proves the limits against
// a mocked DB (deterministic, fast), but a mock cannot prove the two properties
// that make the caps real under autonomy:
//   1. the reserve is ATOMIC (the INSERT...SELECT under pg_advisory_xact_lock
//      cannot be raced by concurrent spends reading the same stale total), and
//   2. the kill switch halts spending on the LIVE surface the owner actually
//      uses (PUT /api/agents/:id/solana/limits -> the very next reserve throws).
// This script is the second half of that proof.
//
// What it proves, in order:
//   1. per_tx_usd            an over-cap reserve is rejected; an at-cap one lands
//   2. daily_usd             a wallet at its rolling-24h ceiling rejects the next
//                            reserve, and 8 CONCURRENT reserves cannot race past it
//   3. per_counterparty_daily_usd  a payee at its ceiling rejects more, while the
//                            identical spend to a different payee still lands
//   4. kill switch           frozen=true blocks every autonomous category
//                            (x402/trade/snipe) immediately, the owner's own
//                            withdraw stays open, and unfreezing resumes spending
//   5. receipts (live HTTP)  every agent-initiated payment is queryable per agent
//                            from the owner ledger surface: the full statement at
//                            GET /api/agents/:id/solana/custody, and the economy
//                            summary at GET /api/agents/:id/economy
//
// Usage:
//   node scripts/a2a-spend-hardening-proof.mjs              # full run, prints transcript
//   node scripts/a2a-spend-hardening-proof.mjs --keep       # leave pg container running
//
// Environment: needs `docker` (postgres:16 image) and port 5817/5818/3817 free.
// `pg` is loaded from node_modules if present, else installed with --no-save.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');

const PG_PORT = 5817;
const SHIM_PORT = 5818;
const HTTP_PORT = 3817;
const PG_CONTAINER = 'a2a-spend-proof-pg';
const PG_URL = `postgres://postgres@127.0.0.1:${PG_PORT}/proof`;
const SHIM_URL = `http://127.0.0.1:${SHIM_PORT}/sql`;
const HTTP_BASE = `http://127.0.0.1:${HTTP_PORT}`;

const PEER_A = 'PeerA111111111111111111111111111111111111';
const PEER_B = 'PeerB222222222222222222222222222222222222';

// ── tiny transcript + assertion kit ──────────────────────────────────────────
const results = [];
let failed = 0;
function step(name) {
	console.log(`\n── ${name}`);
}
function pass(name, detail) {
	results.push({ name, ok: true, detail });
	console.log(`  ✔ ${name}${detail ? ` - ${detail}` : ''}`);
}
function fail(name, detail) {
	failed += 1;
	results.push({ name, ok: false, detail });
	console.error(`  ✘ ${name} - ${detail}`);
}
function check(name, cond, detail) {
	if (cond) pass(name, detail);
	else fail(name, detail);
	return !!cond;
}

// ── process helpers ──────────────────────────────────────────────────────────
const cleanup = [];
async function shutdown() {
	for (const fn of cleanup.splice(0).reverse()) {
		try { await fn(); } catch { /* best effort */ }
	}
}
process.on('SIGINT', async () => { await shutdown(); process.exit(130); });

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
	return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

async function waitFor(fn, { tries = 60, delayMs = 500, label = 'dependency' } = {}) {
	for (let i = 0; i < tries; i++) {
		try {
			const v = await fn();
			if (v) return v;
		} catch { /* not ready */ }
		await new Promise((r) => setTimeout(r, delayMs));
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function portFree(port) {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.once('error', () => resolve(false));
		s.once('listening', () => s.close(() => resolve(true)));
		s.listen(port, '127.0.0.1');
	});
}

// ── pg client (raw SQL for seeding/assertions) ───────────────────────────────
async function loadPg() {
	try {
		return await import('pg');
	} catch {
		// A `--no-save` install is transient: any later `npm install` in this
		// worktree prunes it, so a re-run lands here again. It can also leave a
		// half-written node_modules/pg that resolves as a directory but has no
		// entry point: hence the post-install re-import is checked, not assumed.
		console.log('  installing pg (--no-save) for the local Postgres bridge');
		const r = run('npm', ['i', '--no-save', '--no-audit', '--no-fund', 'pg'], { cwd: root });
		if (r.code !== 0) throw new Error(`npm i pg failed: ${r.out.slice(-400)}`);
		try {
			return await import('pg');
		} catch (e) {
			throw new Error(
				`pg still not importable after install (${e?.message || e}). ` +
				'Run `npm i --no-save pg` yourself and re-run this proof.',
			);
		}
	}
}

// ── neon HTTP shim: lets api/_lib/db.js (neon serverless HTTP driver) talk to
// the local Postgres. Same pattern previous local proofs used; array-mode raw
// text rows so the driver applies its own type parsing exactly as against Neon.
function startShim(pg) {
	const preloadPath = '/tmp/a2a-spend-proof-preload.mjs';
	const shimPath = '/tmp/a2a-spend-proof-shim.mjs';
	fs.writeFileSync(shimPath, `
import http from 'node:http';
import pg from ${JSON.stringify(path.join(root, 'node_modules/pg/esm/index.mjs'))};
const client = new pg.Client(${JSON.stringify(PG_URL)});
await client.connect();
// Raw text rows would break the guard SQL: a float8 cap parameter that comes
// back as the string '1' makes Postgres compare 'double > text', and every cap
// silently passes. Serialize per column type so the HTTP response carries real
// JSON values the way Neon's own endpoint does. bool(16), ints(20,21,23,26) and
// floats(700,701,1700) get typed values; everything else stays text (uuid,
// timestamptz, ...) exactly like production.
//
// json/jsonb (114/3802) MUST stay text: the neon driver runs its own JSON.parse
// over those columns, so handing it an already-parsed object makes it parse
// String(object) and every query that selects a jsonb column dies with
// '"[object Object]" is not valid JSON'. That is precisely the shape of every
// agent policy read (SELECT meta FROM agent_identities), so parsing here turns
// the whole proof into a false negative.
const NUMERIC_OIDS = new Set([700, 701, 1700]);
const INT_OIDS = new Set([20, 21, 23, 26]);
function coerce(value, oid) {
	if (value === null || value === undefined) return null;
	if (oid === 16) return value === 't' || value === 'true';
	if (INT_OIDS.has(oid)) { const n = BigInt(value); return n <= 9007199254740991n && n >= -9007199254740991n ? Number(n) : value; }
	if (NUMERIC_OIDS.has(oid)) return Number(value);
	return value;
}
http.createServer(async (req, res) => {
	if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
	let body = '';
	for await (const c of req) body += c;
	try {
		const { query, params } = JSON.parse(body || '{}');
		const r = await client.query({
			text: query, values: params || [], rowMode: 'array',
			types: { getTypeParser: () => (v) => v },
		});
		const rows = r.rows.map((row) => row.map((v, i) => coerce(v, r.fields[i].dataTypeID)));
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({
			fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
			rows, rowCount: r.rowCount, command: r.command,
		}));
	} catch (e) {
		res.writeHead(500, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ message: String(e && e.message || e) }));
	}
}).listen(${SHIM_PORT}, '127.0.0.1');
`);
	fs.writeFileSync(preloadPath, `
import { neonConfig } from ${JSON.stringify(path.join(root, 'node_modules/@neondatabase/serverless/index.mjs'))};
neonConfig.fetchEndpoint = () => ${JSON.stringify(SHIM_URL)};
`);
	const shim = spawn('node', [shimPath], { stdio: 'inherit' });
	cleanup.push(() => shim.kill('SIGKILL'));
	return { preloadPath };
}

// ── HTTP client with a cookie jar ────────────────────────────────────────────
function makeHttp() {
	const cookies = new Map();
	function capture(res) {
		const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
		for (const c of set) {
			const [pair] = c.split(';');
			const i = pair.indexOf('=');
			cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
		}
	}
	function cookieHeader() {
		return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
	}
	async function req(method, p, { body, headers = {} } = {}) {
		const res = await fetch(HTTP_BASE + p, {
			method,
			headers: {
				cookie: cookieHeader(),
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
				...headers,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			redirect: 'manual',
		});
		capture(res);
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* html or empty */ }
		return { status: res.status, json, text };
	}
	async function freshCsrf() {
		const r = await req('GET', '/api/csrf-token');
		if (r.status !== 200 || !r.json?.token) throw new Error(`csrf-token failed: ${r.status} ${r.text.slice(0, 200)}`);
		return r.json.token;
	}
	return { req, freshCsrf };
}

async function main() {
	console.log('a2a spend hardening proof - real Postgres, live local HTTP, no real funds\n');

	// ── environment ──────────────────────────────────────────────────────────
	step('0. environment');
	for (const [port, name] of [[PG_PORT, 'postgres'], [SHIM_PORT, 'shim'], [HTTP_PORT, 'http']]) {
		if (!(await portFree(port))) throw new Error(`port ${port} (${name}) is already in use - pick another port or stop the stale process`);
	}
	check('docker available', run('docker', ['--version']).code === 0);
	run('docker', ['rm', '-f', PG_CONTAINER]);
	const up = run('docker', [
		'run', '-d', '--name', PG_CONTAINER,
		'-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=proof',
		'-p', `${PG_PORT}:5432`, 'postgres:16',
	]);
	if (up.code !== 0) throw new Error(`docker run failed: ${up.out}`);
	cleanup.push(() => run('docker', ['rm', '-f', PG_CONTAINER]));
	pass('throwaway postgres started', `${PG_CONTAINER} on :${PG_PORT}`);

	const pg = await loadPg();
	let db = null;
	const dbQuery = async (text, params) => {
		if (!db) throw new Error('db not connected');
		try {
			return await db.query(text, params);
		} catch (e) {
			// The container or the connection can drop mid-run; reconnect once and retry.
			if (/terminated|ECONNRESET|Connection/i.test(String(e?.message))) {
				try { db.end().catch(() => {}); } catch { /* gone */ }
				db = new pg.Client(PG_URL);
				await db.connect();
				return await db.query(text, params);
			}
			throw e;
		}
	};
	await waitFor(async () => {
		try {
			const c = new pg.Client(PG_URL);
			c.on('error', () => {});
			await c.connect();
			await c.query('select 1');
			db = c;
			return true;
		} catch { return false; }
	}, { label: 'postgres accepting queries' });
	pass('postgres accepting queries');

	// Schema: the notifications migration FIRST (schema.sql references
	// user_notifications without creating it), then schema.sql, then every
	// migration in order. Drifted ancient migrations are tolerated only when
	// nothing we touch depends on them; users/agent_identities/
	// agent_custody_events/sessions/csrf_tokens MUST exist afterwards.
	const migrationsDir = path.join(root, 'api/_lib/migrations');
	const schemaFiles = [
		path.join(migrationsDir, '2026-04-30-notifications.sql'),
		path.join(root, 'api/_lib/schema.sql'),
		...fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
			.map((f) => path.join(migrationsDir, f)),
	];
	let applied = 0;
	const skipped = [];
	for (const f of schemaFiles) {
		const r = run('docker', ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', 'proof', '-v', 'ON_ERROR_STOP=1', '-q'], { input: fs.readFileSync(f, 'utf8') });
		if (r.code === 0) applied += 1;
		else skipped.push(path.basename(f));
	}
	const mustHave = ['users', 'sessions', 'csrf_tokens', 'agent_identities', 'agent_custody_events'];
	const missing = [];
	for (const t of mustHave) {
		const { rows } = await dbQuery('select to_regclass($1) AS r', [`public.${t}`]);
		if (!rows[0].r) missing.push(t);
	}
	check('schema applied', applied > 0 && missing.length === 0,
		`${applied} files applied, ${skipped.length} skipped from drift; required tables present`);
	if (missing.length) throw new Error(`required tables missing: ${missing.join(', ')}`);

	// Seed the proof agent (library phase). Direct SQL, real rows. The anomaly
	// guard (the wallet's behavioral immune system) is disabled on proof agents:
	// it auto-freezes a fresh wallet's first out-of-pattern spend, which is the
	// correct production behavior but would freeze the harness mid-proof. The
	// anomaly guard has its own dedicated test coverage; here it is noise.
	const ANOMALY_OFF = { enabled: false };
	const { rows: [u1] } = await dbQuery(
		`insert into users (email, password_hash, email_verified) values ($1, 'x', true) returning id`,
		[`proof-lib-${Date.now()}@proof.local`],
	);
	const { rows: [a1] } = await dbQuery(
		`insert into agent_identities (user_id, name, meta) values ($1, $2, jsonb_build_object('anomaly', $3::jsonb)) returning id`,
		[u1.id, 'spend-proof-agent', JSON.stringify(ANOMALY_OFF)],
	);
	const agentId = a1.id;
	pass('proof user + agent seeded', `agent ${agentId}`);

	// Bridge api/_lib/db.js (neon HTTP) onto the local postgres.
	const { preloadPath } = startShim(pg);
	await waitFor(async () => {
		try {
			const r = await fetch(SHIM_URL, { method: 'POST', body: JSON.stringify({ query: 'select 1', params: [] }) });
			return r.ok;
		} catch { return false; }
	}, { label: 'sql shim' });
	pass('neon HTTP shim up', SHIM_URL);

	// The guards module is imported in a CHILD process so the neon fetchEndpoint
	// preload applies before db.js evaluates. The child exposes the guard calls
	// this proof needs as a tiny JSON-over-stdio RPC.
	const workerPath = '/tmp/a2a-spend-proof-worker.mjs';
	fs.writeFileSync(workerPath, `
import { reserveSpendUsd, enforceSpendLimit, updateCustodyEvent, releaseSpendReservation,
	recordCustodyEvent, SpendLimitError } from ${JSON.stringify(path.join(root, 'api/_lib/agent-trade-guards.js'))};
let buf = '';
// Serialize RPCs: the shim runs one pg client, and pg deprecated overlapping
// queries on a single connection. Each guard call is a single SQL statement
// anyway; the concurrency this proof cares about is the DATABASE advisory lock
// across statements, not socket overlap inside the harness.
const queue = [];
let busy = false;
async function drain() {
	if (busy) return;
	busy = true;
	while (queue.length) {
		const { id, fn, args } = queue.shift();
		try {
			const out = await ({ reserveSpendUsd, enforceSpendLimit, updateCustodyEvent,
				releaseSpendReservation, recordCustodyEvent })[fn](...(args || []));
			process.stdout.write(JSON.stringify({ id, ok: true, out: out ?? null }) + '\\n');
		} catch (e) {
			process.stdout.write(JSON.stringify({ id, ok: false, err: {
				name: e?.name, code: e?.code || null, status: e?.status || null,
				message: String(e?.message || e), detail: e?.detail || null,
			} }) + '\\n');
		}
	}
	busy = false;
}
process.stdin.on('data', (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf('\\n')) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		queue.push(JSON.parse(line));
	}
	drain();
});
`);
	const worker = spawn('node', ['--import', preloadPath, workerPath], {
		env: { ...process.env, DATABASE_URL: PG_URL, JWT_SECRET: 'proof-jwt-secret' },
		stdio: ['pipe', 'pipe', 'inherit'],
	});
	cleanup.push(() => worker.kill('SIGKILL'));
	const pending = new Map();
	let rpcSeq = 0;
	let workerBuf = '';
	worker.stdout.on('data', (d) => {
		workerBuf += d;
		let i;
		while ((i = workerBuf.indexOf('\n')) >= 0) {
			const line = workerBuf.slice(0, i); workerBuf = workerBuf.slice(i + 1);
			if (!line.trim()) continue;
			const msg = JSON.parse(line);
			pending.get(msg.id)?.(msg);
			pending.delete(msg.id);
		}
	});
	function call(fn, ...args) {
		const id = ++rpcSeq;
		return new Promise((resolve, reject) => {
			pending.set(id, resolve);
			worker.stdin.write(JSON.stringify({ id, fn, args }) + '\n');
			setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${fn} timed out`)); } }, 30000);
		});
	}
	async function callErr(fn, ...args) {
		const r = await call(fn, ...args);
		if (r.ok) return { thrown: null, out: r.out };
		return { thrown: r.err, out: null };
	}
	// Sanity: the worker can reach the DB through the shim.
	{
		const probe = await callErr('recordCustodyEvent', {
			agentId, userId: u1.id, eventType: 'limit_change', reason: 'proof_warmup', meta: {},
		});
		if (probe.thrown) throw new Error(`worker DB round-trip failed: ${probe.thrown.message}`);
	}
	pass('guard module live against real postgres', 'worker round-trip through advisory-lock SQL ok');

	const spend = (over = {}) => ({
		agentId, userId: u1.id, category: 'x402', usdValue: 1,
		destination: PEER_A, network: 'mainnet', asset: 'USDC', ...over,
	});
	const confirm = async (reservationId, sig) => {
		await call('updateCustodyEvent', reservationId, { status: 'ok', signature: sig });
	};
	const setLimits = async (patch) => {
		await dbQuery(
			`update agent_identities set meta =
				jsonb_set(
					jsonb_set(coalesce(meta,'{}'::jsonb), '{spend_limits}', $2::jsonb),
					'{anomaly}', $3::jsonb
				) where id = $1`,
			[agentId, JSON.stringify(patch), JSON.stringify(ANOMALY_OFF)],
		);
	};

	// ── 1. per-transaction ceiling ───────────────────────────────────────────
	step('1. per_tx_usd - cap per call');
	await setLimits({ daily_usd: null, per_tx_usd: 1, per_counterparty_daily_usd: null, withdraw_allowlist: [], frozen: false, require_capabilities: false });
	{
		const over = await callErr('reserveSpendUsd', spend({ usdValue: 1.5 }));
		check('over-per-tx reserve blocked', over.thrown?.code === 'per_tx_exceeded',
			over.thrown ? `${over.thrown.code}: ${over.thrown.message}` : 'ERROR: reserve was allowed');
		const at = await callErr('reserveSpendUsd', spend({ usdValue: 1 }));
		check('at-cap reserve allowed', !at.thrown && !!at.out?.reservationId, at.thrown?.message || `reservation ${at.out?.reservationId}`);
		if (at.out?.reservationId) await call('releaseSpendReservation', at.out.reservationId, 'proof_cleanup');
	}

	// ── 2. daily ceiling + concurrency race ──────────────────────────────────
	step('2. daily_usd - rolling 24h wallet ceiling, race-proof');
	{
		// Backfill real, priced, confirmed spend rows (history, not reservations).
		for (const [usd, dest] of [[0.6, PEER_A], [0.3, PEER_B]]) {
			const id = await call('recordCustodyEvent', {
				agentId, userId: u1.id, eventType: 'spend', category: 'x402', network: 'mainnet',
				asset: 'USDC', usd, destination: dest, status: 'ok', meta: { proof: 'backfill' },
			});
			if (!id) throw new Error('backfill row failed');
		}
		await setLimits({ daily_usd: 1, per_tx_usd: null, per_counterparty_daily_usd: null, withdraw_allowlist: [], frozen: false, require_capabilities: false });
		const over = await callErr('reserveSpendUsd', spend({ usdValue: 0.2 }));
		check('daily cap blocks the $0.20 that would push $0.90 -> $1.10 over $1.00', over.thrown?.code === 'daily_exceeded',
			over.thrown ? `${over.thrown.code}: spent $${over.thrown.detail?.spent_usd} + $${over.thrown.detail?.usd} > cap $${over.thrown.detail?.daily_usd}` : 'ERROR: reserve was allowed');

		// Concurrency: 8 simultaneous reserves for the last $0.10 of headroom.
		// Without the advisory lock all 8 read spent=$0.90 and all pass ($0.80 over).
		await setLimits({ daily_usd: 1, per_tx_usd: null, per_counterparty_daily_usd: null, withdraw_allowlist: [], frozen: false, require_capabilities: false });
		const raced = await Promise.all([...Array(8)].map(() => callErr('reserveSpendUsd', spend({ usdValue: 0.1 }))));
		const winners = raced.filter((r) => !r.thrown);
		check('8 concurrent reserves for $0.10 headroom: exactly 1 wins', winners.length === 1,
			`winners=${winners.length} blocked=${raced.length - winners.length} (advisory lock serialized them)`);
		const after = winners.length === 1 ? raced.find((r) => r.thrown) : null;
		check('the losers get daily_exceeded, not an error', !after || after.thrown.code === 'daily_exceeded', after?.thrown?.code);
		for (const w of winners) await call('releaseSpendReservation', w.out.reservationId, 'proof_cleanup');
	}

	// ── 3. per-counterparty ceiling ──────────────────────────────────────────
	step('3. per_counterparty_daily_usd - concentrated-drain ceiling');
	{
		// Fresh agent so the wallet-wide cap never fires first.
		const { rows: [a2] } = await dbQuery(
			`insert into agent_identities (user_id, name, meta) values ($1, $2, jsonb_build_object('anomaly', $3::jsonb)) returning id`,
			[u1.id, 'spend-proof-agent-cp', JSON.stringify(ANOMALY_OFF)],
		);
		const cpAgent = a2.id;
		for (const usd of [0.6, 0.3]) {
			await call('recordCustodyEvent', {
				agentId: cpAgent, userId: u1.id, eventType: 'spend', category: 'x402', network: 'mainnet',
				asset: 'USDC', usd, destination: PEER_A, status: 'ok', meta: { proof: 'backfill' },
			});
		}
		await dbQuery(
			`update agent_identities set meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{spend_limits}', $2::jsonb) where id = $1`,
			[cpAgent, JSON.stringify({ daily_usd: null, per_tx_usd: null, per_counterparty_daily_usd: 1, withdraw_allowlist: [], frozen: false, require_capabilities: false })],
		);
		// (anomaly already disabled at insert time)
		const spendCp = (over = {}) => ({
			agentId: cpAgent, userId: u1.id, category: 'x402', usdValue: 0.2,
			destination: PEER_A, network: 'mainnet', asset: 'USDC', ...over,
		});
		const overSame = await callErr('reserveSpendUsd', spendCp());
		check('counterparty at $0.90 of $1.00 blocks the next $0.20 to the SAME payee', overSame.thrown?.code === 'counterparty_daily_exceeded',
			overSame.thrown ? `${overSame.thrown.code}: $${overSame.thrown.detail?.counterparty_spent_usd} + $${overSame.thrown.detail?.usd} > $${overSame.thrown.detail?.per_counterparty_daily_usd}` : 'ERROR: reserve was allowed');
		const otherPeer = await callErr('reserveSpendUsd', spendCp({ destination: PEER_B }));
		check('the identical $0.20 to a DIFFERENT payee still lands', !otherPeer.thrown && !!otherPeer.out?.reservationId,
			otherPeer.thrown?.message || 'the cap meters per payee, not in total');
		if (otherPeer.out?.reservationId) await call('releaseSpendReservation', otherPeer.out.reservationId, 'proof_cleanup');
	}

	// ── 4. kill switch ───────────────────────────────────────────────────────
	step('4. kill switch - frozen halts every autonomous path immediately');
	{
		// Fresh agent, generous caps, no history: only the freeze can block.
		const { rows: [a3] } = await dbQuery(
			`insert into agent_identities (user_id, name, meta) values ($1, $2, jsonb_build_object('anomaly', $3::jsonb)) returning id`,
			[u1.id, 'spend-proof-agent-kill', JSON.stringify(ANOMALY_OFF)],
		);
		const killAgent = a3.id;
		const open = { daily_usd: 1000, per_tx_usd: 1000, per_counterparty_daily_usd: null, withdraw_allowlist: [], frozen: false, require_capabilities: false };
		await dbQuery(
			`update agent_identities set meta =
				jsonb_set(
					jsonb_set(coalesce(meta,'{}'::jsonb), '{spend_limits}', $2::jsonb),
					'{anomaly}', $3::jsonb
				) where id = $1`,
			[killAgent, JSON.stringify(open), JSON.stringify(ANOMALY_OFF)],
		);
		const spendKill = (over = {}) => ({
			agentId: killAgent, userId: u1.id, category: 'x402', usdValue: 0.5,
			destination: PEER_A, network: 'mainnet', asset: 'USDC', ...over,
		});
		const before = await callErr('reserveSpendUsd', spendKill());
		check('control: unfrozen agent spends fine', !before.thrown && !!before.out?.reservationId, before.thrown?.message);
		if (before.out?.reservationId) await call('releaseSpendReservation', before.out.reservationId, 'proof_cleanup');

		await setLimitsOn(dbQuery, killAgent, { ...open, frozen: true });
		for (const category of ['x402', 'trade', 'snipe']) {
			const blocked = await callErr('reserveSpendUsd', spendKill({ category }));
			check(`frozen blocks category=${category} instantly`, blocked.thrown?.code === 'wallet_frozen',
				blocked.thrown ? `${blocked.thrown.code} (no lock wait, no reservation written)` : 'ERROR: spend was allowed');
		}
		const ownerSweep = await callErr('reserveSpendUsd', spendKill({ category: 'withdraw', destination: PEER_B }));
		check('owner withdraw stays open while frozen', !ownerSweep.thrown && !!ownerSweep.out?.reservationId,
			ownerSweep.thrown?.message || 'a freeze never traps the owner funds');
		if (ownerSweep.out?.reservationId) await call('releaseSpendReservation', ownerSweep.out.reservationId, 'proof_cleanup');

		await setLimitsOn(dbQuery, killAgent, { ...open, frozen: false });
		const after = await callErr('reserveSpendUsd', spendKill());
		check('unfreeze resumes spending', !after.thrown && !!after.out?.reservationId, after.thrown?.message);
		if (after.out?.reservationId) await call('releaseSpendReservation', after.out.reservationId, 'proof_cleanup');
	}

	// ── 5. receipts on the live local surface ────────────────────────────────
	step('5. receipts - queryable per agent on the live HTTP surface');
	{
		// This section proves the receipt surface, not the ceilings: and the proof
		// agent is still carrying section 2's $1/day cap plus its backfilled history.
		// Open the policy back up so a seeding payment is refused only if something
		// is genuinely broken.
		await setLimits({ daily_usd: null, per_tx_usd: null, per_counterparty_daily_usd: null, withdraw_allowlist: [], frozen: false, require_capabilities: false });

		// Confirmed payments with tx signatures: the receipt rows the owner reads.
		const sigs = ['proofsigA111', 'proofsigB222', 'proofsigC333'];
		const amounts = [[0.4, PEER_A], [0.35, PEER_A], [0.25, PEER_B]];
		for (let i = 0; i < amounts.length; i++) {
			const r = await call('reserveSpendUsd', {
				agentId, userId: u1.id, category: 'x402', usdValue: amounts[i][0],
				destination: amounts[i][1], network: 'mainnet', asset: 'USDC',
				rowMeta: { url: `https://peer-${i}.example/x402`, service: `peer-${i}` },
			});
			if (!r.ok) throw new Error(`receipt seeding reserve blocked unexpectedly: ${r.err?.message}`);
			await confirm(r.out.reservationId, sigs[i]);
		}
		const seeded = await dbQuery(
			`select count(*)::int as n from agent_custody_events where agent_id = $1 and event_type = 'spend' and status = 'ok'`,
			[agentId],
		);
		pass('three settled payments finalized into the ledger', `${seeded.rows[0].n} confirmed spend rows for the agent`);

		// Boot the real server against the same DB.
		const server = spawn('node', ['--import', preloadPath, 'server/index.mjs'], {
			cwd: root,
			env: {
				...process.env,
				PORT: String(HTTP_PORT),
				DATABASE_URL: PG_URL,
				JWT_SECRET: 'proof-jwt-secret',
				NODE_ENV: 'development',
				X402_AUTONOMOUS_ENABLED: 'false',
				X402_SEED_ENABLED: 'false',
				X402_RING_TICK_ENABLED: 'false',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		cleanup.push(() => server.kill('SIGKILL'));
		// Keep the server's own log instead of dropping it: the API answers a failed
		// request with an opaque `ref`, so without the tail below a 500 here is
		// undiagnosable and the proof reports "receipts unverified" with no reason.
		const serverLog = [];
		const captureLog = (d) => {
			for (const line of String(d).split('\n')) {
				if (!line.trim()) continue;
				serverLog.push(line);
				if (serverLog.length > 400) serverLog.shift();
			}
		};
		server.stderr.on('data', captureLog);
		server.stdout.on('data', captureLog);
		const serverTail = (n = 12) => serverLog.slice(-n).map((l) => `\n      | ${l}`).join('');
		await waitFor(async () => {
			try {
				const r = await fetch(`${HTTP_BASE}/api/version`);
				return r.ok;
			} catch { return false; }
		}, { tries: 120, delayMs: 500, label: 'local server' });
		pass('live server up', `${HTTP_BASE}/api/version 200`);

		const http = makeHttp();
		const email = `proof-owner-${Date.now()}@proof.local`;
		const reg = await http.req('POST', '/api/auth/register', { body: { email, password: 'proof-pass-12345', tosAccepted: true } });
		const registered = reg.status === 200 || reg.status === 201;
		check('owner registered through the real /register flow', registered,
			registered ? email : `status ${reg.status}: ${reg.text.slice(0, 200)}${serverTail()}`);
		// Every later check in this section signs in as that owner, so a failed
		// registration is a dead end, not a partial result. Stop here with the
		// server's own log attached rather than emitting a cascade of 401s.
		if (!registered) throw new Error(`registration failed (${reg.status}): the receipt-surface checks cannot run${serverTail(20)}`);

		const csrf1 = await http.freshCsrf();
		const created = await http.req('POST', '/api/agents', {
			body: { name: 'receipt-proof-agent', description: 'receipt surface proof' },
			headers: { 'x-csrf-token': csrf1 },
		});
		const liveAgentId = created.json?.agent?.id || created.json?.data?.id || created.json?.id;
		check('agent created through the real API', (created.status === 200 || created.status === 201) && !!liveAgentId,
			liveAgentId ? `agent ${liveAgentId}` : `status ${created.status}: ${created.text.slice(0, 200)}`);

		if (liveAgentId) {
			// Policy read: defaults visible before anything is set.
			const got0 = await http.req('GET', `/api/agents/${liveAgentId}/solana/limits`);
			check('GET limits returns the effective policy', got0.status === 200 && got0.json?.data?.limits?.frozen === false,
				got0.status === 200 ? `defaults: frozen=${got0.json?.data?.limits?.frozen}` : `status ${got0.status}`);

			// Kill switch over the live surface.
			const csrf2 = await http.freshCsrf();
			const put = await http.req('PUT', `/api/agents/${liveAgentId}/solana/limits`, {
				body: { frozen: true, per_tx_usd: 5, daily_usd: 25, per_counterparty_daily_usd: 10 },
				headers: { 'x-csrf-token': csrf2 },
			});
			check('PUT limits flips the kill switch + sets all three caps', put.status === 200
				&& put.json?.data?.limits?.frozen === true
				&& put.json?.data?.limits?.per_tx_usd === 5
				&& put.json?.data?.limits?.daily_usd === 25
				&& put.json?.data?.limits?.per_counterparty_daily_usd === 10,
				put.status === 200 ? 'limits persisted and read back on the response' : `status ${put.status}: ${put.text.slice(0, 200)}`);

			// The frozen agent must be unable to spend: drive a REAL reserve through
			// the live meta (read back from the DB the server just wrote).
			const { rows: [liveRow] } = await dbQuery('select meta from agent_identities where id = $1', [liveAgentId]);
			const frozenAttempt = await callErr('reserveSpendUsd', {
				agentId: liveAgentId, userId: null, meta: liveRow.meta, category: 'x402',
				usdValue: 1, destination: PEER_A, network: 'mainnet', asset: 'USDC',
			});
			check('live-frozen agent is blocked at the reserve layer', frozenAttempt.thrown?.code === 'wallet_frozen',
				frozenAttempt.thrown ? `${frozenAttempt.thrown.code}: ${frozenAttempt.thrown.message}` : 'ERROR: spend was allowed');

			const csrf3 = await http.freshCsrf();
			const unfreeze = await http.req('PUT', `/api/agents/${liveAgentId}/solana/limits`, {
				body: { frozen: false }, headers: { 'x-csrf-token': csrf3 },
			});
			check('unfreeze over the live surface', unfreeze.status === 200 && unfreeze.json?.data?.limits?.frozen === false);

			// Settle two real ledger payments for THIS agent so its receipts exist.
			for (const [usd, dest, sig] of [[0.75, PEER_A, 'livesigA111'], [0.5, PEER_B, 'livesigB222']]) {
				const r = await call('reserveSpendUsd', {
					agentId: liveAgentId, userId: null, category: 'x402', usdValue: usd,
					destination: dest, network: 'mainnet', asset: 'USDC',
					rowMeta: { url: 'https://peer.example/x402', service: 'live-proof' },
				});
				if (!r.ok) throw new Error(`live-agent receipt reserve blocked: ${r.err?.message}`);
				await confirm(r.out.reservationId, sig);
			}

			const custody = await http.req('GET', `/api/agents/${liveAgentId}/solana/custody?category=x402&limit=50`);
			const items = custody.json?.data?.items || [];
			const receipts = items.filter((e) => e.event_type === 'spend' && e.status === 'ok');
			check('custody surface returns the agent payment receipts', custody.status === 200 && receipts.length === 2,
				custody.status === 200
					? `${receipts.length} receipts: ${receipts.map((r) => `$${r.usd} -> ${String(r.destination).slice(0, 10)}… sig ${r.signature}`).join(' | ')}`
					: `status ${custody.status}: ${custody.text.slice(0, 200)}`);
			check('receipts carry counterparty + amount + signature + status',
				receipts.every((r) => r.destination && r.usd > 0 && r.signature && r.status === 'ok'),
				receipts.length ? 'every receipt fully attributed' : 'no receipts to check');

			const economy = await http.req('GET', `/api/agents/${liveAgentId}/economy`);
			const econ = economy.json;
			const econReceipts = econ?.receipts || econ?.data?.receipts || [];
			const outbound = econReceipts.filter((r) => r.direction === 'out');
			check('economy surface shows spending + receipts for the agent',
				economy.status === 200 && (econ?.spending?.x402?.count ?? econ?.data?.spending?.x402?.count) >= 2 && outbound.length >= 2,
				economy.status === 200
					? `x402 spend count=${econ?.spending?.x402?.count ?? econ?.data?.spending?.x402?.count}, outbound receipts=${outbound.length}`
					: `status ${economy.status}: ${economy.text.slice(0, 200)}`);

			// Ownership gate: a second account must not read the first agent's receipts.
			const http2 = makeHttp();
			const reg2 = await http2.req('POST', '/api/auth/register', {
				body: { email: `proof-stranger-${Date.now()}@proof.local`, password: 'proof-pass-12345', tosAccepted: true },
			});
			if (reg2.status === 200 || reg2.status === 201) {
				const denied = await http2.req('GET', `/api/agents/${liveAgentId}/solana/custody`);
				check('receipts are owner-only (stranger gets 403)', denied.status === 403, `status ${denied.status}`);
			}
		}
	}

	// ── transcript ───────────────────────────────────────────────────────────
	console.log('\n══ transcript ══');
	for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` - ${r.detail}` : ''}`);
	console.log(`\n${results.length - failed}/${results.length} checks passed`);
	if (failed) {
		console.error('PROOF FAILED');
		process.exitCode = 1;
	} else {
		console.log('PROOF PASSED - every limit blocked its over-limit attempt, the kill switch halted spending, and receipts were queryable per agent on the live surface.');
	}
}

async function setLimitsOn(dbQuery, agentId, limits) {
	await dbQuery(
		`update agent_identities set meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{spend_limits}', $2::jsonb) where id = $1`,
		[agentId, JSON.stringify(limits)],
	);
}

try {
	await main();
} catch (e) {
	console.error(`\nproof harness error: ${e?.stack || e}`);
	process.exitCode = 1;
} finally {
	if (!KEEP) await shutdown();
	else console.log(`\n--keep: left ${PG_CONTAINER} running on :${PG_PORT}`);
}
