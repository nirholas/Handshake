import { timingSafeEqual } from 'node:crypto';
import { sql } from '../_lib/db.js';
import { json, method, wrap, error, readJson } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { TOKEN_MINT as THREE_MINT } from '../_lib/token/config.js';
const REQUIRED_AMOUNT = 8000;

function safeEqual(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export default wrap(async (req, res) => {
	if (!method(req, res, ['POST'])) return;

	// Fail closed: when the webhook secret isn't configured this endpoint must
	// not accept anonymous writes — it inserts rider_passes rows that grant
	// access. (Previous form: `if (secret && ...)` silently accepted anything.)
	const secret = env.RIDER_HELIUS_WEBHOOK_SECRET;
	if (!secret) return error(res, 503, 'not_configured', 'rider webhook secret not set');
	const presented = String(req.headers.authorization || '');
	if (!safeEqual(presented, `Bearer ${secret}`)) {
		return error(res, 401, 'unauthorized', 'invalid webhook secret');
	}

	const vaultAddress = env.RIDER_VAULT_ADDRESS;
	if (!vaultAddress) return json(res, 200, { ok: true });

	const txns = await readJson(req);
	if (!Array.isArray(txns)) return json(res, 200, { ok: true });

	for (const txn of txns) {
		if (txn.transactionError) continue;
		for (const t of txn.tokenTransfers ?? []) {
			if (
				t.mint === THREE_MINT &&
				t.toUserAccount === vaultAddress &&
				Number(t.tokenAmount) >= REQUIRED_AMOUNT &&
				t.fromUserAccount
			) {
				await sql`
					insert into rider_passes (wallet_address, amount_paid, tx_signature)
					values (${t.fromUserAccount}, ${t.tokenAmount}, ${txn.signature})
					on conflict (wallet_address) do update
					  set amount_paid  = excluded.amount_paid,
					      tx_signature = excluded.tx_signature
				`;
			}
		}
	}

	return json(res, 200, { ok: true });
});
