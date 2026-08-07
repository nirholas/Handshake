// Presence-ticket verification — the multiplayer half of the friends presence
// handshake. The Vercel API mints a ticket (api/_lib/presence-store.js →
// signPresenceTicket) for an authenticated account; a realm room verifies it
// here on join and trusts the returned account id, so a client can never claim
// another account's presence.
//
// Keep byte-for-byte in sync with the API signer:
//   token   = base64url(JSON{uid,exp,crew,crewName,u,dn}) + '.' + base64url(HMAC_SHA256(secret, payload))
//   secret  = MULTIPLAYER_SHARED_SECRET (falls back to HOLDER_PASS_SECRET, then a
//             public dev secret — the same fallback chain the API uses).
// `u`/`dn` are the bearer's three.ws username + display name; older tickets
// omit them and still verify (they surface as empty strings).

import crypto from 'node:crypto';

function secret() {
	return (
		process.env.MULTIPLAYER_SHARED_SECRET ||
		process.env.HOLDER_PASS_SECRET ||
		'dev-insecure-multiplayer-secret'
	);
}

function timingSafeEqualStr(a, b) {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return crypto.timingSafeEqual(ab, bb);
}

// Verify a presence ticket → the trusted identity it carries, or null if the
// signature is wrong, the payload is malformed, or the ticket has expired.
// Returns { uid, username, displayName, crew, crewName }: uid is the account
// id (users.id UUID); username/displayName are the bearer's public three.ws
// handle, empty for tickets minted before the profile fields existed.
export function verifyPresenceTicket(token) {
	if (typeof token !== 'string' || !token.includes('.')) return null;
	const [payload, sig] = token.split('.');
	if (!payload || !sig) return null;
	const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
	if (!timingSafeEqualStr(sig, expected)) return null;
	let data;
	try {
		data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (!data || !data.uid || !data.exp) return null;
	if (data.exp < Math.floor(Date.now() / 1000)) return null;
	return {
		uid: data.uid,
		username: typeof data.u === 'string' ? data.u : '',
		displayName: typeof data.dn === 'string' ? data.dn : '',
		crew: typeof data.crew === 'string' ? data.crew : '',
		crewName: typeof data.crewName === 'string' ? data.crewName : '',
	};
}

// Maximum age (seconds) an /internal/notify signature stays valid. The API mints
// and delivers a notify within a couple of round-trips, so a tight window bounds
// replay while clearing normal network + clock-skew jitter.
const NOTIFY_MAX_AGE_S = 120;

// Verify the signature on an internal /internal/notify webhook from the API.
// The API signs HMAC_SHA256(secret, `notify:<to>:<type>:<ts>:<sha256(payload)>`),
// so the signature is bound to the exact delivered body and a fresh timestamp —
// a captured tuple can't be replayed with attacker-chosen content, nor outside
// the freshness window. We recompute over the SAME payload we're about to deliver
// (the caller passes the parsed payload it will act on) and compare in constant
// time. Keep byte-compatible with notifyMultiplayer in api/_lib/presence-store.js.
export function verifyNotifySignature(to, type, payload, ts, sig) {
	if (typeof sig !== 'string' || !sig) return false;
	const tsNum = Number(ts);
	if (!Number.isFinite(tsNum)) return false;
	// Reject stale or future-dated timestamps (replay / forged clock).
	const nowS = Math.floor(Date.now() / 1000);
	if (Math.abs(nowS - tsNum) > NOTIFY_MAX_AGE_S) return false;
	const payloadHash = crypto
		.createHash('sha256')
		.update(JSON.stringify(payload ?? {}))
		.digest('base64url');
	const expected = crypto
		.createHmac('sha256', secret())
		.update(`notify:${to}:${type}:${tsNum}:${payloadHash}`)
		.digest('base64url');
	return timingSafeEqualStr(sig, expected);
}

// ── Living Stages internal bridge ────────────────────────────────────────────
// The Vercel API and this server can't share code (separate packages), so the
// stage tip/event webhook reuses the same HMAC discipline as /internal/notify:
// the signature binds the exact body + a fresh timestamp to the shared secret, so
// a captured tuple can't be replayed with attacker-chosen content or after the
// freshness window. Keep byte-compatible with signStageEvent in
// api/_lib/stage-bridge.js.
const STAGE_MAX_AGE_S = 120;

export function verifyStageSignature(payload, ts, sig) {
	if (typeof sig !== 'string' || !sig) return false;
	const tsNum = Number(ts);
	if (!Number.isFinite(tsNum)) return false;
	const nowS = Math.floor(Date.now() / 1000);
	if (Math.abs(nowS - tsNum) > STAGE_MAX_AGE_S) return false;
	const payloadHash = crypto
		.createHash('sha256')
		.update(JSON.stringify(payload ?? {}))
		.digest('base64url');
	const expected = crypto
		.createHmac('sha256', secret())
		.update(`stage:${tsNum}:${payloadHash}`)
		.digest('base64url');
	return timingSafeEqualStr(sig, expected);
}

// ── Live-event announcements ─────────────────────────────────────────────────
// /internal/announce lets an operator (via scripts/announce-play.mjs, which
// holds the same shared secret) broadcast a message to every live walk_world
// room during an event. Same HMAC discipline as the other internal webhooks:
// the signature binds the exact body + a fresh timestamp, so a captured tuple
// can't be replayed with different content or outside the freshness window.
// Keep byte-compatible with the signer in scripts/announce-play.mjs.
const ANNOUNCE_MAX_AGE_S = 120;

export function verifyAnnounceSignature(payload, ts, sig) {
	if (typeof sig !== 'string' || !sig) return false;
	const tsNum = Number(ts);
	if (!Number.isFinite(tsNum)) return false;
	const nowS = Math.floor(Date.now() / 1000);
	if (Math.abs(nowS - tsNum) > ANNOUNCE_MAX_AGE_S) return false;
	const payloadHash = crypto
		.createHash('sha256')
		.update(JSON.stringify(payload ?? {}))
		.digest('base64url');
	const expected = crypto
		.createHmac('sha256', secret())
		.update(`announce:${tsNum}:${payloadHash}`)
		.digest('base64url');
	return timingSafeEqualStr(sig, expected);
}

// Sign an outbound room → API request (the host loop fetching the next beat from
// /api/stage/host). Mirrored by verifyStageRequest in api/_lib/stage-bridge.js.
export function signStageRequest(payload) {
	const ts = Math.floor(Date.now() / 1000);
	const payloadHash = crypto
		.createHash('sha256')
		.update(JSON.stringify(payload ?? {}))
		.digest('base64url');
	const sig = crypto
		.createHmac('sha256', secret())
		.update(`stage-req:${ts}:${payloadHash}`)
		.digest('base64url');
	return { ts, sig };
}
