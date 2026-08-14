// GET /api/cron/likeness-eval - weekly likeness sweep over real reconstructions.
//
// The sibling of /api/cron/quality-bench, on the same weekly cadence and built
// to the same rules. Where that one asks "is what we generate photorealistic",
// this one asks the Phase 1 roadmap's actual question: does the avatar we built
// from someone's photos look like that person? It takes finished
// reconstructions this scorer version has not measured yet, renders each at
// three yaws, embeds the renders and the input captures with the OSS
// face-recognition model in api/_lib/face-embed.js, and files a 1-5 score
// against the generation record.
//
// Differences from the realism bench, both deliberate:
//
//   • It generates nothing. The realism bench submits its own fixed prompts
//     because realism is a property of the pipeline; likeness is a property of
//     a specific person's generation, so the only honest subjects are real
//     reconstructions users actually ran.
//   • It writes to the database rather than to the run log, because a score
//     belongs to the generation it measures. Cloud Run's filesystem is
//     ephemeral and a likeness number is only useful next to the row it scores.
//
// The summary line still goes to Cloud Logging either way, so
// `gcloud logging read` surfaces a drop without anyone opening a page.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';
import { SCORER_VERSION, scoreLikeness } from '../_lib/likeness-score.js';
import {
	likenessDistribution,
	likenessStoreEnabled,
	recordLikenessScore,
	unscoredReconstructions,
} from '../_lib/likeness-store.js';

export const maxDuration = 300;

// Same self-bounding discipline as the realism bench: nothing enforces
// maxDuration on Cloud Run, so the sweep enforces it on itself or it collects a
// 504 and logs its summary into a request nobody is reading.
const RESPONSE_RESERVE_MS = 20_000;
const BUDGET_MS = maxDuration * 1000 - RESPONSE_RESERVE_MS;
// One subject costs three headless renders plus five embeddings. Starting one
// with less runway than this burns render capacity on a result that cannot
// land, so the sweep skips it and reports the skip.
const MIN_SUBJECT_MS = 110_000;
// Ceiling on subjects per sweep. The budget is the real limit; this only stops
// a fast day from turning one cron invocation into an unbounded backfill. Bulk
// backfills are `node scripts/likeness-eval.mjs --backfill`.
const MAX_SUBJECTS = 4;
// A weekly mean this far below the roadmap gate is the finding the whole lane
// exists to surface.
const GATE = 4;

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	if (!likenessStoreEnabled()) {
		error(res, 503, 'store_unavailable', 'likeness scoring needs DATABASE_URL to read subjects and file scores');
		return;
	}

	const startedAt = Date.now();
	const deadlineAt = startedAt + BUDGET_MS;

	const subjects = await unscoredReconstructions({ limit: MAX_SUBJECTS });
	const results = [];
	const skippedForBudget = [];

	for (const subject of subjects) {
		if (Date.now() + MIN_SUBJECT_MS > deadlineAt) {
			skippedForBudget.push(subject.creationId);
			continue;
		}
		const result = await scoreLikeness({
			glbUrl: subject.glbUrl,
			captures: subject.captures,
			deadlineAt,
		});
		const stored = await recordLikenessScore({
			creationId: subject.creationId,
			avatarId: subject.avatarId,
			jobId: subject.jobId,
			result,
		});
		results.push({
			creationId: subject.creationId,
			status: result.status,
			likenessScore: result.likenessScore ?? null,
			identityCosine: result.identityCosine ?? null,
			turnFalloff: result.turnFalloff ?? null,
			capturesEmbedded: result.capturesEmbedded ?? 0,
			stored,
		});
	}

	const scored = results.filter((r) => typeof r.likenessScore === 'number');
	const sweepMean = scored.length ? scored.reduce((s, r) => s + r.likenessScore, 0) / scored.length : null;
	const distribution = await likenessDistribution({ days: 30 });

	const summary = {
		kind: 'likeness-eval',
		scorerVersion: SCORER_VERSION,
		subjects: subjects.length,
		scored: scored.length,
		sweepMean,
		gate: GATE,
		belowGate: scored.filter((r) => r.likenessScore < GATE).length,
		rollingMean: distribution?.meanScore ?? null,
		rollingGateRate: distribution?.gateRate ?? null,
		skippedForBudget,
		budgetMs: BUDGET_MS,
		elapsedMs: Date.now() - startedAt,
		perSubject: results,
	};

	// A sweep with nothing to score is the normal steady state on a quiet week,
	// not a fault: reconstructions are scored once each, so an empty queue means
	// everything already has a number.
	if (scored.length && sweepMean != null && sweepMean < GATE) {
		console.warn('[cron] likeness-eval BELOW GATE', summary);
	} else {
		console.log('[cron] likeness-eval sweep', summary);
	}

	// Always 200: a low score is a reported finding, not a failed invocation. A
	// non-2xx would make Cloud Scheduler retry an expensive render sweep.
	json(res, 200, { ok: true, ...summary, distribution });
});
