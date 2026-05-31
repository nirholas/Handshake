// Holder pass — a short-lived, HMAC-signed token proving a CoinCommunities user
// holds at least HOLDER_MIN_USD worth of a specific coin.
//
// Why this exists: the multiplayer server (a standalone Colyseus process) gates
// entry into a coin's *holder world* but has no Solana RPC or price feed of its
// own. So the on-chain truth is computed once, here on the Vercel side
// (api/community/holder-pass.js reads the user's linked wallet and prices its
// balance), and the result is sealed into a compact token the game server can
// verify with nothing but a shared secret. The wallet is taken from the
// authenticated CoinCommunities session — never the client — so a pass can't be
// minted for someone else's wallet.
//
// Format: base64url(JSON(payload)) + '.' + base64url(HMAC-SHA256(body)).
// Payload: { mint, wallet, usd, tier:'holders', iat, exp }. Verification lives
// in multiplayer/src/holder-pass.js, byte-for-byte compatible with sign() here.

import crypto from 'node:crypto';

// The USD floor a wallet must clear to enter a coin's holder world. One knob,
// shared by the issuer (here) and surfaced to the client so the gate UI can
// state the exact requirement.
export const HOLDER_MIN_USD = Number(process.env.HOLDER_MIN_USD) || 8;

// Lifetime of an issued pass. Long enough to finish loading into a world after
// the check, short enough that a sold-off wallet can't linger on an old pass.
const PASS_TTL_S = 10 * 60;

// Dev fallback keeps the gate working end-to-end on a laptop with no env set;
// production MUST set HOLDER_PASS_SECRET (warned below) or the gate is bypassable
// by anyone who reads this source.
const DEV_SECRET = 'three-ws-holder-pass-dev-secret';

let _warned = false;
function secret() {
	const s = process.env.HOLDER_PASS_SECRET;
	if (s) return s;
	if (!_warned) {
		_warned = true;
		console.warn(
			'[holder-pass] HOLDER_PASS_SECRET is not set — using the insecure dev secret. ' +
				'Set HOLDER_PASS_SECRET in production or the holder gate can be forged.',
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

/**
 * Seal a verified holding into a signed pass.
 * @param {{ mint: string, wallet: string, usd: number }} claims
 * @returns {string} the compact pass token
 */
export function signHolderPass({ mint, wallet, usd }) {
	const now = Math.floor(Date.now() / 1000);
	const payload = {
		mint,
		wallet,
		usd: Math.round((Number(usd) || 0) * 100) / 100,
		tier: 'holders',
		iat: now,
		exp: now + PASS_TTL_S,
	};
	const body = b64url(JSON.stringify(payload));
	return `${body}.${hmac(body)}`;
}
