// world-service-auth — verify that a world-persistence write came from the
// authoritative multiplayer server (not a browser forging a service write).
//
// The Colyseus server signs a short-lived service token and sends it as
// `Authorization: Bearer <token>` when it saves a world doc. Format mirrors the
// presence ticket (api/_lib/presence-store.js) byte-for-byte, with `svc:'world'`
// marking it as a service principal rather than a user identity:
//
//   token  = base64url(JSON{svc:'world', exp}) + '.' + base64url(HMAC_SHA256(secret, payload))
//   secret = MULTIPLAYER_SHARED_SECRET (→ HOLDER_PASS_SECRET → dev fallback)
//
// The signer is multiplayer/src/persistence.js; keep the two in sync.

import { env } from './env.js';
import { hmacSha256, constantTimeEquals } from './crypto.js';

// Resolve the verified service principal, or null if the token is missing,
// forged, malformed, or expired. Returns `{ svc: 'world' }` on success so callers
// can branch on the principal kind.
export async function verifyWorldServiceToken(token) {
	if (typeof token !== 'string' || !token.includes('.')) return null;
	const [payload, sig] = token.split('.');
	if (!payload || !sig) return null;
	const expected = await hmacSha256(env.MULTIPLAYER_SHARED_SECRET, payload);
	if (!constantTimeEquals(sig, expected)) return null;
	let data;
	try {
		data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (!data || data.svc !== 'world' || !data.exp) return null;
	if (data.exp < Math.floor(Date.now() / 1000)) return null;
	return { svc: 'world' };
}
