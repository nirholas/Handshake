#!/usr/bin/env node
// Fact-check accuracy benchmark runner.
//
// Runs tests/fixtures/fact-check-benchmark.json through the REAL fact-check chain
// (POST /api/x402/fact-check) and scores accuracy overall, per verdict class, and
// per difficulty. Writes data/_generated/fact-check-benchmark.json so the public
// /fact-check accuracy page can render real, checkable numbers.
//
// The endpoint is paid ($0.10/claim), so the runner needs an access path. Two
// exist, both handled by api/_lib/x402/access-control.js:
//   • INTERNAL_API_KEY: the internal service key, sent as `X-API-Key`. This is
//     the path the published runs use; the same value is set on the three-ws-api
//     Cloud Run service. See docs/fact-check.md for rotation.
//   • FACT_CHECK_BYPASS_TOKEN: an OAuth bearer carrying the `x402:bypass`
//     scope, sent as `Authorization: Bearer`. Use it when you want a scoped,
//     per-user credential instead of the service key.
// With neither, the free lane (3 checks/day per IP) covers only the first few
// claims and the rest 402: so the runner EXITS with a clear message naming what
// is missing and writes NOTHING. It never fabricates scores.
//
// Usage:
//   node --env-file=.env scripts/fact-check-benchmark.mjs
//   FACT_CHECK_BYPASS_TOKEN=… node scripts/fact-check-benchmark.mjs
//   FACT_CHECK_ENDPOINT=https://three.ws/api/x402/fact-check node scripts/fact-check-benchmark.mjs
//
// In-process mode (how the published numbers are produced): imports
// api/x402/fact-check.js#_checkClaim directly and runs the REAL chain (live
// search + live LLM) with no HTTP or payment layer in between. The Redis cache
// is disabled for the run so every claim exercises the live chain instead of a
// stale cached verdict:
//   node --env-file=.env scripts/fact-check-benchmark.mjs --in-process
//
// Publishing (`--publish`) additionally writes the run to the DB, which is what
// the live /api/fact-check-benchmark endpoint reads first, so a re-run reaches
// the public page without a deploy. Without the flag the run only updates the
// committed file, which takes effect on the next deploy.
//
// The scoring core (scoreResults / validateFixture) is pure, lives in
// api/_lib/fact-check-benchmark.js so the endpoint and the scheduled re-run share
// it, and is unit-tested in tests/api/fact-check-benchmark.test.js.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	MAX_ERROR_RATE,
	buildReport,
	degradationOf,
	degradedReason,
	isDegraded,
	savePublishedRun,
	scoreResults,
	validateFixture,
} from '../api/_lib/fact-check-benchmark.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURE = join(REPO, 'tests/fixtures/fact-check-benchmark.json');
const OUT_DIR = join(REPO, 'data/_generated');
const OUT_FILE = join(OUT_DIR, 'fact-check-benchmark.json');

// Re-exported for anything still importing the pure core from the script path.
export { scoreResults, validateFixture };

function refuseIfDegraded(score) {
	if (!isDegraded(score)) return;
	console.error(
		`\nRefusing to publish: ${degradedReason(score)}\n` +
			`(ceiling: ${Math.round(MAX_ERROR_RATE * 100)}% errored claims.)\n` +
			'Fix the chain (the "[llm] chain exhausted" warn line names every rung that ' +
			'failed) and re-run.\n' +
			'Nothing was written — the accuracy page keeps rendering its honest state.',
	);
	process.exit(1);
}

// Write the scored run: always the committed file (the deploy-time fallback and
// the seed for a fresh environment), plus the DB row when --publish is passed so
// the live page picks it up immediately.
async function writeReport(report, { publish }) {
	await mkdir(OUT_DIR, { recursive: true });
	await writeFile(OUT_FILE, JSON.stringify(report, null, 2) + '\n');
	console.log(`Wrote ${OUT_FILE}`);
	if (!publish) {
		console.log('Not published to the DB (pass --publish to update the live page now).');
		return;
	}
	await savePublishedRun(report);
	console.log('Published to the DB: GET /api/fact-check-benchmark serves this run now.');
}

// ── Live chain call ──────────────────────────────────────────────────────────

// Build the bypass headers once. Both paths are checked by
// api/_lib/x402/access-control.js; sending both is harmless (the service key is
// tried first) and lets a caller hold either credential.
function bypassHeaders({ apiKey, bearer }) {
	const headers = {};
	if (apiKey) headers['x-api-key'] = apiKey;
	if (bearer) headers.authorization = `Bearer ${bearer}`;
	return headers;
}

async function checkOne(endpoint, access, claim) {
	const headers = { 'content-type': 'application/json', ...bypassHeaders(access) };
	const res = await fetch(endpoint, {
		method: 'POST',
		headers,
		// 'medium' matches parseFactCheckBody's own default in api/x402/fact-check.js —
		// spelled out explicitly rather than relying on an unrecognized value falling
		// through to it (the endpoint only accepts high|medium|low; anything else,
		// including the previous 'normal' here, silently resolves to 'medium' anyway).
		body: JSON.stringify({ claim, strictness: 'medium' }),
		signal: AbortSignal.timeout(60_000),
	});
	if (res.status === 402) {
		const e = new Error('payment_required'); e.paymentRequired = true; throw e;
	}
	if (!res.ok) {
		const e = new Error(`chain returned ${res.status}`); e.status = res.status; throw e;
	}
	const data = await res.json();
	const payload = data?.result ?? data;
	const degradation = degradationOf(payload);
	if (degradation) {
		const e = new Error(`degraded check: ${degradation}`); e.degraded = true; throw e;
	}
	return payload?.verdict ?? null;
}

// One live check with a bounded retry. A single 502 or edge timeout on a 40-claim
// run costs 2.5 percentage points of "accuracy" that is really a transport blip,
// and four of them trip the degraded-run refusal, so a transient failure is
// retried once rather than being scored as a wrong verdict. A 402 is NOT
// transient (no credential will appear between attempts) and fails immediately.
async function checkOneWithRetry(endpoint, access, claim) {
	try {
		return await checkOne(endpoint, access, claim);
	} catch (err) {
		if (err.paymentRequired || err.status === 400 || err.status === 403) throw err;
		await new Promise((r) => setTimeout(r, 3_000));
		return checkOne(endpoint, access, claim);
	}
}

async function main() {
	const raw = await readFile(FIXTURE, 'utf8');
	const fixture = JSON.parse(raw);
	const claims = validateFixture(fixture);
	console.log(`Loaded ${claims.length} benchmark claims (validated).`);

	const publish = process.argv.includes('--publish');
	const inProcess =
		process.argv.includes('--in-process') || process.env.FACT_CHECK_INPROCESS === '1';
	if (inProcess) return mainInProcess(claims, fixture, { publish });

	const endpoint = process.env.FACT_CHECK_ENDPOINT || 'https://three.ws/api/x402/fact-check';
	const access = {
		apiKey: process.env.FACT_CHECK_API_KEY || process.env.INTERNAL_API_KEY || '',
		bearer: process.env.FACT_CHECK_BYPASS_TOKEN || '',
	};
	const hasBypass = Boolean(access.apiKey || access.bearer);

	// Probe reachability before spending a full run. A 402 without any bypass
	// credential means the run can't proceed without payment, exit clearly,
	// write nothing.
	if (!hasBypass) {
		try {
			await checkOne(endpoint, access, claims[0].claim);
		} catch (err) {
			if (err.paymentRequired) {
				console.error(
					'\nCannot run the benchmark: the fact-check endpoint requires payment and no ' +
						'bypass credential was provided.\n' +
						'Set INTERNAL_API_KEY (the service key, sent as X-API-Key) or ' +
						'FACT_CHECK_BYPASS_TOKEN (an x402:bypass-scoped bearer), optionally with ' +
						'FACT_CHECK_ENDPOINT, and re-run.\n' +
						'No scores were written — the accuracy page will render its honest "not yet run" state.',
				);
				process.exit(1);
			}
			console.error(`\nCannot reach the fact-check chain at ${endpoint}: ${err.message}`);
			process.exit(1);
		}
	}

	console.log(
		`Running ${claims.length} claims through ${endpoint} ` +
			`(bypass: ${access.apiKey ? 'X-API-Key' : access.bearer ? 'Bearer x402:bypass' : 'none, free lane only'}) …`,
	);
	const results = [];
	for (const [i, c] of claims.entries()) {
		let actual = null;
		try {
			actual = await checkOneWithRetry(endpoint, access, c.claim);
		} catch (err) {
			console.warn(`  [${i + 1}/${claims.length}] error: ${err.message}`);
		}
		const ok = actual === c.expected_verdict;
		console.log(`  [${i + 1}/${claims.length}] ${ok ? 'PASS' : 'MISS'} expected=${c.expected_verdict} actual=${actual ?? 'ERR'} :: ${c.claim.slice(0, 60)}`);
		results.push({ claim: c.claim, expected_verdict: c.expected_verdict, difficulty: c.difficulty, actual_verdict: actual });
	}

	const score = scoreResults(results);
	refuseIfDegraded(score);
	const report = buildReport({ score, endpoint, fixture, claimCount: claims.length });
	console.log(`\nOverall accuracy: ${score.accuracy_pct}%  (${score.correct}/${score.total}, ${score.errors} errors)`);
	await writeReport(report, { publish });
}

// ── In-process mode ──────────────────────────────────────────────────────────
// Runs the real chain by importing the endpoint's exported _checkClaim — the
// same code path a paying caller hits, minus the HTTP/x402 wrapper. Used to
// produce the published data/_generated numbers so the benchmark measures the
// product's verdict quality, not payment plumbing.

async function mainInProcess(claims, fixture, { publish } = {}) {
	// Disable the shared Redis verdict cache for the run: a benchmark that reads
	// week-old cached verdicts measures the cache, not the chain.
	delete process.env.UPSTASH_REDIS_REST_URL;
	delete process.env.UPSTASH_REDIS_REST_TOKEN;
	delete process.env.three_KV_REST_API_URL;
	delete process.env.three_KV_REST_API_TOKEN;
	delete process.env.KV_REST_API_URL;
	delete process.env.KV_REST_API_TOKEN;

	const { _checkClaim } = await import('../api/x402/fact-check.js');
	const endpoint = 'in-process:api/x402/fact-check.js#_checkClaim (real chain, no HTTP/x402 payment layer)';
	console.log(`Running ${claims.length} claims in-process (live search + live LLM, cache disabled) …`);

	const results = [];
	const details = [];
	for (const [i, c] of claims.entries()) {
		let actual = null;
		let detail = null;
		try {
			const r = await _checkClaim(c.claim, 'medium', null);
			const degradation = degradationOf(r);
			if (degradation) throw new Error(`degraded check: ${degradation}`);
			actual = r?.verdict ?? null;
			detail = {
				confidence: r?.confidence ?? null,
				sources: (r?.sources || []).map((s) => ({ url: s.url, stance: s.stance, weight: s.weight })),
			};
		} catch (err) {
			console.warn(`  [${i + 1}/${claims.length}] error: ${err.message}`);
		}
		const ok = actual === c.expected_verdict;
		console.log(`  [${i + 1}/${claims.length}] ${ok ? 'PASS' : 'MISS'} expected=${c.expected_verdict} actual=${actual ?? 'ERR'} :: ${c.claim.slice(0, 60)}`);
		results.push({ claim: c.claim, expected_verdict: c.expected_verdict, difficulty: c.difficulty, actual_verdict: actual });
		details.push({ claim: c.claim, expected: c.expected_verdict, actual, ...detail });
	}

	const score = scoreResults(results);
	// Per-claim detail for diagnosis (not published; scratch aid for whoever is
	// tuning the chain). Written next to nothing public, and written BEFORE the
	// degradation guard: a refused run is exactly the run someone needs the
	// per-source stances for, and refuseIfDegraded exits the process, so writing
	// this after it threw away the evidence for every diagnosis it demanded.
	if (process.env.FACT_CHECK_DETAIL_FILE) {
		await mkdir(dirname(process.env.FACT_CHECK_DETAIL_FILE), { recursive: true });
		await writeFile(process.env.FACT_CHECK_DETAIL_FILE, JSON.stringify(details, null, 2) + '\n');
	}
	refuseIfDegraded(score);
	const report = buildReport({ score, endpoint, fixture, claimCount: claims.length });
	console.log(`\nOverall accuracy: ${score.accuracy_pct}%  (${score.correct}/${score.total}, ${score.errors} errors)`);
	await writeReport(report, { publish });
}

// Only run main() when invoked directly, not when imported by the test.
if (process.argv[1] && process.argv[1].endsWith('fact-check-benchmark.mjs')) {
	main().catch((err) => {
		console.error('benchmark failed:', err);
		process.exit(1);
	});
}
