/**
 * Signed, short-lived tokens for the hub.
 *
 * The hub is a dumb pipe: it joins one satellite to the browsers that are
 * allowed to watch it and forwards bytes. It holds no database, so the only
 * thing that can tell it "this socket may join room X" is the signature on the
 * token the socket presents. Three properties matter and each one is a
 * deliberate choice, not an accident of the format:
 *
 *   * The signature is HMAC-SHA256 over the exact JSON that is transmitted, so
 *     a claim cannot be edited without invalidating it.
 *   * Every token carries an expiry and the hub enforces it. A viewer token
 *     that leaks out of a browser's network log is worthless in minutes.
 *   * Comparison is constant time. A hub that leaks signature bytes through
 *     timing is a hub that can be forged into, and "it is only audio" is not a
 *     defence when the audio is somebody's kitchen.
 *
 * The same primitive signs the satellite's own room token, so a stranger who
 * guesses a satellite id still cannot occupy that room and impersonate
 * somebody's house.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/** Roles a token can carry. A socket gets exactly one. */
export const ROLE = Object.freeze({ SATELLITE: 'satellite', VIEWER: 'viewer' });

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Mint a token.
 *
 * @param {object} claims          Must include `sid` (satellite id) and `role`.
 * @param {string} secret          Shared signing secret.
 * @param {number} ttlSeconds      Lifetime. Kept short for viewers, longer for
 *                                 the satellite's own session token.
 * @returns {string} `v1.<payload>.<signature>`
 */
export function signToken(claims, secret, ttlSeconds) {
	if (!claims || typeof claims.sid !== 'string' || !claims.sid) throw new Error('signToken: sid required');
	if (claims.role !== ROLE.SATELLITE && claims.role !== ROLE.VIEWER) throw new Error('signToken: unknown role');
	if (!secret) throw new Error('signToken: secret required');
	const ttl = Number(ttlSeconds);
	if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('signToken: ttlSeconds must be positive');

	const payload = { ...claims, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + Math.floor(ttl) };
	const body = b64url(JSON.stringify(payload));
	const sig = b64url(createHmac('sha256', secret).update(body).digest());
	return `v1.${body}.${sig}`;
}

/**
 * Verify a token. Returns `{ ok: true, claims }` or `{ ok: false, reason }`.
 * Never throws on malformed input: this runs on the first bytes a stranger
 * sends, so every failure mode has to be a value, not an exception.
 *
 * @param {string} token
 * @param {string} secret
 * @param {number} [nowSeconds]
 */
export function verifyToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
	if (typeof token !== 'string' || !secret) return { ok: false, reason: 'missing' };
	const parts = token.split('.');
	if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };

	const [, body, sig] = parts;
	const expected = createHmac('sha256', secret).update(body).digest();
	let given;
	try {
		given = Buffer.from(sig, 'base64url');
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
		return { ok: false, reason: 'signature' };
	}

	let claims;
	try {
		claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	if (!claims || typeof claims.sid !== 'string' || !claims.sid) return { ok: false, reason: 'malformed' };
	if (claims.role !== ROLE.SATELLITE && claims.role !== ROLE.VIEWER) return { ok: false, reason: 'role' };
	if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds) return { ok: false, reason: 'expired' };
	return { ok: true, claims };
}

/** A new signing secret, for a satellite that has just been claimed. */
export function newSecret() {
	return randomBytes(32).toString('base64url');
}
