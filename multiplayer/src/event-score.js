// Event leaderboard bridge — the game server's client for the event standing.
//
// The board is stored on the API side (api/_lib/event-leaderboard-store.js) rather
// than in this process because a player's runs have to survive a room disposal, a
// redeploy mid-event, and be readable by the web at the same time. This module is
// the two calls that need: report a finished event quest, and read the ranked board
// back for the in-world panel.
//
// Writes sign the same short-lived world-service token persistence.js and
// quest-notify.js use (svc:'world'), so only this trusted process can score a run.
// Reads are the public endpoint, cached here for READ_CACHE_MS: an event crowd all
// opening the panel at once costs one upstream read per few seconds, not one per
// player. The per-player row is NOT cached with the board (it is per-account), so
// the cache key includes the account.
//
// Everything is best-effort and never throws: a flaky API must degrade the panel to
// its error state, never break the mission-complete flow that already paid the
// player in-world.

import crypto from 'node:crypto';

const API_BASE = (process.env.WORLD_API_BASE || 'https://three.ws').replace(/\/$/, '');
const TOKEN_TTL_SEC = 120;
const REQUEST_TIMEOUT_MS = 8000;
const READ_CACHE_MS = 4000;

// Mirrors persistence.js's signServiceToken byte-for-byte.
function signServiceToken() {
	const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
	const payload = Buffer.from(JSON.stringify({ svc: 'world', exp }), 'utf8').toString('base64url');
	const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
	return `${payload}.${sig}`;
}

function secret() {
	return (
		process.env.MULTIPLAYER_SHARED_SECRET ||
		process.env.HOLDER_PASS_SECRET ||
		'dev-insecure-multiplayer-secret'
	);
}

/**
 * Report one finished event quest. Returns the player's updated totals, or null if
 * the report did not land (offline API, closed window, unconfigured secret) — the
 * caller has already paid the player their in-world gold either way.
 *
 * @param {{ eventId: string, account: string, name?: string, missionId: string, gold?: number }} run
 */
export async function reportEventRun({ eventId, account, name = '', missionId, gold = 0 }) {
	if (!account || !missionId) return null;
	try {
		const res = await fetch(`${API_BASE}/api/internal/event-score`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${signServiceToken()}`,
			},
			body: JSON.stringify({ eventId, account, name, missionId, gold }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) {
			console.warn(`[event-score] report → ${res.status}`);
			return null;
		}
		const body = await res.json();
		// A fresh run invalidates every cached view of this board.
		_cache.clear();
		return body;
	} catch (err) {
		console.warn('[event-score] failed to report event run:', err?.message || err);
		return null;
	}
}

const _cache = new Map(); // `${eventId}|${account}` → { at, body }

/**
 * Read the ranked board (top rows plus this account's own row). Returns the API's
 * payload, or null when it is unreachable — the client renders its error state
 * rather than a stale or invented ranking.
 */
export async function fetchEventBoard({ account = '', limit = 10 } = {}) {
	const key = `${account}|${limit}`;
	const hit = _cache.get(key);
	const now = Date.now();
	if (hit && now - hit.at < READ_CACHE_MS) return hit.body;
	try {
		const qs = new URLSearchParams({ limit: String(limit) });
		if (account) qs.set('account', account);
		const res = await fetch(`${API_BASE}/api/play/event-leaderboard?${qs}`, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) {
			console.warn(`[event-score] board read → ${res.status}`);
			return null;
		}
		const body = await res.json();
		_cache.set(key, { at: now, body });
		// Bound the cache: one entry per online player at most, cleared on any write.
		if (_cache.size > 512) {
			for (const [k, v] of _cache) if (now - v.at > READ_CACHE_MS) _cache.delete(k);
		}
		return body;
	} catch (err) {
		console.warn('[event-score] failed to read event board:', err?.message || err);
		return null;
	}
}
