// POST /api/agent/watch-intent  { agentId }
//
// Signals that a viewer is actively watching an agent right now. The on-demand
// caster pool (workers/agent-screen-pool) reads these signals and spins up a
// real Playwright browser for the most-wanted agents, tearing them down when
// nobody is watching. This is what makes a live browser feed available for ANY
// agent on demand without paying for an idle browser per agent.
//
// Public + IP rate-limited: anyone looking at the live wall or an agent screen
// can express intent. We store intent in a Redis sorted set keyed by recency, so
// stale entries fall out of the window automatically: no auth, no DB write.
//
//   ZADD screen:wanted  <now>  <agentId>     (score = last-seen ms)
//   ZADD screen:wanted:count:<agentId> tracked via the score being refreshed.
//
// The worker reads /api/agent/watch-wanted to get the current set.

import { cors, json, method, error, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getRedis } from '../_lib/redis.js';
import { isUuid } from '../_lib/validate.js';
import {
	normalizeReaction,
	REACTION_THROTTLE_MS,
	REACTION_WINDOW_MS,
	REACTION_RECENT_CAP,
	reactionsRecentKey,
	reactionsTotalKey,
	reactionThrottleKey,
} from '../_lib/reaction-rules.js';

export const WANTED_KEY = 'screen:wanted';
const PRUNE_WINDOW_MS = 120_000; // drop intents older than 2 minutes

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	// Generous per-IP limit: a watcher re-pings every ~20s per card, and the live
	// wall may show dozens of cards at once.
	const rl = await limits.apiIp(clientIp(req), { limit: 600, window: '60s' });
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req, 2_000).catch(() => null);
	const agentId = body && typeof body.agentId === 'string' ? body.agentId.trim() : '';
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'valid agentId required');

	// Optional reaction ride-along. A viewer can express intent AND fire a reaction
   // in the same call. Invalid/absent reactions simply don't react: they never
	// fail the intent, which is the load-bearing signal for the caster pool.
	const reaction = normalizeReaction(body?.reaction);

	const r = getRedis();
	if (!r) {
		// No Redis: the wall still works (activity view) and the tapper's own
		// optimistic burst already acknowledged them: we just can't fan out.
		return json(res, 200, { ok: true, queued: false, reaction: reaction ? { emoji: reaction, broadcast: false } : null });
	}

	const now = Date.now();
	try {
		await Promise.all([
			r.zadd(WANTED_KEY, { score: now, member: agentId }),
			r.zremrangebyscore(WANTED_KEY, 0, now - PRUNE_WINDOW_MS),
			r.expire(WANTED_KEY, 300),
		]);
	} catch { /* non-critical: the wall degrades to the activity view */ }

	if (!reaction) return json(res, 200, { ok: true, queued: true });

	// Per-IP-per-agent throttle so one viewer can't spam the overlay. SET NX with a
	// short TTL is the gate: the server is authoritative; client throttling is
	// cosmetic. A throttled reaction still returns 200 (intent succeeded) with
	// throttled:true so the bar can show a quiet "give it a sec" cue.
	try {
		const ip = clientIp(req);
		const gate = await r.set(reactionThrottleKey(agentId, ip), '1', { nx: true, px: REACTION_THROTTLE_MS });
		if (gate !== 'OK' && gate !== true) {
			return json(res, 200, { ok: true, queued: true, throttled: true });
		}
	} catch { /* if the gate read fails, fall through: better to react than to drop */ }

	let total = null;
	try {
		const windowSec = Math.ceil(REACTION_WINDOW_MS / 1000);
		const recentKey = reactionsRecentKey(agentId);
		const totalKey = reactionsTotalKey(agentId);
		const [, , incr] = await Promise.all([
			// Push to the replay list the stream tails, newest-first, capped + TTL'd.
			r.lpush(recentKey, JSON.stringify({ emoji: reaction, ts: now })),
			r.ltrim(recentKey, 0, REACTION_RECENT_CAP - 1),
			// Windowed running total that drives every viewer's live count.
			r.incr(totalKey),
		]);
		await Promise.all([
			r.expire(recentKey, windowSec),
			r.expire(totalKey, windowSec),
		]);
		total = Number(incr) || null;
	} catch { /* reaction fan-out is best-effort; intent already succeeded */ }

	return json(res, 200, { ok: true, queued: true, reaction: { emoji: reaction, total, broadcast: true } });
});
