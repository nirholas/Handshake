// Coin Wars — persistence for the war league.
//
// Three small stores behind one module, all keyed off the coin mint that a
// community fights under:
//
//   1. The BATTLE LEDGER — every finished clash, appended by the game server
//      (multiplayer/src/rooms/ClashRoom.js → war-report.js → POST /api/wars).
//      The Elo standings are recomputed from this list on every read with the
//      shared math in multiplayer/src/war-standings.js, so there is exactly one
//      implementation of "who is winning the war" and nothing to keep in sync.
//   2. The LIVE REGISTRY — a short-TTL snapshot of every clash currently in
//      progress, refreshed by the room itself. This is what lets a player
//      standing in a coin's world watch a war they are not in without opening a
//      second 3D client.
//   3. The MATCHMAKING QUEUE — communities waiting for an opponent. Pairing two
//      of them mints the `matchKey` that Colyseus's filterBy(['matchKey']) uses
//      to seat both sides in the same ClashRoom instance.
//
// Storage is Upstash Redis, with an in-process fallback that has the same
// semantics so the whole feature is playable on a laptop with no infra (the
// pattern clash-store.js established, for the same reason: a Redis blip must
// degrade the league, never 5xx the world).

import { getRedis } from './redis.js';

const redis = getRedis();

const K = {
	ledger: 'wars:ledger',   // capped LIST of battle JSON, newest first
	live: 'wars:live',       // HASH matchKey → live-war JSON (self-expiring by field)
	queue: 'wars:queue',     // HASH mint → queued-community JSON
	pairing: 'wars:pair',    // HASH `${mint}:${wallet}` → pairing JSON
};

// How many finished battles the ledger keeps. Elo is path-dependent, so a
// truncated ledger re-bases ratings on the window it can see; 1000 battles is
// far more history than the standings board ever shows and keeps the recompute
// on a single Redis read.
const LEDGER_MAX = 1000;

// A live-war snapshot is stale this long after its last heartbeat. ClashRoom
// beats every 10s while a match is alive, so three missed beats retire it — a
// crashed game server can never leave a phantom war on the portal board.
export const LIVE_TTL_MS = 35_000;

// A community waits this long for an opponent before the queue forgets it. Long
// enough to walk to the portal and read the board, short enough that a stale
// entry never pairs someone who has closed the tab.
export const QUEUE_TTL_MS = 180_000;

// A minted pairing waits this long to be collected by the side that was already
// queued. Comfortably longer than one poll interval and shorter than the queue
// window, so a collected pairing is always fresher than a re-queue.
export const PAIRING_TTL_MS = 120_000;

let _degradedAt = 0;
function degraded(err) {
	const now = Date.now();
	if (now - _degradedAt > 60_000) {
		_degradedAt = now;
		console.warn('[war-store] redis degraded — serving from in-memory fallback:', err?.message || err);
	}
}

// ─── In-memory fallback (dev / tests / Redis outage) ─────────────────────────

const mem = {
	ledger: [],
	live: new Map(),
	queue: new Map(),
	pairing: new Map(),
};

function memHashPrune(map, ttlMs) {
	const now = Date.now();
	for (const [k, v] of map) if (!v || now - (v.at || 0) > ttlMs) map.delete(k);
	return map;
}

// ─── Battle ledger ───────────────────────────────────────────────────────────

/**
 * Append one finished battle. Returns true when it landed durably, false when it
 * only reached the in-process fallback — the caller reports that honestly rather
 * than claiming a league write it did not make.
 * @param {object} battle the shape ClashMatch.result() emits, plus matchKey/network
 */
export async function appendBattle(battle) {
	mem.ledger.unshift(battle);
	if (mem.ledger.length > LEDGER_MAX) mem.ledger.length = LEDGER_MAX;
	if (!redis) return false;
	try {
		await redis.lpush(K.ledger, JSON.stringify(battle));
		await redis.ltrim(K.ledger, 0, LEDGER_MAX - 1);
		return true;
	} catch (err) {
		degraded(err);
		return false;
	}
}

/**
 * The battle ledger, newest first. `limit` bounds the read; the standings
 * recompute wants the whole window, a "recent results" board wants a handful.
 * @returns {Promise<object[]>}
 */
export async function listBattles(limit = LEDGER_MAX) {
	const n = Math.max(1, Math.min(LEDGER_MAX, limit | 0 || LEDGER_MAX));
	if (redis) {
		try {
			const raw = await redis.lrange(K.ledger, 0, n - 1);
			return (raw || []).map(parseMaybe).filter(Boolean);
		} catch (err) {
			degraded(err);
		}
	}
	return mem.ledger.slice(0, n);
}

// ─── Live registry ───────────────────────────────────────────────────────────

/**
 * Publish (or refresh) the live snapshot of one clash. `war` carries the two
 * factions, the score, the phase and the clock — everything the portal board
 * renders. Stamped with `at` so readers can retire it without a per-key TTL.
 */
export async function putLiveWar(war) {
	const record = { ...war, at: Date.now() };
	mem.live.set(record.matchKey, record);
	memHashPrune(mem.live, LIVE_TTL_MS);
	if (!redis) return false;
	try {
		await redis.hset(K.live, { [record.matchKey]: JSON.stringify(record) });
		// The hash itself expires if the game server goes away entirely, so a dead
		// deployment cannot leave a permanent key behind.
		await redis.expire(K.live, Math.ceil((LIVE_TTL_MS * 6) / 1000));
		return true;
	} catch (err) {
		degraded(err);
		return false;
	}
}

/** Retire one live war (the match ended, or the room disposed). Idempotent. */
export async function dropLiveWar(matchKey) {
	mem.live.delete(matchKey);
	if (!redis) return;
	try {
		await redis.hdel(K.live, matchKey);
	} catch (err) {
		degraded(err);
	}
}

/**
 * Every clash currently in progress, freshest first. Stale entries (no heartbeat
 * within LIVE_TTL_MS) are dropped from the result AND swept from the hash, so a
 * crashed room self-cleans on the next read instead of needing a cron.
 * @returns {Promise<object[]>}
 */
export async function listLiveWars() {
	const now = Date.now();
	if (redis) {
		try {
			const all = (await redis.hgetall(K.live)) || {};
			const live = [];
			const stale = [];
			for (const [key, value] of Object.entries(all)) {
				const war = parseMaybe(value);
				if (!war || now - (war.at || 0) > LIVE_TTL_MS) stale.push(key);
				else live.push(war);
			}
			if (stale.length) await redis.hdel(K.live, ...stale).catch(() => {});
			return live.sort((a, b) => (b.at || 0) - (a.at || 0));
		} catch (err) {
			degraded(err);
		}
	}
	memHashPrune(mem.live, LIVE_TTL_MS);
	return [...mem.live.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
}

// ─── Matchmaking queue ───────────────────────────────────────────────────────

/**
 * The communities currently waiting for an opponent, freshest first. Expired
 * entries are swept on read for the same reason the live registry sweeps.
 * @returns {Promise<object[]>}
 */
export async function listQueue() {
	const now = Date.now();
	if (redis) {
		try {
			const all = (await redis.hgetall(K.queue)) || {};
			const waiting = [];
			const stale = [];
			for (const [mint, value] of Object.entries(all)) {
				const entry = parseMaybe(value);
				if (!entry || now - (entry.at || 0) > QUEUE_TTL_MS) stale.push(mint);
				else waiting.push(entry);
			}
			if (stale.length) await redis.hdel(K.queue, ...stale).catch(() => {});
			return waiting.sort((a, b) => (b.at || 0) - (a.at || 0));
		} catch (err) {
			degraded(err);
		}
	}
	memHashPrune(mem.queue, QUEUE_TTL_MS);
	return [...mem.queue.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** Seat (or refresh) a community in the queue. */
export async function enqueue(entry) {
	const record = { ...entry, at: Date.now() };
	mem.queue.set(record.mint, record);
	if (!redis) return record;
	try {
		await redis.hset(K.queue, { [record.mint]: JSON.stringify(record) });
		await redis.expire(K.queue, Math.ceil((QUEUE_TTL_MS * 4) / 1000));
	} catch (err) {
		degraded(err);
	}
	return record;
}

/**
 * Claim a waiting community out of the queue. The Redis HDEL reply IS the claim
 * token: exactly one concurrent caller sees a 1, so two players queueing at the
 * same instant can never both pair with the same opponent and end up in two
 * different rooms. Returns true when this caller won the claim.
 */
export async function claimQueued(mint) {
	if (!redis) return mem.queue.delete(mint);
	try {
		const removed = await redis.hdel(K.queue, mint);
		mem.queue.delete(mint);
		return Number(removed) > 0;
	} catch (err) {
		degraded(err);
		return mem.queue.delete(mint);
	}
}

/** Drop a community from the queue (they walked away, or they just got paired). */
export async function dequeue(mint) {
	mem.queue.delete(mint);
	if (!redis) return;
	try {
		await redis.hdel(K.queue, mint);
	} catch (err) {
		degraded(err);
	}
}

// ─── Pairings ────────────────────────────────────────────────────────────────
//
// When a fresh challenger pairs with a queued community, only the challenger's
// request knows the minted matchKey. The queued side is not holding an open
// request, so the pairing is parked here under their mint+wallet and collected
// by their next poll. That keeps matchmaking to two plain reads instead of a
// socket the portal would have to hold open while nobody is even near it.

function pairKey(mint, wallet) {
	return `${mint}:${wallet}`;
}

export async function putPairing(mint, wallet, pairing) {
	const record = { ...pairing, at: Date.now() };
	mem.pairing.set(pairKey(mint, wallet), record);
	if (!redis) return record;
	try {
		await redis.hset(K.pairing, { [pairKey(mint, wallet)]: JSON.stringify(record) });
		await redis.expire(K.pairing, Math.ceil((PAIRING_TTL_MS * 4) / 1000));
	} catch (err) {
		degraded(err);
	}
	return record;
}

/**
 * Read the pairing waiting for this wallet, or null. Reads do NOT consume it: a
 * player who reloads mid-handoff must still find the war they were matched into.
 * It lapses on its own after PAIRING_TTL_MS.
 */
export async function getPairing(mint, wallet) {
	const key = pairKey(mint, wallet);
	const now = Date.now();
	if (redis) {
		try {
			const raw = await redis.hget(K.pairing, key);
			const rec = parseMaybe(raw);
			if (!rec) return null;
			if (now - (rec.at || 0) > PAIRING_TTL_MS) {
				await redis.hdel(K.pairing, key).catch(() => {});
				return null;
			}
			return rec;
		} catch (err) {
			degraded(err);
		}
	}
	const rec = mem.pairing.get(key);
	if (!rec) return null;
	if (now - (rec.at || 0) > PAIRING_TTL_MS) { mem.pairing.delete(key); return null; }
	return rec;
}

export async function dropPairing(mint, wallet) {
	mem.pairing.delete(pairKey(mint, wallet));
	if (!redis) return;
	try {
		await redis.hdel(K.pairing, pairKey(mint, wallet));
	} catch (err) {
		degraded(err);
	}
}

// ─── internals ───────────────────────────────────────────────────────────────

// Upstash decodes JSON string values for us on some paths and hands back the raw
// string on others; accept both rather than guessing which one a given command
// took.
function parseMaybe(value) {
	if (value == null) return null;
	if (typeof value === 'object') return value;
	try {
		return JSON.parse(String(value));
	} catch {
		return null;
	}
}

/** Test seam: clear the in-process fallback between cases. */
export function __resetWarStoreMemory() {
	mem.ledger.length = 0;
	mem.live.clear();
	mem.queue.clear();
	mem.pairing.clear();
}
