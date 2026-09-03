/**
 * Install tokens: how the relay knows which house is dialling in, without
 * holding a database and without ever seeing a Home Assistant credential.
 *
 * three.ws mints one of these at pairing time and hands it to the integration
 * running inside the user's house. The integration stores it and presents it on
 * every dial-in. The relay verifies the HMAC with the shared signing key and
 * reads the relay id out of the payload, so the relay stays stateless about
 * ownership: it never queries a database on the connect path, and it cannot be
 * tricked into binding a socket to a relay id its holder was not granted.
 *
 * What this token is NOT: a Home Assistant credential. In relay mode three.ws
 * stores no Home Assistant token at all (`home_connections.access_token_enc` is
 * empty), because the integration authenticates to Home Assistant locally with
 * a refresh token it mints for itself and never sends off the machine. Stealing
 * an install token gets an attacker a socket to the relay, which the relay will
 * only ever join to the owning user's own sessions, and which the physical
 * action gate still sits above.
 *
 * Revocation is push based and immediate: three.ws calls the relay's admin
 * endpoint when a home is revoked, the relay drops the socket and denies the
 * relay id. The token itself is not the last line of defence, which is why it
 * does not carry an expiry the user would have to re-pair around: the platform
 * re-reads the connection row on every bridge connect, so a revoked home never
 * gets a session opened even if the relay were to forget the denial.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const PREFIX = 'hr1';

/** URL-safe base64 without padding, so the token is copy-pasteable. */
function b64url(buf) {
	return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text) {
	const padded = text.replace(/-/g, '+').replace(/_/g, '/');
	return Buffer.from(padded, 'base64');
}

function sign(payloadB64, key) {
	return b64url(createHmac('sha256', key).update(`${PREFIX}.${payloadB64}`).digest());
}

/**
 * A relay id: the public, non-secret handle for one paired house. Stored in
 * `home_connections.relay_id`, carried in the token, and used as the routing
 * key inside the relay. It is deliberately not a database primary key, so the
 * relay never learns anything about three.ws's own identifiers.
 */
export function newRelayId() {
	return `hr_${b64url(randomBytes(18))}`;
}

/**
 * @param {object} claims
 * @param {string} claims.relayId
 * @param {string} claims.userId    the owning three.ws user
 * @param {string} claims.homeId    the home_connections row
 * @param {string} key              HOME_RELAY_SIGNING_KEY
 */
export function mintInstallToken({ relayId, userId, homeId }, key) {
	assertKey(key);
	if (!relayId || !userId || !homeId) throw new Error('mintInstallToken needs relayId, userId and homeId.');
	const payload = { rid: relayId, uid: userId, hid: homeId, iat: Math.floor(Date.now() / 1000) };
	const payloadB64 = b64url(JSON.stringify(payload));
	return `${PREFIX}.${payloadB64}.${sign(payloadB64, key)}`;
}

/**
 * @returns {{ ok: true, claims: { relayId: string, userId: string, homeId: string, issuedAt: number } }
 *          | { ok: false, reason: string }}
 */
export function verifyInstallToken(token, key) {
	assertKey(key);
	if (typeof token !== 'string') return { ok: false, reason: 'No token presented.' };
	const parts = token.split('.');
	if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: 'Token is not a three.ws install token.' };
	const [, payloadB64, mac] = parts;
	const expected = sign(payloadB64, key);
	if (!constantTimeEquals(mac, expected)) return { ok: false, reason: 'Token signature did not verify.' };
	let payload;
	try {
		payload = JSON.parse(unb64url(payloadB64).toString('utf8'));
	} catch {
		return { ok: false, reason: 'Token payload was not readable.' };
	}
	if (!payload?.rid || !payload?.uid || !payload?.hid) return { ok: false, reason: 'Token payload was incomplete.' };
	return { ok: true, claims: { relayId: payload.rid, userId: payload.uid, homeId: payload.hid, issuedAt: payload.iat || 0 } };
}

/**
 * Compares two secrets without leaking their contents through timing. Length
 * differences are hashed away first so a mismatched length is not a fast path.
 */
export function constantTimeEquals(a, b) {
	const ha = createHmac('sha256', 'three.ws/home-relay/compare').update(String(a ?? '')).digest();
	const hb = createHmac('sha256', 'three.ws/home-relay/compare').update(String(b ?? '')).digest();
	return timingSafeEqual(ha, hb);
}

function assertKey(key) {
	if (typeof key !== 'string' || key.length < 32) {
		throw new Error('HOME_RELAY_SIGNING_KEY must be set to at least 32 characters.');
	}
}
