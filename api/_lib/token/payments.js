// On-chain verification + settlement + audit for the $THREE token layer.
//
// Flow (server-authoritative — a client "paid" claim is never trusted):
//   1. verifyQuote()   — quote untampered + unexpired
//   2. nonce-unused    — fast reject of a replayed quote before any RPC
//   3. verifyOnChain() — tx confirmed, memo == nonce, each split leg credited
//   4. settlePayment() — record with UNIQUE(nonce) + UNIQUE(tx_signature); a
//                        duplicate insert is a replay/double-submit, surfaced
//                        as already_settled rather than crediting twice.

import { Connection } from '@solana/web3.js';
import { sql } from '../db.js';
import { env } from '../env.js';
import { verifyQuote } from './quote.js';

const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

function rpcUrl(network) {
	return network === 'devnet' ? env.SOLANA_RPC_URL_DEVNET : env.SOLANA_RPC_URL;
}

function verifyError(message, status = 422, code = 'verification_failed', extra = {}) {
	return Object.assign(new Error(message), { status, code, ...extra });
}

// Net atomics credited to an owner across all of its token accounts for `mint`,
// computed from pre/post token balances. Robust to which transfer variant was
// used and to the destination ATA being created within the same transaction
// (it simply has no pre-balance entry). Works uniformly for the burn address,
// treasury, and a marketplace seller.
function creditedTo(tx, { mint, ownerAddress }) {
	const pre = tx.meta?.preTokenBalances || [];
	const post = tx.meta?.postTokenBalances || [];
	let delta = 0n;
	for (const p of post) {
		if (p.mint !== mint || p.owner !== ownerAddress) continue;
		const before = pre.find((x) => x.accountIndex === p.accountIndex);
		const beforeAmt = BigInt(before?.uiTokenAmount?.amount ?? '0');
		const afterAmt = BigInt(p.uiTokenAmount?.amount ?? '0');
		delta += afterAmt - beforeAmt;
	}
	return delta;
}

/**
 * Verify the on-chain transaction satisfies the quote.
 * @returns {Promise<{ confirmedAt: string, slot: number|null, credited: object }>}
 */
export async function verifyOnChain({ quote, txSignature, network = 'mainnet' }) {
	const connection = new Connection(rpcUrl(network), 'confirmed');
	let tx;
	try {
		tx = await connection.getParsedTransaction(txSignature, {
			maxSupportedTransactionVersion: 0,
			commitment: 'confirmed',
		});
	} catch {
		throw verifyError(
			'transaction not found — may need more confirmations',
			422,
			'tx_not_found',
		);
	}
	if (!tx) throw verifyError('transaction not found', 422, 'tx_not_found');
	if (tx.meta?.err) throw verifyError('transaction failed on-chain', 422, 'tx_failed');

	// Memo must equal the quote nonce — binds this tx to this exact quote and
	// blocks a transfer whose numbers happen to line up from a different intent.
	const memoIx = tx.transaction.message.instructions.find(
		(ix) => ix.programId?.toString() === MEMO_PROGRAM,
	);
	const memo = typeof memoIx?.parsed === 'string' ? memoIx.parsed : null;
	if (!memo || memo !== quote.nonce) {
		throw verifyError('transaction memo does not match quote nonce', 422, 'memo_mismatch');
	}

	// Every split leg must have received at least its share. Underpaying any leg
	// (including the burn) voids the whole payment.
	const credited = {};
	for (const leg of quote.legs) {
		const need = BigInt(leg.atomics);
		const got = creditedTo(tx, { mint: quote.mint, ownerAddress: leg.address });
		credited[leg.role] = got.toString();
		if (got < need) {
			throw verifyError(
				`split leg "${leg.role}" received ${got} < required ${need}`,
				422,
				'split_underpaid',
				{ role: leg.role, required: need.toString(), received: got.toString() },
			);
		}
	}

	return { confirmedAt: new Date().toISOString(), slot: tx.slot ?? null, credited };
}

function isUniqueViolation(err) {
	return err?.code === '23505' || /duplicate key|unique constraint/i.test(err?.message || '');
}

/**
 * Record a verified payment. Returns { id, replay, created_at }. A duplicate
 * nonce or tx_signature resolves to { replay: true } (the prior settled row).
 */
export async function settlePayment({
	quote,
	txSignature,
	network,
	payerWallet,
	userId,
	confirmation,
}) {
	try {
		const [row] = await sql`
			insert into token_payments
				(user_id, payer_wallet, purpose, mint, decimals, usd, price_usd,
				 total_atomics, splits, nonce, tx_signature, network, slot, ref_type, ref_id, confirmed_at)
			values
				(${userId ?? null}, ${payerWallet ?? null}, ${quote.purpose}, ${quote.mint}, ${quote.decimals},
				 ${quote.usd}, ${quote.priceUsd}, ${quote.total}, ${JSON.stringify(quote.legs)}::jsonb,
				 ${quote.nonce}, ${txSignature}, ${network}, ${confirmation?.slot ?? null},
				 ${quote.refType ?? null}, ${quote.refId ?? null}, now())
			returning id, created_at
		`;
		return { id: row.id, replay: false, created_at: row.created_at };
	} catch (err) {
		if (isUniqueViolation(err)) {
			const [existing] = await sql`
				select id, created_at from token_payments
				where nonce = ${quote.nonce} or tx_signature = ${txSignature}
				limit 1
			`;
			return {
				id: existing?.id ?? null,
				replay: true,
				created_at: existing?.created_at ?? null,
			};
		}
		throw err;
	}
}

/**
 * Full verified-payment path reused by Task 19 (paid spins) and Task 20
 * (token-priced listings). Validates the quote, rejects replays, verifies the
 * transaction on-chain, records the settlement.
 * @returns {Promise<{ ok: true, payment_id: string, quote: object, confirmation: object }>}
 */
export async function verifyAndSettlePayment({
	quoteToken,
	txSignature,
	payerWallet = null,
	userId = null,
	network,
}) {
	const quote = verifyQuote(quoteToken);
	const net = network || quote.network || 'mainnet';

	// Fast pre-check (the UNIQUE constraint in settlePayment is the source of
	// truth, but this avoids an RPC round-trip on an obvious replay).
	const [used] =
		await sql`select id, tx_signature from token_payments where nonce = ${quote.nonce} limit 1`;
	if (used) {
		throw verifyError('quote already settled', 409, 'already_settled', {
			tx_signature: used.tx_signature,
		});
	}

	const confirmation = await verifyOnChain({ quote, txSignature, network: net });
	const settled = await settlePayment({
		quote,
		txSignature,
		network: net,
		payerWallet,
		userId,
		confirmation,
	});
	if (settled.replay) {
		throw verifyError('payment already settled', 409, 'already_settled');
	}

	return { ok: true, payment_id: settled.id, quote, confirmation };
}

/**
 * Audit read for reconciliation. Keyset paginated by created_at. No secrets are
 * stored on the row, so the whole record is safe to return to an authorized reader.
 */
export async function listPayments({
	purpose = null,
	userId = null,
	refType = null,
	refId = null,
	limit = 50,
	before = null,
} = {}) {
	const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
	const rows = await sql`
		select id, user_id, payer_wallet, purpose, mint, decimals, usd, price_usd,
		       total_atomics, splits, nonce, tx_signature, network, slot,
		       ref_type, ref_id, confirmed_at, created_at
		from token_payments
		where (${purpose}::text is null or purpose = ${purpose})
		  and (${userId}::uuid is null or user_id = ${userId})
		  and (${refType}::text is null or ref_type = ${refType})
		  and (${refId}::text is null or ref_id = ${refId})
		  and (${before}::timestamptz is null or created_at < ${before})
		order by created_at desc
		limit ${cap + 1}
	`;
	const hasMore = rows.length > cap;
	const items = (hasMore ? rows.slice(0, cap) : rows).map((r) => ({
		id: r.id,
		user_id: r.user_id,
		payer_wallet: r.payer_wallet,
		purpose: r.purpose,
		mint: r.mint,
		decimals: r.decimals,
		usd: Number(r.usd),
		price_usd: Number(r.price_usd),
		total_atomics: r.total_atomics,
		splits: r.splits,
		nonce: r.nonce,
		tx_signature: r.tx_signature,
		network: r.network,
		slot: r.slot,
		ref_type: r.ref_type,
		ref_id: r.ref_id,
		confirmed_at: r.confirmed_at,
		created_at: r.created_at,
	}));
	return { items, next_cursor: hasMore ? items[items.length - 1].created_at : null };
}
