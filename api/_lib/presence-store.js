// Presence store — the volatile half of the friends system. Who is online and
// which realm they're in changes by the second and is shared across every
// realm-room instance, so it lives in Redis (Upstash REST), not Postgres.
//
// Ownership: the standalone multiplayer server is the source of truth. When a
// player joins a realm room it verifies their presence ticket (minted here),
// then writes `presence:<userId>` with a short TTL and refreshes it on a
// heartbeat; on leave it deletes the key. This API only ever READS presence
// (to annotate the friends list) and MINTS the tickets — it never writes
// presence itself, so a stale process can't claim a user is online forever.
//
// This module also signs the tickets and fires the internal notify webhook the
// API uses to push live DMs / friend events to the multiplayer server.

import { Redis } from '@upstash/redis';
import { env } from './env.js';
import { hmacSha256, constantTimeEquals } from './crypto.js';

const PRESENCE_PREFIX = 'presence:';
const TICKET_TTL_SEC = 600; // 10 min — the client refreshes well before expiry

let _redis = null;
let _redisTried = false;
function redis() {
	if (_redisTried) return _redis;
	_redisTried = true;
	if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
		_redis = new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
	}
	return _redis;
}

// ── presence reads ──────────────────────────────────────────────────────────
// Resolve presence for a set of account ids → { id: { online, realm } }. Ids
// without a live key are reported offline. Tolerant of a Redis outage: returns
// everyone offline rather than throwing, so the friends list still renders.
export async function readPresence(userIds) {
	const ids = [...new Set((userIds || []).filter(Boolean))];
	const out = {};
	for (const id of ids) out[id] = { online: false, realm: null, server: null };
	if (!ids.length) return out;
	const r = redis();
	if (!r) return out;
	try {
		const keys = ids.map((id) => PRESENCE_PREFIX + id);
		const vals = await r.mget(...keys);
		ids.forEach((id, i) => {
			const v = vals[i];
			if (!v) return;
			const rec = typeof v === 'string' ? safeParse(v) : v;
			if (rec && typeof rec === 'object') {
				// `server` is the world-instance id (Task 23); null for the /walk world
				// or presence written before servers existed. Surfaced so the friends UI
				// can show "online · Server 2 · Mainland".
				out[id] = { online: true, realm: rec.realm || null, server: rec.server || null };
			}
		});
	} catch (err) {
		console.warn('[presence] read failed:', err?.message);
	}
	return out;
}

function safeParse(s) {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

// ── presence tickets ──────────────────────────────────────────────────────
// A presence ticket proves to the multiplayer server that the bearer is a
// specific authenticated account, without that server needing to read our
// session cookie or call back to verify. Format: base64url(JSON{uid,exp}).base64url(hmac).
export async function signPresenceTicket(userId) {
	const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SEC;
	const payload = base64url(JSON.stringify({ uid: userId, exp }));
	const sig = await hmacSha256(env.MULTIPLAYER_SHARED_SECRET, payload);
	return { token: `${payload}.${sig}`, expiresIn: TICKET_TTL_SEC };
}

// Verify a ticket and return its userId, or null. Mirrored byte-for-byte on the
// multiplayer side (multiplayer/src/presence-token.js); keep the two in sync.
export async function verifyPresenceTicket(token) {
	if (typeof token !== 'string' || !token.includes('.')) return null;
	const [payload, sig] = token.split('.');
	if (!payload || !sig) return null;
	const expected = await hmacSha256(env.MULTIPLAYER_SHARED_SECRET, payload);
	if (!constantTimeEquals(sig, expected)) return null;
	const data = safeParse(Buffer.from(payload, 'base64url').toString('utf8'));
	if (!data || !data.uid || !data.exp) return null;
	if (data.exp < Math.floor(Date.now() / 1000)) return null;
	return data.uid;
}

function base64url(s) {
	return Buffer.from(s, 'utf8').toString('base64url');
}

// ── live delivery ──────────────────────────────────────────────────────────
// Ask the multiplayer server to push an event to a connected account. Used for
// live DM delivery and friend-request/accept toasts. Best-effort and fire-and-
// forget: the recipient may be offline (durable queue covers them on next login)
// or the bridge may be unconfigured. Never throws into the request path.
export async function notifyMultiplayer(type, toUserId, payload = {}) {
	const base = env.MULTIPLAYER_INTERNAL_URL;
	if (!base) return { delivered: false, reason: 'unconfigured' };
	try {
		const sig = await hmacSha256(env.MULTIPLAYER_SHARED_SECRET, `notify:${toUserId}:${type}`);
		const res = await fetch(`${base}/internal/notify`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-mp-signature': sig },
			body: JSON.stringify({ type, to: toUserId, payload }),
			signal: AbortSignal.timeout(2500),
		});
		if (!res.ok) return { delivered: false, reason: `http_${res.status}` };
		const body = await res.json().catch(() => ({}));
		return { delivered: !!body?.delivered, reason: body?.reason };
	} catch (err) {
		return { delivered: false, reason: err?.name === 'TimeoutError' ? 'timeout' : 'error' };
	}
}
