// Reputation store — the durable, recomputed-on-a-cadence layer for agent
// financial reputation.
//
// The per-agent endpoint (api/agents/:id/reputation) computes the score live and
// caches it in Redis for 3 minutes. That keeps the hot read fast, but it is
// ephemeral: it can't power a reputation-weighted leaderboard, an access check
// that must be cheap and consistent, or "your score changed" history. This module
// adds the durable layer:
//
//   • agent_reputation_scores — one row per agent: the score, tier, version, the
//     full component breakdown (pillars/totals/discounted), and when it was
//     computed. Written by the recompute cron (api/cron/recompute-reputation.js)
//     and warmed opportunistically by the live endpoint.
//   • getEffectiveReputation() — the fast read the access layer uses: serve the
//     stored row when it is fresh, otherwise compute live (lite) and self-heal the
//     store. Never fabricates: a brand-new agent reads honestly as "new".
//
// The score is ALWAYS the same pure computation (computeReputation) over real
// inputs — this module only persists and schedules it, never invents a number.

import { sql, isDbUnavailableError } from '../db.js';
import { getAgentReputation, REPUTATION_VERSION } from './wallet-reputation.js';

// A stored score older than this is treated as stale by the access layer's fast
// read, which then recomputes live and refreshes the row. The cron runs more
// often than this, so under normal operation reads are always served from a fresh
// row; this bound just guarantees an access check never trusts an old number.
export const STORE_FRESH_MS = 15 * 60_000;

let _ensured = null;
function ensureTable() {
	if (_ensured) return _ensured;
	_ensured = (async () => {
		await sql`
			create table if not exists agent_reputation_scores (
				agent_id    uuid primary key,
				score       numeric(5,1) not null,
				tier        text not null,
				is_new      boolean not null default false,
				version     integer not null,
				partial     boolean not null default false,
				-- The full computeReputation() result minus the per-call timestamp:
				-- pillars, totals, discounted, evidence, isNew, etc. Rendered verbatim
				-- by the transparency UI and read by the access layer.
				components  jsonb not null,
				computed_at timestamptz not null default now()
			)
		`;
		// Reputation-weighted discovery: rank agents by stored score cheaply.
		await sql`create index if not exists agent_reputation_scores_score_idx on agent_reputation_scores (score desc)`;
		// The recompute cron picks the stalest rows first.
		await sql`create index if not exists agent_reputation_scores_computed_idx on agent_reputation_scores (computed_at asc)`;
		return true;
	})().catch((err) => {
		if (isDbUnavailableError(err)) console.warn('[reputation-store] ensureTable deferred (db unavailable):', err?.message || err);
		else console.error('[reputation-store] ensureTable failed:', err?.message || err);
		_ensured = null;
		return false;
	});
	return _ensured;
}

/**
 * Persist one computed reputation result. Fire-and-forget safe: a write failure
 * (e.g. table not migrated on a cold deploy) logs and resolves false rather than
 * breaking the caller. Never stores a degraded/partial-zero score as authoritative
 * unless it carries real signal — but we still record `partial` so readers know.
 *
 * @param {object} result the object returned by getAgentReputation()
 * @returns {Promise<boolean>}
 */
export async function saveReputation(result) {
	if (!result?.agent_id) return false;
	if (!(await ensureTable())) return false;
	const { agent_id, score, tier, isNew, version, computed_at, partial, ...rest } = result;
	// Strip the volatile timestamp from the stored components; computed_at is its
	// own column. Keep everything the transparency UI and access layer need.
	const components = { score, tier, isNew, version, ...rest };
	try {
		await sql`
			insert into agent_reputation_scores (agent_id, score, tier, is_new, version, partial, components, computed_at)
			values (${agent_id}, ${score}, ${tier}, ${Boolean(isNew)}, ${version || REPUTATION_VERSION},
				${Boolean(partial)}, ${JSON.stringify(components)}, ${computed_at || new Date().toISOString()})
			on conflict (agent_id) do update set
				score = excluded.score,
				tier = excluded.tier,
				is_new = excluded.is_new,
				version = excluded.version,
				partial = excluded.partial,
				components = excluded.components,
				computed_at = excluded.computed_at
		`;
		return true;
	} catch (err) {
		console.warn('[reputation-store] saveReputation failed:', err?.message || err);
		return false;
	}
}

/**
 * Read the stored reputation row for an agent, or null when there is none / the
 * table isn't ready. Reconstitutes the full result shape (components + columns).
 */
export async function readStoredReputation(agentId) {
	if (!agentId) return null;
	let row;
	try {
		[row] = await sql`
			select agent_id, score, tier, is_new, version, partial, components, computed_at
			from agent_reputation_scores where agent_id = ${agentId} limit 1
		`;
	} catch {
		return null;
	}
	if (!row) return null;
	const components = row.components || {};
	return {
		...components,
		agent_id: row.agent_id,
		score: Number(row.score),
		tier: row.tier,
		isNew: row.is_new,
		version: row.version,
		partial: row.partial,
		computed_at: row.computed_at instanceof Date ? row.computed_at.toISOString() : row.computed_at,
		stored: true,
	};
}

/**
 * The fast, consistent reputation read the access layer relies on: serve the
 * stored row when it is fresh; otherwise compute live (lite — skips the heavy
 * solvency/registry RPC reads, conviction/tier stay accurate) and self-heal the
 * store. Falls back to a live compute whenever the store is unavailable.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs=STORE_FRESH_MS]
 * @returns {Promise<object>} full reputation result
 */
export async function getEffectiveReputation(agentId, { maxAgeMs = STORE_FRESH_MS } = {}) {
	const stored = await readStoredReputation(agentId);
	if (stored?.computed_at && stored.version === REPUTATION_VERSION) {
		const age = Date.now() - new Date(stored.computed_at).getTime();
		if (age <= maxAgeMs) return stored;
	}
	const live = await getAgentReputation(agentId, { lite: true });
	// Warm the store so the next read (and the leaderboard) is instant. Never store
	// a partial as if complete — but a partial live result is still returned now.
	if (!live.partial) saveReputation(live).catch(() => {});
	return live;
}

/**
 * Agents most in need of a recompute, stalest first. Prioritises agents that have
 * a custodial Solana wallet (the ones with real financial life to score) and have
 * either never been scored or whose stored score is oldest / on an old version.
 *
 * @param {number} limit
 * @returns {Promise<string[]>} agent ids
 */
export async function listStaleAgents(limit = 40) {
	await ensureTable();
	try {
		const rows = await sql`
			select a.id
			from agent_identities a
			left join agent_reputation_scores r on r.agent_id = a.id
			where a.deleted_at is null
			  and a.meta->>'solana_address' is not null
			order by
				(r.agent_id is null) desc,                       -- never-scored first
				(r.version is distinct from ${REPUTATION_VERSION}) desc, -- then old-version
				r.computed_at asc nulls first                    -- then stalest
			limit ${limit}
		`;
		return rows.map((r) => r.id);
	} catch (err) {
		// A DB outage must NOT read as "nobody needs scoring": swallowing it made
		// the recompute cron answer {ok:true, scored:0} and heartbeat healthy for
		// as long as the database was down, so the one signal that the durable
		// scores had stopped refreshing was invisible. Re-throw it and let the
		// caller's wrapCron classify it as db_unavailable. Every other failure
		// (a missing column mid-migration, a malformed row) still degrades to an
		// empty batch, which the next tick retries.
		if (isDbUnavailableError(err)) throw err;
		console.warn('[reputation-store] listStaleAgents failed:', err?.message || err);
		return [];
	}
}

/**
 * Recompute + persist a batch of agents (used by the cron). Computes the FULL
 * score (not lite) so the durable row carries solvency + registry signal. Bounded
 * concurrency to stay within the cron time budget and avoid RPC bursts.
 *
 * @param {string[]} agentIds
 * @param {object} [opts]
 * @param {number} [opts.concurrency]
 * @param {number} [opts.deadlineMs] stop dispatching new chunks once this much
 *   wall-clock has elapsed, so a per-agent RPC/DB latency spike can't run the
 *   batch past the cron's function timeout. Unscored agents simply roll over to
 *   the next tick (they sort as stalest-first), so coverage is never lost.
 * @returns {Promise<{ scored: number, failed: number, remaining: number, timedOut: boolean }>}
 */
export async function recomputeAgents(
	agentIds = [],
	{ concurrency = 4, deadlineMs = Infinity, perAgentTimeoutMs = 20_000 } = {},
) {
	let scored = 0;
	let failed = 0;
	let timedOut = false;
	const ids = [...new Set(agentIds.filter(Boolean))];
	const startedAt = Date.now();
	let i = 0;
	for (; i < ids.length; i += concurrency) {
		const elapsed = Date.now() - startedAt;
		// Cap each agent's compute so ONE hung upstream (a stalled Solana RPC, a slow
		// DB read) can't block the whole chunk — and thus the cron — past Vercel's
		// hard function timeout. Checking the deadline only BETWEEN chunks is not
		// enough: an un-timed getAgentReputation() inside Promise.allSettled awaits
		// forever, so the 250s deadline never gets a turn and the run 504s at 300s.
		const remainingBudget = Number.isFinite(deadlineMs) ? deadlineMs - elapsed : Infinity;
		if (remainingBudget <= 0) { timedOut = true; break; }
		// The per-agent ceiling is the smaller of a fixed budget and the wall-clock
		// remaining before the deadline, so even the final chunk can't overrun it.
		// A tiny remaining sliver just means slow agents on the last chunk time out
		// and roll over to the next tick — never lost, since they sort stalest-first.
		const budget = Math.min(perAgentTimeoutMs, remainingBudget);
		const chunk = ids.slice(i, i + concurrency);
		const results = await Promise.allSettled(
			chunk.map((id) => withTimeout(getAgentReputation(id), budget, id)),
		);
		for (const r of results) {
			if (r.status === 'fulfilled' && r.value) {
				const ok = await saveReputation(r.value);
				ok ? scored++ : failed++;
			} else {
				// A timed-out or failed agent rolls over to the next tick — it sorts
				// stalest-first — so bounding it here never loses coverage.
				failed++;
			}
		}
	}
	return { scored, failed, remaining: Math.max(0, ids.length - i), timedOut };
}

// Race a per-agent recompute against a timeout. A hung upstream can leave the
// original promise pending forever; Promise.race settles on the timeout, and the
// loser's late rejection is swallowed so it never surfaces as an unhandled
// rejection after the race resolved. The timer is always cleared so a fast agent
// doesn't leave a dangling handle keeping the function warm.
function withTimeout(promise, ms, id) {
	promise.catch(() => {}); // swallow a late rejection from the losing promise
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`reputation recompute timed out for ${id} after ${ms}ms`)),
			ms,
		);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
