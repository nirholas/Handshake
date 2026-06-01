// Cross-realm, cross-restart player persistence (Task 16).
//
// A player's full progression — name, inventory, hotbar, bank, gold, skill XP,
// hp, cosmetics (owned + equipped), quest/tutorial/daily state, and last realm —
// is keyed to a stable account id (the wallet address once authenticated per
// Task 17, otherwise a guest id the client persists in localStorage). It must
// travel between realms, survive a disconnect/reconnect, AND survive a server
// restart or redeploy.
//
// Two tiers, the same shape block-store.js uses for voxel builds:
//   1. In-process memory (this Map). The server runs as a single always-on
//      instance, so the Map alone already carries a profile between realms (each
//      realm is its own room in one process) and across a reconnect. It is also
//      the synchronous read/write cache that keeps loadPlayer/savePlayer cheap on
//      the hot path — the GameRoom persists on every meaningful change and reads
//      back inside its eviction/leave paths, all synchronously against the Map.
//   2. Upstash Redis (REST), used when UPSTASH_REDIS_REST_URL + _TOKEN are set.
//      This is what makes a profile durable across restarts and shareable across
//      instances (Task 23): each account is one JSON value under `player:<id>`,
//      written write-behind (debounced a few seconds after the last change) and
//      flushed on leave / dispose / shutdown. A single SET is atomic, so a
//      profile is never half-written.
//
// The interface is identical with or without Redis configured, and identical for
// a wallet id vs. a guest id — so Task 17 (wallet auth) and Task 23 (scaling) are
// drop-ins. Without Redis the server is exactly as durable as before (in-process
// only); with it, progress outlives the process.
//
// One-active-session-per-account integrity (Task 16 rule 6) is enforced upstream
// by the presence-based eviction in GameRoom (see presence-keys.js): a fresh
// login persists and disconnects the stale session before taking over, so two
// sessions never fork-and-clobber one profile. This module is purely the store.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

const SAVE_DEBOUNCE_MS = 3000;       // collapse a burst of saves into one Redis write
const KEY_PREFIX = 'player:';
const REDIS_TTL_S = 60 * 60 * 24 * 90; // 90d, refreshed on every flush — bounds abandoned-guest growth
const MEM_TTL_MS = 1000 * 60 * 60 * 6; // evict idle cache entries after 6h (a returning player rehydrates from Redis)

function redisKey(id) { return KEY_PREFIX + id; }

class PlayerStore {
	constructor() {
		this._mem = new Map();        // accountId → record (synchronous cache + memory-only tier)
		this._saveTimers = new Map(); // accountId → debounce handle
		this._redis = null;
		this._redisReady = null;
		// True only once a real Redis round-trip has succeeded — same honesty as
		// block-store: we never claim durability we haven't proven.
		this._durable = false;
		this._writeFailures = 0;
		if (REDIS_URL && REDIS_TOKEN) {
			this._redisReady = import('@upstash/redis')
				.then(async ({ Redis }) => {
					this._redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
					await this._redis.ping();
					this._durable = true;
					console.log('[player-store] persistence: memory + Upstash Redis (verified)');
				})
				.catch((err) => {
					this._redis = null;
					console.error('[player-store] Redis unreachable — profiles are MEMORY-ONLY and will not survive a restart:', err?.message);
				});
		} else {
			console.log('[player-store] persistence: memory-only (set UPSTASH_REDIS_REST_URL/_TOKEN for cross-restart durability)');
		}

		// Evict idle cache entries so the Map doesn't grow without bound. An online
		// player keeps `savedAt` fresh (the room persists on every change), so only
		// offline/abandoned records age out — and in durable mode they remain safe in
		// Redis, rehydrated on the player's next join.
		const sweep = setInterval(() => {
			const now = Date.now();
			for (const [id, rec] of this._mem) {
				if (this._saveTimers.has(id)) continue; // a pending write is in flight — keep it
				if (now - (rec?.savedAt || 0) > MEM_TTL_MS) this._mem.delete(id);
			}
		}, 1000 * 60 * 30);
		if (typeof sweep.unref === 'function') sweep.unref();
	}

	get durable() { return this._durable; }
	async ready() { if (this._redisReady) await this._redisReady; }

	// Pull an account's profile from Redis into the in-process cache so the
	// synchronous loadPlayer() that follows finds it. A cache hit returns instantly
	// (no network); only a miss — a fresh process after a restart, or a player who
	// last played on another instance — touches Redis. Call this (and await it) on
	// join, before loadPlayer.
	async hydrate(accountId) {
		if (!accountId) return null;
		if (this._mem.has(accountId)) return this._mem.get(accountId);
		if (this._redisReady) {
			try {
				await this._redisReady;
				const raw = this._redis ? await this._redis.get(redisKey(accountId)) : null;
				const obj = typeof raw === 'string' ? JSON.parse(raw) : raw; // Upstash may auto-parse JSON
				if (obj && typeof obj === 'object') {
					this._mem.set(accountId, obj);
					return obj;
				}
			} catch (err) {
				console.warn(`[player-store] hydrate failed for ${accountId}:`, err?.message);
			}
		}
		return null;
	}

	// Synchronous read of the cached profile (null if this account has no record in
	// the cache). After a restart, call hydrate() first so a returning player isn't
	// mistaken for a brand-new one.
	load(accountId) {
		return this._mem.get(accountId) || null;
	}

	has(accountId) {
		return this._mem.has(accountId);
	}

	// Synchronous write: update the cache now and arm a debounced durable write.
	// Stamps savedAt so the cache sweep can tell fresh records from abandoned ones.
	save(accountId, state) {
		if (!accountId) return;
		const record = { ...state, savedAt: Date.now() };
		this._mem.set(accountId, record);
		this._scheduleSave(accountId);
	}

	_scheduleSave(accountId) {
		if (!this._redis && !this._redisReady) return; // memory-only: nothing to flush
		if (this._saveTimers.has(accountId)) return;
		const handle = setTimeout(() => {
			this._saveTimers.delete(accountId);
			this.flush(accountId);
		}, SAVE_DEBOUNCE_MS);
		if (typeof handle.unref === 'function') handle.unref();
		this._saveTimers.set(accountId, handle);
	}

	// Write the account's current profile to Redis now (one atomic SET). Called by
	// the debounce timer and on leave/dispose/shutdown so the final state lands.
	// No-op without Redis.
	async flush(accountId) {
		const pending = this._saveTimers.get(accountId);
		if (pending) { clearTimeout(pending); this._saveTimers.delete(accountId); }
		if (!this._redisReady) return;
		await this._redisReady;
		if (!this._redis) return;
		const record = this._mem.get(accountId);
		if (!record) return;
		try {
			await this._redis.set(redisKey(accountId), JSON.stringify(record), { ex: REDIS_TTL_S });
			if (this._writeFailures > 0) {
				console.log(`[player-store] Redis writes recovered after ${this._writeFailures} failure(s)`);
				this._writeFailures = 0;
			}
			this._durable = true;
		} catch (err) {
			this._writeFailures++;
			if (this._writeFailures >= 3) {
				this._durable = false;
				console.error(`[player-store] Redis save failing (${this._writeFailures}×) for ${accountId} — durability DEGRADED, progress at risk:`, err?.message);
			} else {
				console.warn(`[player-store] save failed for ${accountId}:`, err?.message);
			}
		}
	}

	// Flush every account that still holds in-memory state. Called on process
	// shutdown (SIGTERM on redeploy) so a profile whose debounce timer hadn't fired
	// isn't lost between the last change and the instance going away.
	async flushAll() {
		if (!this._redisReady) return;
		await Promise.allSettled([...this._mem.keys()].map((id) => this.flush(id)));
	}
}

// One store shared by every GameRoom instance in the process — that shared memory
// is what lets a profile travel between realms without a Redis hop.
export const playerStore = new PlayerStore();

// Backwards-compatible functional API. The GameRoom persists synchronously on the
// hot path (loadPlayer/savePlayer), and the durable Redis tier rides underneath
// via the write-behind cache. hydratePlayer/flushPlayer/flushAllPlayers expose the
// async durability hooks for the join, leave/dispose, and shutdown paths.
export function loadPlayer(playerId) { return playerStore.load(playerId); }
export function savePlayer(playerId, state) { return playerStore.save(playerId, state); }
export function hasPlayer(playerId) { return playerStore.has(playerId); }
export function hydratePlayer(playerId) { return playerStore.hydrate(playerId); }
export function flushPlayer(playerId) { return playerStore.flush(playerId); }
export function flushAllPlayers() { return playerStore.flushAll(); }
export function playerStoreReady() { return playerStore.ready(); }
