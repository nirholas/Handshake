// Fact-check accuracy benchmark: the shared core.
//
// One place holds the things the runner script, the public read endpoint, and
// the scheduled re-run all have to agree on:
//   • the fixture contract (validateFixture)
//   • the scoring math (scoreResults), pure, unit-tested in
//     tests/api/fact-check-benchmark.test.js
//   • the degraded-run refusal (isDegraded), a run whose claims mostly ERRORED
//     measures provider availability, not verdict accuracy, and must never be
//     published as an accuracy figure
//   • where a published run lives (readPublishedRun / savePublishedRun)
//
// Storage: a published run is a single row in app_settings. The committed file
// data/_generated/fact-check-benchmark.json is the fallback (and the seed for a
// fresh environment), the DB row wins so a re-run publishes without a deploy.
// scripts/fact-check-benchmark.mjs imports this module and re-exports the pure
// halves so the existing test imports keep resolving.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from './db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '../..');
export const FIXTURE_PATH = join(REPO_ROOT, 'tests/fixtures/fact-check-benchmark.json');
export const REPORT_PATH = join(REPO_ROOT, 'data/_generated/fact-check-benchmark.json');

export const VERDICT_CLASSES = ['supported', 'contradicted', 'mixed', 'insufficient'];
export const DIFFICULTIES = ['easy', 'medium', 'hard'];

// app_settings key holding the most recently published run.
export const RUN_STATE_KEY = 'fact_check_benchmark:latest_run';
// Cross-instance lock so two overlapping scheduled ticks never run the suite twice.
const LOCK_KEY = 'fact_check_benchmark:lock';
const LOCK_TTL_S = 15 * 60;

// ── Pure scoring core ────────────────────────────────────────────────────────

// Group an array by a key function into { [key]: items[] }.
function groupBy(items, keyFn) {
	const out = {};
	for (const it of items) {
		const k = keyFn(it);
		(out[k] ||= []).push(it);
	}
	return out;
}

/**
 * Score a set of results against the fixture. `results` is an array of
 * { claim, expected_verdict, difficulty, actual_verdict } (actual_verdict null =
 * the chain could not be reached for that claim → counts as incorrect but is
 * tracked separately as `errors`). Returns a structured accuracy report.
 */
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

/**
 * Validate the fixture shape and return its claims. Throws on a malformed suite, 
 * the benchmark is the product's quality bar, so a broken fixture must fail loud.
 */
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

// A run whose claims mostly ERRORED measures upstream availability, not accuracy:
// every unreachable claim scores as incorrect, so the headline number reads as
// "the product is wrong" when the truth is "the chain was down". Publishing that
// to /fact-check states a false accuracy figure for a paid product, a run went
// out at 7.5% with 30 of 40 claims errored while the LLM chain was exhausted.
// Refuse to write it; the page's designed "not yet run" state is honest, a bad
// number is not.
export const MAX_ERROR_RATE = 0.1;

/** True when a scored run errored too heavily to be published as accuracy. */
export function isDegraded(score) {
	const errorRate = score.total > 0 ? score.errors / score.total : 1;
	return errorRate > MAX_ERROR_RATE;
}

/** Human-readable reason a degraded run was refused. */
export function degradedReason(score) {
	const errorRate = score.total > 0 ? score.errors / score.total : 1;
	return (
		`${score.errors}/${score.total} claims could not be checked ` +
		`(${Math.round(errorRate * 100)}% > ${Math.round(MAX_ERROR_RATE * 100)}% ceiling). ` +
		'This run measured provider availability, not verdict accuracy.'
	);
}

/** Load and validate the committed claim suite. */
export async function loadFixture() {
	const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
	validateFixture(fixture);
	return fixture;
}

// ── Bounded-concurrency execution ────────────────────────────────────────────

/**
 * Run every claim through `checkOne` with at most `concurrency` in flight, and
 * stop early if `deadlineMs` of wall clock is exhausted. Claims that error (or
 * are cut off by the deadline) come back with actual_verdict null, which
 * scoreResults counts as an error: so a truncated run trips the degraded-run
 * refusal instead of publishing a partial suite as a full one.
 *
 * @param {Array<object>} claims
 * @param {(claim: string) => Promise<string|null>} checkOne
 * @param {{ concurrency?: number, deadlineMs?: number, onResult?: Function }} [opts]
 */
export async function runClaims(claims, checkOne, { concurrency = 6, deadlineMs = Infinity, onResult } = {}) {
	const started = Date.now();
	const results = new Array(claims.length);
	let next = 0;

	async function worker() {
		for (;;) {
			const i = next++;
			if (i >= claims.length) return;
			const c = claims[i];
			let actual = null;
			let errorMessage = null;
			if (Date.now() - started >= deadlineMs) {
				errorMessage = 'deadline exceeded before this claim ran';
			} else {
				try {
					actual = await checkOne(c.claim);
				} catch (err) {
					errorMessage = String(err?.message || err);
				}
			}
			results[i] = {
				claim: c.claim,
				expected_verdict: c.expected_verdict,
				difficulty: c.difficulty,
				actual_verdict: actual,
			};
			onResult?.({ index: i, total: claims.length, result: results[i], errorMessage });
		}
	}

	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, claims.length)) }, worker));
	return results;
}

/** Assemble the publishable report envelope from a scored run. */
export function buildReport({ score, endpoint, fixture, claimCount }) {
	return {
		generated_at: new Date().toISOString(),
		endpoint,
		fixture_version: fixture?.version || '1.0.0',
		claim_count: claimCount,
		...score,
	};
}

// ── Published-run storage (app_settings) ─────────────────────────────────────

async function ensureTable() {
	await sql`
		CREATE TABLE IF NOT EXISTS app_settings (
			key text PRIMARY KEY,
			value jsonb NOT NULL,
			updated_at timestamptz NOT NULL DEFAULT now()
		)
	`;
}

/**
 * Read the published run from the DB. Returns null when nothing is published or
 * the DB is unreachable: the caller falls back to the committed file, so a
 * database blip degrades to the last shipped run rather than to an empty page.
 */
export async function readPublishedRun() {
	try {
		const [row] = await sql`SELECT value FROM app_settings WHERE key = ${RUN_STATE_KEY}`;
		return row?.value ?? null;
	} catch {
		return null;
	}
}

/** Publish a run. Throws on a DB failure: a silent publish failure is a lie. */
export async function savePublishedRun(report) {
	await ensureTable();
	await sql`
		INSERT INTO app_settings (key, value) VALUES (${RUN_STATE_KEY}, ${JSON.stringify(report)}::jsonb)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
	`;
}

/** Claim the run lock. Returns false when another tick already holds it. */
export async function acquireLock() {
	await ensureTable();
	const rows = await sql`
		INSERT INTO app_settings (key, value)
		VALUES (${LOCK_KEY}, jsonb_build_object('until', extract(epoch from now()) + ${LOCK_TTL_S}))
		ON CONFLICT (key) DO UPDATE
			SET value = excluded.value, updated_at = now()
			WHERE (app_settings.value->>'until')::numeric < extract(epoch from now())
		RETURNING key
	`;
	return rows.length > 0;
}

export async function releaseLock() {
	await sql`
		INSERT INTO app_settings (key, value) VALUES (${LOCK_KEY}, jsonb_build_object('until', 0))
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
	`;
}
