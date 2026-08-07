// Guest-token signing/verification — the account proof for un-walleted players.
//
// The game profile account key (playerId) must never be taken from a raw client
// option: a `pid` set to a victim's wallet or guest id would load and control
// their saved profile (gold, bank, items) and grief them off their eviction
// channel. Wallet accounts are proven by a play pass (verifyPlayPass). Guests have
// no wallet to sign, so the SERVER mints them an identity instead: a random guest
// id sealed into an HMAC-signed token here. The client echoes the token back on
// reconnect; the room verifies it and binds the sealed guest id as the account,
// so a guest id can only ever be claimed by the socket that holds its signed
// token — another client can't guess or assert it.
//
// Format: base64url(JSON{ k:'guest', gid, iat, exp }) + '.' + base64url(HMAC-SHA256).
// Same construction + shared secret as play-pass.js / presence-token.js so the
// whole multiplayer trust layer keys off one secret.

import crypto from 'node:crypto';

// 90 days — long enough that a returning guest keeps their progression across
// sessions, short enough to bound an abandoned id. The client refreshes the token
// (re-issued on every join below) well before this, so an active guest never lapses.
const GUEST_TTL_S = 60 * 60 * 24 * 90;

function secret() {
	return (
		process.env.MULTIPLAYER_SHARED_SECRET ||
		process.env.HOLDER_PASS_SECRET ||
		'dev-insecure-multiplayer-secret'
	);
}

function b64url(buf) {
	return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function hmac(body) {
	return b64url(crypto.createHmac('sha256', secret()).update(body).digest());
}

function safeEqual(a, b) {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ba.length !== bb.length) return false;
	return crypto.timingSafeEqual(ba, bb);
}

// Guest ids are server-minted with this prefix so they're visibly distinct from
// wallet accounts and from a client-supplied `g_…` localStorage id (which is no
// longer trusted as an account key).
const GUEST_PREFIX = 'gs_';

/**
 * Mint a fresh, unguessable guest id.
 * @returns {string}
 */
export function newGuestId() {
	return GUEST_PREFIX + crypto.randomBytes(12).toString('hex');
}

/**
 * Seal a guest id into a signed token the client stores and replays on reconnect.
 * @param {string} gid
 * @returns {string}
 */
export function signGuestToken(gid) {
	const now = Math.floor(Date.now() / 1000);
	const body = b64url(JSON.stringify({ k: 'guest', gid, iat: now, exp: now + GUEST_TTL_S }));
	return `${body}.${hmac(body)}`;
}

/**
 * Verify a guest token and return its sealed guest id, or null when the token is
 * missing, malformed, tampered with, or expired.
 * @param {unknown} token
 * @returns {string | null}
 */
export function verifyGuestToken(token) {
	if (typeof token !== 'string' || token.length < 16 || token.length > 4096) return null;
	const dot = token.indexOf('.');
	if (dot <= 0) return null;
	const body = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	if (!safeEqual(sig, hmac(body))) return null;

	let payload;
	try {
		payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
	} catch {
		return null;
	}
	if (!payload || typeof payload !== 'object' || payload.k !== 'guest') return null;
	if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
	const now = Date.now() / 1000;
	if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
	// `gs_…` ids are server-minted. `guest-…` ids are the legacy client-minted
	// localStorage ids: a bare one is never trusted, but once the room has sealed
	// it into a signed token (the one-time migration in WalkRoom._resolveIdentity)
	// the HMAC proves the server vouched for it, so honoring it here is what lets
	// a pre-token guest keep their progression.
	if (typeof payload.gid !== 'string') return null;
	if (!payload.gid.startsWith(GUEST_PREFIX) && !payload.gid.startsWith('guest-')) return null;
	return payload.gid;
}
