#!/usr/bin/env node
// retention-metric-proof: prove the week-2 retention metric end to end against a
// REAL Postgres and the REAL server process, over live HTTP. No mocks anywhere in
// the path: the visit is written by the real GET /api/agents/:id handler, the
// rollup is the real cron endpoint behind the real cron gate, and the number is
// read back from the real admin-gated GET /api/analytics/retention.
//
// Why this exists: tests/retention-cohorts.test.js covers the pure arithmetic
// (cohortRecords, summarizeCohorts, the window and ISO-week helpers) against
// in-memory rows, which is fast and deterministic but structurally cannot catch
// the half that only Postgres can answer. The cohort query is a four-CTE
// aggregate with a jsonb regex guard, two correlated EXISTS subqueries and a
// date_trunc that has to agree with the JS isoWeekStart; the visit write is an
// upsert on a composite primary key. None of that is exercised until a real
// database parses it. This script closes that gap.
//
// What it proves, in order:
//   1. an owner opening their own agent writes exactly one coarse visit row
//      (owner, agent, UTC day) through the real HTTP handler, and a second open
//      the same day does not add a row
//   2. a non-owner opening the same agent writes nothing at all
//   3. the rollup cron computes a cohort from those visits and stores absolute
//      dates (cohort_week, window_start, window_end), never a relative offset
//   4. the number discriminates: a second owner who minted in the same week but
//      never came back lands in the denominator and not the numerator, so the
//      cohort reads 1/2 rather than 2/2 or 1/1
//   5. a visit inside the honeymoon week (days 0..6) does NOT count as retention,
//      which is the whole reason the window starts at day 7
//   6. a cohort whose 14-day window has closed is marked complete and carries a
//      final rate, which is what the dashboard's headline and target line read
//   7. re-running the rollup is idempotent (same numbers, no double count)
//   8. the read endpoint is gated: 401 anonymous, 403 signed-in non-admin, and
//      the cohort numbers for an admin
//
// Mint seeding: minting for real is an irreversible on-chain write, so the two
// cohort owners are seeded by stamping the same `meta.onchain.confirmed_at` an
// on-chain registration writes, at an absolute date 8 days back, in a throwaway
// database. Everything downstream of that stamp is the real code path.
//
// Usage:
//   node scripts/retention-metric-proof.mjs           # full run, prints transcript
//   node scripts/retention-metric-proof.mjs --keep    # leave the stack running
//
// Environment: needs `docker` (postgres:16 image) and ports 5851/5852/3851 free.
// `pg` is loaded from node_modules if present, else installed with --no-save.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');

const PG_PORT = 5851;
const SHIM_PORT = 5852;
const HTTP_PORT = 3851;
const PG_CONTAINER = 'retention-metric-proof-pg';
const PG_URL = `postgres://postgres@127.0.0.1:${PG_PORT}/proof`;
const SHIM_URL = `http://127.0.0.1:${SHIM_PORT}/sql`;
const HTTP_BASE = `http://127.0.0.1:${HTTP_PORT}`;
const TMP = path.join(root, '.retention-proof');

const CRON_SECRET = 'retention-proof-cron-secret';

// Absolute day offsets, chosen against the measurement window in
// api/_lib/retention.js: retention counts a visit in days 7..13 after the mint.
// A mint 8 days back puts "today" squarely inside that window, and a mint 2 days
// back puts today inside the honeymoon week the metric deliberately ignores.
const MINT_DAYS_AGO_IN_WINDOW = 8;
const MINT_DAYS_AGO_HONEYMOON = 2;
// A cohort whose 14-day window has already closed, so the rollup can be checked
// against a FINAL number (is_complete = true) and the dashboard has a real rate
// to draw. 20 days back puts the whole window in the past; the visit lands on
// day 9, inside days 7..13.
const MINT_DAYS_AGO_CLOSED = 20;
const CLOSED_VISIT_DAY_OFFSET = 9;

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

// process helpers
const cleanup = [];
// Server stdout/stderr, kept at module scope so an abort can print why the
// server failed instead of leaving only the client-side symptom.
const serverLog = [];
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

// Absolute path to pg's ESM entry, read from its own export map rather than
// assumed. The shim runs as a generated file and has to import pg by path, and
// the layout differs across pg majors, so hardcoding `pg/esm/index.mjs` breaks
// on a version bump in a way that only surfaces as a shim timeout.
function pgEsmEntry() {
	const pkgPath = fs.realpathSync(path.join(root, 'node_modules/pg/package.json'));
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	const entry = pkg?.exports?.['.']?.import || pkg?.module || pkg?.main;
	if (!entry) throw new Error('cannot resolve pg ESM entry from its package.json');
	return path.join(path.dirname(pkgPath), entry);
}

// neon HTTP shim: bridges api/_lib/db.js (neon serverless HTTP driver) onto the
// local Postgres. Column values are serialized per type OID so the driver sees
// the same JSON shapes Neon's own endpoint returns.
function startShim() {
	fs.mkdirSync(TMP, { recursive: true });
	const preloadPath = path.join(TMP, 'preload.mjs');
	const shimPath = path.join(TMP, 'shim.mjs');
	fs.writeFileSync(shimPath, `
import http from 'node:http';
import pg from ${JSON.stringify(pgEsmEntry())};
const pool = new pg.Pool({ connectionString: ${JSON.stringify(PG_URL)}, max: 8 });
// Values go back as raw Postgres wire text, exactly as Neon's own HTTP endpoint
// returns them. The driver runs pg-types' parser per column OID on what it
// receives (processQueryResult in @neondatabase/serverless), so coercing here
// would double-parse: a jsonb column would arrive as an object and blow up on
// JSON.parse("[object Object]"), and a bool would arrive as \`true\` and fail the
// parser's \`v === 't'\` test, silently reading false. Pass through and let the
// real driver do the real conversion.
function coerce(value) {
	return value === null || value === undefined ? null : value;
}
http.createServer(async (req, res) => {
	if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
	let body = '';
	for await (const c of req) body += c;
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
				rows: r.rows.map((row) => row.map((v) => coerce(v))),
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

// HTTP client with a cookie jar
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
	async function req(method, p, { body, headers = {}, anonymous = false } = {}) {
		const res = await fetch(HTTP_BASE + p, {
			method,
			headers: {
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
	async function write(method, p, body) {
		return req(method, p, { body, headers: { 'x-csrf-token': await csrf() } });
	}
	return { req, write };
}

/** Absolute `YYYY-MM-DD` for `days` before now, matching utcDay() in the lib. */
function daysAgo(days) {
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** ISO-week Monday (UTC) of an absolute day, mirroring isoWeekStart() in the lib. */
function isoWeekStart(day) {
	const d = new Date(`${day}T00:00:00Z`);
	const offset = (d.getUTCDay() + 6) % 7;
	return new Date(d.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
}

async function main() {
	console.log('retention metric proof - real Postgres, real server, live HTTP, nothing minted on-chain\n');

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
	const mustHave = ['users', 'sessions', 'csrf_tokens', 'agent_identities', 'agent_owner_visits', 'agent_retention_cohorts'];
	const missing = [];
	for (const t of mustHave) {
		const { rows } = await db.query('select to_regclass($1) as r', [`public.${t}`]);
		if (!rows[0].r) missing.push(t);
	}
	check('schema applied', applied > 0 && missing.length === 0,
		`${applied} files applied, ${skipped.length} skipped from drift; both retention tables present`);
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
			JWT_SECRET: 'retention-proof-jwt-secret',
			CRON_SECRET,
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

	// Three real users through the real registration flow: two cohort owners who
	// mint in the same ISO week (one returns, one does not) and one unrelated
	// signed-in visitor used to prove non-owners are never tracked.
	step('3. real users and agents');
	const stamp = Date.now();
	const retained = makeHttp();
	const lapsed = makeHttp();
	const visitor = makeHttp();
	const closed = makeHttp();

	const users = [
		['retained owner', retained, `ret-owner-${stamp}@proof.local`],
		['lapsed owner', lapsed, `lapsed-owner-${stamp}@proof.local`],
		['unrelated visitor', visitor, `visitor-${stamp}@proof.local`],
		['closed-cohort owner', closed, `closed-owner-${stamp}@proof.local`],
	];
	for (const [label, client, email] of users) {
		const r = await client.req('POST', '/api/auth/register', { body: { email, password: 'proof-pass-12345', tosAccepted: true } });
		check(`${label} registered through the real /register flow`, r.status < 300,
			r.status < 300 ? email : `status ${r.status}: ${r.text.slice(0, 200)}`);
	}

	async function createAgent(client, name) {
		const created = await client.write('POST', '/api/agents', { name, description: 'week-2 retention proof' });
		const id = created.json?.agent?.id || created.json?.data?.id || created.json?.id;
		if (!id) throw new Error(`agent create failed: ${created.status} ${created.text.slice(0, 200)}`);
		return id;
	}
	const retainedAgent = await createAgent(retained, `ret-agent-${stamp}`);
	const lapsedAgent = await createAgent(lapsed, `lapsed-agent-${stamp}`);
	const honeymoonAgent = await createAgent(visitor, `honeymoon-agent-${stamp}`);
	const closedAgent = await createAgent(closed, `closed-agent-${stamp}`);
	pass('four agents created through the real API');

	// Seed the mint stamp. Minting for real is an irreversible on-chain write, so
	// the proof writes the same `meta.onchain.confirmed_at` an on-chain
	// registration writes, at an absolute date, in a throwaway database.
	const inWindowMint = `${daysAgo(MINT_DAYS_AGO_IN_WINDOW)}T12:00:00Z`;
	const honeymoonMint = `${daysAgo(MINT_DAYS_AGO_HONEYMOON)}T12:00:00Z`;
	const closedMint = `${daysAgo(MINT_DAYS_AGO_CLOSED)}T12:00:00Z`;
	for (const [agentId, mintedAt] of [
		[retainedAgent, inWindowMint],
		[lapsedAgent, inWindowMint],
		[honeymoonAgent, honeymoonMint],
		[closedAgent, closedMint],
	]) {
		await db.query(
			`update agent_identities
			    set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('onchain', jsonb_build_object('chain', 'solana', 'confirmed_at', $2::text))
			  where id = $1`,
			[agentId, mintedAt],
		);
	}
	pass('mint stamps seeded', `two owners at ${inWindowMint} (day ${MINT_DAYS_AGO_IN_WINDOW}), one at ${honeymoonMint} (day ${MINT_DAYS_AGO_HONEYMOON}), one at ${closedMint} (day ${MINT_DAYS_AGO_CLOSED})`);

	// One historical visit, written directly. Every other visit in this proof goes
	// through the real HTTP handler, but that handler can only ever stamp TODAY,
	// and a cohort whose window has closed needs a visit dated inside a window that
	// ended days ago. Waiting 14 days is not an option, so the row is seeded at an
	// absolute past date in the exact shape recordAgentOwnerVisit writes. It is
	// what gives the rollup a final (is_complete) number and the dashboard a real
	// rate to draw.
	const closedVisitDay = daysAgo(MINT_DAYS_AGO_CLOSED - CLOSED_VISIT_DAY_OFFSET);
	await db.query(
		`insert into agent_owner_visits (user_id, agent_id, visit_day, viewed, conversed, first_seen_at, last_seen_at)
		 values ((select user_id from agent_identities where id = $1), $1, $2::date, true, true, $2::timestamptz, $2::timestamptz)`,
		[closedAgent, closedVisitDay],
	);
	pass('historical conversing visit seeded', `${closedVisitDay} (day ${CLOSED_VISIT_DAY_OFFSET} after that owner's mint)`);

	step('4. the return-visit signal');
	const today = daysAgo(0);
	{
		const r = await retained.req('GET', `/api/agents/${retainedAgent}`);
		check('owner opens their own agent -> 200', r.status === 200, `status ${r.status}`);
	}
	// The write is detached (queueMicrotask) so it lands just after the response.
	const visitRow = await waitFor(async () => {
		const { rows } = await db.query(
			'select viewed, conversed, visit_day::text as visit_day from agent_owner_visits where user_id = (select user_id from agent_identities where id = $1) and agent_id = $1',
			[retainedAgent],
		);
		return rows.length ? rows[0] : false;
	}, { tries: 40, delayMs: 250, label: 'owner visit row' });
	check('a real return visit landed in the store', !!visitRow,
		`visit_day ${visitRow.visit_day}, viewed=${visitRow.viewed}, conversed=${visitRow.conversed}`);
	check('visit day is the absolute UTC day', visitRow.visit_day === today, `${visitRow.visit_day} === ${today}`);

	// A second open the same day must not add a row: the composite primary key
	// makes the write an upsert, so a heavy session stays one row.
	await retained.req('GET', `/api/agents/${retainedAgent}`);
	await new Promise((r) => setTimeout(r, 750));
	{
		const { rows } = await db.query('select count(*)::int as n from agent_owner_visits where agent_id = $1', [retainedAgent]);
		check('a second open the same day is still one row', rows[0].n === 1, `${rows[0].n} row(s)`);
	}

	// A signed-in non-owner is not tracked at all.
	{
		const r = await visitor.req('GET', `/api/agents/${retainedAgent}`);
		await new Promise((res) => setTimeout(res, 750));
		const { rows } = await db.query('select count(*)::int as n from agent_owner_visits where agent_id = $1', [retainedAgent]);
		check('a non-owner viewing the agent writes nothing', r.status === 200 && rows[0].n === 1,
			`GET ${r.status}, still ${rows[0].n} row(s) for the agent`);
	}

	// The honeymoon owner DOES come back, but only 2 days after minting, which is
	// inside days 0..6 and must not count toward retention.
	{
		await visitor.req('GET', `/api/agents/${honeymoonAgent}`);
		await waitFor(async () => {
			const { rows } = await db.query('select count(*)::int as n from agent_owner_visits where agent_id = $1', [honeymoonAgent]);
			return rows[0].n === 1;
		}, { tries: 40, delayMs: 250, label: 'honeymoon visit row' });
		pass('honeymoon-week owner also has a real visit row');
	}

	// The lapsed owner never opens their agent, so they stay in the denominator
	// and out of the numerator. Nothing to do here beyond asserting the absence.
	{
		const { rows } = await db.query('select count(*)::int as n from agent_owner_visits where agent_id = $1', [lapsedAgent]);
		check('the lapsed owner has no visit row', rows[0].n === 0, `${rows[0].n} row(s)`);
	}

	step('5. the rollup cron');
	{
		const r = await fetch(`${HTTP_BASE}/api/cron/retention-rollup`);
		check('cron endpoint refuses an unauthenticated caller', r.status === 401 || r.status === 403,
			`status ${r.status}`);
	}
	let cohortWeek = null;
	{
		const r = await fetch(`${HTTP_BASE}/api/cron/retention-rollup`, {
			headers: { authorization: `Bearer ${CRON_SECRET}` },
		});
		const body = await r.json().catch(() => null);
		check('rollup runs behind the real cron gate', r.status === 200 && body?.ok === true,
			`status ${r.status}, cohorts=${body?.cohorts}, written=${body?.written}, errors=${body?.errors}`);
		check('rollup wrote cohort rows', (body?.written ?? 0) > 0 && (body?.errors ?? 1) === 0,
			`${body?.written} row(s) written, ${body?.errors} error(s)`);
	}
	{
		const expectedWeek = isoWeekStart(daysAgo(MINT_DAYS_AGO_IN_WINDOW));
		const { rows } = await db.query(
			`select cohort_week::text as cohort_week, metric, minted_owners, retained_owners,
			        retention_rate, window_start::text as window_start, window_end::text as window_end,
			        is_complete, computed_at
			   from agent_retention_cohorts
			  where cohort_week = $1::date
			  order by metric`,
			[expectedWeek],
		);
		cohortWeek = expectedWeek;
		const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r]));
		check('the in-window cohort exists at its absolute ISO week', rows.length === 2,
			`cohort_week ${expectedWeek}, metrics ${rows.map((r) => r.metric).join(', ')}`);

		const ret = byMetric.week2_return;
		if (ret) {
			// Two owners minted that week; exactly one came back inside days 7..13.
			check('the cohort number discriminates: 1 of 2 owners retained',
				Number(ret.minted_owners) === 2 && Number(ret.retained_owners) === 1 && Math.abs(Number(ret.retention_rate) - 0.5) < 1e-9,
				`minted=${ret.minted_owners}, retained=${ret.retained_owners}, rate=${ret.retention_rate}`);
			check('stored dates are absolute, not relative',
				/^\d{4}-\d{2}-\d{2}$/.test(ret.window_start) && /^\d{4}-\d{2}-\d{2}$/.test(ret.window_end) && !!ret.computed_at,
				`window ${ret.window_start} .. ${ret.window_end}, computed_at ${new Date(ret.computed_at).toISOString()}`);
			check('an open window is flagged incomplete', ret.is_complete === false,
				`is_complete=${ret.is_complete} (the day-14 boundary has not passed yet)`);
		} else {
			fail('week2_return cohort row', 'missing');
		}

		// The honeymoon owner minted 2 days ago, so their own cohort week exists but
		// their day-2 visit sits outside the day 7..13 window and must not count.
		const honeymoonWeek = isoWeekStart(daysAgo(MINT_DAYS_AGO_HONEYMOON));
		const { rows: hRows } = await db.query(
			`select minted_owners, retained_owners from agent_retention_cohorts
			  where cohort_week = $1::date and metric = 'week2_return'`,
			[honeymoonWeek],
		);
		if (honeymoonWeek === expectedWeek) {
			pass('honeymoon owner shares the in-window cohort', 'covered by the 1-of-2 assertion above');
		} else {
			check('a visit inside the honeymoon week does not count as retention',
				hRows.length === 1 && Number(hRows[0].retained_owners) === 0,
				hRows.length ? `minted=${hRows[0].minted_owners}, retained=${hRows[0].retained_owners}` : 'cohort row missing');
		}
	}
	{
		// The closed cohort: its window ended days ago, so its number is FINAL.
		const closedWeek = isoWeekStart(daysAgo(MINT_DAYS_AGO_CLOSED));
		const { rows } = await db.query(
			`select minted_owners, retained_owners, retention_rate, is_complete,
			        window_start::text as window_start, window_end::text as window_end
			   from agent_retention_cohorts
			  where cohort_week = $1::date and metric = 'week2_converse'`,
			[closedWeek],
		);
		const c = rows[0];
		check('a cohort whose window has closed is marked complete',
			!!c && c.is_complete === true,
			c ? `${closedWeek}: window ${c.window_start} .. ${c.window_end}, is_complete=${c.is_complete}` : 'cohort row missing');
		check('the closed cohort carries a final converse rate',
			!!c && Number(c.minted_owners) === 1 && Number(c.retained_owners) === 1 && Math.abs(Number(c.retention_rate) - 1) < 1e-9,
			c ? `retained ${c.retained_owners}/${c.minted_owners} = ${c.retention_rate}` : 'cohort row missing');
	}
	{
		// Idempotence: the rollup recomputes a trailing window every run, so a
		// re-run must converge on the same numbers rather than double count.
		const before = await db.query('select cohort_week::text, metric, minted_owners, retained_owners from agent_retention_cohorts order by cohort_week, metric');
		const r = await fetch(`${HTTP_BASE}/api/cron/retention-rollup`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
		await r.json().catch(() => null);
		const after = await db.query('select cohort_week::text, metric, minted_owners, retained_owners from agent_retention_cohorts order by cohort_week, metric');
		check('a second rollup run is idempotent',
			JSON.stringify(before.rows) === JSON.stringify(after.rows),
			`${after.rows.length} cohort row(s), unchanged`);
	}

	step('6. the read endpoint');
	{
		const r = await fetch(`${HTTP_BASE}/api/analytics/retention?metric=week2_return`);
		check('anonymous read -> 401', r.status === 401, `status ${r.status}`);
	}
	{
		const r = await visitor.req('GET', '/api/analytics/retention?metric=week2_return');
		check('signed-in non-admin read -> 403', r.status === 403, `status ${r.status}`);
	}
	{
		// Promote the visitor to admin the same way the platform does: the
		// is_admin column api/_lib/admin.js reads.
		await db.query(`update users set is_admin = true where email = $1`, [`visitor-${stamp}@proof.local`]);
		const r = await visitor.req('GET', '/api/analytics/retention?metric=week2_return&weeks=12');
		const cohorts = r.json?.cohorts ?? [];
		const mine = cohorts.find((c) => c.cohort_week === cohortWeek);
		check('admin read -> 200 with the cohort series', r.status === 200 && cohorts.length > 0,
			`status ${r.status}, ${cohorts.length} cohort(s), metric ${r.json?.metric}`);
		check('the served cohort carries the same real number',
			!!mine && mine.minted_owners === 2 && mine.retained_owners === 1 && Math.abs(mine.retention_rate - 0.5) < 1e-9,
			mine ? `${mine.cohort_week}: ${mine.retained_owners}/${mine.minted_owners} = ${mine.retention_rate}` : 'cohort not served');
		check('the roadmap target ships with the payload', r.json?.target === 0.3,
			`target ${r.json?.target}`);
		check('summary counts only the cohort whose window closed',
			r.json?.summary?.completeCohorts === 1,
			`completeCohorts=${r.json?.summary?.completeCohorts}, latestRate=${r.json?.summary?.latestRate}, pooledRate=${r.json?.summary?.pooledRate}`);
	}

	step('7. result');
	if (failed > 0) {
		console.error(`\n${failed} check(s) failed. Last server output:\n${serverLog.slice(-12).join('')}`);
	} else {
		console.log('\nAll checks passed: a real return visit lands in the store, the rollup computes a real cohort number, and the dashboard endpoint serves it.');
	}
	return failed;
}

let code = 1;
try {
	code = (await main()) > 0 ? 1 : 0;
} catch (err) {
	console.error(`\nproof aborted: ${err?.stack || err}`);
	if (serverLog.length) console.error(`\nLast server output:\n${serverLog.slice(-20).join('')}`);
	code = 1;
} finally {
	if (KEEP) console.log(`\n--keep: stack left running (postgres :${PG_PORT}, server ${HTTP_BASE}). Remove with: docker rm -f ${PG_CONTAINER}`);
	else await shutdown();
}
process.exit(code);
