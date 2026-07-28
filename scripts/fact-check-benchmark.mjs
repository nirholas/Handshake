#!/usr/bin/env node
// Fact-check accuracy benchmark runner.
//
// Runs tests/fixtures/fact-check-benchmark.json through the REAL fact-check chain
// (POST /api/x402/fact-check) and scores accuracy overall, per verdict class, and
// per difficulty. Writes data/_generated/fact-check-benchmark.json so the public
// /fact-check accuracy page can render real, checkable numbers.
//
// The endpoint is paid ($0.10/claim), so the runner needs an access path — set
// FACT_CHECK_BYPASS_TOKEN (an x402:bypass-scoped token) OR run it against a
// deployment whose free lane covers the run. Without a way to reach the chain the
// runner EXITS with a clear message naming what's missing and writes NOTHING — it
// never fabricates scores.
//
// Usage:
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
// The scoring core (scoreResults / summarize) is pure and unit-tested in
// tests/api/fact-check-v2.test.js.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURE = join(REPO, 'tests/fixtures/fact-check-benchmark.json');
const OUT_DIR = join(REPO, 'data/_generated');
const OUT_FILE = join(OUT_DIR, 'fact-check-benchmark.json');

const VERDICT_CLASSES = ['supported', 'contradicted', 'mixed', 'insufficient'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

// ── Pure scoring core (exported for tests) ───────────────────────────────────

// Group an array by a key function into { [key]: items[] }.
function groupBy(items, keyFn) {
	const out = {};
	for (const it of items) {
		const k = keyFn(it);
		(out[k] ||= []).push(it);
	}
	return out;
}

// Score a set of results against the fixture. `results` is an array of
// { claim, expected_verdict, difficulty, actual_verdict } (actual_verdict null =
// the chain could not be reached for that claim → counts as incorrect but is
// tracked separately as `errors`). Returns a structured accuracy report.
export function scoreResults(results) {
	const total = results.length;
	const correct = results.filter((r) => r.actual_verdict === r.expected_verdict).length;
	const errors = results.filter((r) => r.actual_verdict == null).length;

	const pct = (c, t) => (t > 0 ? Math.round((c / t) * 1000) / 10 : null);

	const byClass = {};
	const grpClass = groupBy(results, (r) => r.expected_verdict);
	for (const cls of VERDICT_CLASSES) {
		const g = grpClass[cls] || [];
		byClass[cls] = { total: g.length, correct: g.filter((r) => r.actual_verdict === r.expected_verdict).length };
		byClass[cls].accuracy_pct = pct(byClass[cls].correct, byClass[cls].total);
	}

	const byDifficulty = {};
	const grpDiff = groupBy(results, (r) => r.difficulty);
	for (const d of DIFFICULTIES) {
		const g = grpDiff[d] || [];
		byDifficulty[d] = { total: g.length, correct: g.filter((r) => r.actual_verdict === r.expected_verdict).length };
		byDifficulty[d].accuracy_pct = pct(byDifficulty[d].correct, byDifficulty[d].total);
	}

	// A simple confusion matrix expected→actual (only for claims that were checked).
	const confusion = {};
	for (const cls of VERDICT_CLASSES) confusion[cls] = {};
	for (const r of results) {
		if (r.actual_verdict == null) continue;
		const row = (confusion[r.expected_verdict] ||= {});
		row[r.actual_verdict] = (row[r.actual_verdict] || 0) + 1;
	}

	return {
		total,
		correct,
		errors,
		accuracy_pct: pct(correct, total),
		by_class: byClass,
		by_difficulty: byDifficulty,
		confusion,
	};
}

// Validate the fixture shape and return its claims. Throws on a malformed suite —
// the benchmark is the product's quality bar, so a broken fixture must fail loud.
export function validateFixture(fixture) {
	if (!fixture || !Array.isArray(fixture.claims)) throw new Error('fixture.claims must be an array');
	const claims = fixture.claims;
	if (claims.length < 40) throw new Error(`fixture must have ≥40 claims, has ${claims.length}`);
	const counts = Object.fromEntries(VERDICT_CLASSES.map((c) => [c, 0]));
	for (const [i, c] of claims.entries()) {
		if (!c.claim || typeof c.claim !== 'string') throw new Error(`claims[${i}].claim missing`);
		if (!VERDICT_CLASSES.includes(c.expected_verdict)) throw new Error(`claims[${i}].expected_verdict invalid: ${c.expected_verdict}`);
		if (!c.rationale) throw new Error(`claims[${i}].rationale missing`);
		if (!DIFFICULTIES.includes(c.difficulty)) throw new Error(`claims[${i}].difficulty invalid: ${c.difficulty}`);
		counts[c.expected_verdict]++;
	}
	for (const cls of VERDICT_CLASSES) {
		if (counts[cls] < 10) throw new Error(`class "${cls}" has ${counts[cls]} claims, needs ≥10`);
	}
	return claims;
}

// ── Live chain call ──────────────────────────────────────────────────────────

async function checkOne(endpoint, bypassToken, claim) {
	const headers = { 'content-type': 'application/json' };
	if (bypassToken) headers.authorization = `Bearer ${bypassToken}`;
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
	const verdict = data?.verdict ?? data?.result?.verdict ?? null;
	return verdict;
}

async function main() {
	const raw = await readFile(FIXTURE, 'utf8');
	const fixture = JSON.parse(raw);
	const claims = validateFixture(fixture);
	console.log(`Loaded ${claims.length} benchmark claims (validated).`);

	const inProcess =
		process.argv.includes('--in-process') || process.env.FACT_CHECK_INPROCESS === '1';
	if (inProcess) return mainInProcess(claims, fixture);

	const endpoint = process.env.FACT_CHECK_ENDPOINT || 'https://three.ws/api/x402/fact-check';
	const bypassToken = process.env.FACT_CHECK_BYPASS_TOKEN || '';

	// Probe reachability before spending a full run. A 402 without a bypass token
	// means the run can't proceed without payment — exit clearly, write nothing.
	if (!bypassToken) {
		try {
			await checkOne(endpoint, '', claims[0].claim);
		} catch (err) {
			if (err.paymentRequired) {
				console.error(
					'\nCannot run the benchmark: the fact-check endpoint requires payment and no ' +
						'FACT_CHECK_BYPASS_TOKEN (x402:bypass scope) was provided.\n' +
						'Set FACT_CHECK_BYPASS_TOKEN (and optionally FACT_CHECK_ENDPOINT) and re-run.\n' +
						'No scores were written — the accuracy page will render its honest "not yet run" state.',
				);
				process.exit(1);
			}
			console.error(`\nCannot reach the fact-check chain at ${endpoint}: ${err.message}`);
			process.exit(1);
		}
	}

	console.log(`Running ${claims.length} claims through ${endpoint} …`);
	const results = [];
	for (const [i, c] of claims.entries()) {
		let actual = null;
		try {
			actual = await checkOne(endpoint, bypassToken, c.claim);
		} catch (err) {
			console.warn(`  [${i + 1}/${claims.length}] error: ${err.message}`);
		}
		const ok = actual === c.expected_verdict;
		console.log(`  [${i + 1}/${claims.length}] ${ok ? 'PASS' : 'MISS'} expected=${c.expected_verdict} actual=${actual ?? 'ERR'} :: ${c.claim.slice(0, 60)}`);
		results.push({ claim: c.claim, expected_verdict: c.expected_verdict, difficulty: c.difficulty, actual_verdict: actual });
	}

	const score = scoreResults(results);
	const report = {
		generated_at: new Date().toISOString(),
		endpoint,
		fixture_version: fixture.version || '1.0.0',
		claim_count: claims.length,
		...score,
	};
	await mkdir(OUT_DIR, { recursive: true });
	await writeFile(OUT_FILE, JSON.stringify(report, null, 2) + '\n');
	console.log(`\nOverall accuracy: ${score.accuracy_pct}%  (${score.correct}/${score.total}, ${score.errors} errors)`);
	console.log(`Wrote ${OUT_FILE}`);
}

// ── In-process mode ──────────────────────────────────────────────────────────
// Runs the real chain by importing the endpoint's exported _checkClaim — the
// same code path a paying caller hits, minus the HTTP/x402 wrapper. Used to
// produce the published data/_generated numbers so the benchmark measures the
// product's verdict quality, not payment plumbing.

async function mainInProcess(claims, fixture) {
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
	const report = {
		generated_at: new Date().toISOString(),
		endpoint,
		fixture_version: fixture.version || '1.0.0',
		claim_count: claims.length,
		...score,
	};
	await mkdir(OUT_DIR, { recursive: true });
	await writeFile(OUT_FILE, JSON.stringify(report, null, 2) + '\n');
	// Per-claim detail for diagnosis (not published; scratch aid for whoever is
	// tuning the chain). Written next to nothing public.
	if (process.env.FACT_CHECK_DETAIL_FILE) {
		await writeFile(process.env.FACT_CHECK_DETAIL_FILE, JSON.stringify(details, null, 2) + '\n');
	}
	console.log(`\nOverall accuracy: ${score.accuracy_pct}%  (${score.correct}/${score.total}, ${score.errors} errors)`);
	console.log(`Wrote ${OUT_FILE}`);
}

// Only run main() when invoked directly, not when imported by the test.
if (process.argv[1] && process.argv[1].endsWith('fact-check-benchmark.mjs')) {
	main().catch((err) => {
		console.error('benchmark failed:', err);
		process.exit(1);
	});
}
