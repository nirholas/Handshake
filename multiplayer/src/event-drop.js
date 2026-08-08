// Event souvenir drop, the server's read of /event.json.
//
// A live community event (the countdown pill, the in-world agenda, the fireworks
// finale) is configured in ONE file: public/event.json on three.ws. This module
// is the game server's view of that same file, so the window a player is judged
// against is byte-for-byte the window they were shown a countdown to. Nothing
// here duplicates the schedule; drift is impossible by construction.
//
// What it adds on top of the shared config is the souvenir: a free commemorative
// wearable granted to everyone who is in the event world while the event is
// live. The rules are deliberately narrow:
//
//   • The window is [startsAt, endsAt) from the config. Before it, nothing is
//     granted. After it, nothing is granted, ever again, that is the whole
//     point of a souvenir, and there is no purchase path to soften it.
//   • The world must be the one the config's `link` points at (its `coin`
//     query param). Standing in an unrelated coin world during the window
//     earns nothing.
//   • The item must be a catalog cosmetic with tier 'event'. A config that
//     names a boutique item grants nothing rather than giving away a paid
//     cosmetic, a misconfiguration must not be able to devalue the shop.
//
// The server is a separate deployment from the site (its Docker image carries
// only multiplayer/src), so the config arrives over HTTP from the same origin
// the persistence layer already talks to. Reads are cached with a TTL, refreshed
// in the background, and FAIL OPEN in the safe direction: an unreachable config
// grants nothing and never blocks or slows a join.

import { getCosmetic } from './cosmetics-catalog.js';

const CONFIG_URL = process.env.EVENT_CONFIG_URL
	|| `${(process.env.WORLD_API_BASE || 'https://three.ws').replace(/\/$/, '')}/event.json`;

// How long a fetched config is trusted before a refresh. Short enough that an
// operator moving the event window is picked up within a couple of minutes,
// long enough that a busy world isn't refetching per join. Overridable so live
// ops can tighten it while an event is being set up, and so a conformance run
// can flip the window without waiting two minutes for it to be noticed.
const TTL_MS = Math.max(1000, Number(process.env.EVENT_CONFIG_TTL_MS) || 120_000);
// A failed fetch backs off for this long instead of retrying on every join,
// bounded by the TTL so a tightened TTL cannot invert the two.
const ERROR_TTL_MS = Math.min(30_000, TTL_MS);
// The join path must never wait on the network. Anything slower than this is
// treated as "no config yet"; the background refresh still completes and warms
// the cache for the next arrival.
const FETCH_TIMEOUT_MS = 3000;

// Pull the coin mint out of the config's `link` (e.g.
// "/play?coin=<mint>&name=…"). The link is what the countdown's CTA sends
// players to, so reading the world from it means the drop can never target a
// different world than the one the event advertises. Returns '' for a link with
// no coin, the Mainland, which every world-scoped drop then declines.
export function eventCoinFromLink(link) {
	const raw = String(link ?? '');
	const q = raw.indexOf('?');
	if (q < 0) return '';
	try {
		const coin = new URLSearchParams(raw.slice(q + 1)).get('coin');
		return typeof coin === 'string' ? coin.trim().slice(0, 64) : '';
	} catch {
		return '';
	}
}

// Reduce a raw /event.json document to the drop the server enforces, or null
// when this config has no souvenir to grant. Pure, every gate below is
// testable without a network or a clock.
export function parseEventDrop(doc) {
	if (!doc || typeof doc !== 'object') return null;
	const startsAt = Date.parse(doc.startsAt);
	const endsAt = Date.parse(doc.endsAt);
	if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) return null;

	const cosmeticId = String(doc.souvenir?.cosmeticId ?? '').trim().slice(0, 64);
	if (!cosmeticId) return null;
	// Only an event-tier catalog item may be dropped. A typo naming a premium
	// cosmetic yields no drop at all rather than a free Stetson for everyone.
	const cosmetic = getCosmetic(cosmeticId);
	if (!cosmetic || cosmetic.tier !== 'event') return null;

	const coin = eventCoinFromLink(doc.link);
	if (!coin) return null;

	return {
		eventId: String(doc.id || 'event').slice(0, 64),
		eventName: String(doc.name || 'Community meetup').slice(0, 120),
		startsAt,
		endsAt,
		coin,
		cosmeticId,
		cosmeticName: cosmetic.name,
		slot: cosmetic.slot,
	};
}

// Is `drop` claimable right now, in the world identified by `coin`? Both gates
// in one call so no caller can accidentally check the window and forget the
// world. `now` is injected so tests own the clock.
export function dropClaimable(drop, coin, now) {
	if (!drop) return false;
	const t = Number(now);
	if (!Number.isFinite(t)) return false;
	if (t < drop.startsAt || t >= drop.endsAt) return false;
	return String(coin || '') === drop.coin;
}

// ── Cached config reader ───────────────────────────────────────────────────

let _cache = { drop: null, at: 0, ok: false };
let _inflight = null;

async function fetchDrop() {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(CONFIG_URL, {
			headers: { accept: 'application/json' },
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const drop = parseEventDrop(await res.json());
		_cache = { drop, at: Date.now(), ok: true };
		return drop;
	} catch (err) {
		// Keep serving the last good config while the source is unreachable: an
		// event already underway should not stop granting because of one bad
		// response. Only the retry clock moves.
		_cache = { ..._cache, at: Date.now() - (TTL_MS - ERROR_TTL_MS), ok: false };
		if (!_cache.drop) console.warn('[event-drop] config unavailable:', err?.message);
		return _cache.drop;
	} finally {
		clearTimeout(timer);
	}
}

// Start a refresh if the cache is stale, without awaiting it. Rooms call this on
// create so the first arrival of an event reads a warm cache.
export function warmEventDrop() {
	if (Date.now() - _cache.at < TTL_MS) return;
	if (!_inflight) _inflight = fetchDrop().finally(() => { _inflight = null; });
}

// The current drop, or null. Returns the cached value immediately when fresh;
// otherwise awaits the refresh (bounded by FETCH_TIMEOUT_MS) so the very first
// join of a cold process still gets a correct answer instead of a false "no
// event". Never throws.
export async function currentEventDrop() {
	if (Date.now() - _cache.at < TTL_MS) return _cache.drop;
	if (!_inflight) _inflight = fetchDrop().finally(() => { _inflight = null; });
	try {
		return await _inflight;
	} catch {
		return _cache.drop;
	}
}

// Test seam: drop the cached config so a suite can exercise the fetch path.
export function resetEventDropCache() {
	_cache = { drop: null, at: 0, ok: false };
	_inflight = null;
}
