// Coin Clash — persistence.
//
// Battle power is hot, concurrent, and additive: many soldiers across many
// serverless instances tap for the same faction at once. That needs atomic
// increments and ranked reads, so this layer talks to Upstash Redis directly
// (ZINCRBY for faction + member tallies, INCRBY for the per-wallet cap) rather
// than the JSON get/set cache. When Redis is unconfigured — local dev, tests —
// it transparently falls back to an in-process model with the same semantics so
// the game is fully playable on a laptop with no infra.
//
// Keys are namespaced by round (epoch) and expire a few rounds out, so the store
// self-prunes without a sweeper.

import { getRedis } from './redis.js';
import { EPOCH_MS } from './clash.js';

const redis = getRedis();

// Keep finished rounds around briefly for settlement + "last round" display,
// then let them lapse. Records (all-time W/L) never expire.
const ROUND_TTL_S = Math.ceil((EPOCH_MS * 4) / 1000);

// A configured Redis can still fail at call time — an Upstash transport blip
// ("fetch failed"), an over-quota/billing 4xx, or a rotated token. The shared
// HTTP wrapper classifies those as "database unavailable" and 503s the whole
// request, which once took the entire Clash page (state + leaderboard reads)
// dark for >15h on a recoverable backend hiccup. So every Redis op here is
// resilient the same way the rate limiters are: on a command error we warn
// (throttled — a real outage hits every request) and fall through to the
// in-memory model below. Reads then serve the designed zero/empty round state
// with a 200 instead of a 5xx; writes degrade to a per-instance tally. Better a
// briefly non-durable game than a dead feature.
let _degradedAt = 0;
function redisDegraded(err) {
	const now = Date.now();
	if (now - _degradedAt > 60_000) {
		_degradedAt = now;
		console.warn('[clash-store] redis degraded — serving from in-memory fallback:', err?.message || err);
	}
}

const K = {
	factions: (epoch) => `clash:fac:${epoch}`, // ZSET mint → power
	members: (epoch, mint) => `clash:mem:${epoch}:${mint}`, // ZSET wallet → power
	wallet: (epoch, mint, wallet) => `clash:w:${epoch}:${mint}:${wallet}`, // INT cap counter
	momentum: (mint) => `clash:mom:${mint}`, // JSON cached factor
	price: (mint) => `clash:px:${mint}`, // JSON { spot, at, base, baseAt }
	settled: (epoch) => `clash:settled:${epoch}`, // marker
	record: 'clash:record', // HASH mint → JSON {w,l,battles,power}
};

// ─── In-memory fallback (dev/tests) ──────────────────────────────────────────
const mem = {
	z: new Map(), // key → Map(member → score)
	s: new Map(), // key → { value, exp }
	h: new Map(), // hash key → Map(field → value)
};
function memZ(key) {
	let m = mem.z.get(key);
	if (!m) {
		m = new Map();
		mem.z.set(key, m);
	}
	return m;
}
function memValid(key) {
	const e = mem.s.get(key);
	if (!e) return undefined;
	if (e.exp && Date.now() > e.exp) {
		mem.s.delete(key);
		return undefined;
	}
	return e.value;
}

// ─── Power: faction + member tallies, per-wallet cap ─────────────────────────

/**
 * Atomically add power to a faction and the soldier's standing within it, unless
 * the soldier has already hit their per-round ceiling. Returns the soldier's new
 * cumulative power for the round and whether the cap was reached.
 *
 * @returns {Promise<{ added: number, walletTotal: number, capped: boolean }>}
 */
export async function addPower({ epoch, mint, wallet, amount, walletCap }) {
	const amt = Math.max(0, Math.floor(Number(amount) || 0));
	if (amt <= 0) return { added: 0, walletTotal: 0, capped: false };

	if (redis) {
		try {
			const wKey = K.wallet(epoch, mint, wallet);
			// Reserve against the per-wallet ceiling first. INCRBY returns the running
			// total; if this push would breach the cap, clamp the credited amount to
			// whatever headroom remains (possibly zero) and roll the counter back to the
			// cap so it stays truthful.
			const after = await redis.incrby(wKey, amt);
			await redis.expire(wKey, ROUND_TTL_S);
			let credit = amt;
			let capped = false;
			if (after > walletCap) {
				credit = Math.max(0, amt - (after - walletCap));
				capped = true;
				if (credit !== amt) await redis.set(wKey, walletCap, { ex: ROUND_TTL_S });
			}
			if (credit > 0) {
				await redis.zincrby(K.factions(epoch), credit, mint);
				await redis.expire(K.factions(epoch), ROUND_TTL_S);
				await redis.zincrby(K.members(epoch, mint), credit, wallet);
				await redis.expire(K.members(epoch, mint), ROUND_TTL_S);
			}
			return { added: credit, walletTotal: Math.min(after, walletCap), capped };
		} catch (err) {
			redisDegraded(err);
		}
	}

	// In-memory
	const wKey = K.wallet(epoch, mint, wallet);
	const prev = Number(memValid(wKey) || 0);
	const after = prev + amt;
	let credit = amt;
	let capped = false;
	if (after > walletCap) {
		credit = Math.max(0, walletCap - prev);
		capped = true;
	}
	mem.s.set(wKey, { value: prev + credit, exp: Date.now() + ROUND_TTL_S * 1000 });
	if (credit > 0) {
		const fz = memZ(K.factions(epoch));
		fz.set(mint, (fz.get(mint) || 0) + credit);
		const mz = memZ(K.members(epoch, mint));
		mz.set(wallet, (mz.get(wallet) || 0) + credit);
	}
	return { added: credit, walletTotal: prev + credit, capped };
}

/** A soldier's power so far this round for one faction. */
export async function walletPower({ epoch, mint, wallet }) {
	if (redis) {
		try {
			return Number((await redis.get(K.wallet(epoch, mint, wallet))) || 0);
		} catch (err) {
			redisDegraded(err);
		}
	}
	return Number(memValid(K.wallet(epoch, mint, wallet)) || 0);
}

/** Faction → power map for a round. */
export async function factionPowers(epoch) {
	if (redis) {
		try {
			const flat = await redis.zrange(K.factions(epoch), 0, -1, { withScores: true });
			return zflatToMap(flat);
		} catch (err) {
			redisDegraded(err);
		}
	}
	const out = {};
	for (const [k, v] of memZ(K.factions(epoch))) out[k] = Number(v) || 0;
	return out;
}

/**
 * One faction's power this round. The rally path echoes this back on every tap
 * flush, so it reads a single score rather than ranging the whole round ZSET.
 */
export async function factionPower(epoch, mint) {
	if (redis) {
		try {
			return Number((await redis.zscore(K.factions(epoch), mint)) || 0);
		} catch (err) {
			redisDegraded(err);
		}
	}
	return Number(memZ(K.factions(epoch)).get(mint) || 0);
}

/** Top soldiers for a faction this round: [{ wallet, power }] descending. */
export async function topSoldiers({ epoch, mint, limit = 10 }) {
	if (redis) {
		try {
			const flat = await redis.zrange(K.members(epoch, mint), 0, limit - 1, {
				rev: true,
				withScores: true,
			});
			return zflatToList(flat);
		} catch (err) {
			redisDegraded(err);
		}
	}
	const m = memZ(K.members(epoch, mint));
	return [...m.entries()]
		.map(([wallet, power]) => ({ wallet, power: Number(power) || 0 }))
		.sort((a, b) => b.power - a.power)
		.slice(0, limit);
}

// ─── Momentum cache ──────────────────────────────────────────────────────────

export async function getMomentum(mint) {
	if (redis) {
		try {
			const v = await redis.get(K.momentum(mint));
			const n = Number(v);
			return Number.isFinite(n) && n > 0 ? n : null;
		} catch (err) {
			redisDegraded(err);
		}
	}
	const v = memValid(K.momentum(mint));
	return v == null ? null : Number(v);
}
export async function setMomentum(mint, factor, ttlS = 120) {
	if (redis) {
		try {
			return void (await redis.set(K.momentum(mint), factor, { ex: ttlS }));
		} catch (err) {
			redisDegraded(err);
		}
	}
	mem.s.set(K.momentum(mint), { value: factor, exp: Date.now() + ttlS * 1000 });
}

// ─── Price snapshot cache ────────────────────────────────────────────────────
// Shared across instances so a faction is priced upstream once per spot TTL for
// the whole fleet, not once per poll per viewer.

export async function getPrice(mint) {
	if (redis) {
		try {
			return parsePrice(await redis.get(K.price(mint)));
		} catch (err) {
			redisDegraded(err);
		}
	}
	return parsePrice(memValid(K.price(mint)));
}

export async function setPrice(mint, snap, ttlS) {
	const value = JSON.stringify(snap);
	if (redis) {
		try {
			return void (await redis.set(K.price(mint), value, { ex: ttlS }));
		} catch (err) {
			redisDegraded(err);
		}
	}
	mem.s.set(K.price(mint), { value, exp: Date.now() + ttlS * 1000 });
}

// ─── All-time war record + lazy settlement ───────────────────────────────────

/** All-time records for a set of mints: mint → { w, l, battles, power }. */
export async function getRecords(mints = []) {
	const out = {};
	if (!mints.length) return out;
	if (redis) {
		try {
			const raw = await redis.hmget(K.record, ...mints);
			mints.forEach((mint, i) => {
				out[mint] = parseRecord(raw?.[i]);
			});
			return out;
		} catch (err) {
			redisDegraded(err);
		}
	}
	const h = mem.h.get(K.record) || new Map();
	for (const mint of mints) out[mint] = parseRecord(h.get(mint));
	return out;
}

/**
 * Settle a finished round exactly once. Re-reads the round's faction powers,
 * recomputes the same deterministic bracket, decides each battle on raw power
 * (effort wins, not market cap), and folds win/loss/power into the all-time
 * record. A round marker makes this idempotent across concurrent readers.
 *
 * @param {number} epoch finished round to settle
 * @param {(mints: string[], epoch: number) => { battles: Array<{a:string,b:string|null}> }} matchmakeFn
 * @returns {Promise<{ settled: boolean, results?: Array<object> }>}
 */
export async function settleRound(epoch, matchmakeFn) {
	// Claim the settlement so two concurrent readers don't double-count.
	const claimed = await claimSettle(epoch);
	if (!claimed) return { settled: false };

	const powers = await factionPowers(epoch);
	const ranked = Object.keys(powers).sort((a, b) => (powers[b] || 0) - (powers[a] || 0));
	const { battles } = matchmakeFn(ranked, epoch);

	const results = [];
	for (const { a, b } of battles) {
		if (!b) continue;
		const pa = powers[a] || 0;
		const pb = powers[b] || 0;
		if (pa === 0 && pb === 0) continue; // no-show: nobody fought, no record
		let winner = null;
		let loser = null;
		if (pa > pb) {
			winner = a;
			loser = b;
		} else if (pb > pa) {
			winner = b;
			loser = a;
		}
		await bumpRecord(a, { power: pa, win: winner === a, loss: loser === a, draw: !winner });
		await bumpRecord(b, { power: pb, win: winner === b, loss: loser === b, draw: !winner });
		results.push({ epoch, a, b, powerA: pa, powerB: pb, winner });
	}
	return { settled: true, results };
}

async function claimSettle(epoch) {
	if (redis) {
		try {
			// SET NX — first writer wins the settlement.
			const ok = await redis.set(K.settled(epoch), Date.now(), { nx: true, ex: ROUND_TTL_S });
			return ok === 'OK' || ok === true;
		} catch (err) {
			redisDegraded(err);
		}
	}
	if (memValid(K.settled(epoch))) return false;
	mem.s.set(K.settled(epoch), { value: Date.now(), exp: Date.now() + ROUND_TTL_S * 1000 });
	return true;
}

async function bumpRecord(mint, { power, win, loss, draw }) {
	const cur = (await getRecords([mint]))[mint];
	const next = {
		w: cur.w + (win ? 1 : 0),
		l: cur.l + (loss ? 1 : 0),
		d: cur.d + (draw ? 1 : 0),
		battles: cur.battles + 1,
		power: cur.power + Math.round(power),
	};
	if (redis) {
		try {
			await redis.hset(K.record, { [mint]: JSON.stringify(next) });
			return;
		} catch (err) {
			redisDegraded(err);
		}
	}
	let h = mem.h.get(K.record);
	if (!h) {
		h = new Map();
		mem.h.set(K.record, h);
	}
	h.set(mint, JSON.stringify(next));
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseRecord(raw) {
	const empty = { w: 0, l: 0, d: 0, battles: 0, power: 0 };
	if (!raw) return empty;
	try {
		const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
		return {
			w: Number(v.w) || 0,
			l: Number(v.l) || 0,
			d: Number(v.d) || 0,
			battles: Number(v.battles) || 0,
			power: Number(v.power) || 0,
		};
	} catch {
		return empty;
	}
}

function parsePrice(raw) {
	if (!raw) return null;
	try {
		const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (!v || typeof v !== 'object') return null;
		return {
			spot: Number(v.spot) || 0,
			at: Number(v.at) || 0,
			base: Number(v.base) || 0,
			baseAt: Number(v.baseAt) || 0,
		};
	} catch {
		return null;
	}
}

// Upstash zrange withScores returns a flat [member, score, member, score, …].
function zflatToMap(flat) {
	const out = {};
	if (!Array.isArray(flat)) return out;
	for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1]) || 0;
	return out;
}
function zflatToList(flat) {
	const out = [];
	if (!Array.isArray(flat)) return out;
	for (let i = 0; i + 1 < flat.length; i += 2) {
		out.push({ wallet: flat[i], power: Number(flat[i + 1]) || 0 });
	}
	return out;
}
