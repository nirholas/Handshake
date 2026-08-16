// POST /api/rider/webhook
//
// Helius enhanced-transaction webhook for the rider vault. Every $THREE transfer
// of at least REQUIRED_AMOUNT into RIDER_VAULT_ADDRESS grants the sending wallet
// a rider pass, which /api/rider/check reads back out of rider_passes.
//
// Auth: Helius attaches a fixed `Authorization` header configured on the webhook.
// It is compared in constant time against RIDER_HELIUS_WEBHOOK_SECRET, and the
// endpoint FAILS CLOSED when that secret is unset: rows written here grant paid
// access, so it must never accept an anonymous write. (Previous form:
// `if (secret && ...)`, which silently accepted anything.)

import { sql } from '../_lib/db.js';
import { json, method, wrap, error, readJson } from '../_lib/http.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { env } from '../_lib/env.js';
import { qualifyingPayments, REQUIRED_AMOUNT } from '../_lib/rider.js';
import { TOKEN_MINT as THREE_MINT } from '../_lib/token/config.js';

export default wrap(async (req, res) => {
	if (!method(req, res, ['POST'])) return;

	const secret = env.RIDER_HELIUS_WEBHOOK_SECRET;
	if (!secret) return error(res, 503, 'not_configured', 'rider webhook secret not set');
	if (!constantTimeEquals(req.headers.authorization || '', `Bearer ${secret}`)) {
		return error(res, 401, 'unauthorized', 'invalid webhook secret');
	}

	const vaultAddress = env.RIDER_VAULT_ADDRESS;
	if (!vaultAddress) return error(res, 503, 'not_configured', 'rider vault address not set');

	const txns = await readJson(req);
	if (!Array.isArray(txns)) {
		return error(res, 400, 'validation_error', 'body must be an array of Helius transactions');
	}

	const payments = qualifyingPayments(txns, {
		vaultAddress,
		mint: THREE_MINT,
		requiredAmount: REQUIRED_AMOUNT,
	});

	for (const p of payments) {
		await sql`
			insert into rider_passes (wallet_address, amount_paid, tx_signature)
			values (${p.wallet}, ${p.amount}, ${p.signature})
			on conflict (wallet_address) do update
			  set amount_paid  = excluded.amount_paid,
			      tx_signature = excluded.tx_signature
		`;
	}

	return json(res, 200, { ok: true, granted: payments.length });
});
