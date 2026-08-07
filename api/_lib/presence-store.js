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

import { env } from './env.js';
import { getRedis } from './redis.js';
import { hmacSha256, constantTimeEquals, sha256Base64Url } from './crypto.js';

const PRESENCE_PREFIX = 'presence:';
const TICKET_TTL_SEC = 600; // 10 min — the client refreshes well before expiry

function redis() { return getRedis(); }

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
// session cookie or call back to verify. The crew tag (W09) rides inside the
// signed payload too, so the game server can stamp a TRUSTWORTHY crew badge over
// the avatar without a DB of its own and without trusting a client option.
// The bearer's public profile handle (username + display name) rides the same
// way: it is what lets a realm room publish a VERIFIED three.ws identity on the
// player schema, so peers can open the real profile, follow, and DM — a client
// option could claim anyone's handle, a signed ticket cannot.
// Format: base64url(JSON{uid,exp,crew,crewName,u,dn}).base64url(hmac).
export async function signPresenceTicket(userId) {
	const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SEC;
	// Fold in the bearer's crew tag if they're in one. Defensive: a missing crews
	// table (pre-migration) or any lookup error must never break ticket minting —
	// friends presence has to keep working regardless of the crew feature.
	let crew = '';
	let crewName = '';
	try {
		// Dynamic import (not top-level) so this module stays importable by endpoints
		// that never mint tickets, and resilient if the dependency is unavailable.
		const { crewTagFor } = await import('./crews-store.js');
		const c = await crewTagFor(userId);
		if (c) { crew = c.tag; crewName = c.name; }
	} catch { /* crew is optional metadata; presence works without it */ }
	// Fold in the bearer's public handle, same defensive posture: an account with
	// no username yet (or a DB hiccup) still gets a valid presence-only ticket.
	let u = '';
	let dn = '';
	try {
		const { sql } = await import('./db.js');
		const [row] = await sql`
			select username, display_name from users
			where id = ${userId} and deleted_at is null
			limit 1
		`;
		if (row?.username) u = row.username;
		if (row?.display_name) dn = String(row.display_name).slice(0, 24);
	} catch { /* profile handle is optional metadata; presence works without it */ }
	const payload = base64url(JSON.stringify({ uid: userId, exp, crew, crewName, u, dn }));
	const sig = await hmacSha256(env.MULTIPLAYER_SHARED_SECRET, payload);
	return { token: `${payload}.${sig}`, expiresIn: TICKET_TTL_SEC };
}

// Verify a ticket and return { uid, crew, crewName, username, displayName }, or
// null. Mirrored byte-for-byte on the multiplayer side
// (multiplayer/src/presence-token.js); keep the two in sync. (No API caller
// today — the multiplayer server is the verifier; this stays here as the
// canonical reference implementation.)
export async function verifyPresenceTicket(token) {
	if (typeof token !== 'string' || !token.includes('.')) return null;
	const [payload, sig] = token.split('.');
	if (!payload || !sig) return null;
	const expected = await hmacSha256(env.MULTIPLAYER_SHARED_SECRET, payload);
	if (!constantTimeEquals(sig, expected)) return null;
	const data = safeParse(Buffer.from(payload, 'base64url').toString('utf8'));
	if (!data || !data.uid || !data.exp) return null;
	if (data.exp < Math.floor(Date.now() / 1000)) return null;
	return {
		uid: data.uid,
		crew: data.crew || '',
		crewName: data.crewName || '',
		username: data.u || '',
		displayName: data.dn || '',
	};
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
		// Bind the signature to the exact body and a fresh timestamp so a captured
		// (to,type,sig) tuple can't be replayed with a different payload or after the
		// short freshness window. The signed string covers the payload hash; the
		// multiplayer verifier recomputes it over the same serialized payload it acts
		// on, so a tampered body fails the check. Keep byte-compatible with
		// verifyNotifySignature in multiplayer/src/presence-token.js.
		const requestBody = JSON.stringify({ type, to: toUserId, payload });
		const ts = Math.floor(Date.now() / 1000);
		const payloadHash = await sha256Base64Url(JSON.stringify(payload ?? {}));
		const sig = await hmacSha256(
			env.MULTIPLAYER_SHARED_SECRET,
			`notify:${toUserId}:${type}:${ts}:${payloadHash}`,
		);
		const res = await fetch(`${base}/internal/notify`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-mp-signature': sig, 'x-mp-timestamp': String(ts) },
			body: requestBody,
			signal: AbortSignal.timeout(2500),
		});
		if (!res.ok) return { delivered: false, reason: `http_${res.status}` };
		const body = await res.json().catch(() => ({}));
		return { delivered: !!body?.delivered, reason: body?.reason };
	} catch (err) {
		return { delivered: false, reason: err?.name === 'TimeoutError' ? 'timeout' : 'error' };
	}
}
