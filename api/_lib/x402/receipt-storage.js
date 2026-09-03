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
import { clampInt } from '../http-params.js';

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
 * The signed artifact is stored verbatim, but the row also records settlement
 * facts the artifact deliberately omits: the transaction hash (dropped from the
 * payload when the endpoint declares includeTxHash=false per spec §5.2) and the
 * amount/asset (never part of a receipt payload at all). Those are our own
 * audit trail, so the wire format and its privacy properties are unchanged;
 * /api/x402/my-receipts only ever returns them to the wallet that signed for
 * its own receipts.
 *
 * @param {object} args
 * @param {string} args.resourceUrl
 * @param {object} args.signedReceipt
 * @param {{ payer?: string, network?: string, transaction?: string }} args.settled
 * @param {{ amountAtomics?: string|number|null, asset?: string|null }} [args.payment]
 */
export function recordReceipt({ resourceUrl, signedReceipt, settled, payment }) {
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
	// The payload's transaction is absent whenever includeTxHash is false; the
	// settle response still carries it, and the buyer is entitled to their own.
	const transaction = payload.transaction || settled?.transaction || null;
	const amountAtomics =
		payment?.amountAtomics == null ? null : String(payment.amountAtomics);
	const asset = payment?.asset || null;
	sql`
		insert into x402_receipts
			(payer, network, resource_url, format, receipt, transaction, amount_atomics, asset)
		values
			(${payer}, ${network}, ${resourceUrl}, ${format},
			 ${JSON.stringify(signedReceipt)}::jsonb, ${transaction},
			 ${amountAtomics}, ${asset})
	`.catch((err) => {
		console.error('[x402-receipt-log] insert failed:', err?.message || err);
	});
}

/** ISO string for a timestamptz that may arrive as a Date or a string. */
function isoOf(value) {
	return value instanceof Date ? value.toISOString() : value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The keyset cursor is the last row's id, and the boundary timestamp is looked
 * up from that row inside the query.
 *
 * Carrying the timestamp in the cursor instead is the obvious design and it is
 * wrong: `issued_at` is a timestamptz with microsecond precision, JavaScript
 * Dates hold milliseconds, so a client-echoed ISO cursor rounds the boundary
 * DOWN and every row inside the truncated microsecond is skipped. Measured on
 * the live table, that dropped a receipt at the page-1/page-2 seam (the busiest
 * single second there holds 60 receipts, so same-timestamp ties are routine,
 * not theoretical). Resolving the boundary server-side from the row itself
 * compares at full precision.
 */
export function encodeReceiptCursor(row) {
	return row?.id ? String(row.id) : null;
}

export function decodeReceiptCursor(cursor) {
	if (!cursor) return null;
	const id = String(cursor).trim();
	return UUID_RE.test(id) ? id : null;
}

/**
 * Fetch receipts for a payer address. Used by /api/x402/my-receipts after
 * verifying a buyer-signed SIWE message proving wallet ownership.
 *
 * Newest first. Pass the previous page's `nextCursor` to walk backwards
 * through the whole history rather than seeing only the newest `limit` rows.
 *
 * @param {object} args
 * @param {string} args.payer - wallet address (will be lower-cased for EVM)
 * @param {number} [args.sinceUnix] - return receipts issued >= this time (seconds)
 * @param {string} [args.cursor] - opaque keyset cursor from a previous page
 * @param {number} [args.limit] - clamp 1..200, default 50
 * @returns {Promise<{receipts: object[], nextCursor: string|null}>}
 */
export async function listReceiptPage({ payer, sinceUnix, cursor, limit }) {
	const normPayer = normalisePayer(payer);
	if (!normPayer) return { receipts: [], nextCursor: null };
	const clampedLimit = clampInt(limit, { max: 200, fallback: 50 });
	const sinceDate =
		sinceUnix && Number.isFinite(Number(sinceUnix))
			? new Date(Number(sinceUnix) * 1000)
			: new Date(0);
	const after = decodeReceiptCursor(cursor);
	// A cursor that is not a well-formed id is a client bug, not a reason to
	// silently restart from the newest page and repeat rows the caller has.
	if (cursor && !after) return { receipts: [], nextCursor: null };
	// One extra row decides hasMore without a second round trip.
	const probeLimit = clampedLimit + 1;
	const rows = after
		? await sql`
			select id, payer, network, resource_url, format, receipt, transaction,
			       amount_atomics, asset, issued_at
			from x402_receipts
			where payer = ${normPayer}
			  and issued_at >= ${sinceDate.toISOString()}
			  and (issued_at, id) < (
			      select issued_at, id from x402_receipts
			      where id = ${after}::uuid and payer = ${normPayer}
			  )
			order by issued_at desc, id desc
			limit ${probeLimit}
		`
		: await sql`
			select id, payer, network, resource_url, format, receipt, transaction,
			       amount_atomics, asset, issued_at
			from x402_receipts
			where payer = ${normPayer}
			  and issued_at >= ${sinceDate.toISOString()}
			order by issued_at desc, id desc
			limit ${probeLimit}
		`;
	const hasMore = rows.length > clampedLimit;
	const page = hasMore ? rows.slice(0, clampedLimit) : rows;
	const receipts = page.map((r) => ({
		id: r.id,
		payer: r.payer,
		network: r.network,
		resourceUrl: r.resource_url,
		format: r.format,
		receipt: r.receipt,
		transaction: r.transaction,
		amountAtomics: r.amount_atomics ?? null,
		asset: r.asset ?? null,
		issuedAt: isoOf(r.issued_at),
	}));
	return {
		receipts,
		nextCursor: hasMore ? encodeReceiptCursor(receipts.at(-1)) : null,
	};
}

/**
 * Fetch receipts for a payer address (first page only).
 *
 * Retained as the simple shape for callers that want the newest N rows and
 * nothing else. Anything that must show a payer their WHOLE history should
 * use listReceiptPage() and follow `nextCursor`.
 *
 * @param {object} args - same as listReceiptPage
 */
export async function listReceiptsForPayer({ payer, sinceUnix, limit }) {
	const { receipts } = await listReceiptPage({ payer, sinceUnix, limit });
	return receipts;
}

/**
 * Account-wide totals for one payer, independent of the page window.
 *
 * The vault's KPI strip used to be computed from the loaded page, so a wallet
 * with 60k receipts was told it had 200 and shown the spend of its newest 200
 * only. These aggregates ride the same (payer, issued_at desc) index as the
 * page query and answer for the entire history.
 *
 * Amounts stay per-asset and atomic: different settlement assets have
 * different scales, and summing them into one number server-side would bake in
 * a conversion we have no business inventing.
 *
 * @param {object} args
 * @param {string} args.payer
 * @param {number} [args.sinceUnix]
 * @returns {Promise<{total: number, endpoints: number, networks: string[],
 *   firstAt: string|null, lastAt: string|null,
 *   spend: Array<{asset: string, count: number, atomics: string}>, unpriced: number}>}
 */
export async function summarizeReceiptsForPayer({ payer, sinceUnix }) {
	const empty = {
		total: 0,
		endpoints: 0,
		networks: [],
		firstAt: null,
		lastAt: null,
		spend: [],
		unpriced: 0,
	};
	const normPayer = normalisePayer(payer);
	if (!normPayer) return empty;
	const sinceIso = (
		sinceUnix && Number.isFinite(Number(sinceUnix))
			? new Date(Number(sinceUnix) * 1000)
			: new Date(0)
	).toISOString();
	const [totals, byAsset] = await Promise.all([
		sql`
			select count(*)::int                          as total,
			       count(distinct resource_url)::int      as endpoints,
			       coalesce(array_agg(distinct network), '{}') as networks,
			       min(issued_at)                         as first_at,
			       max(issued_at)                         as last_at,
			       count(*) filter (where amount_atomics is null)::int as unpriced
			from x402_receipts
			where payer = ${normPayer} and issued_at >= ${sinceIso}
		`,
		sql`
			select asset,
			       count(*)::int                     as n,
			       sum(amount_atomics::numeric)::text as atomics
			from x402_receipts
			where payer = ${normPayer} and issued_at >= ${sinceIso}
			  and amount_atomics is not null and asset is not null
			group by asset
			order by sum(amount_atomics::numeric) desc
		`,
	]);
	const t = totals?.[0];
	if (!t) return empty;
	return {
		total: Number(t.total) || 0,
		endpoints: Number(t.endpoints) || 0,
		networks: (t.networks || []).filter(Boolean),
		firstAt: t.first_at ? isoOf(t.first_at) : null,
		lastAt: t.last_at ? isoOf(t.last_at) : null,
		spend: (byAsset || []).map((r) => ({
			asset: r.asset,
			count: Number(r.n) || 0,
			atomics: String(r.atomics ?? '0'),
		})),
		unpriced: Number(t.unpriced) || 0,
	};
}
