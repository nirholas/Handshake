// GET /api/onramp/link?address=SOLANA_ADDR&amount=25&asset=USDC
//
// Returns a URL the client should open (in a popup) to let the user buy the
// requested asset without leaving the app.  Tries Coinbase's hosted onramp
// (destination wallet pre-filled) first, then falls back to that asset's
// Coinbase buy page.
//
// `asset` is USDC (default) or SOL.  Both settle on Solana.  SOL exists because
// some wallets on this platform pay in native lamports (the agent-economy demo
// wallet, for one), and sending them USDC would never make them spendable.
//
// Requires:
//   CDP_API_KEY_ID + CDP_API_KEY_SECRET  (optional): the Coinbase Developer
//                         Platform key pair, already used by the x402
//                         facilitator.  When set, each call mints a single-use
//                         Onramp session token bound to the user's Solana
//                         wallet and returns a pre-populated Coinbase checkout.
//                         When absent (or when Coinbase rejects the call), the
//                         URL falls back to that asset's Coinbase buy page and
//                         the user sends to the address the overlay shows them.
//
// The address param is NOT a secret (it's a Solana public key) and is only
// used as the deposit destination: it is safe to pass in a query string.

import { cors, json, error, rateLimited, reportServerError, wrap } from '../_lib/http.js';
import { isValidSolanaAddress } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { createOnrampSessionToken, onrampClientIp, onrampConfigured } from '../_lib/coinbase-onramp.js';

// Assets buyable through the onramp, all settling on Solana mainnet.  Each maps
// to the Coinbase asset ticker and the Coinbase price page used when no session
// token can be minted.
const SOLANA_BLOCKCHAIN = 'solana';
const ASSETS = {
	USDC: { ticker: 'USDC', fallbackUrl: 'https://www.coinbase.com/price/usd-coin' },
	SOL:  { ticker: 'SOL',  fallbackUrl: 'https://www.coinbase.com/price/solana' },
};
const DEFAULT_ASSET = 'USDC';

const MIN_AMOUNT_USD = 10;
const MAX_AMOUNT_USD = 500;
const DEFAULT_AMOUNT_USD = 25;

/**
 * Build a Coinbase hosted checkout URL around a freshly minted session token.
 * The token carries the destination wallet; everything else is presentation.
 * Spec: https://docs.cdp.coinbase.com/onramp/coinbase-hosted-onramp/generating-onramp-url
 *
 * @param {string} sessionToken   single-use token from the CDP token API
 * @param {string} assetTicker    Coinbase asset ticker (USDC or SOL)
 * @param {number} amount         preset fiat amount in USD
 * @returns {string}
 */
function buildCoinbaseOnrampUrl(sessionToken, assetTicker, amount) {
	const params = new URLSearchParams({
		sessionToken,
		defaultNetwork: SOLANA_BLOCKCHAIN,
		defaultAsset: assetTicker,
		presetFiatAmount: String(amount),
		fiatCurrency: 'USD',
	});
	return `https://pay.coinbase.com/buy/select-asset?${params}`;
}

/**
 * Fallback: the asset's Coinbase price page.  The user lands on Coinbase,
 * selects their amount, and sends the asset to the address the Add funds
 * overlay is already showing them.  Still real; not as frictionless as the
 * hosted onramp but 100% functional without CDP credentials.
 *
 * @param {string} asset  normalized asset key (a key of ASSETS)
 * @returns {string}
 */
function buildCoinbaseFallbackUrl(asset) {
	return ASSETS[asset].fallbackUrl;
}

async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'GET only');

	// Every configured call mints a session token against CDP, so an unauthenticated
	// caller must not be able to drive that upstream at will.  Generous enough that
	// a user reopening the overlay and switching assets never trips it.
	const rl = await limits.onrampLinkIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
	const address = url.searchParams.get('address') || '';
	const amountRaw = url.searchParams.get('amount');
	const amount = Math.max(
		MIN_AMOUNT_USD,
		Math.min(MAX_AMOUNT_USD, Number(amountRaw) || DEFAULT_AMOUNT_USD),
	);
	const assetRaw = (url.searchParams.get('asset') || DEFAULT_ASSET).toUpperCase();
	const asset = Object.hasOwn(ASSETS, assetRaw) ? assetRaw : DEFAULT_ASSET;

	if (!isValidSolanaAddress(address)) {
		return error(res, 400, 'invalid_address', 'address must be a valid Solana public key');
	}

	let onrampUrl = buildCoinbaseFallbackUrl(asset);
	let mode = 'coinbase-fallback';

	if (onrampConfigured()) {
		try {
			const sessionToken = await createOnrampSessionToken({
				address,
				blockchains: [SOLANA_BLOCKCHAIN],
				assets: [ASSETS[asset].ticker],
				clientIp: onrampClientIp(req),
			});
			onrampUrl = buildCoinbaseOnrampUrl(sessionToken, ASSETS[asset].ticker, amount);
			mode = 'coinbase-onramp';
		} catch (err) {
			// Coinbase being down or the key being rotated must not take "Add funds"
			// down with it: log it and hand back the keyless path, which still works.
			reportServerError(err, {
				code: err?.code || 'onramp_session_token',
				status: err?.status || 502,
				context: { asset },
			});
		}
	}

	return json(res, 200, {
		url: onrampUrl,
		mode,
		address,
		amount,
		asset,
	});
}

export default wrap(handler);
