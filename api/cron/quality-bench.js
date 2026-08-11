// GET /api/cron/quality-bench — weekly bounded realism-regression smoke test.
//
// This is NOT the full 23-prompt x all-lanes x all-tiers baseline (that one is
// run by hand/CI via `node scripts/quality-bench.mjs` and its result committed
// to data/quality-bench/runs/ — Cloud Run's filesystem is ephemeral and this
// handler can't commit to git). Instead it runs a small fixed subset — enough
// prompts to span a few subject classes, on the platform's default standard-tier
// image lane — end to end for real (real forge generation, real render, real
// Vertex Gemini judge), and diffs the result against the most recent COMMITTED
// baseline run for the same lane/tier. It logs a structured summary line via
// console.log/console.error either way — Cloud Logging IS "the run log" here —
// so `gcloud logging read` surfaces a regression without anyone needing to run
// the full bench first. For a real before/after gate on a specific change, run
// `node scripts/quality-bench.mjs --compare=latest,previous` by hand — see
// data/quality-bench/README.md.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { error, json, method, wrapCron } from '../_lib/http.js';
import { loadCatalog, runOne } from '../_lib/quality-bench.js';
import { requireCron } from '../_lib/cron-auth.js';

export const maxDuration = 300;

// Nothing enforces `maxDuration` here. It is a Vercel declaration, and this runs
// on Cloud Run, where the only ceilings are the Cloud Scheduler job's 320s
// attempt deadline and Cloud Run's own 900s request timeout. So the sweep has to
// bound itself. Until it did, "kept deliberately short" was an intention rather
// than a limit: the 2026-08-10 run spent 900s, collected a 504 from Cloud Run,
// left Scheduler recording the job as DEADLINE_EXCEEDED, and then logged its
// summary 21 minutes later into a request nobody was reading.
const RESPONSE_RESERVE_MS = 20_000;
const BUDGET_MS = maxDuration * 1000 - RESPONSE_RESERVE_MS;
// Starting another prompt with less runway than this just burns forge capacity
// on a result that cannot land, so the sweep skips it and says so instead.
const MIN_PROMPT_MS = 45_000;

// A small, fixed, cheap-to-run cross-section of the full bench: one
// people/organic subject, one hard-surface subject, one architecture subject.
const SMOKE_PROMPT_IDS = ['qb01', 'qb09', 'qb12'];
const SMOKE_TIER = 'standard';
const REGRESSION_THRESHOLD = 1.0;

const BENCH_DIR = path.join(process.cwd(), 'data', 'quality-bench');
const RUNS_DIR = path.join(BENCH_DIR, 'runs');

async function loadPrompts() {
	const raw = JSON.parse(await readFile(path.join(BENCH_DIR, 'prompts.json'), 'utf8'));
	return raw.prompts;
}

// Mean score for (lane, tier) across every committed run's results — the
// standing baseline this sweep compares a fresh smoke run against.
async function baselineMean(lane, tier) {
	let files = [];
	try {
		files = (await readdir(RUNS_DIR)).filter((f) => f.endsWith('.json'));
	} catch {
		return null;
	}
	const scores = [];
	for (const file of files) {
		try {
			const run = JSON.parse(await readFile(path.join(RUNS_DIR, file), 'utf8'));
			for (const r of run.results || []) {
				if (r.lane === lane && r.tier === tier && typeof r.meanScore === 'number') scores.push(r.meanScore);
			}
		} catch {
			// skip a corrupt run file
		}
	}
	if (!scores.length) return null;
	return scores.reduce((a, b) => a + b, 0) / scores.length;
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	// Clock starts before the catalog fetch: loading the catalog is part of the
	// budget, not free time in front of it.
	const startedAt = Date.now();
	const deadlineAt = startedAt + BUDGET_MS;
	const baseUrl = `https://${req.headers.host || 'three.ws'}`;

	let catalog;
	try {
		catalog = await loadCatalog(baseUrl);
	} catch (err) {
		error(res, 502, 'catalog_unavailable', String(err?.message || err));
		return;
	}
	const lane = catalog.default_backend_for_tier?.[SMOKE_TIER]?.image;
	if (!lane) {
		error(res, 503, 'no_lane', `no default image lane for tier "${SMOKE_TIER}"`);
		return;
	}

	const allPrompts = await loadPrompts();
	const prompts = SMOKE_PROMPT_IDS.map((id) => allPrompts.find((p) => p.id === id)).filter(Boolean);

	const results = [];
	const skippedForBudget = [];
	for (const p of prompts) {
		if (Date.now() + MIN_PROMPT_MS > deadlineAt) {
			skippedForBudget.push(p.id);
			continue;
		}
		results.push(await runOne(baseUrl, p, lane, SMOKE_TIER, { deadlineAt }));
	}

	const scored = results.filter((r) => typeof r.meanScore === 'number');
	const smokeMean = scored.length ? scored.reduce((s, r) => s + r.meanScore, 0) / scored.length : null;
	const baseline = await baselineMean(lane, SMOKE_TIER);

	// A sweep that ran out of clock covers fewer prompts than the baseline it
	// would be compared against, so its delta measures the budget, not the
	// models. Report it loudly and do not let it trip the regression alarm.
	const complete = !skippedForBudget.length && !results.some((r) => r.status === 'budget_exhausted');

	const summary = {
		kind: 'quality-bench-smoke',
		lane,
		tier: SMOKE_TIER,
		promptIds: SMOKE_PROMPT_IDS,
		smokeMean,
		baselineMean: baseline,
		delta: smokeMean != null && baseline != null ? smokeMean - baseline : null,
		complete,
		skippedForBudget,
		budgetMs: BUDGET_MS,
		elapsedMs: Date.now() - startedAt,
		perPrompt: results.map((r) => ({ promptId: r.promptId, status: r.status, meanScore: r.meanScore, error: r.error || null })),
	};

	const regressed = complete && summary.delta != null && summary.delta < -REGRESSION_THRESHOLD;
	if (regressed) {
		console.error('[cron] quality-bench REGRESSION', summary);
	} else if (!complete) {
		console.warn('[cron] quality-bench INCOMPLETE (ran out of budget)', summary);
	} else {
		console.log('[cron] quality-bench smoke run', summary);
	}

	// Always 200: a regression is a reported finding, not a failed invocation.
	// A non-2xx here would make Cloud Scheduler retry the (expensive) bench run.
	json(res, 200, { ok: true, regressed, ...summary });
});
