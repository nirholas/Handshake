#!/usr/bin/env node
// monetization-api-proof: exercise the four /api/monetization endpoints against a
// REAL Postgres and the REAL server process, over live HTTP, with a real
// registered user and a real agent. No mocks anywhere in the request path.
//
// Why this exists: tests/monetization-service.test.js covers prices.js and
// revenue.js against a queue-driven `sql` stub, which is fast and deterministic
// but structurally cannot catch the defects that only appear when Postgres is
// the one parsing the query: a junk `?limit=` binding as NULL (and silently
// disabling the LIMIT), or a price large enough to overflow a bigint column.
// wallet.js and withdrawals.js had no handler-level coverage at all. This
// script closes both gaps by running the handlers for real.
//
// What it proves, per endpoint:
//   prices.js       public GET listing, the owner-only PUT/DELETE gate, the
//                   validation floor and ceiling on price_usdc, NFT-gate rows
//   revenue.js      auth gate, period + agent_id validation, ownership scoping,
//                   and the aggregation math against seeded revenue events
//   wallet.js       auth gate, address validation for both chains, the upsert
//                   round-trip, and the resolved-address summary
//   withdrawals.js  auth gate, pagination clamping, the payout-wallet
//                   precondition, minimum + insufficient-balance refusals, a
//                   successful reservation, and the double-spend refusal
//
// No funds move: a withdrawal here only inserts a 'pending' row in a throwaway
// database. Nothing is signed and no chain is contacted.
//
// Usage:
//   node scripts/monetization-api-proof.mjs           # full run, prints transcript
//   node scripts/monetization-api-proof.mjs --keep    # leave the stack running so
//                                                     # you can curl it by hand
//
// Environment: needs `docker` (postgres:16 image) and ports 5841/5842/3841 free.
// `pg` is loaded from node_modules if present, else installed with --no-save.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');

const PG_PORT = 5841;
const SHIM_PORT = 5842;
const HTTP_PORT = 3841;
const PG_CONTAINER = 'monetization-api-proof-pg';
const PG_URL = `postgres://postgres@127.0.0.1:${PG_PORT}/proof`;
const SHIM_URL = `http://127.0.0.1:${SHIM_PORT}/sql`;
const HTTP_BASE = `http://127.0.0.1:${HTTP_PORT}`;
const TMP = path.join(root, '.monetization-proof');

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_PAYOUT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const EVM_PAYOUT = '0x1111111111111111111111111111111111111111';
// A second EVM address, saved through /api/billing/payout-wallets under the
// legacy chain label 'evm', used to prove it cannot shadow the address the owner
// saves here on chain 'base'.
const EVM_LEGACY = '0x2222222222222222222222222222222222222222';

// One client address per actor. See makeHttp() for why they must not share one.
const OWNER_IP = '198.51.100.11';
const OTHER_IP = '198.51.100.12';
const SOLO_IP = '198.51.100.13';

// tiny transcript + assertion kit
let failed = 0;
function step(name) {
	console.log(`\n-- ${name}`);
}
function pass(name, detail) {
	console.log(`  PASS ${name}${detail ? ` - ${detail}` : ''}`);
}
function fail(name, detail) {
	failed += 1;
	console.error(`  FAIL ${name} - ${detail}`);
}
function check(name, cond, detail) {
	if (cond) pass(name, detail);
	else fail(name, detail);
	return !!cond;
}

// Everything the server process wrote. Kept at module scope so a fatal abort
// can print it: a handler 500 is opaque from the HTTP side (wrap() answers with
// an error ref only), and the matching stack is in here.
const serverLog = [];

// process helpers
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

async function waitFor(fn, { tries = 120, delayMs = 500, label = 'dependency' } = {}) {
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

async function loadPg() {
	try {
		return await import('pg');
	} catch {
		console.log('  installing pg (--no-save) for the local Postgres bridge');
		const r = run('npm', ['i', '--no-save', '--no-audit', '--no-fund', 'pg'], { cwd: root });
		if (r.code !== 0) throw new Error(`npm i pg failed: ${r.out.slice(-400)}`);
		return await import('pg');
	}
}

// neon HTTP shim: bridges api/_lib/db.js (neon serverless HTTP driver) onto the
// local Postgres. The driver sends `Neon-Raw-Text-Output: true` and runs its own
// pg-types parsers over every value, so the shim must hand back the raw wire
// text Neon's endpoint returns. Coercing here (parsing a jsonb column, say)
// double-parses on the client and blows up as `"[object Object]" is not valid
// JSON` inside the driver, which surfaces as an opaque handler 500.
function startShim() {
	fs.mkdirSync(TMP, { recursive: true });
	const preloadPath = path.join(TMP, 'preload.mjs');
	const shimPath = path.join(TMP, 'shim.mjs');
	fs.writeFileSync(shimPath, `
import http from 'node:http';
import pg from ${JSON.stringify(path.join(root, 'node_modules/pg/esm/index.mjs'))};
const pool = new pg.Pool({ connectionString: ${JSON.stringify(PG_URL)}, max: 8 });
http.createServer(async (req, res) => {
	if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
	let body = '';
	for await (const c of req) body += c;
	// Neon's HTTP transaction mode posts an array of queries on one connection.
	const parsed = JSON.parse(body || '{}');
	const batch = Array.isArray(parsed.queries) ? parsed.queries : null;
	const client = await pool.connect();
	try {
		const exec = async (q) => {
			const r = await client.query({
				text: q.query, values: q.params || [], rowMode: 'array',
				types: { getTypeParser: () => (v) => v },
			});
			return {
				fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
				rows: r.rows,
				rowCount: r.rowCount, command: r.command,
			};
		};
		if (batch) {
			await client.query('BEGIN');
			const results = [];
			for (const q of batch) results.push(await exec(q));
			await client.query('COMMIT');
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ results }));
		} else {
			const out = await exec(parsed);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(out));
		}
	} catch (e) {
		if (batch) { try { await client.query('ROLLBACK'); } catch { /* already gone */ } }
		res.writeHead(400, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ message: String((e && e.message) || e), code: e && e.code }));
	} finally {
		client.release();
	}
}).listen(${SHIM_PORT}, '127.0.0.1');
`);
	fs.writeFileSync(preloadPath, `
import { neonConfig } from ${JSON.stringify(path.join(root, 'node_modules/@neondatabase/serverless/index.mjs'))};
neonConfig.fetchEndpoint = () => ${JSON.stringify(SHIM_URL)};
`);
	const shim = spawn('node', [shimPath], { stdio: ['ignore', 'inherit', 'inherit'] });
	cleanup.push(() => shim.kill('SIGKILL'));
	return { preloadPath };
}

// HTTP client with a cookie jar, pinned to one client IP.
//
// Every actor gets its own address because the strict per-IP credential bucket
// (rate-limit.js `authIp`, 50 requests / 10 min) is what most of these calls
// draw on. Sharing 127.0.0.1 across all three actors made the run's own volume
// the binding constraint: adding checks anywhere starved the assertions further
// down with a 429 that says nothing about the handlers. Three separate users on
// three separate addresses is also the shape production actually sees. The
// per-USER budgets (`withdrawalPerUser`) are unaffected, so the "a sixth POST in
// a day is rate limited" check still exercises the real ceiling.
function makeHttp(ip) {
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
	async function req(method, p, { body, headers = {}, anonymous = false } = {}) {
		const res = await fetch(HTTP_BASE + p, {
			method,
			headers: {
				'x-forwarded-for': ip,
				...(anonymous ? {} : { cookie: cookieHeader() }),
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
				...headers,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			redirect: 'manual',
		});
		if (!anonymous) capture(res);
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* html or empty */ }
		return { status: res.status, json, text };
	}
	async function csrf() {
		const r = await req('GET', '/api/csrf-token');
		if (r.status !== 200 || !r.json?.token) throw new Error(`csrf-token failed: ${r.status} ${r.text.slice(0, 200)}`);
		return r.json.token;
	}
	// Every state-changing call needs a fresh CSRF token bound to the session.
	async function write(method, p, body) {
		return req(method, p, { body, headers: { 'x-csrf-token': await csrf() } });
	}
	return { req, write, cookieHeader };
}

async function main() {
	console.log('monetization API proof - real Postgres, real server, live HTTP, no funds moved\n');

	step('0. environment');
	for (const [port, name] of [[PG_PORT, 'postgres'], [SHIM_PORT, 'shim'], [HTTP_PORT, 'http']]) {
		if (!(await portFree(port))) throw new Error(`port ${port} (${name}) is already in use`);
	}
	check('docker available', run('docker', ['--version']).code === 0);
	run('docker', ['rm', '-f', PG_CONTAINER]);
	const up = run('docker', [
		'run', '-d', '--name', PG_CONTAINER,
		'-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=proof',
		'-p', `${PG_PORT}:5432`, 'postgres:16',
	]);
	if (up.code !== 0) throw new Error(`docker run failed: ${up.out}`);
	if (!KEEP) cleanup.push(() => run('docker', ['rm', '-f', PG_CONTAINER]));
	pass('throwaway postgres started', `${PG_CONTAINER} on :${PG_PORT}`);

	const pg = await loadPg();
	let db = null;
	await waitFor(async () => {
		const c = new pg.Client(PG_URL);
		c.on('error', () => {});
		await c.connect();
		await c.query('select 1');
		db = c;
		return true;
	}, { label: 'postgres accepting queries' });
	if (!KEEP) cleanup.push(() => db.end().catch(() => {}));
	pass('postgres accepting queries');

	// Schema: the notifications migration first (schema.sql references
	// user_notifications without creating it), then schema.sql, then every
	// migration in filename order. Ancient drifted migrations may fail; only the
	// tables this proof touches have to exist afterwards.
	step('1. schema');
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
	const mustHave = [
		'users', 'sessions', 'csrf_tokens', 'agent_identities', 'agent_skill_prices',
		'agent_revenue_events', 'agent_payout_wallets', 'agent_withdrawals', 'agent_payment_intents',
	];
	const missing = [];
	for (const t of mustHave) {
		const { rows } = await db.query('select to_regclass($1) as r', [`public.${t}`]);
		if (!rows[0].r) missing.push(t);
	}
	check('schema applied', applied > 0 && missing.length === 0,
		`${applied} files applied, ${skipped.length} skipped from drift; all monetization tables present`);
	if (missing.length) throw new Error(`required tables missing: ${missing.join(', ')}`);

	step('2. live server');
	const { preloadPath } = startShim();
	await waitFor(async () => {
		const r = await fetch(SHIM_URL, { method: 'POST', body: JSON.stringify({ query: 'select 1', params: [] }) });
		return r.ok;
	}, { label: 'sql shim' });
	pass('neon HTTP shim up', SHIM_URL);

	const server = spawn('node', ['--import', preloadPath, 'server/index.mjs'], {
		cwd: root,
		env: {
			...process.env,
			PORT: String(HTTP_PORT),
			DATABASE_URL: PG_URL,
			JWT_SECRET: 'monetization-proof-jwt-secret',
			NODE_ENV: 'development',
			X402_AUTONOMOUS_ENABLED: 'false',
			X402_SEED_ENABLED: 'false',
			X402_RING_TICK_ENABLED: 'false',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (!KEEP) cleanup.push(() => server.kill('SIGKILL'));
	server.stdout.on('data', (d) => serverLog.push(String(d)));
	server.stderr.on('data', (d) => serverLog.push(String(d)));
	await waitFor(async () => (await fetch(`${HTTP_BASE}/api/version`)).ok, { label: 'local server' });
	pass('live server up', `${HTTP_BASE} (api/version 200)`);

	// Owner + a second user, both registered through the real flow.
	const http = makeHttp(OWNER_IP);
	const stamp = Date.now();
	const ownerEmail = `mon-owner-${stamp}@proof.local`;
	const reg = await http.req('POST', '/api/auth/register', { body: { email: ownerEmail, password: 'proof-pass-12345', tosAccepted: true } });
	check('owner registered through the real /register flow', reg.status < 300,
		reg.status < 300 ? ownerEmail : `status ${reg.status}: ${reg.text.slice(0, 200)}`);

	const other = makeHttp(OTHER_IP);
	const otherEmail = `mon-other-${stamp}@proof.local`;
	const reg2 = await other.req('POST', '/api/auth/register', { body: { email: otherEmail, password: 'proof-pass-12345', tosAccepted: true } });
	check('second (non-owner) user registered', reg2.status < 300, `status ${reg2.status}`);

	const created = await http.write('POST', '/api/agents', { name: `mon-proof-${stamp}`, description: 'monetization endpoint proof' });
	const agentId = created.json?.agent?.id || created.json?.data?.id || created.json?.id;
	check('agent created through the real API', created.status < 300 && !!agentId,
		agentId ? `agent ${agentId}` : `status ${created.status}: ${created.text.slice(0, 200)}`);
	if (!agentId) throw new Error('cannot continue without an agent');

	const GHOST = '00000000-0000-4000-8000-000000000000';

	// prices.js
	step('3. /api/monetization/prices');
	{
		const r = await http.req('GET', '/api/monetization/prices', { anonymous: true });
		check('GET without agent_id -> 400', r.status === 400 && r.json?.error === 'validation_error', `status ${r.status}`);
	}
	{
		const r = await http.req('GET', '/api/monetization/prices?agent_id=not-a-uuid', { anonymous: true });
		check('GET with a malformed agent_id -> 400', r.status === 400, `status ${r.status}`);
	}
	{
		const r = await http.req('GET', `/api/monetization/prices?agent_id=${GHOST}`, { anonymous: true });
		check('GET for an unknown agent -> 404', r.status === 404 && r.json?.error === 'not_found', `status ${r.status}`);
	}
	{
		const r = await http.req('GET', `/api/monetization/prices?agent_id=${agentId}`, { anonymous: true });
		check('GET is public and lists an empty catalog', r.status === 200 && Array.isArray(r.json?.prices) && r.json.prices.length === 0,
			`status ${r.status}, ${r.json?.prices?.length} prices`);
	}
	{
		const r = await http.req('PUT', '/api/monetization/prices', {
			body: { agent_id: agentId, skill_name: 'echo', price_usdc: 0.05 }, anonymous: true,
		});
		check('PUT unauthenticated -> 401', r.status === 401, `status ${r.status}`);
	}
	{
		const r = await other.write('PUT', '/api/monetization/prices', { agent_id: agentId, skill_name: 'echo', price_usdc: 0.05 });
		check('PUT by a non-owner -> 403', r.status === 403 && r.json?.error === 'forbidden', `status ${r.status}`);
	}
	{
		const r = await http.write('PUT', '/api/monetization/prices', { agent_id: GHOST, skill_name: 'echo', price_usdc: 0.05 });
		check('PUT for an unknown agent -> 404', r.status === 404, `status ${r.status}`);
	}
	{
		const r = await http.write('PUT', '/api/monetization/prices', { agent_id: agentId, skill_name: 'has spaces!', price_usdc: 0.05 });
		check('PUT with an invalid skill_name -> 400', r.status === 400, `status ${r.status}`);
	}
	{
		const r = await http.write('PUT', '/api/monetization/prices', { agent_id: agentId, skill_name: 'echo', price_usdc: 0.0000004 });
		check('PUT below the atomic floor -> 400', r.status === 400, `status ${r.status}`);
	}
	{
		// Regression: an unbounded price_usdc used to reach Postgres as a bigint
		// overflow and surface as a 500 instead of a validation error.
		const r = await http.write('PUT', '/api/monetization/prices', { agent_id: agentId, skill_name: 'echo', price_usdc: 1e30 });
		check('PUT above the bigint ceiling -> 400 (not 500)', r.status === 400 && r.json?.error === 'validation_error',
			`status ${r.status}: ${r.text.slice(0, 140)}`);
	}
	{
		const r = await http.write('PUT', '/api/monetization/prices', { agent_id: agentId, skill_name: 'echo', price_usdc: 0.05 });
		check('PUT creates a price -> 201', r.status === 201 && r.json?.price?.amount_atomic === 50_000,
			`status ${r.status}, amount ${r.json?.price?.amount_atomic}`);
	}
	{
		const r = await http.write('PUT', '/api/monetization/prices', { agent_id: agentId, skill_name: 'echo', price_usdc: 0.1 });
		check('PUT updates the same skill -> 200', r.status === 200 && r.json?.price?.amount_atomic === 100_000,
			`status ${r.status}, amount ${r.json?.price?.amount_atomic}`);
	}
	{
		const r = await http.write('PUT', '/api/monetization/prices', {
			agent_id: agentId, skill_name: 'gated', gate_type: 'nft', nft_collection_mint: SOL_PAYOUT,
		});
		check('PUT an NFT gate stores a zero-amount row -> 201', r.status === 201 && r.json?.price?.gate_type === 'nft' && r.json.price.amount_atomic === 0,
			`status ${r.status}, gate ${r.json?.price?.gate_type}`);
	}
	{
		const r = await http.write('PUT', '/api/monetization/prices', { agent_id: agentId, skill_name: 'gated2', gate_type: 'nft' });
		check('PUT an NFT gate without a collection mint -> 400', r.status === 400, `status ${r.status}`);
	}
	{
		const r = await http.req('GET', `/api/monetization/prices?agent_id=${agentId}`, { anonymous: true });
		check('GET lists both priced and gated skills', r.status === 200 && r.json.prices.length === 2,
			`${r.json?.prices?.length} prices: ${r.json?.prices?.map((p) => `${p.skill_name}/${p.gate_type}`).join(', ')}`);
	}
	{
		const r = await http.write('DELETE', '/api/monetization/prices', { agent_id: agentId, skill_name: 'gated' });
		const list = await http.req('GET', `/api/monetization/prices?agent_id=${agentId}`, { anonymous: true });
		check('DELETE soft-deactivates and drops it from the public listing', r.status === 200 && list.json.prices.length === 1,
			`delete ${r.status}, ${list.json?.prices?.length} left`);
	}
	{
		const r = await http.write('DELETE', '/api/monetization/prices', { agent_id: agentId, skill_name: 'ghost-skill', hard: true });
		check('DELETE of a skill with no price row -> 404', r.status === 404, `status ${r.status}`);
	}
	{
		// The dashboard's del() helper (src/dashboard-next/api.js) sends no body and
		// no content-type, addressing the row with query parameters instead. Every
		// "Remove price" button on the monetize and creator pages goes through it,
		// so a body-only DELETE reader makes all of them dead.
		await http.write('PUT', '/api/monetization/prices', { agent_id: agentId, skill_name: 'querydel', price_usdc: 0.02 });
		const r = await http.write('DELETE', `/api/monetization/prices?agent_id=${agentId}&skill_name=querydel`);
		const list = await http.req('GET', `/api/monetization/prices?agent_id=${agentId}`, { anonymous: true });
		check('DELETE addressed by query string, the shape the dashboard sends -> 200',
			r.status === 200 && !list.json.prices.some((p) => p.skill_name === 'querydel'),
			`status ${r.status}, ${list.json?.prices?.length} price(s) left`);
	}
	{
		const r = await http.write('DELETE', '/api/monetization/prices?skill_name=querydel');
		check('DELETE with neither a body nor an agent_id -> 400', r.status === 400, `status ${r.status}`);
	}
	{
		// The embed's skill-access gate reads prices through the shared cache (1h
		// TTL), so a write that skips invalidation keeps quoting buyers the old
		// amount for an hour. Warm the cache, edit the price, read it back.
		await http.write('PUT', '/api/monetization/prices', { agent_id: agentId, skill_name: 'cached', price_usdc: 0.25 });
		const warm = await http.req('GET', `/api/agents/${agentId}/skill-access`, { anonymous: true });
		await http.write('PUT', '/api/monetization/prices', { agent_id: agentId, skill_name: 'cached', price_usdc: 0.75 });
		const after = await http.req('GET', `/api/agents/${agentId}/skill-access`, { anonymous: true });
		check('a price edit is visible immediately through the cached skill-access gate',
			Number(warm.json?.data?.skill_prices?.cached?.amount) === 250_000
			&& Number(after.json?.data?.skill_prices?.cached?.amount) === 750_000,
			`warm ${warm.json?.data?.skill_prices?.cached?.amount}, after ${after.json?.data?.skill_prices?.cached?.amount}`);
	}
	{
		const r = await http.write('DELETE', `/api/monetization/prices?agent_id=${agentId}&skill_name=cached`);
		const gate = await http.req('GET', `/api/agents/${agentId}/skill-access`, { anonymous: true });
		check('removing a price clears it from the cached gate too',
			r.status === 200 && !('cached' in (gate.json?.data?.skill_prices || {})),
			`status ${r.status}, gate keys ${Object.keys(gate.json?.data?.skill_prices || {}).join(',') || 'none'}`);
	}

	// wallet.js
	step('4. /api/monetization/wallet');
	{
		const r = await http.req('GET', `/api/monetization/wallet?agent_id=${agentId}`, { anonymous: true });
		check('GET unauthenticated -> 401', r.status === 401, `status ${r.status}`);
	}
	{
		const r = await http.req('GET', '/api/monetization/wallet?agent_id=not-a-uuid');
		check('GET with a malformed agent_id -> 400', r.status === 400, `status ${r.status}`);
	}
	{
		const r = await http.req('GET', `/api/monetization/wallet?agent_id=${GHOST}`);
		check('GET for an unknown agent -> 404', r.status === 404, `status ${r.status}`);
	}
	{
		const r = await other.req('GET', `/api/monetization/wallet?agent_id=${agentId}`);
		check("GET for someone else's agent -> 403", r.status === 403, `status ${r.status}`);
	}
	{
		const r = await http.req('GET', `/api/monetization/wallet?agent_id=${agentId}`);
		check('GET with no wallet configured returns an empty resolved set', r.status === 200 && r.json?.resolved?.solana_address === null,
			`status ${r.status}, wallets ${r.json?.wallets?.length}`);
	}
	{
		const r = await http.write('PUT', '/api/monetization/wallet', { agent_id: agentId });
		check('PUT with no address -> 400', r.status === 400, `status ${r.status}`);
	}
	{
		const r = await http.write('PUT', '/api/monetization/wallet', { agent_id: agentId, solana_address: 'not-base58-0OIl' });
		check('PUT with a malformed Solana address -> 400', r.status === 400, `status ${r.status}`);
	}
	{
		const r = await http.write('PUT', '/api/monetization/wallet', { agent_id: agentId, evm_address: '0xnope' });
		check('PUT with a malformed EVM address -> 400', r.status === 400, `status ${r.status}`);
	}
	{
		const r = await other.write('PUT', '/api/monetization/wallet', { agent_id: agentId, solana_address: SOL_PAYOUT });
		check('PUT by a non-owner -> 403', r.status === 403, `status ${r.status}`);
	}
	{
		const r = await http.write('PUT', '/api/monetization/wallet', { agent_id: agentId, solana_address: SOL_PAYOUT, evm_address: EVM_PAYOUT });
		check('PUT stores both chains -> 200', r.status === 200 && r.json?.wallets?.length === 2, `status ${r.status}, ${r.json?.wallets?.length} rows`);
	}
	{
		const r = await http.req('GET', `/api/monetization/wallet?agent_id=${agentId}`);
		check('GET reflects both stored addresses', r.status === 200
			&& r.json.resolved.solana_address === SOL_PAYOUT
			&& r.json.resolved.evm_address === EVM_PAYOUT,
			`solana ${r.json?.resolved?.solana_address?.slice(0, 8)}, evm ${r.json?.resolved?.evm_address?.slice(0, 8)}`);
	}
	{
		// Re-PUT must upsert in place, never duplicate the (user, agent, chain) row.
		const r = await http.write('PUT', '/api/monetization/wallet', { agent_id: agentId, solana_address: SOL_PAYOUT, preferred_network: 'solana' });
		const list = await http.req('GET', `/api/monetization/wallet?agent_id=${agentId}`);
		check('re-PUT upserts rather than duplicating', r.status === 200 && list.json.wallets.length === 2,
			`${list.json?.wallets?.length} wallet rows after the second PUT`);
	}
	{
		// 'base' and 'evm' are one payout rail carrying two chain labels, and the
		// unique key is (user_id, agent_id, chain), so /api/billing/payout-wallets
		// can leave a default 'evm' row sitting beside this endpoint's 'base' row.
		// Both resolvers (here and in withdrawals.js) order by is_default then
		// created_at, and an upsert never moves created_at, so the stale sibling
		// used to outrank the address the owner had just saved and the payout went
		// to the replaced address.
		const legacy = await http.write('POST', '/api/billing/payout-wallets', {
			address: EVM_LEGACY, chain: 'evm', agent_id: agentId, is_default: true,
		});
		const r = await http.write('PUT', '/api/monetization/wallet', { agent_id: agentId, evm_address: EVM_PAYOUT });
		const list = await http.req('GET', `/api/monetization/wallet?agent_id=${agentId}`);
		const { rows } = await db.query(
			`select count(*)::int as n from agent_payout_wallets
			 where agent_id = $1 and chain in ('base', 'evm') and is_default`,
			[agentId],
		);
		check('a legacy evm row cannot shadow the newly saved EVM payout address',
			legacy.status < 300 && r.status === 200
			&& list.json?.resolved?.evm_address === EVM_PAYOUT && rows[0].n === 1,
			`legacy ${legacy.status}, resolved ${list.json?.resolved?.evm_address}, ${rows[0].n} default row(s) on the EVM rail`);
	}

	// withdrawals.js, empty-balance paths
	step('5. /api/monetization/withdrawals (no balance yet)');
	{
		const r = await http.req('GET', '/api/monetization/withdrawals', { anonymous: true });
		check('GET unauthenticated -> 401', r.status === 401, `status ${r.status}`);
	}
	{
		const r = await http.req('GET', '/api/monetization/withdrawals?agent_id=not-a-uuid');
		check('GET with a malformed agent_id -> 400', r.status === 400, `status ${r.status}`);
	}
	{
		const r = await http.req('GET', `/api/monetization/withdrawals?agent_id=${agentId}`);
		check('GET returns an empty history plus a zeroed balance', r.status === 200
			&& r.json?.withdrawals?.length === 0 && r.json?.balance?.available_usdc === 0,
			`status ${r.status}, available ${r.json?.balance?.available_usdc}`);
	}
	// Withdrawal POSTs are rate limited to 5 per user per day (rate-limit.js,
	// `withdrawalPerUser`), and a refused request still spends one. So the
	// refusal probes run as their own throwaway user, leaving the owner's whole
	// budget for the real reservations in step 7.
	const solo = makeHttp(SOLO_IP);
	const soloEmail = `mon-solo-${stamp}@proof.local`;
	const soloReg = await solo.req('POST', '/api/auth/register', { body: { email: soloEmail, password: 'proof-pass-12345', tosAccepted: true } });
	const soloAgent = await solo.write('POST', '/api/agents', { name: `mon-solo-${stamp}`, description: 'withdrawal refusal probes' });
	const soloAgentId = soloAgent.json?.agent?.id || soloAgent.json?.data?.id || soloAgent.json?.id;
	check('third (refusal-probe) user and agent created', soloReg.status < 300 && !!soloAgentId,
		soloAgentId ? `agent ${soloAgentId}` : `register ${soloReg.status}, agent ${soloAgent.status}`);
	if (!soloAgentId) throw new Error('cannot continue without the refusal-probe agent');
	{
		const r = await solo.write('POST', '/api/monetization/withdrawals', { agent_id: soloAgentId, amount_usdc: 5 });
		check('POST before any payout wallet exists -> 422 no_payout_wallet', r.status === 422 && r.json?.error === 'no_payout_wallet',
			`status ${r.status}, ${r.json?.error}`);
	}
	await solo.write('PUT', '/api/monetization/wallet', { agent_id: soloAgentId, solana_address: SOL_PAYOUT });
	{
		const r = await solo.write('POST', '/api/monetization/withdrawals', { agent_id: soloAgentId, amount_usdc: 5, network: 'base' });
		check('POST on a chain with no wallet -> 422 rather than paying out on another chain',
			r.status === 422 && r.json?.error === 'no_payout_wallet', `status ${r.status}, ${r.json?.error}`);
	}
	{
		const r = await solo.write('POST', '/api/monetization/withdrawals', { agent_id: soloAgentId, amount_usdc: 5 });
		check('POST with a zero balance -> 422 insufficient_balance', r.status === 422 && r.json?.error === 'insufficient_balance',
			`status ${r.status}, ${r.json?.error}`);
	}
	{
		const r = await solo.write('POST', '/api/monetization/withdrawals', { agent_id: soloAgentId, amount_usdc: 0.5 });
		check('POST below the 1 USDC minimum -> 422 below_minimum', r.status === 422 && r.json?.error === 'below_minimum',
			`status ${r.status}, ${r.json?.error}`);
	}
	{
		const r = await solo.write('POST', '/api/monetization/withdrawals', { agent_id: GHOST, amount_usdc: 5 });
		check('POST for an unknown agent -> 404', r.status === 404, `status ${r.status}`);
	}
	{
		const r = await other.write('POST', '/api/monetization/withdrawals', { agent_id: agentId, amount_usdc: 5 });
		check("POST against someone else's agent -> 403", r.status === 403, `status ${r.status}`);
	}
	{
		const r = await solo.write('POST', '/api/monetization/withdrawals', { agent_id: soloAgentId, amount_usdc: 5 });
		check('a sixth POST in a day is rate limited -> 429', r.status === 429, `status ${r.status}`);
	}

	// seeded revenue events, then a live withdrawal against them
	step('6. seed revenue events');
	const { rows: [ownerRow] } = await db.query('select id from users where email = $1', [ownerEmail]);
	// Revenue events reference a payment intent (FK), so seed real intents.
	for (const [i, [skill, gross, fee, net]] of [
		['echo', 1_000_000, 25_000, 975_000],
		['echo', 2_000_000, 50_000, 1_950_000],
		['summarize', 3_000_000, 75_000, 2_925_000],
	].entries()) {
		const intentId = `proof_intent_${stamp}_${i}`;
		await db.query(
			`insert into agent_payment_intents
				(id, payer_user_id, agent_id, currency_mint, amount, memo, start_time, end_time, status, cluster, payload, expires_at)
			 values ($1, $2, $3, $4, $5, 'proof', now(), now() + interval '1 hour', 'paid', 'mainnet', '{}'::jsonb, now() + interval '1 hour')`,
			[intentId, ownerRow.id, agentId, USDC_SOL, String(gross)],
		);
		await db.query(
			`insert into agent_revenue_events
				(agent_id, intent_id, skill, gross_amount, fee_amount, net_amount, currency_mint, chain, payer_address)
			 values ($1, $2, $3, $4, $5, $6, $7, 'solana', $8)`,
			[agentId, intentId, skill, gross, fee, net, USDC_SOL, 'Payer1111111111111111111111111111111111111'],
		);
	}
	pass('seeded 3 real revenue events', '6.000000 USDC gross across 2 skills');

	step('7. /api/monetization/withdrawals (funded)');
	{
		const r = await http.req('GET', `/api/monetization/withdrawals?agent_id=${agentId}`);
		check('GET balance now reflects the seeded net revenue', r.status === 200 && r.json.balance.available_usdc === 5.85,
			`available ${r.json?.balance?.available_usdc} USDC`);
	}
	{
		const r = await http.write('POST', '/api/monetization/withdrawals', { agent_id: agentId, amount_usdc: 100 });
		check('POST beyond the balance -> 422 insufficient_balance', r.status === 422 && r.json?.error === 'insufficient_balance', `status ${r.status}`);
	}
	{
		const r = await http.write('POST', '/api/monetization/withdrawals', { agent_id: agentId, amount_usdc: 4 });
		// The EVM payout row was saved after the Solana one. Taking the newest row
		// would price this withdrawal in Base USDC, where the balance is zero, and
		// refuse it. Solana is the home chain and the saved preference, so it wins.
		check('POST reserves a pending withdrawal -> 201, on Solana', r.status === 201
			&& r.json?.withdrawal?.status === 'pending'
			&& r.json.withdrawal.amount_atomic === 4_000_000
			&& r.json.withdrawal.chain === 'solana'
			&& r.json.withdrawal.currency_mint === USDC_SOL
			&& r.json.withdrawal.destination_address === SOL_PAYOUT,
			`status ${r.status}, ${r.json?.withdrawal?.amount_usdc} USDC on ${r.json?.withdrawal?.chain} to ${r.json?.withdrawal?.destination_address?.slice(0, 8)}`);
	}
	{
		const r = await http.write('POST', '/api/monetization/withdrawals', { agent_id: agentId, amount_usdc: 4 });
		check('a second identical POST is refused (the pending row is reserved)', r.status === 422 && r.json?.error === 'insufficient_balance',
			`status ${r.status}, ${r.json?.error}`);
	}
	{
		const r = await http.req('GET', `/api/monetization/withdrawals?agent_id=${agentId}`);
		check('GET lists the pending withdrawal and nets it out of available', r.status === 200
			&& r.json.withdrawals.length === 1
			&& r.json.balance.pending_usdc === 4
			&& r.json.balance.available_usdc === 1.85,
			`${r.json?.withdrawals?.length} rows, pending ${r.json?.balance?.pending_usdc}, available ${r.json?.balance?.available_usdc}`);
	}
	{
		const r = await http.req('GET', `/api/monetization/withdrawals?agent_id=${agentId}&status=completed`);
		check('status filter narrows the list', r.status === 200 && r.json.withdrawals.length === 0, `${r.json?.withdrawals?.length} completed`);
	}
	{
		const r = await http.req('GET', `/api/monetization/withdrawals?agent_id=${agentId}&status=bogus-status`);
		check('an unknown status filter -> 400 rather than a silently empty page', r.status === 400, `status ${r.status}`);
	}
	{
		// Regression: a junk `limit` used to bind as NULL, which Postgres reads as
		// "no limit" - the page size silently became the whole table.
		const r = await http.req('GET', `/api/monetization/withdrawals?agent_id=${agentId}&limit=abc&offset=xyz`);
		check('junk limit/offset fall back to the default page, not an unbounded scan',
			r.status === 200 && Array.isArray(r.json?.withdrawals),
			`status ${r.status}, ${r.json?.withdrawals?.length} rows`);
	}
	{
		const r = await http.req('GET', `/api/monetization/withdrawals?agent_id=${agentId}&limit=0`);
		check('limit=0 clamps up to 1 rather than returning nothing', r.status === 200 && r.json.withdrawals.length === 1,
			`${r.json?.withdrawals?.length} rows`);
	}
	{
		const r = await http.req('GET', `/api/monetization/withdrawals?agent_id=${agentId}&offset=1`);
		check('offset pages past the only row', r.status === 200 && r.json.withdrawals.length === 0, `${r.json?.withdrawals?.length} rows`);
	}
	{
		const r = await http.write('POST', '/api/monetization/withdrawals', { agent_id: agentId });
		check('POST with no amount drains the remaining available balance', r.status === 201
			&& r.json?.withdrawal?.amount_atomic === 1_850_000,
			`status ${r.status}, ${r.json?.withdrawal?.amount_usdc} USDC`);
	}
	{
		const r = await http.req('GET', `/api/monetization/withdrawals?agent_id=${agentId}`);
		check('balance is fully reserved after the drain', r.status === 200 && r.json.balance.available_usdc === 0 && r.json.withdrawals.length === 2,
			`available ${r.json?.balance?.available_usdc}, ${r.json?.withdrawals?.length} rows`);
	}
	{
		const { rows } = await db.query('select count(*)::int as n from agent_withdrawals where user_id = $1', [ownerRow.id]);
		check('exactly two withdrawal rows landed in Postgres', rows[0].n === 2, `${rows[0].n} rows`);
	}

	step('8. no stack traces or HTML leaked');
	{
		const bad = [
			await http.req('PUT', '/api/monetization/prices', { body: { nope: true }, headers: { 'x-csrf-token': 'wrong' } }),
			await http.req('POST', '/api/monetization/withdrawals', { body: 'not json', headers: { 'content-type': 'application/json' } }),
			await http.req('PATCH', '/api/monetization/wallet'),
		];
		const leaked = bad.filter((r) => /<html|\bat [A-Za-z$_][\w$.]*\s*\(.*:\d+:\d+\)/.test(r.text));
		check('malformed requests return JSON errors, never a trace or an HTML page', leaked.length === 0,
			`statuses ${bad.map((r) => r.status).join(', ')}`);
	}
	{
		const errs = serverLog.join('').split('\n').filter((l) => /\bfailed:|Unhandled/i.test(l));
		check('server log carries no unhandled handler errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'clean');
	}

	console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
	if (KEEP) {
		console.log(`\nStack left running for manual curl:\n  base:   ${HTTP_BASE}\n  agent:  ${agentId}\n  cookie: ${http.cookieHeader()}\n  pg:     ${PG_URL} (docker rm -f ${PG_CONTAINER} to stop)`);
	}
}

main()
	.then(async () => {
		if (!KEEP) await shutdown();
		process.exit(failed === 0 ? 0 : 1);
	})
	.catch(async (err) => {
		console.error(`\nFATAL: ${err?.stack || err}`);
		const tail = serverLog.join('').split('\n').slice(-40).join('\n').trim();
		if (tail) console.error(`\nserver log (last 40 lines):\n${tail}`);
		if (!KEEP) await shutdown();
		process.exit(1);
	});
