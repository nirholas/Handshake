/**
 * /api/webhooks/solana-pay
 * --------------------------------------------------------------
 * GET  - Solana Pay merchant discovery probe: returns { label, icon }. Wallets
 *        render both in the confirmation sheet before the buyer signs, so the
 *        icon MUST be a live absolute URL; a 404 there shows the buyer a broken
 *        merchant at the exact moment they decide whether to pay.
 * POST - Off-web confirmation path. Looks up the pending skill_purchases row
 *        by reference and runs the same on-chain verification + ledger writes
 *        as the buyer's polling /confirm endpoint via confirmSkillPurchase().
 *        Mainly useful for mobile QR flows where the merchant pings the
 *        server directly after the buyer signs in their wallet.
 *
 * Auth: Authorization: Bearer <WEBHOOK_SECRET>. The reference itself is also
 * a unique secret, so the surface is narrow; we still gate to avoid spammy
 * DoS-via-confirm probes.
 *
 * CORS: the Solana Pay spec has wallets fetch this endpoint cross-origin, so the
 * GET probe answers any origin. That is safe because the only cross-origin-
 * reachable response is the public merchant label, and the POST leg still needs
 * the bearer secret that no browser context holds.
 */
import { timingSafeEqual } from 'node:crypto';
import { sql } from '../_lib/db.js';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { confirmSkillPurchase } from '../_lib/purchase-confirm.js';

function authOk(req) {
	const secret = process.env.WEBHOOK_SECRET;
	if (!secret) return false;
	const header = req.headers?.authorization || '';
	// Constant-time compare so the static webhook secret can't be recovered via a
	// timing side-channel (mirrors api/webhooks/replicate.js).
	const expected = Buffer.from(`Bearer ${secret}`);
	const provided = Buffer.from(header);
	return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'GET') {
		return json(res, 200, {
			label: 'three.ws Skill Marketplace',
			// /logo.png is the real served asset. This pointed at /assets/logo.png,
			// which has never existed and answers 404 with the SPA HTML shell.
			icon: 'https://three.ws/logo.png',
		});
	}

	if (!authOk(req)) return error(res, 401, 'unauthorized', 'invalid or missing webhook secret');

	const body = await readJson(req).catch(() => null);
	const reference = typeof body?.reference === 'string' ? body.reference.trim() : null;
	if (!reference) return error(res, 400, 'validation_error', 'reference required');

	// Solana settles by scanning the chain for the reference and ignores this. An
	// EVM row has no on-chain reference to scan, so without the settlement hash the
	// confirm can only ever answer 'pending' — the same tx_hash the buyer's
	// /confirm endpoint takes, accepted here so an EVM purchase routed through the
	// webhook is not a permanently unconfirmable dead path.
	const rawTxHash = body?.tx_hash ?? body?.txHash;
	const txHash = typeof rawTxHash === 'string' && rawTxHash.trim() ? rawTxHash.trim() : null;

	const [pur] = await sql`
		SELECT sp.*, COALESCE(asp.mint_decimals, 6) AS mint_decimals
		FROM skill_purchases sp
		LEFT JOIN agent_skill_prices asp
		       ON asp.agent_id = sp.agent_id AND asp.skill = sp.skill
		WHERE sp.reference = ${reference}
		LIMIT 1
	`;
	if (!pur) return error(res, 404, 'not_found', 'purchase not found');

	// A confirm fault (RPC outage, unconfigured payout wallet, DB down) is not
	// something this handler can resolve, and swallowing it into a hand-rolled 500
	// used to hide it: wrap() is what captures the exception to Sentry, degrades a
	// database outage to a throttled 503 instead of an error-tracker flood, and
	// scrubs the message before it reaches the caller. Let it through so a broken
	// payment path is visible to ops rather than silently 500ing per delivery.
	const result = await confirmSkillPurchase(pur, { txHash });

	if (result.status === 'pending') return json(res, 200, { data: { status: 'pending' } });
	if (result.status === 'expired') return error(res, 410, 'expired', 'purchase expired');
	if (result.status === 'mismatch') return error(res, 409, 'transfer_mismatch', result.message);
	if (result.status === 'tipped') {
		return error(res, 409, 'transfer_mismatch', result.message, {
			status: 'tipped',
			tipped_amount: result.tipped_amount,
			tx_signature: result.tx_signature,
		});
	}
	return json(res, 200, { data: { status: 'confirmed', tx_signature: result.tx_signature } });
});
