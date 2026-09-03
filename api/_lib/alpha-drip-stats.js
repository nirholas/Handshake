/**
 * How fast a leader's edge actually decays: measured, not assumed.
 *
 * Alpha-drip prices latency, so the only honest way to judge a ladder is against
 * how long this leader's entry advantage survives in their own history. The
 * proxy is the MEDIAN hold time of their profitable closed positions: the window
 * in which following them was still worth something. A ladder whose slowest tier
 * waits longer than that is selling a signal that is already spent, which is
 * exactly what `assessFairness` refuses to ship quietly.
 *
 * Median, not mean, because one position held overnight would otherwise justify
 * a delay nobody should be sold. Returns null rather than a guess when the
 * leader has too few profitable closes to measure. Every caller treats a null
 * half-life as "cannot judge" and says nothing instead of inventing a number.
 */

import { sql } from './db.js';

/** Below this many profitable closes the median is noise, not a measurement. */
export const MIN_CLOSES_FOR_HALFLIFE = 5;

/**
 * @param {string} leaderAgentId agent_identities.id
 * @param {object} [opts] { network }
 * @returns {Promise<number|null>} seconds, or null when unmeasurable
 */
export async function leaderEdgeHalflifeSec(leaderAgentId, { network = 'mainnet' } = {}) {
	if (!leaderAgentId) return null;
	try {
		const rows = await sql`
			select extract(epoch from (closed_at - opened_at)) as hold_sec
			from agent_sniper_positions
			where agent_id = ${leaderAgentId}
			  and network = ${network}
			  and status = 'closed'
			  and closed_at is not null
			  and closed_at > opened_at
			  and realized_pnl_lamports is not null
			  and realized_pnl_lamports > 0
			order by closed_at desc
			limit 200
		`;
		const holds = rows.map((r) => Number(r.hold_sec)).filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
		if (holds.length < MIN_CLOSES_FOR_HALFLIFE) return null;
		return median(holds);
	} catch {
		// A stats read must never block a leader from saving their ladder.
		return null;
	}
}

function median(sorted) {
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
