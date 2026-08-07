// Live activity feed — the multiplayer server's producer half.
//
// The standalone game server emits the in-world half of the site-wide activity
// ticker (level-ups, world-joins, jackpots). It writes to the SAME capped Redis
// list the serverless API reads from (`feed:events`), mirroring how
// presence-store splits writer (this server) from reader (api/_lib/feed.js).
// Keep the key and event shape in lockstep with api/_lib/feed.js.
//
// Every publish is best-effort and self-throttled: the feed is a delight layer,
// never on the gameplay critical path. Redis being unreachable, or the server
// running memory-only, simply means no events — never a thrown error in a room
// handler.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

const FEED_KEY = 'feed:events';
const MAX_EVENTS = 200;
const ALLOWED_TYPES = new Set(['coin-buy', 'agent-deploy', 'level-up', 'world-join', 'jackpot', 'mission-complete', 'war-result']);

// Per-event-kind cooldown so a busy world can't flood the global ticker with a
// hundred near-identical lines. Keyed by `${type}:${dedupeKey}`.
const THROTTLE_MS = 60_000;
const _lastByKey = new Map();

let _redis = null;
let _redisReady = null;
let _seq = 0;

if (REDIS_URL && REDIS_TOKEN) {
	_redisReady = import('@upstash/redis')
		.then(async ({ Redis }) => {
			_redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
			await _redis.ping();
			console.log('[feed] activity feed: writing to Upstash Redis (verified)');
		})
		.catch((err) => {
			_redis = null;
			console.warn('[feed] Redis unreachable — activity events will be dropped:', err?.message);
		});
} else {
	console.log('[feed] activity feed disabled (no UPSTASH_REDIS_REST_URL/_TOKEN)');
}

function eventId(ts) {
	_seq = (_seq + 1) % 1_000_000;
	return `${ts.toString(36)}-${_seq.toString(36)}`;
}

// Fire-and-forget. `dedupeKey` collapses repeats of the same kind within the
// throttle window (e.g. the same player levelling several skills in a flurry).
// Returns a promise only so callers may await in tests; room handlers should
// not await it.
export function publishFeedEvent(event, dedupeKey = '') {
	if (!_redis || !event || !ALLOWED_TYPES.has(event.type)) return Promise.resolve(null);

	const now = Date.now();
	const throttleKey = `${event.type}:${dedupeKey}`;
	if (dedupeKey) {
		const last = _lastByKey.get(throttleKey) || 0;
		if (now - last < THROTTLE_MS) return Promise.resolve(null);
		_lastByKey.set(throttleKey, now);
		// Bound the throttle map: drop entries older than the window on each write.
		if (_lastByKey.size > 5000) {
			for (const [k, t] of _lastByKey) if (now - t > THROTTLE_MS) _lastByKey.delete(k);
		}
	}

	const ts = Number.isFinite(event.ts) ? event.ts : now;
	const record = { ...event, ts, id: event.id || eventId(ts) };
	return (async () => {
		try {
			await _redis.lpush(FEED_KEY, JSON.stringify(record));
			await _redis.ltrim(FEED_KEY, 0, MAX_EVENTS - 1);
			return record;
		} catch (err) {
			console.warn('[feed] publish failed:', err?.message);
			return null;
		}
	})();
}

// Exposed for tests / graceful shutdown sequencing.
export function feedReady() {
	return _redisReady || Promise.resolve();
}
