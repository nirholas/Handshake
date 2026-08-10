// GET /api/cosmetics/earnings?creator=<solanaWallet>
//
// Real, settled cosmetic creator earnings (R25) for a creator wallet: lifetime +
// 30-day totals, paid vs. pending, per-coin and per-cosmetic breakdowns, and recent
// sales. Reads the settled-sale ledger — never estimated. Powers the creator
// earnings view in the dashboard. Public read keyed on the wallet (the numbers are
// derived from public on-chain settlements); no secrets are exposed.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { creatorEarnings, isWallet } from '../_lib/cosmetics-economy.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const creator = String(url.searchParams.get('creator') || '').trim();
	if (!isWallet(creator)) {
		return error(res, 400, 'creator_required', 'query parameter "creator" must be a Solana wallet address');
	}

	// A creator with no sales yet already reads back as zeroed totals from the
	// ledger, not a 404, so the dashboard renders the designed empty state.
	// A read FAILURE is a different thing entirely and must not be flattened into
	// the same zeros: telling a creator they earned nothing because the ledger was
	// unreachable is fabricated financial data. Surface it as a retryable 503 so
	// the dashboard shows its error state instead of a wrong balance.
	let earnings;
	try {
		earnings = await creatorEarnings(creator);
	} catch (err) {
		console.warn('[cosmetics/earnings] read failed:', err?.message);
		return error(res, 503, 'ledger_unavailable',
			'the cosmetic sales ledger is temporarily unreachable, retry in a moment');
	}

	return json(res, 200, earnings, { 'cache-control': 'no-store' });
});
