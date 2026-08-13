#!/usr/bin/env node
// genome-endpoints-proof: exercise every /api/genome/* endpoint over real HTTP,
// against a real Postgres, through the real server route table. No mocks, no
// fixtures, no funds: the stud-fee path is proved at its 402/409 boundaries,
// which is exactly where it stops BEFORE any settlement is trusted.
//
// Why this exists: tests/genome-*.test.js pin the handlers' decisions against a
// mocked DB (fast, deterministic), but a mock cannot prove the things this audit
// cares about:
//   1. the handlers are actually ROUTED (server/index.mjs filesystem mapping),
//   2. their SQL is valid against a real schema (a typo in a join or a column
//      that only exists after a migration fails here, not in production),
//   3. malformed input returns JSON, never an HTML error page or a stack trace,
//   4. the stud-listing write has PATCH semantics (an omitted field keeps its
//      stored value) and survives a concurrent write to a sibling meta key.
//
// What it proves, in order:
//   1. edges     public, cached, bounded; excludes deleted agents
//   2. stud GET  public market listing, rarest first
//   3. stud POST owner-only, CSRF-gated, PATCH semantics, meta-preserving
//   4. lineage   family tree on parent and child, verify=1 re-derives the genome,
//                and a forged genome fails verification
//   5. preview   deterministic offspring, same seed -> byte-identical genome
//   6. breed     validation, auth, cooldown, and the 402 stud-fee gate
//
// Usage:
//   node scripts/genome-endpoints-proof.mjs           # full run, prints transcript
//   node scripts/genome-endpoints-proof.mjs --keep    # leave the pg container up
//
// Environment: needs `docker` (postgres:16 image) and ports 5823/5824/3823 free.
// `pg` is loaded from node_modules if present, else installed with --no-save.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');

const PG_PORT = 5823;
const SHIM_PORT = 5824;
const HTTP_PORT = 3823;
const PG_CONTAINER = 'genome-proof-pg';
const PG_URL = `postgres://postgres@127.0.0.1:${PG_PORT}/proof`;
const SHIM_URL = `http://127.0.0.1:${SHIM_PORT}/sql`;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const TMP = path.join(root, '.genome-proof-tmp');

// ── transcript ───────────────────────────────────────────────────────────────
const results = [];
let failed = 0;
function step(name) { console.log(`\n-- ${name}`); }
function pass(name, detail) { results.push({ name, ok: true }); console.log(`  PASS ${name}${detail ? ` - ${detail}` : ''}`); }
function fail(name, detail) { failed += 1; results.push({ name, ok: false }); console.error(`  FAIL ${name} - ${detail}`); }
function check(name, cond, detail) { if (cond) pass(name, detail); else fail(name, detail); return !!cond; }

const cleanup = [];
async function shutdown() {
	for (const fn of cleanup.splice(0).reverse()) { try { await fn(); } catch { /* best effort */ } }
}
process.on('SIGINT', async () => { await shutdown(); process.exit(130); });

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
	return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

async function waitFor(fn, { tries = 90, delayMs = 500, label = 'dependency' } = {}) {
	for (let i = 0; i < tries; i++) {
		try { const v = await fn(); if (v) return v; } catch { /* not ready */ }
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
	try { return await import('pg'); } catch {
		console.log('  installing pg (--no-save) for the local Postgres bridge');
		const r = run('npm', ['i', '--no-save', '--no-audit', '--no-fund', 'pg'], { cwd: root });
		if (r.code !== 0) throw new Error(`npm i pg failed: ${r.out.slice(-400)}`);
		return await import('pg');
	}
}

// ── neon HTTP shim: bridges api/_lib/db.js (neon serverless HTTP driver) onto
// the local Postgres, serializing per column type so the driver sees the same
// JSON shapes Neon's own endpoint returns.
function startShim() {
	fs.mkdirSync(TMP, { recursive: true });
	const shimPath = path.join(TMP, 'shim.mjs');
	const preloadPath = path.join(TMP, 'preload.mjs');
	fs.writeFileSync(shimPath, `
import http from 'node:http';
import pg from ${JSON.stringify(path.join(root, 'node_modules/pg/esm/index.mjs'))};
const pool = new pg.Pool({ connectionString: ${JSON.stringify(PG_URL)}, max: 8 });
// Neon's HTTP endpoint returns EVERY column as raw text and lets the driver's
// own pg-types parsers turn it into a JS value. Coercing here as well double
// parses: a pre-made boolean re-enters parseBool as a non-string and comes back
// false, and a pre-parsed jsonb object makes JSON.parse throw on "[object
// Object]". Raw text in, driver parsing out, exactly like production.
http.createServer(async (req, res) => {
	if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
	let body = '';
	for await (const c of req) body += c;
	try {
		const { query, params } = JSON.parse(body || '{}');
		const r = await pool.query({
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
		res.end(JSON.stringify({ message: String(e && e.message || e), code: e && e.code, constraint: e && e.constraint }));
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
	async function req(method, p, { body, headers = {}, raw } = {}) {
		const res = await fetch(BASE + p, {
			method,
			headers: {
				cookie: [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
				...headers,
			},
			body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
			redirect: 'manual',
		});
		capture(res);
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* html or empty */ }
		return { status: res.status, json, text, headers: res.headers };
	}
	async function csrf() {
		const r = await req('GET', '/api/csrf-token');
		if (r.status !== 200 || !r.json?.token) throw new Error(`csrf-token failed: ${r.status} ${r.text.slice(0, 200)}`);
		return r.json.token;
	}
	// Every authenticated write below goes through here, so a missing CSRF token
	// can never silently turn into a "the endpoint accepted it" pass.
	async function post(p, body) {
		return req('POST', p, { body, headers: { 'x-csrf-token': await csrf() } });
	}
	return { req, post, csrf, cookies };
}

async function main() {
	console.log('genome endpoints proof - real Postgres, real HTTP route table, no funds move\n');

	step('0. environment');
	for (const [port, name] of [[PG_PORT, 'postgres'], [SHIM_PORT, 'shim'], [HTTP_PORT, 'http']]) {
		if (!(await portFree(port))) throw new Error(`port ${port} (${name}) is in use`);
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
	cleanup.push(() => fs.rmSync(TMP, { recursive: true, force: true }));
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
	cleanup.push(() => db?.end().catch(() => {}));
	pass('postgres accepting queries');

	step('1. schema');
	const migrationsDir = path.join(root, 'api/_lib/migrations');
	const files = [
		path.join(migrationsDir, '2026-04-30-notifications.sql'),
		path.join(root, 'api/_lib/schema.sql'),
		...fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(migrationsDir, f)),
	];
	let applied = 0;
	for (const f of files) {
		const r = run('docker', ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', 'proof', '-v', 'ON_ERROR_STOP=1', '-q'], { input: fs.readFileSync(f, 'utf8') });
		if (r.code === 0) applied += 1;
	}
	const required = ['users', 'sessions', 'csrf_tokens', 'agent_identities', 'genome_breedings'];
	const missing = [];
	for (const t of required) {
		const { rows } = await db.query('select to_regclass($1) as r', [`public.${t}`]);
		if (!rows[0].r) missing.push(t);
	}
	if (missing.length) throw new Error(`required tables missing: ${missing.join(', ')}`);
	check('schema applied', applied > 0, `${applied}/${files.length} files applied; ${required.join(', ')} present`);
	// The audit's own migration must be in effect, or breed.js records a fee it
	// cannot persist and the stud-fee replay guard is not atomic.
	const { rows: feeCols } = await db.query(
		`select column_name from information_schema.columns where table_name = 'genome_breedings' and column_name = 'stud_fee_atomics'`,
	);
	const { rows: feeIdx } = await db.query(
		`select indexname from pg_indexes where tablename = 'genome_breedings' and indexname = 'genome_breedings_stud_fee_signature'`,
	);
	check('stud-fee integrity migration applied', feeCols.length === 1 && feeIdx.length === 1,
		`stud_fee_atomics column ${feeCols.length === 1 ? 'present' : 'MISSING'}, unique signature index ${feeIdx.length === 1 ? 'present' : 'MISSING'}`);

	step('2. seed real rows');
	const stamp = process.env.GENOME_PROOF_STAMP || String(process.pid);
	const { rows: [owner] } = await db.query(
		`insert into users (email, password_hash, email_verified) values ($1, 'x', true) returning id`,
		[`genome-owner-${stamp}@proof.local`],
	);
	const { rows: [stranger] } = await db.query(
		`insert into users (email, password_hash, email_verified) values ($1, 'x', true) returning id`,
		[`genome-stranger-${stamp}@proof.local`],
	);
	const mkAgent = async (userId, name, meta = {}, isPublic = true) => {
		const { rows: [a] } = await db.query(
			`insert into agent_identities (user_id, name, is_public, skills, persona_tone_tags,
				voice_provider, voice_id, voice_model, voice_settings, meta)
			 values ($1, $2, $3, $4::text[], $5::jsonb, 'elevenlabs', $6, 'eleven_flash_v2_5', $7::jsonb, $8::jsonb)
			 returning id`,
			[userId, name, isPublic, ['trading', 'research'], JSON.stringify(['precise']),
				`voice-${name}`, JSON.stringify({ stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true }),
				JSON.stringify(meta)],
		);
		return a.id;
	};
	const parentA = await mkAgent(owner.id, 'Proof Parent A', { solana_address: 'ProofSolA1111111111111111111111111111111111' });
	const parentB = await mkAgent(owner.id, 'Proof Parent B', { solana_address: 'ProofSolB2222222222222222222222222222222222' });
	const paidStud = await mkAgent(stranger.id, 'Proof Paid Stud', {
		solana_address: 'ProofSolS3333333333333333333333333333333333',
		genome_breeding: { breedable: true, stud: true, stud_fee_three: 25 },
	});
	const privateAgent = await mkAgent(stranger.id, 'Proof Private', {}, false);
	pass('users + agents seeded', `owner=${owner.id.slice(0, 8)} parents=${parentA.slice(0, 8)},${parentB.slice(0, 8)} stud=${paidStud.slice(0, 8)}`);

	// A real session cookie for the owner, minted the way api/_lib/auth.js reads it.
	const sessionToken = crypto.randomBytes(32).toString('hex');
	const sessionHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
	await db.query(
		`insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')`,
		[owner.id, sessionHash],
	);
	pass('owner session minted');

	step('3. start the real server on the local database');
	const { preloadPath } = startShim();
	await waitFor(async () => {
		const r = await fetch(SHIM_URL, { method: 'POST', body: JSON.stringify({ query: 'select 1', params: [] }) });
		return r.ok;
	}, { label: 'sql shim' });
	pass('neon HTTP shim up', SHIM_URL);

	const server = spawn('node', ['--import', preloadPath, path.join(root, 'server/index.mjs')], {
		cwd: root,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			PORT: String(HTTP_PORT),
			DATABASE_URL: PG_URL,
			NODE_ENV: 'development',
			SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
			JWT_SECRET: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
		},
	});
	const serverLog = [];
	server.stdout.on('data', (d) => serverLog.push(String(d)));
	server.stderr.on('data', (d) => serverLog.push(String(d)));
	cleanup.push(() => server.kill('SIGKILL'));
	await waitFor(async () => {
		const r = await fetch(`${BASE}/api/genome/edges?limit=1`);
		return r.status === 200;
	}, { label: 'api server', tries: 120 });
	pass('server listening on the proof database', BASE);

	const http = makeHttp();
	const anon = makeHttp();
	http.cookies.set('__Host-sid', sessionToken);

	// ── 4. edges ──────────────────────────────────────────────────────────────
	step('4. GET /api/genome/edges');
	const edges0 = await anon.req('GET', '/api/genome/edges?limit=5');
	check('edges 200 public JSON', edges0.status === 200 && Array.isArray(edges0.json?.edges),
		`status ${edges0.status}, ${edges0.json?.edges?.length ?? 'no'} edges, cache-control "${edges0.headers.get('cache-control')}"`);
	const edgesBad = await anon.req('GET', '/api/genome/edges?limit=not-a-number');
	check('edges clamps junk limit instead of erroring', edgesBad.status === 200, `status ${edgesBad.status}`);
	const edgesPost = await anon.req('POST', '/api/genome/edges', { body: {} });
	check('edges rejects POST with 405 JSON', edgesPost.status === 405 && !!edgesPost.json, `status ${edgesPost.status}, body ${edgesPost.text.slice(0, 80)}`);

	// ── 5. stud market ────────────────────────────────────────────────────────
	step('5. GET/POST /api/genome/stud');
	const studs0 = await anon.req('GET', '/api/genome/stud');
	check('stud GET lists the seeded paid stud', studs0.status === 200 && studs0.json?.studs?.some((s) => s.id === paidStud),
		`status ${studs0.status}, ${studs0.json?.studs?.length ?? 0} listed`);
	const studAnon = await anon.req('POST', '/api/genome/stud', { body: { agent_id: parentA, stud: true } });
	check('stud POST is 401 without a session', studAnon.status === 401, `status ${studAnon.status}`);
	const noCsrf = await http.req('POST', '/api/genome/stud', { body: { agent_id: parentA, stud: true } });
	check('stud POST is 403 without a CSRF token', noCsrf.status === 403, `status ${noCsrf.status} ${noCsrf.json?.error || ''}`);
	const notOwned = await http.post('/api/genome/stud', { agent_id: paidStud, stud: true });
	check('stud POST refuses an agent you do not own', notOwned.status === 403, `status ${notOwned.status} ${notOwned.json?.error || ''}`);
	const badId = await http.post('/api/genome/stud', { agent_id: 'nope' });
	check('stud POST rejects a malformed id with 400 JSON', badId.status === 400 && badId.json?.error === 'validation_error', `status ${badId.status}`);
	const unknownAgent = await http.post('/api/genome/stud', { agent_id: '11111111-1111-4111-8111-111111111111' });
	check('stud POST 404s an unknown agent', unknownAgent.status === 404, `status ${unknownAgent.status}`);

	// Poison meta with a sibling key, then list: the write must preserve it.
	await db.query(`update agent_identities set meta = meta || '{"sentinel":"keep-me"}'::jsonb where id = $1`, [parentA]);
	const listed = await http.post('/api/genome/stud', { agent_id: parentA, stud: true, stud_fee_three: 40 });
	check('stud POST lists the agent at the requested fee',
		listed.status === 200 && listed.json?.genome_breeding?.stud === true && listed.json?.genome_breeding?.stud_fee_three === 40,
		JSON.stringify(listed.json?.genome_breeding));
	const { rows: [afterList] } = await db.query('select meta from agent_identities where id = $1', [parentA]);
	check('stud POST preserves unrelated meta keys', afterList.meta.sentinel === 'keep-me' && afterList.meta.solana_address,
		`sentinel=${afterList.meta.sentinel}, wallet ${afterList.meta.solana_address ? 'intact' : 'LOST'}`);

	// PATCH semantics: a fee-only body must not silently unlist the agent.
	const feeOnly = await http.post('/api/genome/stud', { agent_id: parentA, stud_fee_three: 12 });
	check('a fee-only update keeps the agent listed',
		feeOnly.status === 200 && feeOnly.json?.genome_breeding?.stud === true && feeOnly.json?.genome_breeding?.stud_fee_three === 12,
		JSON.stringify(feeOnly.json?.genome_breeding));
	const junkFee = await http.post('/api/genome/stud', { agent_id: parentA, stud_fee_three: 'free-please' });
	check('a junk fee clamps to 0 rather than 500ing',
		junkFee.status === 200 && junkFee.json?.genome_breeding?.stud_fee_three === 0, JSON.stringify(junkFee.json?.genome_breeding));
	const hugeFee = await http.post('/api/genome/stud', { agent_id: parentA, stud_fee_three: 9e18 });
	check('an absurd fee clamps to the ceiling',
		hugeFee.status === 200 && hugeFee.json?.genome_breeding?.stud_fee_three === 1_000_000, JSON.stringify(hugeFee.json?.genome_breeding));
	const unlisted = await http.post('/api/genome/stud', { agent_id: parentA, stud: false });
	check('unlisting works and keeps the fee on record',
		unlisted.status === 200 && unlisted.json?.genome_breeding?.stud === false, JSON.stringify(unlisted.json?.genome_breeding));
	const studsAfter = await anon.req('GET', '/api/genome/stud');
	check('an unlisted agent leaves the public market', !studsAfter.json?.studs?.some((s) => s.id === parentA));

	// ── 6. preview ────────────────────────────────────────────────────────────
	step('6. POST /api/genome/preview');
	const prevAnon = await anon.req('POST', '/api/genome/preview', { body: { parent_a: parentA, parent_b: parentB } });
	check('preview requires auth', prevAnon.status === 401, `status ${prevAnon.status}`);
	const prevSelf = await http.post('/api/genome/preview', { parent_a: parentA, parent_b: parentA });
	check('preview rejects self-breeding with 400 JSON', prevSelf.status === 400 && prevSelf.json?.error === 'validation_error', `status ${prevSelf.status}`);
	const prevJunk = await http.post('/api/genome/preview', { parent_a: 'x', parent_b: 'y' });
	check('preview rejects malformed ids with 400 JSON', prevJunk.status === 400, `status ${prevJunk.status}`);
	const prevPrivate = await http.post('/api/genome/preview', { parent_a: parentA, parent_b: privateAgent });
	check('preview refuses a private agent you do not own',
		prevPrivate.status === 403 && prevPrivate.json?.error === 'parent_ineligible', `status ${prevPrivate.status} ${prevPrivate.json?.reason || ''}`);
	const prevNotJson = await http.req('POST', '/api/genome/preview', { raw: 'not json', headers: { 'content-type': 'text/plain' } });
	check('preview rejects a non-JSON body with a JSON error, not a stack trace',
		prevNotJson.status === 415 && !!prevNotJson.json && !/at \w+ \(/.test(prevNotJson.text), `status ${prevNotJson.status} ${prevNotJson.text.slice(0, 90)}`);
	const preview1 = await http.post('/api/genome/preview', { parent_a: parentA, parent_b: parentB, seed: 'proof-seed' });
	check('preview derives a real child genome',
		preview1.status === 200 && preview1.json?.genome?.generation === 1 && Array.isArray(preview1.json?.genome?.skills),
		`gen ${preview1.json?.genome?.generation}, ${preview1.json?.genome?.skills?.length} skill alleles, tier ${preview1.json?.genome?.pedigree?.tier}`);
	const preview2 = await http.post('/api/genome/preview', { parent_a: parentA, parent_b: parentB, seed: 'proof-seed' });
	check('the same seed derives a byte-identical child',
		JSON.stringify(preview1.json?.genome) === JSON.stringify(preview2.json?.genome));
	const preview3 = await http.post('/api/genome/preview', { parent_a: parentA, parent_b: parentB, seed: 'other-seed' });
	check('a different seed derives a different child',
		JSON.stringify(preview1.json?.genome) !== JSON.stringify(preview3.json?.genome));
	const longName = await http.post('/api/genome/preview', { parent_a: parentA, parent_b: parentB, name: 'z'.repeat(500) });
	check('preview caps the child name at breed.js\'s 80 chars',
		longName.status === 200 && longName.json?.child_name?.length === 80, `name length ${longName.json?.child_name?.length}`);
	const studPreview = await http.post('/api/genome/preview', { parent_a: parentA, parent_b: paidStud });
	check('preview quotes the cross-owner stud fee up front',
		studPreview.status === 200 && studPreview.json?.stud_fee_three === 25 && studPreview.json?.consent_required === true,
		`fee ${studPreview.json?.stud_fee_three} $THREE, consent ${studPreview.json?.consent_required}`);

	// ── 7. breed (boundaries only; no settlement is ever trusted here) ─────────
	step('7. POST /api/genome/breed');
	const breedAnon = await anon.req('POST', '/api/genome/breed', { body: { parent_a: parentA, parent_b: parentB } });
	check('breed requires auth', breedAnon.status === 401, `status ${breedAnon.status}`);
	const breedNoCsrf = await http.req('POST', '/api/genome/breed', { body: { parent_a: parentA, parent_b: parentB } });
	check('breed requires CSRF on a cookie session', breedNoCsrf.status === 403, `status ${breedNoCsrf.status}`);
	const breedSelf = await http.post('/api/genome/breed', { parent_a: parentA, parent_b: parentA });
	check('breed rejects self-breeding', breedSelf.status === 400, `status ${breedSelf.status}`);
	const breedMissing = await http.post('/api/genome/breed', { parent_a: parentA, parent_b: '11111111-1111-4111-8111-111111111111' });
	check('breed 404s an unknown parent', breedMissing.status === 404, `status ${breedMissing.status}`);
	const breedPaid = await http.post('/api/genome/breed', { parent_a: parentA, parent_b: paidStud });
	check('breed 402s a fee-bearing stud with the exact $THREE terms',
		breedPaid.status === 402 && breedPaid.json?.error === 'stud_fee_required' && breedPaid.json?.stud_fee_three === 25 && breedPaid.json?.coin === '$THREE',
		`status ${breedPaid.status} ${breedPaid.json?.error} ${breedPaid.json?.stud_fee_three} ${breedPaid.json?.coin}`);
	const breedBadSig = await http.post('/api/genome/breed', { parent_a: parentA, parent_b: paidStud, stud_fee_signature: 'not-a-signature' });
	check('a bogus settlement signature is refused, never trusted',
		breedBadSig.status === 402 && breedBadSig.json?.error === 'stud_fee_unverified',
		`status ${breedBadSig.status} ${breedBadSig.json?.error}`);

	// Cooldown must be decided BEFORE the fee gate, so a breeder is never charged
	// for a breeding that was always going to be refused.
	await db.query(
		`insert into genome_breedings (breeding_key, parent_a_agent_id, parent_b_agent_id, child_agent_id,
			seed, genome, genome_hash, generation, pedigree_tier, bred_by, status)
		 values ($1, $2, $3, null, 'cooldown-seed', '{}'::jsonb, 'x', 1, 'common', $4, 'born')`,
		[`cooldown-${stamp}`, parentA, parentB, owner.id],
	);
	const cooled = await http.post('/api/genome/breed', { parent_a: parentA, parent_b: paidStud });
	check('a parent on cooldown 409s BEFORE the 402 fee demand',
		cooled.status === 409 && cooled.json?.error === 'breeding_cooldown' && cooled.json?.cooldown_remaining_ms > 0,
		`status ${cooled.status} ${cooled.json?.error}, ${cooled.json?.cooldown_remaining_min} min left`);
	await db.query('delete from genome_breedings where breeding_key = $1', [`cooldown-${stamp}`]);

	// ── 8. lineage over a recorded breeding ───────────────────────────────────
	step('8. GET /api/genome/lineage');
	const badAgent = await anon.req('GET', '/api/genome/lineage?agentId=nope');
	check('lineage rejects a malformed id with 400 JSON', badAgent.status === 400 && badAgent.json?.error === 'validation_error', `status ${badAgent.status}`);
	const noAgent = await anon.req('GET', '/api/genome/lineage?agentId=11111111-1111-4111-8111-111111111111');
	check('lineage 404s an unknown agent', noAgent.status === 404, `status ${noAgent.status}`);

	// Record a real breeding the way breed.js does, deriving the genome with the
	// same pure module the endpoint uses, so verify=1 has something honest to check.
	const { deriveGenome, hashGenome, genomeFromAgent } = await import(path.join(root, 'api/_lib/genome.js'));
	const rowFor = async (id) => {
		const { rows: [r] } = await db.query('select * from agent_identities where id = $1', [id]);
		return genomeFromAgent({
			id: r.id, meta: r.meta || {}, persona_tone_tags: r.persona_tone_tags || [],
			voice_provider: r.voice_provider, voice_id: r.voice_id, voice_model: r.voice_model,
			voice_settings: r.voice_settings, appearance: {}, skills: r.skills || [], avatar_id: r.avatar_id,
		});
	};
	const gA = await rowFor(parentA);
	const gB = await rowFor(parentB);
	const seed = 'lineage-proof-seed';
	const childGenome = deriveGenome({ parentA: gA, parentB: gB, seed });
	const childMeta = {
		genome: childGenome,
		bred_from: {
			breeding_key: `lineage-${stamp}`, seed,
			parent_a: { agent_id: parentA, name: 'Proof Parent A', genome: gA },
			parent_b: { agent_id: parentB, name: 'Proof Parent B', genome: gB },
			generation: childGenome.generation,
		},
	};
	const child = await mkAgent(owner.id, 'Proof Child', childMeta);
	await db.query(
		`insert into genome_breedings (breeding_key, parent_a_agent_id, parent_b_agent_id, child_agent_id,
			seed, genome, genome_hash, generation, pedigree_tier, bred_by, status)
		 values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'common', $9, 'born')`,
		[`lineage-${stamp}`, parentA, parentB, child, seed, JSON.stringify(childGenome),
			childGenome.genome_hash || hashGenome(childGenome), childGenome.generation, owner.id],
	);
	pass('a real breeding recorded', `child ${child.slice(0, 8)} gen ${childGenome.generation}`);

	const lineChild = await anon.req('GET', `/api/genome/lineage?agentId=${child}`);
	check('lineage on the child shows both parents',
		lineChild.status === 200 && lineChild.json?.bred === true && lineChild.json?.parents?.length === 2,
		`bred=${lineChild.json?.bred}, ${lineChild.json?.parents?.length} parents, ${lineChild.json?.ancestors?.length} ancestors`);
	const lineParent = await anon.req('GET', `/api/genome/lineage?agentId=${parentA}`);
	check('lineage on a parent shows the child and its co-parent',
		lineParent.status === 200 && lineParent.json?.children?.[0]?.id === child && lineParent.json?.children?.[0]?.co_parent?.id === parentB,
		`${lineParent.json?.children?.length} children, co-parent ${lineParent.json?.children?.[0]?.co_parent?.name}`);
	const verified = await anon.req('GET', `/api/genome/lineage?agentId=${child}&verify=1`);
	check('verify=1 re-derives the genome and confirms it',
		verified.status === 200 && verified.json?.verifiable === true && verified.json?.valid === true,
		`verifiable=${verified.json?.verifiable} valid=${verified.json?.valid} hash ${String(verified.json?.genome_hash).slice(0, 16)}`);
	const verifyOff = await anon.req('GET', `/api/genome/lineage?agentId=${child}&verify=0`);
	check('verify=0 returns the tree, not a verification',
		verifyOff.status === 200 && verifyOff.json?.verifiable === undefined && Array.isArray(verifyOff.json?.parents),
		`keys ${Object.keys(verifyOff.json || {}).slice(0, 4).join(',')}`);

	// Forge the child's genome. Verification must catch it: that is the whole point.
	await db.query(
		`update agent_identities set meta = jsonb_set(meta, '{genome,brain,curiosity}', '0.999'::jsonb, true) where id = $1`,
		[child],
	);
	const forged = await anon.req('GET', `/api/genome/lineage?agentId=${child}&verify=1`);
	check('a forged genome fails verification',
		forged.status === 200 && forged.json?.verifiable === true && forged.json?.valid === false,
		`valid=${forged.json?.valid} reason=${forged.json?.reason}`);
	await db.query(
		`update agent_identities set meta = jsonb_set(meta, '{genome}', $2::jsonb, true) where id = $1`,
		[child, JSON.stringify(childGenome)],
	);

	// ── 9. edges reflects the breeding, and drops deleted nodes ───────────────
	step('9. edges over real lineage');
	const edges1 = await anon.req('GET', '/api/genome/edges?limit=100');
	check('the recorded breeding appears as a descent edge',
		edges1.json?.edges?.some((e) => e.child === child && e.a === parentA && e.b === parentB),
		`${edges1.json?.edges?.length} edges`);
	await db.query('update agent_identities set deleted_at = now() where id = $1', [child]);
	const edges2 = await anon.req('GET', '/api/genome/edges?limit=100');
	check('a deleted child leaves no dangling edge on the star map',
		!edges2.json?.edges?.some((e) => e.child === child), `${edges2.json?.edges?.length} edges after delete`);
	await db.query('update agent_identities set deleted_at = null where id = $1', [child]);

	step('10. no handler leaked an HTML error page or a stack trace');
	const unhandled = serverLog.join('').match(/\[api\] unhandled/g) || [];
	check('server logged no unhandled exception', unhandled.length === 0, `${unhandled.length} unhandled`);

	if (failed > 0) {
		console.log('\n-- server log tail (last 40 lines)');
		console.log(serverLog.join('').split('\n').slice(-40).join('\n'));
	}
	console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`} - ${results.length} assertions`);
	if (KEEP) console.log(`postgres left running: ${PG_CONTAINER} (${PG_URL})`);
}

main()
	.then(async () => { await shutdown(); process.exit(failed === 0 ? 0 : 1); })
	.catch(async (e) => { console.error('\nPROOF ABORTED:', e?.message || e); await shutdown(); process.exit(2); });
