// Rider pass — shared policy for the /api/rider/* surface.
//
// A rider pass is granted two ways, and every reader has to honor both:
//   1. Holding $THREE in the wallet (a holder pass), read on-chain.
//   2. Paying REQUIRED_AMOUNT $THREE into the rider vault, which the Helius
//      webhook records in `rider_passes`. A payer no longer holds those tokens,
//      so a balance read on its own revokes the pass the vault just sold.
//
// REQUIRED_AMOUNT used to be a literal in both info.js (the advertised price)
// and webhook.js (the accepted price). Two copies of one price is a single edit
// away from advertising a pass the webhook refuses to grant.

export const REQUIRED_AMOUNT = 8000;

/**
 * Reduce a Helius enhanced-transaction batch to the vault payments that earn a
 * pass, one entry per paying wallet.
 *
 * Helius delivers an array of enhanced transactions, each with a `tokenTransfers`
 * array. A single transaction can carry $THREE from more than one wallet (a batch
 * or aggregator transfer), and a wallet can appear in several transfers of the
 * same transaction, so the qualifying legs are summed per wallet per transaction
 * before the threshold is applied. Anything else in the payload — other mints,
 * other destinations, failed transactions, transfers with no sender — is dropped.
 *
 * @param {unknown} txns Parsed webhook body.
 * @param {object} opts
 * @param {string} opts.vaultAddress Owner account that must receive the transfer.
 * @param {string} opts.mint Mint that must be transferred.
 * @param {number} [opts.requiredAmount] Minimum whole tokens per wallet per transaction.
 * @returns {Array<{ wallet: string, amount: number, signature: string }>}
 */
export function qualifyingPayments(txns, { vaultAddress, mint, requiredAmount = REQUIRED_AMOUNT }) {
	if (!Array.isArray(txns) || !vaultAddress || !mint) return [];

	// wallet -> winning payment. A wallet that pays in two transactions of one
	// batch keeps the larger payment, so the row records what actually bought the
	// pass rather than whichever leg happened to land last.
	const best = new Map();

	for (const txn of txns) {
		if (!txn || typeof txn !== 'object') continue;
		if (txn.transactionError) continue;
		const signature = typeof txn.signature === 'string' ? txn.signature : '';
		if (!signature) continue;

		const perWallet = new Map();
		for (const t of Array.isArray(txn.tokenTransfers) ? txn.tokenTransfers : []) {
			if (!t || t.mint !== mint || t.toUserAccount !== vaultAddress) continue;
			const wallet = typeof t.fromUserAccount === 'string' ? t.fromUserAccount : '';
			if (!wallet) continue;
			const amount = Number(t.tokenAmount);
			if (!Number.isFinite(amount) || amount <= 0) continue;
			perWallet.set(wallet, (perWallet.get(wallet) ?? 0) + amount);
		}

		for (const [wallet, amount] of perWallet) {
			if (amount < requiredAmount) continue;
			const prior = best.get(wallet);
			if (!prior || amount > prior.amount) best.set(wallet, { wallet, amount, signature });
		}
	}

	return [...best.values()];
}
