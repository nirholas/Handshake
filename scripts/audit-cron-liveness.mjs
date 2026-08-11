#!/usr/bin/env node
// Prove every cron declared in vercel.json is actually ALIVE, that its handler
// exists, resolves through the real route table, loads, and runs.
//
// WHY THIS EXISTS. `scripts/check-cron-drift.mjs` already answers "is the
// schedule valid, and is Cloud Scheduler running it?". It cannot answer the
// question that actually breaks production: Cloud Scheduler fires the job on
// time, the request reaches the server, and the server 404s it, or imports a
// handler that throws at module scope. From the outside a silently dead cron is
// indistinguishable from a healthy one: the job shows ENABLED, the schedule
// matches, and nothing ever happens. That exact gap killed all 30+ dispatcher
// jobs (payouts, subscriptions, buybacks, pumpfun monitors) until July 2026,
// because vercel.json's legacy `routes` array does not auto-route the
// `[name]` dynamic segment.
//
// This script closes it, in four stages per cron:
//   1. ROUTE: walk vercel.json's phase-1 rules with the production resolver
//                 (server/route-resolve.mjs, the same module server/index.mjs
//                 imports) and see what path the functions phase receives.
//   2. HANDLER: resolve that path to a file under api/ with Vercel's
//                 filesystem-routing precedence. No file = DEAD.
//   3. LOAD: import the module and confirm a callable default export.
//                 A module-scope throw = DEAD.
//   4. RUN: boot the real server and invoke the cron URL with NO
//                 Authorization header, then classify the response.
//
// SAFETY. The probe is deliberately UNAUTHENTICATED. Every cron handler in this
// repo gates on `CRON_SECRET` and fails closed (401 on mismatch, 503 when the
// secret is unset), so an unauthenticated probe proves the handler loaded and
// ran its first statements WITHOUT executing the job body. Nothing is paid,
// swapped, minted, transferred, or written. A cron that answers 200 to an
// unauthenticated request is therefore not a pass, it is reported as UNGATED,
// which is a security finding in its own right. `--verify-gate` additionally
// sends a deliberately WRONG bearer token to prove the comparison rejects it.
//
// Schedule-expression validity and Cloud Scheduler drift are NOT re-implemented
// here: this script shells out to check-cron-drift.mjs and folds its verdict in,
// so there stays exactly one implementation of each check.
//
// Usage:
//   node scripts/audit-cron-liveness.mjs                # static + boot + probe
//   node scripts/audit-cron-liveness.mjs --static       # no server, no probe
//   node scripts/audit-cron-liveness.mjs --base=https://three.ws
//   node scripts/audit-cron-liveness.mjs --verify-gate  # also probe a bad token
//   node scripts/audit-cron-liveness.mjs --json
//   node scripts/audit-cron-liveness.mjs --drift        # include the live
//                                                       # Cloud Scheduler diff
//
// Exits non-zero when any cron is DEAD, BROKEN, or UNGATED.

import { readFileSync, existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import {
	loadRouteTable,
	resolvePhase1,
	resolveApiHandler,
} from '../server/route-resolve.mjs';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ROOT = path.join(ROOT, 'api');

const argv = process.argv.slice(2);
const STATIC_ONLY = argv.includes('--static');
const AS_JSON = argv.includes('--json');
const VERIFY_GATE = argv.includes('--verify-gate');
const WITH_DRIFT = argv.includes('--drift');
const baseArg = argv.find((a) => a.startsWith('--base='));
const BASE = baseArg ? baseArg.slice('--base='.length).replace(/\/+$/, '') : null;

// A cron request as Cloud Scheduler sends it, minus the credential. Some routes
// in the table gate on headers (`has`), so the probe must carry a realistic
// shape or it would resolve down a path production never takes.
const CRON_UA = 'vercel-cron/1.0';
const cronReqShape = { method: 'GET', headers: { 'user-agent': CRON_UA, host: 'three.ws' } };

// ---------------------------------------------------------------------------
// Stage 1-3: static resolution
// ---------------------------------------------------------------------------

const { phase1Routes } = loadRouteTable(path.join(ROOT, 'vercel.json'));
const { crons } = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

if (!Array.isArray(crons) || !crons.length) {
	console.error('No crons declared in vercel.json.');
	process.exit(1);
}

/** Walk the production phase-1 rules and report where the request lands. */
function routeOf(cronPath) {
	const url = new URL(cronPath, 'https://three.ws');
	const r = resolvePhase1(phase1Routes, cronReqShape, url);
	return r;
}

const results = [];
for (const { path: cronPath, schedule } of crons) {
	const row = {
		path: cronPath,
		schedule,
		routedTo: null,
		rewritten: false,
		handler: null,
		params: null,
		loads: null,
		loadError: null,
		probe: null,
		verdict: 'UNKNOWN',
		notes: [],
	};

	const phase = routeOf(cronPath);

	if (phase.terminal === 'status') {
		row.verdict = 'DEAD';
		row.notes.push(`route table answers ${phase.status} before the functions phase`);
		results.push(row);
		continue;
	}
	if (phase.terminal === 'external') {
		row.verdict = 'DEAD';
		row.notes.push(`route table proxies this path to ${phase.external}, so no handler runs`);
		results.push(row);
		continue;
	}

	row.routedTo = phase.path;
	row.rewritten = phase.path !== cronPath;
	if (Object.keys(phase.extraQuery).length) row.destQuery = phase.extraQuery;

	if (!phase.path.startsWith('/api/')) {
		row.verdict = 'DEAD';
		row.notes.push(`route table rewrites this to "${phase.path}", which is not an API path`);
		results.push(row);
		continue;
	}

	const hit = resolveApiHandler(API_ROOT, phase.path);
	if (!hit) {
		row.verdict = 'DEAD';
		row.notes.push(`no handler file under api/ resolves ${phase.path}`);
		results.push(row);
		continue;
	}
	row.handler = path.relative(ROOT, hit.file);
	if (Object.keys(hit.params).length) row.params = hit.params;
	results.push(row);
}

// Stage 3: load each distinct handler module once.
//
// Importing ~75 handlers pulls in the whole dependency graph (ethers, viem, the
// Solana SDKs, the pump.fun stack) and blows the default 2 GB heap, the audit
// died with exit 144 before reporting anything, which is exactly the kind of
// silent nothing this script exists to eliminate. The imports therefore run in a
// dedicated child with a raised heap, and the parent only reads its verdict.
async function loadHandlersInChild(files) {
	const { stdout } = await execFileP(
		process.execPath,
		['--max-old-space-size=4096', fileURLToPath(import.meta.url), '--load-probe', ...files],
		{ cwd: ROOT, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 },
	).catch((e) => ({ stdout: e.stdout || '' }));
	try {
		return JSON.parse(stdout.slice(stdout.indexOf('{')));
	} catch {
		return Object.fromEntries(
			files.map((f) => [f, { ok: false, error: 'load probe subprocess produced no verdict' }]),
		);
	}
}

if (argv.includes('--load-probe')) {
	// Child mode: import each file, report whether it exposes a callable default.
	const files = argv.slice(argv.indexOf('--load-probe') + 1);
	const out = {};
	for (const f of files) {
		try {
			const mod = await import(pathToFileURL(path.join(ROOT, f)).href);
			out[f] =
				typeof mod.default === 'function'
					? { ok: true }
					: { ok: false, error: 'module has no callable default export' };
		} catch (err) {
			out[f] = { ok: false, error: String(err?.message || err).split('\n')[0] };
		}
	}
	process.stdout.write(JSON.stringify(out));
	process.exit(0);
}

const handlerFiles = [...new Set(results.map((r) => r.handler).filter(Boolean))];
const loadVerdicts = await loadHandlersInChild(handlerFiles);

for (const row of results) {
	if (!row.handler) continue;
	const r = loadVerdicts[row.handler] || { ok: false, error: 'no verdict returned' };
	row.loads = r.ok;
	if (!r.ok) {
		row.loadError = r.error;
		row.verdict = 'DEAD';
		row.notes.push(`handler module fails to load: ${r.error}`);
	}
}

// ---------------------------------------------------------------------------
// Stage 4: run it
// ---------------------------------------------------------------------------

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

async function waitForHealth(base, deadlineMs = 60_000) {
	const until = Date.now() + deadlineMs;
	while (Date.now() < until) {
		try {
			const res = await fetch(`${base}/api/healthz`, { signal: AbortSignal.timeout(4000) });
			if (res.ok) return true;
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

let child = null;
let base = BASE;
let bootError = null;

if (!STATIC_ONLY && !base) {
	const port = await freePort();
	const args = [];
	// The gates fail CLOSED without CRON_SECRET (503 "not_configured"), which
	// would read as a broken cron rather than a healthy gated one. Load .env when
	// it exists so the probe sees the same gate production has.
	if (existsSync(path.join(ROOT, '.env'))) args.push(`--env-file=${path.join(ROOT, '.env')}`);
	args.push(path.join(ROOT, 'server', 'index.mjs'));
	child = spawn(process.execPath, args, {
		cwd: ROOT,
		env: { ...process.env, PORT: String(port), NODE_ENV: process.env.NODE_ENV || 'production' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const serverLog = [];
	child.stdout.on('data', (d) => serverLog.push(String(d)));
	child.stderr.on('data', (d) => serverLog.push(String(d)));
	base = `http://127.0.0.1:${port}`;
	const up = await waitForHealth(base);
	if (!up) {
		bootError = `server did not answer /api/healthz on ${base}\n${serverLog.join('').slice(-2000)}`;
		base = null;
	}
	globalThis.__cronAuditServerLog = serverLog;
}

/**
 * Classify one probe response.
 *
 * 401/403          → ALIVE: the handler ran and its auth gate rejected us.
 * 503 not_configured → ALIVE: the gate ran but CRON_SECRET is missing locally.
 * 405              → ALIVE: the method gate ran (crons are invoked with GET by
 *                    Cloud Scheduler, so a GET-rejecting handler is a real bug,
 *                    flagged separately).
 * 404 not_found    → DEAD: nothing routes this path (the killer case).
 * 404 other        → ALIVE: the handler itself chose to answer 404.
 * 5xx              → BROKEN: the handler threw.
 * 2xx + skip marker→ SKIPPED: wrapCron short-circuited BEFORE the auth gate.
 * 2xx              → UNGATED: it executed for an anonymous caller.
 *
 * The SKIPPED case is subtle and was worth a verdict of its own. `wrapCron`
 * runs its storage-pressure probe BEFORE the handler body, so a cron built with
 * `{ requireWriteCapacity: true }` answers 200 {ok:true, skipped:
 * 'db_at_storage_cap'} to ANY caller, credential or not, whenever the database
 * is over DB_RETENTION_HIGH_WATER_MB. Reading that as UNGATED is wrong (nothing
 * ran, no gate was bypassed) and reading it as ALIVE is also wrong (the job is
 * doing nothing on every tick). It is its own state: reachable, but inert. The
 * same applies to wrapCron's db_unavailable / db_full degradation.
 */
const SKIP_MARKERS = ['db_at_storage_cap', 'db_unavailable', 'db_full'];

function classify(status, body) {
	const err = body && typeof body === 'object' ? String(body.error || '') : '';
	if (status === 401 || status === 403) return { verdict: 'ALIVE', why: `auth gate rejected (${status})` };
	if (status === 503 && /not_configured/.test(err))
		return { verdict: 'ALIVE', why: '503 not_configured (gate ran; CRON_SECRET unset in this env)' };
	if (status === 405) return { verdict: 'ALIVE', why: '405 method gate ran' };
	if (status === 404) {
		if (/^not_found$/.test(err)) return { verdict: 'DEAD', why: '404 no API route matches this path' };
		return { verdict: 'ALIVE', why: `handler answered 404 (${err || 'no error code'})` };
	}
	if (status >= 500) return { verdict: 'BROKEN', why: `handler returned ${status} ${err}` };
	if (status >= 200 && status < 300) {
		const marker = body && typeof body === 'object' ? String(body.skipped || body.reason || '') : '';
		if (SKIP_MARKERS.includes(marker)) {
			return {
				verdict: 'SKIPPED',
				why: `200 ${marker}, wrapCron short-circuited before the handler body; the job is doing nothing`,
			};
		}
		return { verdict: 'UNGATED', why: `${status} to an unauthenticated caller, the job body ran` };
	}
	return { verdict: 'BROKEN', why: `unexpected ${status} ${err}` };
}

async function probe(url, headers = {}) {
	const res = await fetch(url, {
		method: 'GET',
		headers: { 'user-agent': CRON_UA, ...headers },
		redirect: 'manual',
		signal: AbortSignal.timeout(45_000),
	});
	let body = null;
	const text = await res.text().catch(() => '');
	try {
		body = JSON.parse(text);
	} catch {
		body = { raw: text.slice(0, 200) };
	}
	return { status: res.status, body };
}

let probeAborted = false;

if (base) {
	// Serial, not parallel: a hundred concurrent handler imports on one process
	// makes a slow cold import look like a timeout, and the point of this stage
	// is to tell a real failure from a slow one.
	for (const row of results) {
		if (row.verdict === 'DEAD') continue; // static stage already proved it
		try {
			const r = await probe(`${base}${row.path}`);
			const c = classify(r.status, r.body);
			row.probe = {
				status: r.status,
				error: r.body?.error ?? null,
				skipped: r.body?.skipped ?? r.body?.reason ?? null,
				why: c.why,
			};
			row.verdict = c.verdict;
			if (c.verdict === 'ALIVE' && r.status === 405) {
				row.notes.push('handler rejects GET; Cloud Scheduler invokes crons with GET');
			}
			if (c.verdict === 'SKIPPED') {
				row.notes.push(
					r.body?.high_water_mb
						? `db ${r.body.size_mb ?? '?'}MB vs high-water ${r.body.high_water_mb}MB. DB_RETENTION_HIGH_WATER_MB is read from THIS env; confirm production's value before calling it an outage.`
						: 'confirm whether this env matches production before calling it an outage',
				);
			}
		} catch (err) {
			// A transport-level failure is ambiguous: it can mean this handler hung,
			// or that the server died and every remaining probe will "fail" too.
			// Re-check health before blaming the cron: without this, one crashed
			// server turns into a report of ~90 phantom dead crons, which is exactly
			// the false signal this audit exists to remove.
			const serverUp = await fetch(`${base}/api/healthz`, { signal: AbortSignal.timeout(5000) })
				.then((r) => r.ok)
				.catch(() => false);
			row.probe = { status: null, error: String(err?.message || err) };
			if (serverUp) {
				row.verdict = 'BROKEN';
				row.notes.push(`probe failed while the server stayed healthy: ${row.probe.error}`);
			} else {
				row.verdict = 'INCONCLUSIVE';
				row.notes.push(
					`server stopped responding during the probe (${row.probe.error}); re-run this cron alone`,
				);
				probeAborted = true;
				break;
			}
		}
	}

	if (VERIFY_GATE) {
		for (const row of results) {
			if (row.verdict !== 'ALIVE') continue;
			try {
				const r = await probe(`${base}${row.path}`, {
					authorization: 'Bearer three-ws-cron-audit-deliberately-wrong-token',
				});
				row.gateRejectsBadToken = r.status === 401 || r.status === 403 || r.status === 503;
				if (!row.gateRejectsBadToken) {
					row.verdict = 'UNGATED';
					row.notes.push(`accepted a WRONG bearer token with ${r.status}`);
				}
			} catch (err) {
				row.notes.push(`bad-token probe failed: ${String(err?.message || err)}`);
			}
		}
	}
} else if (!STATIC_ONLY) {
	for (const row of results) {
		if (row.verdict === 'UNKNOWN') row.verdict = 'STATIC-OK';
	}
}

for (const row of results) {
	if (row.verdict === 'UNKNOWN') row.verdict = probeAborted ? 'INCONCLUSIVE' : 'STATIC-OK';
}

if (child) child.kill('SIGTERM');

// ---------------------------------------------------------------------------
// Fold in check-cron-drift.mjs (schedules + Cloud Scheduler), never re-implement
// ---------------------------------------------------------------------------

let drift = null;
try {
	const args = ['scripts/check-cron-drift.mjs', '--json'];
	if (!WITH_DRIFT) args.push('--offline');
	const { stdout } = await execFileP(process.execPath, args, {
		cwd: ROOT,
		maxBuffer: 16 * 1024 * 1024,
	}).catch((e) => ({ stdout: e.stdout || '' }));
	drift = JSON.parse(stdout || 'null');
} catch (err) {
	drift = { error: String(err?.message || err).split('\n')[0] };
}

if (drift && Array.isArray(drift.invalid)) {
	const badSchedules = new Map(drift.invalid.map((i) => [i.path, i.error]));
	for (const row of results) {
		if (badSchedules.has(row.path)) {
			row.verdict = 'BROKEN';
			row.notes.push(`invalid schedule expression: ${badSchedules.get(row.path)}`);
		}
	}
}

// A cron whose handler is perfectly healthy but which Cloud Scheduler never
// fires is DEAD in the only sense that matters. This is the verdict the code-side
// stages structurally cannot reach on their own, and it is why --drift exists:
// /api/cron/garment-job-sweep passed every static and probe stage while having
// no scheduler job at all, so the garment worker's whole claim/retry recovery
// path had never once been driven.
if (drift?.checkedLive) {
	const missing = new Map((drift.missing || []).map((m) => [m.path, m.id]));
	const paused = new Map((drift.paused || []).map((p) => [p.path, p.state]));
	for (const row of results) {
		if (missing.has(row.path)) {
			row.scheduler = { state: 'MISSING', id: missing.get(row.path) };
			row.verdict = 'DEAD';
			row.notes.push(
				`no Cloud Scheduler job "${missing.get(row.path)}" exists, so this cron never fires in production regardless of handler health`,
			);
		} else if (paused.has(row.path)) {
			row.scheduler = { state: paused.get(row.path) };
			row.verdict = 'DEAD';
			row.notes.push(`Cloud Scheduler job is ${paused.get(row.path)}, not ENABLED`);
		} else {
			row.scheduler = { state: 'ENABLED' };
		}
	}
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const byVerdict = (v) => results.filter((r) => r.verdict === v);
const dead = byVerdict('DEAD');
const broken = byVerdict('BROKEN');
const ungated = byVerdict('UNGATED');
const alive = byVerdict('ALIVE');
const staticOk = byVerdict('STATIC-OK');
const skipped = byVerdict('SKIPPED');
const inconclusive = byVerdict('INCONCLUSIVE');

const report = {
	declared: results.length,
	probed: Boolean(base),
	base: base && base.startsWith('http://127.0.0.1') ? '(local server)' : base,
	schedulerChecked: Boolean(drift?.checkedLive),
	bootError,
	counts: {
		alive: alive.length,
		staticOk: staticOk.length,
		dead: dead.length,
		broken: broken.length,
		ungated: ungated.length,
		skipped: skipped.length,
		inconclusive: inconclusive.length,
	},
	crons: results,
	drift,
};

if (AS_JSON) {
	console.log(JSON.stringify(report, null, 2));
} else {
	const pad = (s, n) => String(s).padEnd(n);
	console.log(`Crons declared in vercel.json: ${report.declared}`);
	console.log(base ? `Probed against: ${report.base}` : 'Static analysis only (no probe).');
	if (bootError) console.log(`\nCould not boot a local server:\n${bootError}`);
	console.log('');
	console.log(
		report.schedulerChecked
			? 'Cloud Scheduler: compared against the live job list.'
			: 'Cloud Scheduler: NOT compared (pass --drift with a live gcloud session).',
	);
	console.log('');
	console.log(`${pad('PATH', 44)} ${pad('VERDICT', 13)} ${pad('HANDLER', 34)} EVIDENCE`);
	for (const r of results) {
		const evidence = r.probe
			? `${r.probe.status ?? 'ERR'} ${r.probe.why || r.probe.error || ''}`
			: r.notes[0] || (r.loads ? 'module loads' : '');
		console.log(
			`${pad(r.path, 44)} ${pad(r.verdict, 13)} ${pad(r.handler || '(none)', 34)} ${evidence}`,
		);
	}

	for (const [label, rows] of [
		['DEAD (declared but nothing runs)', dead],
		['BROKEN (handler errors)', broken],
		['UNGATED (runs for anonymous callers)', ungated],
		['SKIPPED (reachable but short-circuiting every tick)', skipped],
		['INCONCLUSIVE (probe could not finish)', inconclusive],
	]) {
		if (!rows.length) continue;
		console.log(`\n${label}: ${rows.length}`);
		for (const r of rows) {
			console.log(`  ${r.path}`);
			console.log(`    handler: ${r.handler || 'unresolved'}`);
			for (const n of r.notes) console.log(`    ${n}`);
			if (r.probe) console.log(`    probe: HTTP ${r.probe.status} ${r.probe.error || ''}`);
		}
	}

	const methodWarnings = results.filter((r) => r.notes.some((n) => n.includes('rejects GET')));
	if (methodWarnings.length) {
		console.log(`\nWARNING: rejects the GET verb Cloud Scheduler uses: ${methodWarnings.length}`);
		for (const r of methodWarnings) console.log(`  ${r.path}`);
	}

	if (drift?.invalid?.length || drift?.duplicates?.length) {
		console.log('\nFrom check-cron-drift.mjs:');
		for (const i of drift.invalid || []) console.log(`  invalid schedule  ${i.path}  ${i.error}`);
		for (const d of drift.duplicates || []) console.log(`  duplicate job id  ${d.id}`);
	}
	if (WITH_DRIFT && drift?.checkedLive) {
		// A bare "Cloud Scheduler drift:" header over nothing reads as truncated
		// output, which is the one thing a clean comparison must never look like.
		const driftRows = [
			...(drift.missing || []).map((m) => `  MISSING     ${m.path}`),
			...(drift.mismatched || []).map((m) => `  MISMATCH    ${m.path}  declared "${m.declared}" live "${m.live}"`),
			...(drift.paused || []).map((p) => `  NOT ENABLED ${p.path}  ${p.state}`),
			...(drift.orphaned || []).map((o) => `  ORPHANED    ${o.id}`),
		];
		console.log(
			driftRows.length
				? `\nCloud Scheduler drift:\n${driftRows.join('\n')}`
				: '\nCloud Scheduler drift: none (every declared cron exists, is enabled, and matches its live schedule).',
		);
	} else if (WITH_DRIFT && drift?.liveError) {
		console.log(`\nCloud Scheduler not readable: ${drift.liveError}`);
	}

	console.log(
		`\nalive ${alive.length}  static-ok ${staticOk.length}  skipped ${skipped.length}  dead ${dead.length}  broken ${broken.length}  ungated ${ungated.length}  inconclusive ${inconclusive.length}`,
	);
}

// SKIPPED does not fail the run on its own: whether it is an outage depends on
// the environment's DB_RETENTION_HIGH_WATER_MB, which is a deployment fact this
// script cannot decide from a local probe. It is reported loudly instead.
process.exit(dead.length + broken.length + ungated.length ? 1 : 0);
