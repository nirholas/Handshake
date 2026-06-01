// Signed payment quotes for the $THREE token layer.
//
// The server prices a USD amount, splits it per policy, and seals the result
// into a compact HMAC-signed token: base64url(JSON(payload)) + '.' + sig.
// The client builds and sends one transaction from the quote's legs, then
// returns the quote token + tx signature on settle. Signing it means the client
// cannot tamper with the token amount, the split ratio, or the destinations
// after the server priced them — and the embedded `exp` enforces a short
// validity window so a stale price can't be exploited after the market moves.
//
// Boot guard mirrors api/_lib/holder-pass.js: production MUST set
// THREE_QUOTE_SECRET or quotes would be forgeable by anyone reading this source.

import crypto from 'node:crypto';
import { env } from '../env.js';
import { randomToken } from '../crypto.js';
import {
	TOKEN_MINT,
	TOKEN_DECIMALS,
	TOKEN_SYMBOL,
	resolveSplitLegs,
	applySplit,
} from './config.js';
import { quoteTokenForUsd } from './price.js';

const DEV_SECRET = 'three-ws-token-quote-dev-secret';

let _warned = false;
function secret() {
	const s = env.THREE_QUOTE_SECRET;
	if (s) return s;
	if (process.env.NODE_ENV === 'production') {
		throw new Error(
			'[token] THREE_QUOTE_SECRET is required in production — refusing to sign payment quotes with the dev secret.',
		);
	}
	if (!_warned) {
		_warned = true;
		console.warn(
			'[token] THREE_QUOTE_SECRET is not set — using the insecure dev secret. ' +
				'Set THREE_QUOTE_SECRET in production or payment quotes can be forged.',
		);
	}
	return DEV_SECRET;
}

function b64url(buf) {
	return Buffer.from(buf)
		.toString('base64')
		.replace(/=+$/, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}
function b64urlToBuf(s) {
	return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function hmac(body) {
	return b64url(crypto.createHmac('sha256', secret()).update(body).digest());
}

function quoteError(message, status = 422, code = 'invalid_quote') {
	return Object.assign(new Error(message), { status, code });
}

/**
 * Price a USD amount, split it, and return a signed quote.
 * @param {{
 *   purpose: string,        // 'spin' | 'marketplace_sale' | ...
 *   usd: number,            // USD amount to charge
 *   splitPolicy: string,    // a key of SPLIT_POLICIES
 *   sellerWallet?: string,  // required when the policy has a 'seller' leg
 *   network?: 'mainnet'|'devnet',
 *   refType?: string|null,  // links the payment to a spin / listing for audit
 *   refId?: string|null,
 * }} params
 */
export async function issueQuote({
	purpose,
	usd,
	splitPolicy,
	sellerWallet = null,
	network = 'mainnet',
	refType = null,
	refId = null,
}) {
	const priced = await quoteTokenForUsd(usd);
	const legs = applySplit(priced.atomics, resolveSplitLegs(splitPolicy, { sellerWallet }));
	const now = Math.floor(Date.now() / 1000);
	const nonce = await randomToken(16);

	const payload = {
		v: 1,
		purpose,
		network,
		mint: TOKEN_MINT,
		decimals: TOKEN_DECIMALS,
		symbol: TOKEN_SYMBOL,
		usd: priced.usd,
		priceUsd: priced.priceUsd,
		priceSource: priced.source,
		total: priced.atomics.toString(),
		// Destinations + per-leg atomics the client must satisfy on-chain.
		legs: legs.map((l) => ({
			role: l.role,
			address: l.address,
			bps: l.bps,
			atomics: l.atomics.toString(),
		})),
		// The nonce doubles as the transaction memo, binding the on-chain tx to
		// this exact quote and serving as the replay-protection key at settle.
		nonce,
		refType,
		refId,
		iat: now,
		exp: now + env.THREE_QUOTE_TTL_S,
	};

	const body = b64url(Buffer.from(JSON.stringify(payload)));
	const token = `${body}.${hmac(body)}`;
	return { token, quote: payload, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

/**
 * Verify a quote token's signature and expiry, returning the payload.
 * Throws (422 invalid_quote / 410 quote_expired) on any tamper or timeout.
 */
export function verifyQuote(token) {
	if (typeof token !== 'string' || !token.includes('.'))
		throw quoteError('malformed quote token');
	const [body, sig] = token.split('.');
	if (!body || !sig) throw quoteError('malformed quote token');

	const expected = hmac(body);
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
		throw quoteError('quote signature invalid');

	let payload;
	try {
		payload = JSON.parse(b64urlToBuf(body).toString('utf8'));
	} catch {
		throw quoteError('quote payload unreadable');
	}

	const now = Math.floor(Date.now() / 1000);
	if (!payload.exp || payload.exp < now) throw quoteError('quote expired', 410, 'quote_expired');
	if (!payload.nonce || !Array.isArray(payload.legs) || payload.legs.length === 0) {
		throw quoteError('quote missing required fields');
	}
	return payload;
}
