#!/usr/bin/env node
// scripts/x402-milestone-stats.mjs
//
// Ground-truth milestone figures for the x402 economy, read straight from the
// facilitator's own logs. These numbers get published (marketing video, holder
// changelog, X thread), so every figure here has to be defensible from a single
// query someone else can re-run.
//
// What each figure means, and which table proves it:
//
//   payments settled     x402_self_facilitator_log WHERE action='settle' AND ok
//                        One row per settlement our facilitator actually
//                        completed. Verifies are excluded: a verify is a quote,
//                        not a payment.
//
//   on-chain txs         COUNT(DISTINCT tx_sig) over those same rows. Lower than
//                        the settle count whenever settles share a signature
//                        (batched) or a settle succeeded without recording one.
//                        Never claim this equals the payment count.
//
//   distinct endpoints   COUNT(DISTINCT endpoint) across the ring ledger and the
//                        autonomous log. This is the "how many different things
//                        got paid for" number.
//
//   window               min/max ts over the settle rows, in whole days.
//
//   networks             Proves the "all on Solana mainnet" claim rather than
//                        assuming it. Any non-solana network shows up here.
//
// Usage:
//   node scripts/x402-milestone-stats.mjs           # human-readable table
//   node scripts/x402-milestone-stats.mjs --json    # machine-readable
//
// Read-only. Safe to run against production at any time.

import { sql } from '../api/_lib/db.js';

const asJson = process.argv.includes('--json');

function n(v) {
	return Number(v ?? 0);
}

function fmt(v) {
	return n(v).toLocaleString('en-US');
}

async function collect() {
	const [settles] = await sql`
		SELECT
			COUNT(*)                                             AS settle_rows,
			COUNT(DISTINCT tx_sig) FILTER (WHERE tx_sig IS NOT NULL) AS onchain_txs,
			COUNT(*) FILTER (WHERE tx_sig IS NULL)               AS settles_without_sig,
			COUNT(DISTINCT payer)                                AS distinct_payers,
			COUNT(DISTINCT pay_to)                               AS distinct_recipients,
			MIN(ts)                                              AS first_ts,
			MAX(ts)                                              AS last_ts,
			COALESCE(SUM(amount_atomic), 0)                      AS amount_atomic_total,
			COALESCE(SUM(fee_lamports), 0)                       AS fee_lamports_total
		FROM x402_self_facilitator_log
		WHERE action = 'settle' AND ok = true
	`;

	const [verifies] = await sql`
		SELECT COUNT(*) AS verify_rows
		FROM x402_self_facilitator_log
		WHERE action = 'verify' AND ok = true
	`;

	const networks = await sql`
		SELECT COALESCE(network, '(null)') AS network, COUNT(*) AS rows
		FROM x402_self_facilitator_log
		WHERE action = 'settle' AND ok = true
		GROUP BY 1
		ORDER BY 2 DESC
	`;

	const [ledgerEndpoints] = await sql`
		SELECT COUNT(DISTINCT endpoint) AS endpoints
		FROM x402_ring_ledger
		WHERE endpoint IS NOT NULL AND kind = 'settle'
	`;

	const [autoEndpoints] = await sql`
		SELECT
			COUNT(DISTINCT endpoint_url)                       AS endpoints,
			COUNT(DISTINCT service_name)                       AS services,
			COUNT(*) FILTER (WHERE success)                    AS successful_calls,
			COUNT(DISTINCT tx_signature) FILTER (WHERE tx_signature IS NOT NULL) AS onchain_txs
		FROM x402_autonomous_log
		WHERE success = true
	`;

	const [unionEndpoints] = await sql`
		SELECT COUNT(*) AS endpoints FROM (
			SELECT DISTINCT endpoint AS e FROM x402_ring_ledger
			  WHERE endpoint IS NOT NULL AND kind = 'settle'
			UNION
			SELECT DISTINCT endpoint_url AS e FROM x402_autonomous_log
			  WHERE success = true
		) AS combined
	`;

	const first = settles.first_ts ? new Date(settles.first_ts) : null;
	const last = settles.last_ts ? new Date(settles.last_ts) : null;
	const spanDays =
		first && last ? (last.getTime() - first.getTime()) / 86_400_000 : 0;

	const rowsSharingSig = n(settles.settle_rows) - n(settles.onchain_txs) - n(settles.settles_without_sig);

	return {
		paymentsSettled: n(settles.settle_rows),
		// Settle rows that share a tx signature with another row. Confirmed on
		// mainnet 2026-07-28: sampled transactions carry exactly ONE token transfer
		// yet up to 9 settle rows (9 distinct idempotency keys, seconds apart) are
		// logged against them. So these rows did not each settle on chain, and
		// paymentsSettled is correspondingly higher than the signature count.
		rowsSharingSig,
		rowsSharingSigPct: settles.settle_rows
			? Math.round((rowsSharingSig / n(settles.settle_rows)) * 1000) / 10
			: 0,
		verifiesOk: n(verifies.verify_rows),
		onchainTxs: n(settles.onchain_txs),
		settlesWithoutSig: n(settles.settles_without_sig),
		distinctPayers: n(settles.distinct_payers),
		distinctRecipients: n(settles.distinct_recipients),
		distinctEndpoints: n(unionEndpoints.endpoints),
		endpointsFromLedger: n(ledgerEndpoints.endpoints),
		endpointsFromAutonomousLog: n(autoEndpoints.endpoints),
		distinctServices: n(autoEndpoints.services),
		autonomousSuccessfulCalls: n(autoEndpoints.successful_calls),
		autonomousOnchainTxs: n(autoEndpoints.onchain_txs),
		amountAtomicTotal: String(settles.amount_atomic_total ?? '0'),
		feeSolTotal: n(settles.fee_lamports_total) / 1e9,
		firstTs: first ? first.toISOString() : null,
		lastTs: last ? last.toISOString() : null,
		spanDays: Math.round(spanDays * 100) / 100,
		// Floor, not ceil. A 25.06-day window is "25 days" in public copy;
		// rounding up would overstate the claim by most of a day.
		spanDaysWhole: Math.floor(spanDays),
		networks: networks.map((r) => ({ network: r.network, rows: n(r.rows) })),
	};
}

const stats = await collect();

if (asJson) {
	console.log(JSON.stringify(stats, null, 2));
} else {
	const rows = [
		['Payments settled (facilitator)', fmt(stats.paymentsSettled)],
		['On-chain txs (distinct sigs)', fmt(stats.onchainTxs)],
		['  settles with no sig recorded', fmt(stats.settlesWithoutSig)],
		['Distinct endpoints paid', fmt(stats.distinctEndpoints)],
		['  from ring ledger', fmt(stats.endpointsFromLedger)],
		['  from autonomous log', fmt(stats.endpointsFromAutonomousLog)],
		['Distinct services', fmt(stats.distinctServices)],
		['Distinct payers', fmt(stats.distinctPayers)],
		['Distinct recipients', fmt(stats.distinctRecipients)],
		['Verifies (ok)', fmt(stats.verifiesOk)],
		['Sponsor SOL burned on settles', stats.feeSolTotal.toFixed(4)],
		['First settle', stats.firstTs ?? '(none)'],
		['Last settle', stats.lastTs ?? '(none)'],
		['Span (days)', `${stats.spanDays} (${stats.spanDaysWhole} whole)`],
	];
	const width = Math.max(...rows.map((r) => r[0].length));
	console.log('\nx402 milestone figures (source: facilitator logs)\n');
	for (const [label, value] of rows) {
		console.log(`  ${label.padEnd(width)}  ${value}`);
	}
	console.log('\n  Networks on settled payments:');
	for (const net of stats.networks) {
		console.log(`    ${net.network.padEnd(22)} ${fmt(net.rows)}`);
	}

	if (stats.rowsSharingSig > 0) {
		console.log(
			`\n  WARNING: ${fmt(stats.rowsSharingSig)} settle rows (${stats.rowsSharingSigPct}%) share a\n` +
				'  tx signature with another row. Sampled on mainnet, those transactions carry\n' +
				'  exactly one token transfer each, so those rows did not settle independently.\n' +
				`  Publishable as "payments settled" (${fmt(stats.paymentsSettled)}); do NOT publish it as\n` +
				`  on-chain transactions — that figure is ${fmt(stats.onchainTxs)}.`,
		);
	}
	console.log('');
}
