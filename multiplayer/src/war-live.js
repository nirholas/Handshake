// Live war registry, the multiplayer server's spectator half of Coin Wars.
//
// A battle runs inside a ClashRoom, which only its fighters are connected to.
// Players standing in either community's world want to watch it without joining
// it: the score, the round clock, who just got knocked down. Opening a second
// websocket per spectator (and a second 3D render) to answer that would be
// absurd, so the room instead publishes a small JSON snapshot to Redis on a
// heartbeat and the portal board polls a cheap read (api/_lib/wars-store.js
// reads exactly these keys).
//
// Same writer/reader split as feed.js and presence-store.js: Redis is the bus
// between the long-running game server and the serverless API. Every write is
// best-effort, spectating is a delight layer, never on the battle's critical
// path, so an unreachable Redis means no spectators, never a thrown error inside
// a room handler.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

const LIVE_KEY = (matchKey) => `wars:live:${matchKey}`;
const LIVE_INDEX = 'wars:live:index';

// A snapshot outlives its heartbeat by enough that a slow tick never makes a
// running war blink out of the board, and expires soon enough that a crashed
// room stops advertising a battle nobody is fighting.
const SNAPSHOT_TTL_S = 120;

// Minimum gap between heartbeats for one match. The clock and score are the only
// things that move between kills, and the board renders its own countdown from
// `endsAt`, so 2s is plenty and keeps the write rate flat regardless of how
// furious the fight is.
export const HEARTBEAT_MS = 2000;

// How many knockdowns ride along for the kill feed. The board shows the last
// handful; anything older is history the ledger keeps.
const KILL_FEED_MAX = 12;

let _redis = null;
let _redisReady = null;

if (REDIS_URL && REDIS_TOKEN) {
	_redisReady = import('@upstash/redis')
		.then(async ({ Redis }) => {
			_redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
			await _redis.ping();
			console.log('[war-live] live war registry: writing to Upstash Redis (verified)');
		})
		.catch((err) => {
			_redis = null;
			console.warn('[war-live] Redis unreachable, wars will not be spectatable:', err?.message);
		});
} else {
	console.log('[war-live] live war registry disabled (no UPSTASH_REDIS_REST_URL/_TOKEN)');
}

/**
 * Publish (or refresh) one running battle. Returns the snapshot that was written,
 * or null when nothing was written (no Redis, bad shape, or a failed command).
 * @param {object} snapshot see ClashRoom._liveSnapshot() for the fields
 */
export function publishWarLive(snapshot) {
	if (!_redis || !snapshot?.matchKey) return Promise.resolve(null);
	const record = {
		...snapshot,
		kills: (snapshot.kills || []).slice(-KILL_FEED_MAX),
		updatedAt: Number.isFinite(snapshot.updatedAt) ? snapshot.updatedAt : Date.now(),
	};
	return (async () => {
		try {
			await _redis.set(LIVE_KEY(record.matchKey), JSON.stringify(record), { ex: SNAPSHOT_TTL_S });
			await _redis.zadd(LIVE_INDEX, { score: record.updatedAt, member: record.matchKey });
			// Sweep index entries whose snapshot has certainly expired, so the set
			// cannot grow without bound across a long-running process.
			await _redis.zremrangebyscore(LIVE_INDEX, 0, record.updatedAt - SNAPSHOT_TTL_S * 1000);
			return record;
		} catch (err) {
			console.warn('[war-live] publish failed:', err?.message);
			return null;
		}
	})();
}

/**
 * Drop a battle from the registry the moment its room disposes, so the portal
 * stops showing a war whose arena has already emptied out rather than waiting for
 * the TTL to expire it.
 */
export function clearWarLive(matchKey) {
	if (!_redis || !matchKey) return Promise.resolve(false);
	return (async () => {
		try {
			await _redis.del(LIVE_KEY(matchKey));
			await _redis.zrem(LIVE_INDEX, matchKey);
			return true;
		} catch (err) {
			console.warn('[war-live] clear failed:', err?.message);
			return false;
		}
	})();
}

// Exposed for tests / graceful shutdown sequencing, mirroring feed.js.
export function warLiveReady() {
	return _redisReady || Promise.resolve();
}
