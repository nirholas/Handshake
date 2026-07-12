// POST /api/premium/quote — lock a price and get the unsigned payment tx.
//
// body: { asset: 'THREE' | 'SOL' | 'USDC', wallet: '<base58>',
//         plan?: 'developer' | 'pro' | 'enterprise' }   (default developer)
// →     { quote: { id, asset, amount_atomics, usd_price, expires_at }, tx_base64 }
//
// The buyer signs tx_base64 in their own wallet (they are the fee payer),
// sends it, then POSTs the signature to /api/premium/subscribe. The quote
// freezes the oracle price for 10 minutes so verification compares the landed
// transaction against this exact number.

import { cors, json, error, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser } from '../_lib/auth.js';
import { createQuote } from '../_lib/premium.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.premiumQuoteIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => null);
	const asset = String(body?.asset || '').toUpperCase();
	const wallet = String(body?.wallet || '').trim();
	const planId = String(body?.plan || 'developer').toLowerCase();
	if (!['THREE', 'SOL', 'USDC'].includes(asset)) {
		return error(res, 400, 'bad_asset', 'asset must be THREE, SOL, or USDC');
	}

	// Session is optional — a raw-API buyer quotes with just a wallet; a
	// dashboard buyer gets the pass linked to their account for key management.
	let userId = null;
	try {
		const user = await getSessionUser(req);
		userId = user?.id || null;
	} catch {
		userId = null;
	}

	try {
		const { quote, tx_base64 } = await createQuote({ wallet, asset, planId, userId });
		return json(res, 200, { quote, tx_base64 }, { 'cache-control': 'no-store' });
	} catch (e) {
		return error(res, e.status || 502, e.code || 'quote_failed', e.message);
	}
});
