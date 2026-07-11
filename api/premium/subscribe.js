// POST /api/premium/subscribe — redeem a paid quote for a 30-day premium pass.
//
// body: { quote_id, tx_signature }
// →     200 { pass, api_key?, renewed }   — api_key (x402_live_…) is returned
//                                           exactly once, on first key mint
//       202 { pending: true }             — tx not confirmed yet; poll again
//       4xx { error }                     — mismatch / expired / already used
//
// Verification is against the LANDED transaction (balance delta to the
// treasury, quoted wallet among the signers) and the persisted quote — never
// client-supplied numbers. tx_signature is UNIQUE, so replays and double
// submits idempotently return the already-issued pass.

import { cors, json, error, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser } from '../_lib/auth.js';
import { verifyPassPayment, activatePass } from '../_lib/premium.js';

// A quote is redeemable for 30 minutes after creation (10-min price lock plus
// grace for slow confirmation) — the price was locked at signing time, and the
// blockhash in the built tx expires long before this window anyway.
const REDEEM_WINDOW_MS = 30 * 60_000;

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.premiumSubscribeIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => null);
	const quoteId = String(body?.quote_id || '').trim();
	const txSignature = String(body?.tx_signature || '').trim();
	if (!quoteId) return error(res, 400, 'bad_quote', 'quote_id is required');
	if (!SIG_RE.test(txSignature)) {
		return error(res, 400, 'bad_signature', 'tx_signature must be a base58 Solana signature');
	}

	// Idempotent fast path: this exact payment already produced a pass.
	const [existing] = await sql`
		select * from premium_passes where tx_signature = ${txSignature} limit 1
	`;
	if (existing) {
		return json(res, 200, { pass: existing, api_key: null, renewed: true }, { 'cache-control': 'no-store' });
	}

	const [quote] = await sql`select * from premium_quotes where id = ${quoteId} limit 1`;
	if (!quote) return error(res, 404, 'quote_not_found', 'unknown quote_id — request a fresh quote');
	if (quote.status === 'used' && quote.tx_signature !== txSignature) {
		return error(res, 409, 'quote_used', 'this quote was already redeemed with a different transaction');
	}
	if (Date.now() - new Date(quote.created_at).getTime() > REDEEM_WINDOW_MS) {
		return error(res, 410, 'quote_expired', 'quote expired — request a fresh quote and pay again');
	}

	const verdict = await verifyPassPayment(quote, txSignature);
	if (!verdict.ok) {
		if (verdict.pending) {
			return json(res, 202, { pending: true, reason: verdict.reason }, { 'cache-control': 'no-store' });
		}
		return error(res, 400, 'payment_mismatch', verdict.reason);
	}

	let userId = quote.user_id || null;
	if (!userId) {
		try {
			const user = await getSessionUser(req);
			userId = user?.id || null;
		} catch {
			userId = null;
		}
	}

	try {
		const { pass, apiKey, renewed } = await activatePass({ quote, txSignature, userId });
		return json(res, 200, { pass, api_key: apiKey, renewed }, { 'cache-control': 'no-store' });
	} catch (e) {
		return error(res, e.status || 502, e.code || 'activation_failed', e.message);
	}
});
