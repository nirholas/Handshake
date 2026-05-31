// Holder pass verification — the game-server half of holder-gated worlds.
//
// The Vercel API (api/_lib/holder-pass.js) prices a user's on-chain holding and
// seals { mint, wallet, usd, tier, iat, exp } into an HMAC-SHA256 token. This
// process re-derives the signature with the same shared secret and checks it,
// so WalkRoom.onAuth can admit a client into a coin's holder world without ever
// touching Solana RPC or a price feed. Keep this byte-for-byte compatible with
// the signer.

import crypto from 'node:crypto';

const DEV_SECRET = 'three-ws-holder-pass-dev-secret';

let _warned = false;
function secret() {
	const s = process.env.HOLDER_PASS_SECRET;
	if (s) return s;
	if (!_warned) {
		_warned = true;
		console.warn(
			'[holder-pass] HOLDER_PASS_SECRET is not set — using the insecure dev secret. ' +
				'Set HOLDER_PASS_SECRET in production or holder worlds can be entered with a forged pass.',
		);
	}
	return DEV_SECRET;
}

function b64url(buf) {
	return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function hmac(body) {
	return b64url(crypto.createHmac('sha256', secret()).update(body).digest());
}

// Constant-time compare so a forged token can't be brute-forced byte by byte.
function safeEqual(a, b) {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ba.length !== bb.length) return false;
	return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify a holder pass and return its payload, or null if the token is missing,
 * malformed, tampered with, or expired.
 * @param {unknown} token
 * @returns {{ mint: string, wallet: string, usd: number, tier: string, iat: number, exp: number } | null}
 */
export function verifyHolderPass(token) {
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
	if (!payload || typeof payload !== 'object') return null;
	if (payload.tier !== 'holders') return null;
	if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
	if (typeof payload.mint !== 'string') return null;
	return payload;
}
