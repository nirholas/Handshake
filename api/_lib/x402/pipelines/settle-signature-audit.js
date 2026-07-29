// api/_lib/x402/pipelines/settle-signature-audit.js
//
// Settle Signature Audit — autonomous pipeline (self/reconciliation).
//
// The standing guard for the invariant "one on-chain signature settles at most
// one payment". Free, read-only, no payment: it is a DB reconciliation, not a
// probe.
//
// Why it exists: on 2026-07-28 an audit of the facilitator log found 12,674 of
// 59,271 ok settle rows (21.4%) sharing a tx_sig with another ok row. Sampled
// transactions on mainnet carried exactly ONE token transfer each, yet up to 9
// settle rows with 9 distinct idempotency keys were credited against them.
// Deterministic Ed25519 signatures on byte-identical ring payments meant the
// facilitator's already-processed recovery branch credited later payments off an
// earlier one's broadcast, overstating settlement by ~76 USDC.
//
// Two defences now stop that: settle-credit.js claims the credit atomically
// (one payment per signature, arbitrated by the partial unique index from
// migration 20260729000000), and pay.js widened the fee-nonce space so identical
// transactions are not built in the first place. This audit is the third leg —
// it proves those defences are actually holding in production rather than
// assuming they are, and it is the thing that would have caught the original
// defect months earlier.
//
// It reports on GATED rows only — those written by settle-credit.js. Pre-fix
// history keeps its duplicates on purpose: they are real, documented, and
// analysed by scripts/x402-milestone-stats.mjs. Scoping by the credit_gated
// marker rather than a timestamp means this reports nothing at all until the
// fix is actually serving, and never re-flags history as a regression.

import { sql } from '../../db.js';

// A single duplicate among gated rows means the gate is not holding, so the
// alert threshold is 1. There is no acceptable non-zero rate for this invariant.
const ALERT_THRESHOLD = 1;

export async function settleSignatureAudit() {
	const [totals] = await sql`
		SELECT
			COUNT(*)                                                     AS settle_rows,
			COUNT(DISTINCT tx_sig) FILTER (WHERE tx_sig IS NOT NULL)     AS distinct_sigs,
			COUNT(*) FILTER (WHERE tx_sig IS NULL)                       AS rows_without_sig
		FROM x402_self_facilitator_log
		WHERE action = 'settle' AND ok = true AND credit_gated = true
	`;

	// The offenders themselves, so an alert names the signature to investigate
	// rather than only a count.
	const offenders = await sql`
		SELECT tx_sig,
		       COUNT(*)                          AS credited_rows,
		       COUNT(DISTINCT idempotency_key)   AS distinct_keys,
		       MIN(ts)                           AS first_ts,
		       MAX(ts)                           AS last_ts
		FROM x402_self_facilitator_log
		WHERE action = 'settle' AND ok = true AND credit_gated = true AND tx_sig IS NOT NULL
		GROUP BY tx_sig
		HAVING COUNT(*) > 1
		ORDER BY COUNT(*) DESC
		LIMIT 20
	`;

	// The gate's own refusals. A healthy system may show a nonzero count here —
	// it means collisions still occur upstream and are being correctly refused,
	// which is the gate working, not failing. A sharp rise says the payer-side
	// entropy has regressed and buyers are eating avoidable retries.
	const [refusals] = await sql`
		SELECT
			COUNT(*) FILTER (WHERE reject_reason LIKE 'signature_already_settled%')  AS refused_duplicate,
			COUNT(*) FILTER (WHERE reject_reason = 'settle_credit_unavailable')      AS refused_db_down
		FROM x402_self_facilitator_log
		WHERE action = 'settle' AND ok = false AND credit_gated = true
	`;

	const settleRows = Number(totals?.settle_rows ?? 0);
	const distinctSigs = Number(totals?.distinct_sigs ?? 0);
	const rowsWithoutSig = Number(totals?.rows_without_sig ?? 0);
	const duplicateRows = Math.max(0, settleRows - distinctSigs - rowsWithoutSig);

	const healthy = duplicateRows < ALERT_THRESHOLD;

	const summary = healthy
		? `settle-signature-audit OK — ${settleRows.toLocaleString('en-US')} gated settles, ` +
			`${distinctSigs.toLocaleString('en-US')} distinct signatures, zero duplicates. ` +
			`Gate refusals: ${Number(refusals?.refused_duplicate ?? 0)} duplicate, ` +
			`${Number(refusals?.refused_db_down ?? 0)} db-unavailable.`
		: `settle-signature-audit REGRESSION — ${duplicateRows} gated settle row(s) share a ` +
			`signature. The credit gate (settle-credit.js) or the unique index ` +
			`(migration 20260729000000) is not holding. Offenders: ` +
			offenders.map((o) => `${String(o.tx_sig).slice(0, 16)}…×${o.credited_rows}`).join(', ');

	if (!healthy) console.error(`[settle-signature-audit] ${summary}`);

	return {
		success: true,
		free: true,
		paid: false,
		amountAtomic: 0,
		txSig: null,
		signal: {
			healthy,
			settleRows,
			distinctSigs,
			rowsWithoutSig,
			duplicateRows,
			refusedDuplicate: Number(refusals?.refused_duplicate ?? 0),
			refusedDbUnavailable: Number(refusals?.refused_db_down ?? 0),
			offenders: offenders.map((o) => ({
				txSig: o.tx_sig,
				creditedRows: Number(o.credited_rows),
				distinctKeys: Number(o.distinct_keys),
				firstTs: o.first_ts,
				lastTs: o.last_ts,
			})),
		},
		responseBody: { summary },
	};
}

export default settleSignatureAudit;
