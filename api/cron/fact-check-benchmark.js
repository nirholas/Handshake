// @ts-check
// GET /api/cron/fact-check-benchmark: re-run the published accuracy benchmark.
//
// The number on /fact-check is a quality claim about a paid product, so it has
// to carry a recent date. This tick runs the committed 40-claim suite
// (tests/fixtures/fact-check-benchmark.json) through the REAL chain in-process
// (api/x402/fact-check.js#_checkClaim: live search, live LLM, no HTTP and no
// payment layer), scores it, and publishes the run to the DB, which
// GET /api/fact-check-benchmark reads first. No deploy is involved.
//
// Three guards keep a bad tick from publishing a false number:
//   • A DB lock, so two overlapping ticks never run the suite twice.
//   • A wall-clock deadline under Cloud Scheduler's attempt deadline (320s, see
//     scripts/create-gcp-scheduler.mjs). Claims that do not get to run come back
//     as errors rather than being silently dropped from the denominator.
//   • The shared degraded-run refusal: above a 10% errored-claim rate the run
//     measured provider availability, not verdict accuracy, so nothing is
//     published and the previous run stays up.
//
// The Redis verdict cache is disabled for the run. A benchmark that reads
// week-old cached verdicts measures the cache, not the chain.

import { json, method, wrapCron } from '../_lib/http.js';
import {
	acquireLock,
	buildReport,
	degradationOf,
	degradedReason,
	isDegraded,
	loadFixture,
	releaseLock,
	runClaims,
	savePublishedRun,
	scoreResults,
} from '../_lib/fact-check-benchmark.js';
import { requireCron } from '../_lib/cron-auth.js';

// Cloud Scheduler gives every job a 320s attempt deadline. Stop issuing claims
// at 240s so the scoring, the publish, and the response all land inside it.
const RUN_DEADLINE_MS = Number(process.env.FACT_CHECK_BENCHMARK_DEADLINE_MS) || 240_000;
// Measured against production: a single claim resolves in roughly 10 seconds, so
// six in flight finishes 40 claims in about a minute. Higher concurrency starts
// tripping upstream search and LLM rate limits, which shows up as errored claims
// and trips the refusal for no gain.
const CONCURRENCY = Number(process.env.FACT_CHECK_BENCHMARK_CONCURRENCY) || 6;

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	if (!(await acquireLock())) {
		json(res, 200, { ok: true, skipped: 'locked' });
		return;
	}

	try {
		const fixture = await loadFixture();
		const claims = fixture.claims;

		// Disable the shared Redis verdict cache for this run only. Deleting the
		// env keys before importing the endpoint would leak into every other
		// handler in this instance, so instead the cache credentials are hidden
		// for the duration of the run and restored in the finally below.
		const cacheKeys = [
			'UPSTASH_REDIS_REST_URL',
			'UPSTASH_REDIS_REST_TOKEN',
			'three_KV_REST_API_URL',
			'three_KV_REST_API_TOKEN',
			'KV_REST_API_URL',
			'KV_REST_API_TOKEN',
		];
		const saved = Object.fromEntries(cacheKeys.map((k) => [k, process.env[k]]));
		for (const k of cacheKeys) delete process.env[k];

		let results;
		try {
			const { _checkClaim } = await import('../x402/fact-check.js');
			results = await runClaims(
				claims,
				async (claim) => {
					const r = await _checkClaim(claim, 'medium', null);
					// A degraded check never reached the full chain. Surface it as an
					// error so it counts toward the refusal, rather than letting an
					// LLM outage publish 40 fallback verdicts as an accuracy figure.
					const degradation = degradationOf(r);
					if (degradation) throw new Error(`degraded check: ${degradation}`);
					return r?.verdict ?? null;
				},
				{ concurrency: CONCURRENCY, deadlineMs: RUN_DEADLINE_MS },
			);
		} finally {
			for (const k of cacheKeys) {
				if (saved[k] !== undefined) process.env[k] = saved[k];
			}
		}

		const score = scoreResults(results);
		if (isDegraded(score)) {
			console.warn('[cron] fact-check-benchmark refused a degraded run', {
				errors: score.errors,
				total: score.total,
			});
			json(res, 200, {
				ok: true,
				published: false,
				refused: degradedReason(score),
				errors: score.errors,
				total: score.total,
			});
			return;
		}

		const report = buildReport({
			score,
			endpoint: 'in-process:api/x402/fact-check.js#_checkClaim (real chain, no HTTP/x402 payment layer)',
			fixture,
			claimCount: claims.length,
		});
		await savePublishedRun(report);
		json(res, 200, {
			ok: true,
			published: true,
			accuracy_pct: score.accuracy_pct,
			correct: score.correct,
			total: score.total,
			errors: score.errors,
			generated_at: report.generated_at,
		});
	} finally {
		await releaseLock().catch(() => {});
	}
});
