// GET /api/agent/watch-status?agentId=<uuid>  →  { state, position?, max }
//
// Resolves, from Redis ALONE (no DB), where a single agent sits in the on-demand
// caster pipeline so the live wall can show an honest handoff between the
// zero-cost activity terminal and real browser pixels:
//
//   • casting  — a real frame exists (a Playwright caster is pushing pixels now).
//   • warming  — the agent is inside the watch window AND the pool has free
//                capacity, so a browser is (or is about to be) spinning up for it.
//   • queued   — the agent is wanted but the pool is at MAX_BROWSERS; we return a
//                1-based queue position so the card can say "#N in line".
//   • activity  not wanted, no caster pool running, or Redis is off: the
//                always-available activity view stays, and we never claim a live
//                state without a real frame.
//
// "No caster pool running" is load-bearing. warming/queued are promises that a
// real browser is coming, and only a live pool can keep them. The pool proves it
// is alive by polling /api/agent/watch-wanted, which refreshes POOL_ALIVE_KEY;
// with that key absent every wanted agent falls back to the honest activity view
// instead of spinning "warming up" at a viewer forever.
//
// The wall fetches this on mount and refreshes it only while a card is
// warming/queued — never once it's casting (frames drive that), so steady-state
// adds no per-frame load. Public + per-IP rate-limited like watch-intent.
//
// SCREEN_POOL_MAX must mirror the pool worker's MAX_BROWSERS (default 6) for the
// queue math to be accurate — the worker casts the first MAX_BROWSERS wanted
// agents in recency order, exactly the ordering ZREVRANK reflects here.

import { cors, json, method, error, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getRedis } from '../_lib/redis.js';
import { isUuid } from '../_lib/validate.js';
import { POOL_ALIVE_KEY } from './watch-wanted.js';

export const WANTED_KEY = 'screen:wanted';
const WINDOW_MS = 90_000; // mirrors watch-wanted: agents wanted within 90s are live-watched
// Read-only mirror of the worker's MAX_BROWSERS. Display/queue-math only — the
// worker reads its own env; this never casts, it only reports position.
export const POOL_MAX = Math.max(1, Number(process.env.SCREEN_POOL_MAX) || 6);

// Pure queue-math seam (unit-tested): given an agent's reverse-rank in the wanted
// set (0 = most-recently-wanted) and the pool size, classify its handoff state.
// Ranks 0..max-1 are within casting capacity (warming); the rest queue, 1-based.
// With no caster pool alive there is nothing to warm up or queue behind, so the
// honest answer is the activity view regardless of rank.
export function classifyRank(rank, max = POOL_MAX, { poolAlive = true } = {}) {
	if (!poolAlive) return { state: 'activity' };
	if (rank == null || rank < 0) return { state: 'activity' };
	if (rank < max) return { state: 'warming' };
	return { state: 'queued', position: rank - max + 1 };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	// High-frequency status poll: bound per-IP, enforced per-instance (local) so a
	// poll flood can't drain the Upstash quota the wall's economics depend on.
	const rl = await limits.apiIp(clientIp(req), { limit: 300, window: '60s', local: true });
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const agentId = (url.searchParams.get('agentId') || '').trim();
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'valid agentId required');

	const r = getRedis();
	// No Redis → the activity view is the honest state; never fake a live handoff.
	if (!r) return json(res, 200, { state: 'activity', max: POOL_MAX }, { 'cache-control': 'no-store' });

	try {
		// A live frame outranks everything: if pixels exist, we're casting.
		const hasFrame = await r.exists(`agent:screen:${agentId}:frame`);
		if (hasFrame) return json(res, 200, { state: 'casting', max: POOL_MAX }, { 'cache-control': 'no-store' });

		// Otherwise place the agent in the wanted ordering. Stale members (older than
		// the window) carry lower scores and rank BELOW every in-window member, so a
		// fresh agent's reverse-rank equals its position among currently-wanted
		// agents — the same set, in the same order, the worker casts from.
		const [score, rank, poolAlive] = await Promise.all([
			r.zscore(WANTED_KEY, agentId),
			r.zrevrank(WANTED_KEY, agentId),
			r.exists(POOL_ALIVE_KEY),
		]);
		const fresh = score != null && Date.now() - Number(score) <= WINDOW_MS;
		if (!fresh) return json(res, 200, { state: 'activity', max: POOL_MAX }, { 'cache-control': 'no-store' });

		return json(res, 200, {
			...classifyRank(rank, POOL_MAX, { poolAlive: !!poolAlive }),
			max: POOL_MAX,
		}, { 'cache-control': 'no-store' });
	} catch {
		// Redis blip — degrade to the always-available activity view, never an error.
		return json(res, 200, { state: 'activity', max: POOL_MAX }, { 'cache-control': 'no-store' });
	}
});
