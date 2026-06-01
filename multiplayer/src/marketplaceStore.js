// MarketplaceStore — durable persistence for the player-to-player marketplace
// (Task 20): the live listings every player can browse, and the pending payouts
// owed to sellers who were offline when their goods sold.
//
// This is the in-game item economy — distinct from the platform's AGENT
// marketplace under `api/marketplace*`. Listings here are account-scoped (keyed
// to a player's stable account id / wallet) and must survive a seller's
// disconnect, the room emptying, AND a server restart, so a buyer in one realm
// can purchase goods a seller listed from another realm yesterday.
//
// Same two-tier model as block-store.js:
//   1. In-process memory — the multiplayer server runs as a single always-on
//      instance, so the Maps below already let a listing outlive both the
//      seller's session and the room it was created in.
//   2. Upstash Redis (REST), used when UPSTASH_REDIS_REST_URL + _TOKEN are set —
//      upgrades durability across restarts/redeploys. Writes are debounced and
//      flushed on shutdown so a busy market doesn't hammer Redis.
//
// Escrow lives HERE, not in any inventory: when a player lists, the offered
// item(s) or gold are removed from them and stored on the listing object. That
// is the escrow — there is exactly one copy of the goods, so nothing can be
// listed-and-spent or duplicated. Cancel returns the escrow to the seller; a
// sale delivers it to the buyer.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const SAVE_DEBOUNCE_MS = 2500;
const LISTINGS_KEY = 'market:listings';
const PAYOUTS_KEY = 'market:payouts';
const SETTLED_KEY = 'market:settled'; // on-chain tx signatures already consumed (replay guard)

let _seq = 0;
function newId() {
	// Monotonic + time so ids sort by recency and never collide within a process.
	_seq = (_seq + 1) % 0xffffff;
	return `lst_${Date.now().toString(36)}${_seq.toString(36).padStart(4, '0')}`;
}

class MarketplaceStore {
	constructor() {
		this._listings = new Map(); // id -> listing
		this._payouts = new Map();  // sellerId -> [{ gold, items:[{item,qty}], reason, listingId, ts }]
		this._settled = new Set();  // tx signatures consumed by a token settlement
		this._saveTimer = null;
		this._redis = null;
		this._redisReady = null;
		this._loaded = false;
		this._durable = false;

		if (REDIS_URL && REDIS_TOKEN) {
			this._redisReady = import('@upstash/redis')
				.then(async ({ Redis }) => {
					this._redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
					await this._redis.ping();
					this._durable = true;
					await this._hydrate();
					console.log('[marketplace-store] persistence: memory + Upstash Redis (verified)');
				})
				.catch((err) => {
					this._redis = null;
					console.error('[marketplace-store] Redis unreachable — listings are MEMORY-ONLY and will not survive a restart:', err?.message);
				});
		} else {
			console.log('[marketplace-store] persistence: memory-only (set UPSTASH_REDIS_REST_URL/_TOKEN for cross-restart durability)');
		}
	}

	get durable() { return this._durable; }
	async ready() { if (this._redisReady) await this._redisReady; }

	async _hydrate() {
		if (this._loaded || !this._redis) return;
		try {
			const [rawL, rawP, rawS] = await Promise.all([
				this._redis.get(LISTINGS_KEY),
				this._redis.get(PAYOUTS_KEY),
				this._redis.get(SETTLED_KEY),
			]);
			const parse = (raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw) || null;
			const L = parse(rawL);
			if (L && typeof L === 'object') for (const v of Object.values(L)) if (v && v.id) this._listings.set(v.id, v);
			const P = parse(rawP);
			if (P && typeof P === 'object') for (const [k, v] of Object.entries(P)) if (Array.isArray(v) && v.length) this._payouts.set(k, v);
			const S = parse(rawS);
			if (Array.isArray(S)) for (const sig of S) if (typeof sig === 'string') this._settled.add(sig);
		} catch (err) {
			console.warn('[marketplace-store] hydrate failed:', err?.message);
		}
		this._loaded = true;
	}

	// ---- listings ---------------------------------------------------------

	// Active listings, most-recent first. Optionally excluding one seller (so the
	// Buy tab can hide your own goods if desired — the caller decides).
	activeListings() {
		const out = [];
		for (const l of this._listings.values()) if (l.status === 'active') out.push(l);
		out.sort((a, b) => b.createdAt - a.createdAt);
		return out;
	}

	listingsBySeller(sellerId) {
		const out = [];
		for (const l of this._listings.values()) if (l.seller === sellerId) out.push(l);
		out.sort((a, b) => b.createdAt - a.createdAt);
		return out;
	}

	get(id) { return this._listings.get(id) || null; }

	// Create a listing. `escrow` is the goods already removed from the seller:
	// either { item, qty } (gold listing) or { gold } (gold-for-token listing).
	create(listing) {
		const id = newId();
		const rec = { id, ...listing, status: 'active', createdAt: Date.now() };
		this._listings.set(id, rec);
		this._scheduleSave();
		return rec;
	}

	update(id, patch) {
		const l = this._listings.get(id);
		if (!l) return null;
		Object.assign(l, patch);
		this._scheduleSave();
		return l;
	}

	// Prune sold/cancelled listings older than `maxAgeMs` so the store and the Buy
	// snapshot don't grow without bound. Active listings are never pruned.
	prune(maxAgeMs = 1000 * 60 * 60 * 24 * 7) {
		const cutoff = Date.now() - maxAgeMs;
		let removed = 0;
		for (const [id, l] of this._listings) {
			if (l.status !== 'active' && (l.closedAt || l.createdAt) < cutoff) {
				this._listings.delete(id);
				removed++;
			}
		}
		if (removed) this._scheduleSave();
		return removed;
	}

	// ---- pending payouts (offline-seller proceeds) ------------------------

	// Queue value owed to a seller who isn't online to receive it now. Drained on
	// their next join. Durable, so owed proceeds survive a restart until claimed.
	enqueuePayout(sellerId, payout) {
		if (!sellerId) return;
		const list = this._payouts.get(sellerId) || [];
		list.push({ ...payout, ts: Date.now() });
		this._payouts.set(sellerId, list);
		this._scheduleSave();
	}

	// Take and clear all pending payouts for a seller (called on join). Returns the
	// list; the caller is responsible for actually delivering them.
	drainPayouts(sellerId) {
		const list = this._payouts.get(sellerId);
		if (!list || !list.length) return [];
		this._payouts.delete(sellerId);
		this._scheduleSave();
		return list;
	}

	hasPendingPayouts(sellerId) {
		return (this._payouts.get(sellerId)?.length || 0) > 0;
	}

	// ---- on-chain replay guard -------------------------------------------

	isSettled(txSig) { return this._settled.has(txSig); }
	markSettled(txSig) {
		if (!txSig) return;
		this._settled.add(txSig);
		// Bound the set so a long-lived process doesn't accumulate signatures forever.
		if (this._settled.size > 5000) {
			const first = this._settled.values().next().value;
			this._settled.delete(first);
		}
		this._scheduleSave();
	}

	// ---- persistence ------------------------------------------------------

	_scheduleSave() {
		if (!this._redis && !this._redisReady) return; // memory-only
		if (this._saveTimer) return;
		const handle = setTimeout(() => { this._saveTimer = null; this.flush(); }, SAVE_DEBOUNCE_MS);
		if (typeof handle.unref === 'function') handle.unref();
		this._saveTimer = handle;
	}

	async flush() {
		if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
		if (!this._redisReady) return;
		await this._redisReady;
		if (!this._redis) return;
		try {
			await Promise.all([
				this._redis.set(LISTINGS_KEY, JSON.stringify(Object.fromEntries(this._listings))),
				this._redis.set(PAYOUTS_KEY, JSON.stringify(Object.fromEntries(this._payouts))),
				this._redis.set(SETTLED_KEY, JSON.stringify([...this._settled])),
			]);
			this._durable = true;
		} catch (err) {
			console.error('[marketplace-store] save failed — market durability degraded:', err?.message);
		}
	}

	async flushAll() { await this.flush(); }
}

// One store shared by every GameRoom in the process — that shared memory is
// exactly what lets a listing outlive its seller's session and its room.
export const marketplaceStore = new MarketplaceStore();

// Periodically retire long-closed (sold/cancelled) listings so neither the store
// nor the Buy snapshot grows without bound over a long-lived process. Active
// listings are never touched. Unref'd so it never keeps the process alive.
setInterval(() => marketplaceStore.prune(), 1000 * 60 * 60).unref?.();
