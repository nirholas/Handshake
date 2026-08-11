// @ts-check
// Week-2 retention on minted agents — the phase-2 verification metric from the
// README roadmap ("users return to converse with their own agent; >=30% week-2
// retention on minted agents").
//
// Two halves live here:
//
//   1. The SIGNAL. `recordAgentOwnerVisit` writes one row per (owner, agent, UTC
//      day) into `agent_owner_visits` the first time an owner opens or converses
//      with an agent they own. That is the entire footprint: no IP, no user
//      agent, no session id, no fingerprint, no third-party analytics tag, and no
//      per-request row. Day granularity is exactly what a weekly cohort needs and
//      nothing finer is collected, so the table cannot answer a more invasive
//      question than the one it exists for. Writes are fire-and-forget and never
//      affect the request that triggered them.
//
//   2. The MEASUREMENT. `computeRetentionCohorts` groups owners by the ISO week
//      (Monday, UTC) in which they minted their FIRST agent on-chain, then asks,
//      per owner, whether they came back to a minted agent of theirs during days
//      7..13 after that mint. Measuring from each owner's own mint instant rather
//      than from the cohort week boundary keeps a Sunday minter from being judged
//      on a 1-day window. `api/cron/retention-rollup.js` stores the result.
//
// Every stored date is absolute (a real `date` / `timestamptz`), never a relative
// offset, so a cohort row read months later still means what it meant when it was
// written.

import { sql } from './db.js';
import { withDbRetry } from './db-retry.js';
import { acquireLock } from './cache.js';

/** Metrics stored per cohort week. Mirrors the CHECK constraint on the table. */
export const RETENTION_METRICS = ['week2_converse', 'week2_return'];

/** Human labels for the dashboard, keyed by metric. */
export const RETENTION_METRIC_LABELS = {
	week2_converse: 'Returned to converse',
	week2_return: 'Returned at all',
};

/** The roadmap's phase-2 bar: >=30% week-2 retention on minted agents. */
export const WEEK2_TARGET_RATE = 0.3;

// An owner is "retained" if they came back between day 7 and day 13 after their
// first mint. Days 0..6 are the honeymoon week every minter is active in, so
// counting them would measure nothing.
const WINDOW_START_DAYS = 7;
const WINDOW_END_DAYS = 14;

// Visit-dedup lock TTL. Slightly over a day so the key survives the whole UTC day
// it guards even when the first visit lands a minute after midnight.
const VISIT_LOCK_TTL_S = 26 * 3600;

/** UTC calendar day of an instant, as `YYYY-MM-DD`. */
export function utcDay(at = new Date()) {
	return at.toISOString().slice(0, 10);
}

/**
 * Monday (UTC) of the ISO week containing `at`, as `YYYY-MM-DD`. Matches
 * Postgres `date_trunc('week', …)`, which the cohort query uses, so the JS and
 * SQL sides of a cohort key can never disagree.
 * @param {Date|string} at
 */
export function isoWeekStart(at) {
	const d = at instanceof Date ? new Date(at.getTime()) : new Date(`${at}`.length === 10 ? `${at}T00:00:00Z` : at);
	// getUTCDay: 0=Sunday … 6=Saturday. ISO weeks start Monday, so Sunday sits 6
	// days into its week, not 0.
	const offset = (d.getUTCDay() + 6) % 7;
	const monday = new Date(
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - offset * 86_400_000,
	);
	return monday.toISOString().slice(0, 10);
}

/**
 * The measurement window for an owner who minted at `mintedAt`: days 7..13 after
 * the mint, as absolute `YYYY-MM-DD` bounds. `end` is exclusive.
 * @param {Date|string} mintedAt
 */
export function retentionWindow(mintedAt) {
	const t = (mintedAt instanceof Date ? mintedAt : new Date(mintedAt)).getTime();
	return {
		start: utcDay(new Date(t + WINDOW_START_DAYS * 86_400_000)),
		end: utcDay(new Date(t + WINDOW_END_DAYS * 86_400_000)),
	};
}

/**
 * True once every member of a cohort week has had their full window close — the
 * cohort's number is final and will not move as time passes.
 * @param {string} windowEnd absolute `YYYY-MM-DD`, exclusive
 * @param {string} today     absolute `YYYY-MM-DD`
 */
export function isCohortComplete(windowEnd, today) {
	return windowEnd <= today;
}

/**
 * Record that an owner came back to their own agent today. Never rejects: a Redis
 * or Neon hiccup degrades to a lost data point rather than a failed page load.
 *
 * Deduped per (owner, agent, UTC day, kind) through the shared lock so a burst of
 * dashboard polls is a single write. The upsert is idempotent regardless, so the
 * lock is an optimisation, not a correctness requirement.
 *
 * @param {{ userId: string|null|undefined, agentId: string|null|undefined, conversed?: boolean }} p
 * @returns {Promise<boolean>} true when a row was written on this call.
 */
export async function recordAgentOwnerVisit({ userId, agentId, conversed = false }) {
	if (!userId || !agentId) return false;
	const day = utcDay();
	const kind = conversed ? 'chat' : 'view';
	try {
		const fresh = await acquireLock(
			`retention:visit:${userId}:${agentId}:${day}:${kind}`,
			VISIT_LOCK_TTL_S,
		);
		if (!fresh) return false;
		await withDbRetry(
			() => sql`
				insert into agent_owner_visits (user_id, agent_id, visit_day, viewed, conversed)
				values (${userId}, ${agentId}, ${day}::date, ${!conversed}, ${conversed})
				on conflict (user_id, agent_id, visit_day) do update
				   set viewed       = agent_owner_visits.viewed or excluded.viewed,
				       conversed    = agent_owner_visits.conversed or excluded.conversed,
				       last_seen_at = now()
			`,
			{ timeoutMs: 2_500 },
		);
		return true;
	} catch (err) {
		console.warn('[retention] owner visit write failed', err?.message);
		return false;
	}
}

/**
 * Detached variant for request paths: schedules the write on a microtask so the
 * caller never awaits telemetry. Mirrors `recordEvent` in _lib/usage.js.
 * @param {{ userId: string|null|undefined, agentId: string|null|undefined, conversed?: boolean }} p
 */
export function trackAgentOwnerVisit(p) {
	if (!p?.userId || !p?.agentId) return;
	queueMicrotask(() => {
		recordAgentOwnerVisit(p);
	});
}

/**
 * Compute week-2 retention per cohort week straight from the live tables.
 *
 * "Minted" is the same predicate `api/agents.js` uses for `?onchain=true` — a
 * Metaplex Core asset on Solana (the home chain) or an ERC-8004 identity on an
 * EVM leg — so the word means one thing platform-wide. The mint instant is the
 * `confirmed_at` the on-chain writer stamped, falling back to row creation; the
 * regex guard on that cast is not decoration, since `meta` is free-form jsonb
 * written by several registration paths and a malformed value would raise 22007
 * and take the whole rollup down.
 *
 * @param {{ weeks?: number, today?: string }} [opts]
 *   weeks — how many cohort weeks back to compute (default 26).
 *   today — absolute `YYYY-MM-DD` the completeness check is made against.
 * @returns {Promise<Array<{
 *   cohort_week: string, minted_owners: number, retained_converse: number,
 *   retained_return: number, window_start: string, window_end: string, is_complete: boolean
 * }>>} newest cohort first.
 */
export async function computeRetentionCohorts({ weeks = 26, today = utcDay() } = {}) {
	// Cohort floor: `weeks` full ISO weeks before the current one. Computed here
	// rather than in SQL so the boundary is inspectable and testable.
	const since = utcDay(
		new Date(Date.parse(`${isoWeekStart(today)}T00:00:00Z`) - weeks * 7 * 86_400_000),
	);

	return await sql`
		with minted_agents as (
			select ai.id,
			       ai.user_id,
			       coalesce(
			           case when ai.meta->'onchain'->>'confirmed_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]'
			                then (ai.meta->'onchain'->>'confirmed_at')::timestamptz end,
			           ai.created_at
			       ) as minted_at
			from agent_identities ai
			where ai.deleted_at is null
			  and (ai.meta->'onchain' is not null or ai.erc8004_agent_id is not null)
		),
		owner_cohort as (
			select user_id, min(minted_at) as minted_at
			from minted_agents
			group by user_id
		),
		windowed as (
			select c.user_id,
			       (date_trunc('week', c.minted_at at time zone 'UTC'))::date       as cohort_week,
			       ((c.minted_at at time zone 'UTC') + interval '7 days')::date     as window_start,
			       ((c.minted_at at time zone 'UTC') + interval '14 days')::date    as window_end
			from owner_cohort c
			where (date_trunc('week', c.minted_at at time zone 'UTC'))::date >= ${since}::date
		)
		select w.cohort_week::text as cohort_week,
		       count(*)::int       as minted_owners,
		       count(*) filter (where exists (
		           select 1
		           from agent_owner_visits v
		           join minted_agents m on m.id = v.agent_id and m.user_id = w.user_id
		           where v.user_id = w.user_id
		             and v.visit_day >= w.window_start
		             and v.visit_day <  w.window_end
		             and v.conversed
		       ))::int as retained_converse,
		       count(*) filter (where exists (
		           select 1
		           from agent_owner_visits v
		           join minted_agents m on m.id = v.agent_id and m.user_id = w.user_id
		           where v.user_id = w.user_id
		             and v.visit_day >= w.window_start
		             and v.visit_day <  w.window_end
		       ))::int as retained_return,
		       min(w.window_start)::text as window_start,
		       max(w.window_end)::text   as window_end,
		       bool_and(w.window_end <= ${today}::date) as is_complete
		from windowed w
		group by w.cohort_week
		order by w.cohort_week desc
	`;
}

/**
 * Flatten the per-week query result into one storable record per (week, metric).
 * Pure — the rollup cron's arithmetic lives here so it can be tested without a
 * database.
 *
 * @param {Array<Record<string, any>>} rows result of `computeRetentionCohorts`
 * @param {string} [today] absolute `YYYY-MM-DD` used for the completeness flag
 */
export function cohortRecords(rows, today = utcDay()) {
	const out = [];
	for (const row of rows ?? []) {
		const minted = Number(row.minted_owners) || 0;
		if (minted <= 0) continue;
		const windowEnd = String(row.window_end);
		const complete = row.is_complete === undefined
			? isCohortComplete(windowEnd, today)
			: Boolean(row.is_complete);
		for (const metric of RETENTION_METRICS) {
			const retained = Number(
				metric === 'week2_converse' ? row.retained_converse : row.retained_return,
			) || 0;
			out.push({
				cohortWeek: String(row.cohort_week),
				metric,
				mintedOwners: minted,
				retainedOwners: retained,
				retentionRate: retained / minted,
				windowStart: String(row.window_start),
				windowEnd: windowEnd,
				isComplete: complete,
			});
		}
	}
	return out;
}

/**
 * Persist one cohort record. Idempotent — a re-run of the same week overwrites
 * its own row, so the rollup can safely recompute a long tail of weeks every time
 * (late-arriving visits do move a not-yet-complete cohort).
 * @param {ReturnType<typeof cohortRecords>[number]} rec
 */
export async function upsertCohortRecord(rec) {
	await sql`
		insert into agent_retention_cohorts
		    (cohort_week, metric, minted_owners, retained_owners, retention_rate,
		     window_start, window_end, is_complete, computed_at)
		values (${rec.cohortWeek}::date, ${rec.metric}, ${rec.mintedOwners}, ${rec.retainedOwners},
		        ${rec.retentionRate}, ${rec.windowStart}::date, ${rec.windowEnd}::date,
		        ${rec.isComplete}, now())
		on conflict (cohort_week, metric) do update
		   set minted_owners   = excluded.minted_owners,
		       retained_owners = excluded.retained_owners,
		       retention_rate  = excluded.retention_rate,
		       window_start    = excluded.window_start,
		       window_end      = excluded.window_end,
		       is_complete     = excluded.is_complete,
		       computed_at     = excluded.computed_at
	`;
}

/**
 * Read stored cohorts for one metric, oldest first (chart order).
 * @param {{ metric?: string, limit?: number }} [opts]
 */
export async function readCohorts({ metric = 'week2_converse', limit = 26 } = {}) {
	const capped = Math.min(Math.max(Number(limit) || 26, 1), 104);
	const rows = await sql`
		select cohort_week::text  as cohort_week,
		       metric,
		       minted_owners,
		       retained_owners,
		       retention_rate,
		       window_start::text as window_start,
		       window_end::text   as window_end,
		       is_complete,
		       computed_at
		from agent_retention_cohorts
		where metric = ${metric}
		order by cohort_week desc
		limit ${capped}
	`;
	return rows.reverse();
}

/**
 * Headline numbers for the dashboard: the most recent COMPLETE cohort (the only
 * one whose number is final), plus a pooled rate across every complete cohort.
 * Pure, so the dashboard's summary line is unit-testable.
 * @param {Array<Record<string, any>>} cohorts oldest first, as `readCohorts` returns
 */
export function summarizeCohorts(cohorts) {
	const complete = (cohorts ?? []).filter((c) => c.is_complete);
	const latest = complete.length ? complete[complete.length - 1] : null;
	const mintedTotal = complete.reduce((s, c) => s + (Number(c.minted_owners) || 0), 0);
	const retainedTotal = complete.reduce((s, c) => s + (Number(c.retained_owners) || 0), 0);
	return {
		latestCompleteWeek: latest ? String(latest.cohort_week) : null,
		latestRate: latest ? Number(latest.retention_rate) : null,
		pooledRate: mintedTotal > 0 ? retainedTotal / mintedTotal : null,
		completeCohorts: complete.length,
		mintedOwners: mintedTotal,
		retainedOwners: retainedTotal,
		target: WEEK2_TARGET_RATE,
		meetsTarget: mintedTotal > 0 ? retainedTotal / mintedTotal >= WEEK2_TARGET_RATE : null,
	};
}
