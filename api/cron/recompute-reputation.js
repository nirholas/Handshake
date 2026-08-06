// @ts-check
// GET/POST /api/cron/recompute-reputation — refresh persisted agent reputation.
//
// The per-agent endpoint computes a score live and caches it in Redis for a few
// minutes; that's great for a viewed agent but ephemeral. This cron keeps a
// DURABLE score for every agent with a custodial wallet in agent_reputation_scores
// so the reputation-weighted leaderboard, the access/unlock checks, and "your
// score changed" all read a fresh, consistent number for the cost of one DB query.
//
// Each run recomputes the stalest batch (never-scored first, then old-version,
// then oldest) within the cron time budget, so the whole population rolls over
// continuously without any single run going long. Bounded so a large agent
// population never blows the function timeout.
//
// Standalone (not [name].js) so the import graph stays minimal.

import { json, method, wrapCron } from '../_lib/http.js';
import { listStaleAgents, recomputeAgents } from '../_lib/trust/reputation-store.js';
import { requireCron } from '../_lib/cron-auth.js';

// How many agents to recompute per tick. Each is a handful of indexed DB reads
// plus (for full mode) one cached price + light RPC; 40 fits comfortably in the
// cron budget and, at a 10-minute cadence, rolls a few thousand agents per hour.
const BATCH = 40;

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const started = Date.now();
	try {
		const ids = await listStaleAgents(BATCH);
		if (!ids.length) {
			return json(res, 200, { ok: true, scored: 0, failed: 0, reason: 'no agents to score' });
		}
		// Stop well before Vercel's 300s hard kill: a single agent's slow RPC/DB read
		// must not drag the whole batch past the limit and 504 the cron (which would
		// drop every score this tick). Unfinished agents are the stalest, so they're
		// first in line next run — continuous rollover, never lost coverage.
		const { scored, failed, remaining, timedOut } = await recomputeAgents(ids, { deadlineMs: 250_000 });
		console.log(`[recompute-reputation] scored ${scored}/${ids.length} (failed ${failed}, remaining ${remaining}${timedOut ? ', hit time budget' : ''}) in ${Date.now() - started}ms`);
		return json(res, 200, { ok: true, scored, failed, remaining, timed_out: timedOut, batch: ids.length, elapsed_ms: Date.now() - started });
	} catch (err) {
		// Never throw: a failed run leaves the prior stored scores intact.
		console.error('[recompute-reputation] failed:', err?.message || err);
		return json(res, 200, { ok: false, error: err?.message || String(err) });
	}
}, { requireWriteCapacity: true });
