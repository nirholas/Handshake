// api/_lib/x402/settle-credit.js
//
// The settle CREDIT gate: one on-chain signature settles AT MOST one payment.
//
// Why this exists (measured on mainnet 2026-07-28): Ed25519 signatures are
// deterministic, so two ring payments with the same payer/amount/recipient,
// built against one shared tick blockhash with a colliding fee nonce, compile
// to byte-identical transactions with the SAME signature. The first broadcast
// lands; every later one hits "already processed" and settleRingPayment's
// replay-recovery branch reports success — it cannot tell a retry of THIS
// payment from a different payment reusing the signature. Result: 12,674 of
// 59,271 logged settles (21.4%) shared a signature with another settle, i.e.
// services were delivered without their own settlement (76 USDC overstated).
//
// The fix is to make crediting explicit and atomic. A successful settle is only
// credited if this module can INSERT the ok=true row for its tx signature:
//
//   - No prior credit for the signature → insert wins → payment is credited.
//   - Prior credit with the SAME idempotency key → this is a genuine retry of
//     the already-credited payment → idempotent success, no second credit.
//   - Prior credit with a DIFFERENT (or absent) key → refusal:
//     `signature_already_settled`. The service must not be delivered again.
//
// Concurrency: the SELECT pre-check is advisory; the race-proof arbiter is the
// partial unique index on (tx_sig) WHERE action='settle' AND ok AND credit_gated
// (migration 20260729000000) plus INSERT … ON CONFLICT DO NOTHING RETURNING id.
// Whichever request's INSERT returns a row owns the credit; the loser re-reads
// the winner and classifies itself as idempotent replay or refusal.
//
// Every row this module writes carries credit_gated = true. That marker — not a
// timestamp — is what scopes the uniqueness constraint, so the pre-fix history
// (which contains real duplicates, published and analysed) is excluded by
// construction and the constraint begins exactly when this code starts serving.
//
// DB unavailability fails CLOSED (`settle_credit_unavailable`). A refused
// settle is retryable: once the DB is back, the retry broadcasts, hits
// already-processed, finds no prior credit row, and claims it — the buyer is
// made whole without ever opening the replay window during an outage.

// Insert the audit row for a NON-credit outcome (refusal / idempotent replay).
// Best-effort like the endpoint's logOp: a trail-write hiccup must not turn an
// already-decided outcome into a 5xx.
function logOutcome(sql, row, reason) {
	return sql`
		INSERT INTO x402_self_facilitator_log
			(action, network, payer, pay_to, mint, amount_atomic, tx_sig,
			 fee_lamports, ok, reject_reason, idempotency_key, fee_payer, credit_gated)
		VALUES
			('settle', ${row.network || null}, ${row.payer || null},
			 ${row.payTo || null}, ${row.mint || null}, ${row.amountAtomic ?? null},
			 ${row.txSig}, ${row.feeLamports ?? null}, false,
			 ${reason}, ${row.idempotencyKey || null}, ${row.feePayer || null}, true)
	`.catch((err) => console.error('[settle-credit] outcome log failed', err?.message || err));
}

// Only GATED rows can own a signature. Pre-fix history carries credit_gated=false
// and must not make a fresh, legitimate payment look like a duplicate.
async function priorCredit(sql, txSig) {
	const rows = await sql`
		SELECT id, idempotency_key
		FROM x402_self_facilitator_log
		WHERE action = 'settle' AND ok = true AND credit_gated = true AND tx_sig = ${txSig}
		LIMIT 1
	`;
	return rows?.[0] || null;
}

function classify(row, winner) {
	const sameKey =
		row.idempotencyKey != null &&
		winner?.idempotency_key != null &&
		winner.idempotency_key === row.idempotencyKey;
	return sameKey
		? { granted: false, idempotentReplay: true, reason: 'idempotent_replay' }
		: { granted: false, idempotentReplay: false, reason: 'signature_already_settled' };
}

// Claim the settlement credit for `row.txSig`. Returns:
//   { granted: true }                                  — credited; audit row written
//   { granted: false, idempotentReplay: true }         — same payment retried; respond
//                                                        success but do NOT re-deliver
//                                                        side effects (fee metering)
//   { granted: false, idempotentReplay: false, reason } — different payment reusing the
//                                                        signature, or DB down; refuse
export async function claimSettleCredit({ sql, row }) {
	// A success with no signature cannot be gated (nothing to key on) and cannot
	// double-credit either — the broadcast path always yields a signature, so this
	// is a defensive branch, recorded as-is.
	if (!row.txSig) {
		await logOutcome(sql, { ...row, txSig: null }, null);
		return { granted: true };
	}

	try {
		// Advisory pre-check: catches the common replay (seconds apart) with one
		// cheap indexed read, before attempting the claim.
		const prior = await priorCredit(sql, row.txSig);
		if (prior) {
			const verdict = classify(row, prior);
			await logOutcome(sql, row, verdict.reason);
			return verdict;
		}

		// The claim. ON CONFLICT DO NOTHING keys on the partial unique index
		// (tx_sig WHERE action='settle' AND ok) — if another request credited this
		// signature between the pre-check and here, we get zero rows back.
		const ins = await sql`
			INSERT INTO x402_self_facilitator_log
				(action, network, payer, pay_to, mint, amount_atomic, tx_sig,
				 fee_lamports, ok, reject_reason, idempotency_key, fee_payer, credit_gated)
			VALUES
				('settle', ${row.network || null}, ${row.payer || null},
				 ${row.payTo || null}, ${row.mint || null}, ${row.amountAtomic ?? null},
				 ${row.txSig}, ${row.feeLamports ?? null}, true,
				 ${null}, ${row.idempotencyKey || null}, ${row.feePayer || null}, true)
			ON CONFLICT DO NOTHING
			RETURNING id
		`;
		if (ins?.length) return { granted: true };

		// Lost the race — classify against the winner.
		const winner = await priorCredit(sql, row.txSig);
		const verdict = classify(row, winner);
		await logOutcome(sql, row, verdict.reason);
		return verdict;
	} catch (err) {
		// Fail closed: without the DB we cannot prove this signature is unspent.
		console.error('[settle-credit] claim failed', err?.message || err);
		return {
			granted: false,
			idempotentReplay: false,
			reason: 'settle_credit_unavailable',
		};
	}
}
