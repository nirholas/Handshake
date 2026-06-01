// Realm-transfer tokens — the trust boundary for portal traversal.
//
// When a player steps onto a portal, the source GameRoom snapshots their full
// state (inventory, hotbar, bank, gold, skills, hp, cosmetic) and reserves a
// seat in the destination realm room. The snapshot can't ride along as plain
// join options: a client could call client.joinOrCreate('game', { realm, carry })
// directly and mint gold or items out of thin air. So we seal the snapshot into
// an HMAC-SHA256 token here — identical construction to holder-pass.js — and the
// destination room refuses any carry that isn't signed with the shared secret.
//
// The token is short-lived (TTL below): a transfer is consumed within a couple
// of network round-trips, so a long window only widens the replay surface (e.g.
// banking a token at high gold, spending, then replaying to restore it).

import crypto from 'node:crypto';

const DEV_SECRET = 'three-ws-realm-transfer-dev-secret';
const TTL_SECONDS = 60; // a transfer is consumed in milliseconds; 60s covers any reconnect hiccup

let _warned = false;
function secret() {
	// Prefer a dedicated secret, but fall back to the holder-pass secret so a
	// single env var secures both gates in the common single-secret deployment.
	const s = process.env.REALM_TRANSFER_SECRET || process.env.HOLDER_PASS_SECRET;
	if (s) return s;
	if (process.env.NODE_ENV === 'production') {
		throw new Error(
			'[realm-transfer] REALM_TRANSFER_SECRET (or HOLDER_PASS_SECRET) is required in production — ' +
				'refusing to sign transfers with the dev secret.',
		);
	}
	if (!_warned) {
		_warned = true;
		console.warn(
			'[realm-transfer] no REALM_TRANSFER_SECRET/HOLDER_PASS_SECRET set — using the insecure dev secret. ' +
				'Set one in production or portal carries can be forged.',
		);
	}
	return DEV_SECRET;
}

function b64url(buf) {
	return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(str) {
	return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
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

/**
 * Seal a portal transfer into a signed token.
 * @param {{ to: string, tx: number, ty: number, carry: object }} payload
 * @returns {string} `${base64url(body)}.${signature}`
 */
export function signTransfer(payload) {
	const now = Math.floor(Date.now() / 1000);
	const body = b64url(
		JSON.stringify({
			to: payload.to,
			tx: payload.tx,
			ty: payload.ty,
			carry: payload.carry,
			iat: now,
			exp: now + TTL_SECONDS,
		}),
	);
	return `${body}.${hmac(body)}`;
}

/**
 * Verify a transfer token and return its payload, or null if missing, malformed,
 * tampered with, or expired.
 * @param {unknown} token
 * @returns {{ to: string, tx: number, ty: number, carry: object, iat: number, exp: number } | null}
 */
export function verifyTransfer(token) {
	if (typeof token !== 'string' || token.length < 16 || token.length > 65536) return null;
	const dot = token.indexOf('.');
	if (dot <= 0) return null;
	const body = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	if (!safeEqual(sig, hmac(body))) return null;

	let payload;
	try {
		payload = JSON.parse(b64urlDecode(body));
	} catch {
		return null;
	}
	if (!payload || typeof payload !== 'object') return null;
	if (typeof payload.to !== 'string' || !payload.to) return null;
	if (!Number.isFinite(payload.tx) || !Number.isFinite(payload.ty)) return null;
	if (!payload.carry || typeof payload.carry !== 'object') return null;

	const now = Date.now() / 1000;
	if (typeof payload.exp !== 'number' || payload.exp < now) return null;
	if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
	if (payload.exp - payload.iat > TTL_SECONDS + 5) return null;
	return payload;
}
