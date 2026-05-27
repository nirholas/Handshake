// Durable log of x402 offer-receipt artifacts (USE-17).
//
// Every signed receipt we emit on a successful payment gets written here so:
//   1. Buyers can later replay them via /api/x402/my-receipts (proof of past
//      purchase even if they lost the original PAYMENT-RESPONSE header).
//   2. Operators have an audit trail for dispute resolution.
//   3. Reputation systems can pull on demand instead of having to capture
//      every receipt at issue time.
//
// Backed by Postgres (Neon) — see api/_lib/migrations/2026-05-24-x402-receipts.sql.
// Writes are fire-and-forget from the paid-endpoint hot path: a Neon hiccup
// must not surface as a 5xx on a paid response that already settled on-chain.

import { sql } from '../db.js';

import { extractReceiptPayload } from '@x402/extensions';

/** Normalize a payer address for lookup: EVM → lowercase, Solana stays as-is. */
function normalisePayer(payer) {
	if (!payer) return null;
	const s = String(payer).trim();
	return s.startsWith('0x') ? s.toLowerCase() : s;
}

/**
 * Persist a signed receipt. Returns nothing — caller does not await.
 *
 * @param {object} args
 * @param {string} args.resourceUrl
 * @param {object} args.signedReceipt
 * @param {{ payer?: string, network?: string, transaction?: string }} args.settled
 */
export function recordReceipt({ resourceUrl, signedReceipt, settled }) {
	if (!signedReceipt) return;
	const payer = normalisePayer(settled?.payer);
	if (!payer) return;
	const format = signedReceipt.format;
	let payload;
	try {
		payload = extractReceiptPayload(signedReceipt);
	} catch (err) {
		console.error(
			`[x402-receipt-log] could not extract payload for storage: ${err.message}`,
		);
		return;
	}
	const network = payload.network || settled?.network || null;
	const transaction = payload.transaction || null;
	sql`
		insert into x402_receipts
			(payer, network, resource_url, format, receipt, transaction)
		values
			(${payer}, ${network}, ${resourceUrl}, ${format},
			 ${JSON.stringify(signedReceipt)}::jsonb, ${transaction})
	`.catch((err) => {
		console.error('[x402-receipt-log] insert failed:', err?.message || err);
	});
}

/**
 * Fetch receipts for a payer address. Used by /api/x402/my-receipts after
 * verifying a buyer-signed SIWE message proving wallet ownership.
 *
 * @param {object} args
 * @param {string} args.payer - wallet address (will be lower-cased for EVM)
 * @param {number} [args.sinceUnix] - return receipts issued >= this time (seconds)
 * @param {number} [args.limit] - clamp 1..200, default 50
 */
export async function listReceiptsForPayer({ payer, sinceUnix, limit }) {
	const normPayer = normalisePayer(payer);
	if (!normPayer) return [];
	const clampedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
	const sinceDate =
		sinceUnix && Number.isFinite(Number(sinceUnix))
			? new Date(Number(sinceUnix) * 1000)
			: new Date(0);
	const rows = await sql`
		select id, payer, network, resource_url, format, receipt, transaction, issued_at
		from x402_receipts
		where payer = ${normPayer}
		  and issued_at >= ${sinceDate.toISOString()}
		order by issued_at desc
		limit ${clampedLimit}
	`;
	return rows.map((r) => ({
		id: r.id,
		payer: r.payer,
		network: r.network,
		resourceUrl: r.resource_url,
		format: r.format,
		receipt: r.receipt,
		transaction: r.transaction,
		issuedAt: r.issued_at instanceof Date ? r.issued_at.toISOString() : r.issued_at,
	}));
}
