// Presence-ticket verification — the multiplayer half of the friends presence
// handshake. The Vercel API mints a ticket (api/_lib/presence-store.js →
// signPresenceTicket) for an authenticated account; a realm room verifies it
// here on join and trusts the returned account id, so a client can never claim
// another account's presence.
//
// Keep byte-for-byte in sync with the API signer:
//   token   = base64url(JSON{uid,exp}) + '.' + base64url(HMAC_SHA256(secret, payload))
//   secret  = MULTIPLAYER_SHARED_SECRET (falls back to HOLDER_PASS_SECRET, then a
//             public dev secret — the same fallback chain the API uses).

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

// Verify a presence ticket → the trusted account id (uid), or null if the
// signature is wrong, the payload is malformed, or the ticket has expired.
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
	return data.uid;
}

// Verify the signature on an internal /internal/notify webhook from the API.
// The API signs HMAC_SHA256(secret, `notify:<to>:<type>`); we recompute and
// compare in constant time so a third party can't inject fake DMs/events.
export function verifyNotifySignature(to, type, sig) {
	if (typeof sig !== 'string' || !sig) return false;
	const expected = crypto.createHmac('sha256', secret()).update(`notify:${to}:${type}`).digest('base64url');
	return timingSafeEqualStr(sig, expected);
}
