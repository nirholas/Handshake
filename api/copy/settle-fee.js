/**
 * Copy-trading performance-fee settlement.
 *
 *   POST /api/copy/settle-fee  { subscription_id }            → CHARGE: issue a $THREE quote
 *                              { leader_agent_id, network }     for the fee owed on the copier's
 *                                                               realized profit above the HWM.
 *   POST /api/copy/settle-fee  { quoteToken, tx_signature }   → SETTLE: verify the on-chain $THREE
 *                                                               split and ratchet the high-water mark.
 *
 * The fee is charged ONLY on realized profit above the subscription's high-water
 * mark, settled in $THREE under the `copy_performance_fee` split policy (leader
 * 80% / treasury 15% / holders 5%). The leader is paid directly on-chain by the
 * split — settlement just records it and ratchets the HWM so the same profit is
 * never billed twice. Auth + CSRF (cookie sessions); agents may settle via bearer.
 */

import { cors, json, error, method, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { sql } from '../_lib/db.js';
import { subscriptionOwed } from '../_lib/copy-earnings.js';
import { issueQuote } from '../_lib/token/quote.js';
import { verifyAndSettlePayment } from '../_lib/token/payments.js';
import { solUsdPrice } from '../_lib/avatar-wallet.js';
import { isUuid } from '../_lib/validate.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

async function requireUser(req, res) {
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) { error(res, 401, 'unauthorized', 'sign in required'); return null; }
	return { userId: session?.id ?? bearer.userId, viaSession: !!session };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await requireUser(req, res);
	if (!auth) return;
	const { userId } = auth;
	if (auth.viaSession && !(await requireCsrf(req, res, userId))) return;

	const body = await readJson(req).catch(() => null);
	if (!body || typeof body !== 'object') return error(res, 400, 'bad_request', 'JSON body required');

	// --- SETTLE phase ---
	if (body.quoteToken && body.tx_signature) {
		let result;
		try {
			result = await verifyAndSettlePayment({
				quoteToken: body.quoteToken,
				txSignature: String(body.tx_signature).trim(),
				userId,
				network: NETWORKS.has(body.network) ? body.network : undefined,
			});
		} catch (e) {
			return error(res, e.status || 402, e.code || 'settle_failed', e.message || 'settlement failed');
		}
		// Ratchet the HWM to the cumulative profit the quote was bound to (refId).
		const [subId, cumulativeStr] = String(result.quote?.refId || '').split('|');
		const cumulative = Number(cumulativeStr);
		if (isUuid(subId) && Number.isFinite(cumulative)) {
			await sql`
				update copy_subscriptions
				set high_water_mark_sol = greatest(high_water_mark_sol, ${cumulative}), updated_at = now()
				where id = ${subId} and copier_user_id = ${userId}
			`;
		}
		return json(res, 200, { ok: true, paid: true, payment_id: result.payment_id });
	}

	// --- CHARGE phase ---
	let sub;
	if (body.subscription_id) {
		if (!isUuid(body.subscription_id)) return error(res, 400, 'invalid_id', 'subscription_id must be a UUID');
		[sub] = await sql`select * from copy_subscriptions where id = ${body.subscription_id} and copier_user_id = ${userId} limit 1`;
	} else {
		const leaderId = String(body.leader_agent_id || '').trim();
		const network = NETWORKS.has(body.network) ? body.network : 'mainnet';
		if (!isUuid(leaderId)) return error(res, 400, 'invalid_leader', 'leader_agent_id must be a UUID');
		[sub] = await sql`
			select * from copy_subscriptions
			where leader_agent_id = ${leaderId} and copier_user_id = ${userId} and network = ${network} limit 1
		`;
	}
	if (!sub) return error(res, 404, 'not_found', 'No such subscription.');

	const owed = await subscriptionOwed(sub);
	if (owed.fee_sol <= 0) {
		return json(res, 200, { ok: true, paid: false, nothing_to_settle: true, owed });
	}
	if (!sub.leader_wallet) {
		return error(res, 409, 'leader_wallet_unknown', 'The leader has no recorded payout wallet yet.');
	}

	let solUsd;
	try { solUsd = await solUsdPrice(); } catch { return error(res, 503, 'price_unavailable', 'SOL price unavailable; try again shortly.'); }
	const usd = owed.fee_sol * solUsd;

	const quote = await issueQuote({
		purpose: 'copy_performance_fee',
		usd,
		splitPolicy: 'copy_performance_fee',
		sellerWallet: sub.leader_wallet,
		network: sub.network,
		refType: 'copy_perf_fee',
		refId: `${sub.id}|${owed.cumulative_profit_sol}`,
	});

	return json(res, 200, {
		ok: true,
		paid: false,
		owed,
		sol_usd: solUsd,
		fee_usd: Number(usd.toFixed(4)),
		quote: quote.token,
		memo: quote.quote.nonce,
		mint: quote.quote.mint,
		legs: quote.quote.legs,
		expires_at: quote.expiresAt,
	});
});
