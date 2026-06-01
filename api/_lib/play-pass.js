// Play pass — the wallet-first entry credential for /play.
//
// Two short-lived, HMAC-signed tokens live here, both keyed on the same shared
// secret as the holder pass (HOLDER_PASS_SECRET) so the standalone Colyseus
// process can verify them with nothing but that secret — no Solana RPC, no DB:
//
//   1. NONCE   — issued by GET /api/play/nonce, embedded in the message the
//      wallet signs, and handed back to POST /api/play/verify. Self-verifying
//      (HMAC + exp) so we never need a cross-instance nonce store on serverless.
//   2. PLAY PASS — minted by POST /api/play/verify once a wallet has both proven
//      ownership (ed25519 signature over the nonce) and cleared the game-token
//      balance floor. Sealed { wallet, mint, balance, tier:'play', iat, exp } so
//      the game server (multiplayer/src/play-pass.js) admits the player and binds
//      the verified wallet as their account id without re-checking the chain.
//
// Format (both tokens): base64url(JSON(payload)) + '.' + base64url(HMAC-SHA256).
// The payload's `k` field namespaces the two so a nonce can never be replayed as
// a pass or vice-versa. Keep verifyPlayPass in the game server byte-compatible
// with signPlayPass here.

import crypto from 'node:crypto';

// The game token a wallet must hold to enter, and how much of it. PLAY_GATE_MINT
// is the canonical knob; it falls back to THREE_MINT (the platform's own token)
// so pinning $THREE in one place lights up the gate. An empty mint means the
// gate is OFF — /play stays open, exactly as before it was pinned.
export const PLAY_GATE_MINT = (process.env.PLAY_GATE_MINT || process.env.THREE_MINT || '').trim();
// Minimum whole-token balance. The world guide asks for ≥ 1 unit of the token.
export const PLAY_GATE_MIN = (() => {
	const n = Number(process.env.PLAY_GATE_MIN);
	return Number.isFinite(n) && n > 0 ? n : 1;
})();
// Optional display ticker for the gate's pre-verify screen ("hold ≥ 1 $THREE").
// Cosmetic only — the real symbol is read from chain metadata at verify time;
// this just spares the connect screen from saying "the game token".
export const PLAY_GATE_SYMBOL = (process.env.PLAY_GATE_SYMBOL || '').trim();

// A nonce is single-use in spirit but stateless in fact (no shared store on
// serverless), so keep its window tight: long enough to connect a wallet and
// approve a signature, short enough that a captured nonce is near-worthless.
const NONCE_TTL_S = 5 * 60;
// Lifetime of a minted pass — long enough to finish loading into the world after
// the check, short enough that a wallet that offloads its tokens can't ride an
// old pass for long. The game server re-checks balance on a cadence too.
const PASS_TTL_S = 10 * 60;

const DEV_SECRET = 'three-ws-holder-pass-dev-secret';

let _warned = false;
function secret() {
	const s = process.env.HOLDER_PASS_SECRET;
	if (s) return s;
	// Fail closed in production: minting credentials with a publicly-known secret
	// would let anyone forge entry. wrap() turns this throw into a 500.
	if (process.env.NODE_ENV === 'production') {
		throw new Error(
			'[play-pass] HOLDER_PASS_SECRET is required in production — refusing to mint passes with the dev secret.',
		);
	}
	if (!_warned) {
		_warned = true;
		console.warn(
			'[play-pass] HOLDER_PASS_SECRET is not set — using the insecure dev secret. ' +
				'Set HOLDER_PASS_SECRET in production or the play gate can be forged.',
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

function safeEqual(a, b) {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ba.length !== bb.length) return false;
	return crypto.timingSafeEqual(ba, bb);
}

function seal(payload) {
	const body = b64url(JSON.stringify(payload));
	return `${body}.${hmac(body)}`;
}

function open(token, kind) {
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
	if (!payload || typeof payload !== 'object' || payload.k !== kind) return null;
	const now = Date.now() / 1000;
	if (typeof payload.exp !== 'number' || payload.exp < now) return null;
	if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
	return payload;
}

/**
 * Issue a fresh sign-in nonce.
 * @returns {{ nonce: string, exp: number }} the self-verifying nonce token + its
 *   epoch-seconds expiry. The whole `nonce` string is what the wallet signs and
 *   what the client returns to /verify.
 */
export function issueNonce() {
	const now = Math.floor(Date.now() / 1000);
	return {
		nonce: seal({ k: 'play-nonce', r: crypto.randomBytes(16).toString('hex'), iat: now, exp: now + NONCE_TTL_S }),
		exp: now + NONCE_TTL_S,
	};
}

/**
 * Verify a nonce token. Returns its payload or null when missing, tampered, or
 * expired.
 * @param {unknown} nonce
 */
export function verifyNonce(nonce) {
	return open(nonce, 'play-nonce');
}

/**
 * Seal a verified, token-holding wallet into a play pass.
 * @param {{ wallet: string, mint: string, balance: number }} claims
 * @returns {string} the compact pass token
 */
export function signPlayPass({ wallet, mint, balance }) {
	const now = Math.floor(Date.now() / 1000);
	return seal({
		k: 'play-pass',
		tier: 'play',
		wallet,
		mint,
		balance: Math.round((Number(balance) || 0) * 1e6) / 1e6,
		// Signed so the game server displays the real requirement, never a
		// client-supplied one.
		minBalance: PLAY_GATE_MIN,
		iat: now,
		exp: now + PASS_TTL_S,
	});
}
