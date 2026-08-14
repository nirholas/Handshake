// Persistence for the likeness harness: the work queue it reads, the scores it
// writes, and the distribution the internal surface renders.
//
// A reconstruction is two rows in two tables and the harness needs both. The
// generation record lives in forge_creations (path = 'reconstruct', written by
// registerReconstructionCreation); the photos it was built from live in
// avatar_regen_jobs.params.images, and the two join on the job id that
// forge_creations stores as replicate_job_id. Nothing else in the codebase
// walks that join, which is exactly why "score a real generation against its
// real inputs" had no query behind it before now.
//
// Every function is fail-soft in the same way forge-store.js is: on a
// deployment with no database the harness degrades to computing scores and
// logging them rather than refusing to run. A measurement that cannot be
// filed is still worth taking.

import { sql, isDbUnavailableError } from './db.js';
import { databaseConfigured } from './env.js';
import { SCORER_VERSION } from './face-embed.js';

export function likenessStoreEnabled() {
	return databaseConfigured();
}

// The cron's work queue: finished reconstructions this scorer version has not
// measured yet, newest first, each carrying the captures it was built from.
//
// `left join ... is null` rather than `not in (...)`: the subquery form degrades
// badly once the score table is the larger of the two, and this query runs on
// every sweep.
export async function unscoredReconstructions({ limit = 10, scorerVersion = SCORER_VERSION } = {}) {
	if (!likenessStoreEnabled()) return [];
	try {
		const rows = await sql`
			select
				c.id           as creation_id,
				c.avatar_id    as avatar_id,
				c.glb_url      as glb_url,
				c.created_at   as created_at,
				j.job_id       as job_id,
				j.params       as params
			from forge_creations c
			join avatar_regen_jobs j on j.job_id = c.replicate_job_id
			left join avatar_likeness_scores s
				on s.creation_id = c.id and s.scorer_version = ${scorerVersion}
			where c.path = 'reconstruct'
				and c.status = 'done'
				and c.glb_url is not null
				and j.mode = 'reconstruct'
				and s.creation_id is null
			order by c.created_at desc
			limit ${Math.max(1, Math.min(100, Number(limit) || 10))}
		`;
		return rows.map((r) => ({
			creationId: r.creation_id,
			avatarId: r.avatar_id,
			jobId: r.job_id,
			glbUrl: r.glb_url,
			createdAt: r.created_at,
			captures: capturesFromParams(r.params),
		}));
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[likeness] work queue skipped (db unavailable):', err?.message);
		else console.error('[likeness] work queue failed:', err?.message);
		return [];
	}
}

// The photos a reconstruct job was submitted with. Selfie jobs carry them in
// params.images; the text-to-avatar path carries the one generated reference
// image the pipeline actually reconstructed from, which is the same thing for
// scoring purposes because it is literally the image the mesh was built to
// match. Neon returns jsonb already parsed, but a text column would not, so
// both shapes are accepted.
export function capturesFromParams(params) {
	const p = typeof params === 'string' ? safeParse(params) : params;
	if (!p) return [];
	const images = Array.isArray(p.images) ? p.images.filter((v) => typeof v === 'string' && v) : [];
	if (images.length) return images;
	return typeof p.referenceImageUrl === 'string' && p.referenceImageUrl ? [p.referenceImageUrl] : [];
}

function safeParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// Upsert one score. Re-scoring the same creation with a newer instrument
// overwrites in place and bumps scored_at, matching how sim_readiness_grades
// treats a re-grade: one current measurement per subject, never a growing pile
// of stale ones.
export async function recordLikenessScore({ creationId, avatarId, jobId, result }) {
	if (!likenessStoreEnabled() || !creationId || !result) return false;
	try {
		await sql`
			insert into avatar_likeness_scores (
				creation_id, avatar_id, job_id, scorer_version, status,
				likeness_score, identity_cosine, mean_score, mean_cosine,
				worst_cosine, turn_falloff, same_identity,
				captures_total, captures_embedded, capture_cohesion, views_scored,
				score_ms, report, scored_at
			) values (
				${creationId}, ${avatarId ?? null}, ${jobId ?? null}, ${result.scorerVersion}, ${result.status},
				${numOrNull(result.likenessScore)}, ${numOrNull(result.identityCosine)},
				${numOrNull(result.meanScore)}, ${numOrNull(result.meanCosine)},
				${numOrNull(result.worstCosine)}, ${numOrNull(result.turnFalloff)},
				${typeof result.sameIdentity === 'boolean' ? result.sameIdentity : null},
				${intOrNull(result.captureCount)}, ${intOrNull(result.capturesEmbedded)},
				${numOrNull(result.captureCohesion)}, ${intOrNull(result.viewsScored)},
				${intOrNull(result.elapsedMs)}, ${JSON.stringify(reportFor(result))}, now()
			)
			on conflict (creation_id) do update set
				avatar_id         = excluded.avatar_id,
				job_id            = excluded.job_id,
				scorer_version    = excluded.scorer_version,
				status            = excluded.status,
				likeness_score    = excluded.likeness_score,
				identity_cosine   = excluded.identity_cosine,
				mean_score        = excluded.mean_score,
				mean_cosine       = excluded.mean_cosine,
				worst_cosine      = excluded.worst_cosine,
				turn_falloff      = excluded.turn_falloff,
				same_identity     = excluded.same_identity,
				captures_total    = excluded.captures_total,
				captures_embedded = excluded.captures_embedded,
				capture_cohesion  = excluded.capture_cohesion,
				views_scored      = excluded.views_scored,
				score_ms          = excluded.score_ms,
				report            = excluded.report,
				scored_at         = now()
		`;
		return true;
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[likeness] score not stored (db unavailable):', err?.message);
		else console.error('[likeness] score insert failed:', err?.message);
		return false;
	}
}

// What gets persisted from a run. Deliberately NOT the whole result object:
// glbUrl is already on the creation row, and nothing derived from the user's
// photos beyond a per-index status may be stored. Face embeddings are
// biometric data and this table holds measurements, not people.
function reportFor(result) {
	return {
		scorerVersion: result.scorerVersion,
		status: result.status,
		views: (result.views || []).map((v) => ({
			view: v.view,
			theta: v.theta,
			status: v.status,
			cosine: numOrNull(v.cosine),
			score5: numOrNull(v.score5),
			meanCaptureCosine: numOrNull(v.meanCaptureCosine),
			detectionScore: numOrNull(v.detectionScore),
			error: v.error ?? null,
		})),
		capturesRejected: (result.capturesRejected || []).map((c) => ({ index: c.index, reason: c.reason })),
		budgetExhausted: result.budgetExhausted === true,
		startedAt: result.startedAt ?? null,
		finishedAt: result.finishedAt ?? null,
	};
}

function numOrNull(v) {
	return Number.isFinite(v) ? v : null;
}

function intOrNull(v) {
	return Number.isFinite(v) ? Math.round(v) : null;
}

// Read-side companion to numOrNull, and NOT the same function: `Number(null)`
// is 0 and `Number.isFinite(0)` is true, so putting a nullable column through
// numOrNull turns "not measured" into a real reading of zero. That is not a
// cosmetic difference here. capture_cohesion is null for a single-photo
// capture because agreement between photos is undefined with one photo, and
// surfacing that as 0.000 reads as "these photos are of different people",
// which is the opposite of what the row says.
function columnNumber(v) {
	if (v === null || v === undefined) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

// Histogram edges in the roadmap's own units. The 4.0 boundary is the gate the
// phase is verified against, so it is a bucket edge rather than something a
// reader has to compute from a chart.
export const SCORE_BUCKETS = [
	{ label: '1.0-2.0', min: 1, max: 2 },
	{ label: '2.0-3.0', min: 2, max: 3 },
	{ label: '3.0-4.0', min: 3, max: 4 },
	{ label: '4.0-5.0', min: 4, max: 5.0001 },
];

// The distribution the internal surface renders: how many generations were
// scored in a window, how they spread across the 1-5 scale, what fraction clear
// the roadmap's 4/5 gate, and how the non-scoring statuses break down (a sweep
// where half the captures were unusable is a capture-quality story, not a
// reconstruction-quality one, and the surface has to be able to tell them
// apart).
export async function likenessDistribution({ days = 30, scorerVersion = SCORER_VERSION } = {}) {
	if (!likenessStoreEnabled()) return null;
	const windowDays = Math.max(1, Math.min(365, Number(days) || 30));
	try {
		const [agg] = await sql`
			select
				count(*)::int                                              as scored,
				avg(likeness_score)::float8                                as mean_score,
				percentile_cont(0.5) within group (order by likeness_score) as median_score,
				min(likeness_score)::float8                                as min_score,
				max(likeness_score)::float8                                as max_score,
				avg(identity_cosine)::float8                               as mean_cosine,
				avg(turn_falloff)::float8                                  as mean_turn_falloff,
				count(*) filter (where likeness_score >= 4)::int           as at_or_above_gate,
				count(*) filter (where same_identity)::int                 as same_identity,
				avg(score_ms)::float8                                      as mean_score_ms
			from avatar_likeness_scores
			where status = 'ok'
				and scorer_version = ${scorerVersion}
				and scored_at > now() - (${windowDays} || ' days')::interval
		`;
		const buckets = await sql`
			select width_bucket(likeness_score, 1, 5, 4) as bucket, count(*)::int as n
			from avatar_likeness_scores
			where status = 'ok'
				and scorer_version = ${scorerVersion}
				and scored_at > now() - (${windowDays} || ' days')::interval
			group by 1
			order by 1
		`;
		const statuses = await sql`
			select status, count(*)::int as n
			from avatar_likeness_scores
			where scorer_version = ${scorerVersion}
				and scored_at > now() - (${windowDays} || ' days')::interval
			group by 1
			order by 2 desc
		`;
		// width_bucket puts an exact 5.0 in overflow bucket 5; fold it into the
		// top bucket so a perfect score is not invisible on the histogram.
		const counts = new Map();
		for (const b of buckets) {
			const idx = Math.min(4, Math.max(1, Number(b.bucket) || 1));
			counts.set(idx, (counts.get(idx) || 0) + b.n);
		}
		const scored = agg?.scored ?? 0;
		return {
			windowDays,
			scorerVersion,
			scored,
			gate: 4,
			atOrAboveGate: agg?.at_or_above_gate ?? 0,
			gateRate: scored ? (agg.at_or_above_gate ?? 0) / scored : null,
			sameIdentity: agg?.same_identity ?? 0,
			meanScore: columnNumber(agg?.mean_score),
			medianScore: columnNumber(agg?.median_score),
			minScore: columnNumber(agg?.min_score),
			maxScore: columnNumber(agg?.max_score),
			meanCosine: columnNumber(agg?.mean_cosine),
			meanTurnFalloff: columnNumber(agg?.mean_turn_falloff),
			meanScoreMs: columnNumber(agg?.mean_score_ms),
			histogram: SCORE_BUCKETS.map((b, i) => ({ ...b, count: counts.get(i + 1) || 0 })),
			statuses: statuses.map((s) => ({ status: s.status, count: s.n })),
		};
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[likeness] distribution skipped (db unavailable):', err?.message);
		else console.error('[likeness] distribution failed:', err?.message);
		return null;
	}
}

// The newest individual measurements, for the surface's table. No URLs, no
// prompt text, no owner: this is an internal quality view, and a likeness score
// is attached to somebody's face, so it carries the minimum that makes a number
// actionable (which generation, when, how well, how far it fell off on a turn).
export async function recentLikenessScores({ limit = 25, scorerVersion = SCORER_VERSION } = {}) {
	if (!likenessStoreEnabled()) return [];
	try {
		const rows = await sql`
			select creation_id, status, likeness_score, identity_cosine, mean_score,
				worst_cosine, turn_falloff, same_identity, captures_total,
				captures_embedded, capture_cohesion, views_scored, score_ms, scored_at
			from avatar_likeness_scores
			where scorer_version = ${scorerVersion}
			order by scored_at desc
			limit ${Math.max(1, Math.min(200, Number(limit) || 25))}
		`;
		return rows.map((r) => ({
			creationId: r.creation_id,
			status: r.status,
			likenessScore: columnNumber(r.likeness_score),
			identityCosine: columnNumber(r.identity_cosine),
			meanScore: columnNumber(r.mean_score),
			worstCosine: columnNumber(r.worst_cosine),
			turnFalloff: columnNumber(r.turn_falloff),
			sameIdentity: r.same_identity,
			capturesTotal: r.captures_total,
			capturesEmbedded: r.captures_embedded,
			captureCohesion: columnNumber(r.capture_cohesion),
			viewsScored: r.views_scored,
			scoreMs: r.score_ms,
			scoredAt: r.scored_at,
		}));
	} catch (err) {
		if (isDbUnavailableError(err)) console.warn('[likeness] recent scores skipped (db unavailable):', err?.message);
		else console.error('[likeness] recent scores failed:', err?.message);
		return [];
	}
}
