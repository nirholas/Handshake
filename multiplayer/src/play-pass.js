// Play pass verification — the game-server half of the wallet-first /play gate.
//
// The Vercel API (api/_lib/play-pass.js) proves a wallet owns its key (ed25519
// signature over a server nonce) and holds ≥ the game-token floor, then seals
// { wallet, mint, balance, tier:'play', iat, exp } into an HMAC-SHA256 token.
// This process re-derives the signature with the same shared secret and checks
// it, so WalkRoom.onAuth can admit a player and bind their verified wallet as
// the account id without ever touching Solana RPC. Keep byte-for-byte compatible
// with signPlayPass().

import crypto from 'node:crypto';

const DEV_SECRET = 'three-ws-holder-pass-dev-secret';

let _warned = false;
function secret() {
	const s = process.env.HOLDER_PASS_SECRET;
	if (s) return s;
	if (process.env.NODE_ENV === 'production') {
		throw new Error(
			'[play-pass] HOLDER_PASS_SECRET is required in production — refusing to verify passes with the dev secret.',
		);
	}
	if (!_warned) {
		_warned = true;
		console.warn(
			'[play-pass] HOLDER_PASS_SECRET is not set — using the insecure dev secret. ' +
				'Set HOLDER_PASS_SECRET in production or the play gate can be entered with a forged pass.',
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
 * Verify a play pass and return its payload, or null if the token is missing,
 * malformed, tampered with, or expired.
 * @param {unknown} token
 * @returns {{ wallet: string, mint: string, balance: number, minBalance?: number, tier: string, iat: number, exp: number } | null}
 */
export function verifyPlayPass(token) {
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
	if (payload.k !== 'play-pass' || payload.tier !== 'play') return null;
	if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
	// Reject future-dated passes (clock skew / forged iat) and any whose lifetime
	// exceeds the issuer's TTL — a defence against a tampered exp slipping past the
	// HMAC if the secret ever leaks.
	const now = Date.now() / 1000;
	if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
	if (payload.exp - payload.iat > 15 * 60) return null;
	if (typeof payload.wallet !== 'string' || !payload.wallet) return null;
	if (typeof payload.mint !== 'string' || !payload.mint) return null;
	if (typeof payload.balance !== 'number' || !Number.isFinite(payload.balance) || payload.balance < 0) return null;
	if (payload.minBalance != null && (typeof payload.minBalance !== 'number' || !Number.isFinite(payload.minBalance) || payload.minBalance < 0)) return null;
	return payload;
}
