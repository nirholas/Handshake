// Did this settlement actually happen, on-chain, to the right wallet?
//
// Several surfaces record a money event from a signature the CLIENT hands us: a
// stage tip, an IRL "someone paid your agent" tap. Until the 2026-08-06 security
// review (M4) those paths checked only the SHAPE of the signature (a base58 or
// 0x-hash regex), the mint allow-list, and a positive amount. Nothing fetched the
// transaction, so a well-formed but unrelated signature with a large amount
// recorded a tip that never happened: leaderboard and social fraud on a surface
// whose whole promise is "never trusts a client-asserted tip without a verifiable
// settlement".
//
// This module is that verification, shared so the two surfaces cannot drift:
//
//   • Solana (base58 signature): fetch the parsed transaction and sum the SPL
//     balance delta for `mint` credited to any recipient wallet. Robust to an
//     associated token account created inside the same transaction, and to the
//     payer bundling several transfers.
//   • EVM (0x tx hash): delegate to verifyEvmUsdcPayment, which already handles
//     receipt status, confirmations, and Transfer-log decoding for USDC on Base.
//
// Three outcomes, and the difference matters:
//   match    the funds moved; record it.
//   pending  the chain has not shown us this transaction yet (RPC lag, not yet
//            confirmed). The money may well be real, so callers hold the record
//            rather than discarding a genuine payment.
//   mismatch it is not there, it failed, or it paid too little / the wrong
//            wallet. Never record.

import { TOKEN_MINT, TOKEN_DECIMALS } from './token/config.js';
import { verifyEvmUsdcPayment } from './evm-payment-verify.js';

export const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;
export const SOL_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{43,88}$/;

// $THREE, the only coin this platform promotes, plus USDC, the sole other asset
// the existing pay paths settle in. Kept in lockstep with stage-split.js.
export const THREE_MINT = TOKEN_MINT;
export const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

export const THREE_ATOMIC_DECIMALS = Number(TOKEN_DECIMALS) || 6;

function isEvmMint(mint) {
	return typeof mint === 'string' && mint.toLowerCase() === USDC_BASE;
}

// Solana native-SOL transfers are not a settlement asset here (every allowed mint
// is an SPL token or an ERC-20), so a Solana verification is always a token
// balance-delta check.
async function verifySolana({ signature, mint, amountAtomic, recipients, network, anyRecipient }) {
	const { solanaConnection } = await import('./agent-pumpfun.js');
	const cluster = String(network || '').toLowerCase().includes('devnet') ? 'devnet' : 'mainnet';
	let tx;
	try {
		tx = await solanaConnection(cluster).getParsedTransaction(signature, {
			maxSupportedTransactionVersion: 0,
			commitment: 'confirmed',
		});
	} catch {
		return { status: 'pending', reason: 'could not reach the chain to verify this settlement' };
	}
	if (!tx) return { status: 'pending', reason: 'the settlement is not confirmed on-chain yet' };
	if (tx.meta?.err) return { status: 'mismatch', reason: 'the settlement transaction failed on-chain' };

	const owners = new Set(recipients);
	const pre = tx.meta?.preTokenBalances || [];
	const post = tx.meta?.postTokenBalances || [];
	let credited = 0n;
	for (const p of post) {
		if (p.mint !== mint) continue;
		if (!anyRecipient && !owners.has(p.owner)) continue;
		const before = pre.find((x) => x.accountIndex === p.accountIndex);
		const delta = BigInt(p.uiTokenAmount?.amount ?? '0') - BigInt(before?.uiTokenAmount?.amount ?? '0');
		// With no known destination, only credits count: summing the payer's own
		// negative delta back in would net a real transfer to zero.
		if (anyRecipient && delta <= 0n) continue;
		credited += delta;
	}
	if (credited <= 0n) {
		return { status: 'mismatch', reason: 'this transaction moved nothing to the recipient wallet' };
	}
	if (credited < BigInt(amountAtomic)) {
		return { status: 'mismatch', credited: credited.toString(), reason: 'the amount claimed is larger than what the transaction actually paid' };
	}
	return { status: 'match', credited: credited.toString() };
}

async function verifyEvm({ signature, amountAtomic, recipients, network, anyRecipient }) {
	const chain = String(network || '').toLowerCase().includes('sepolia') ? 'base-sepolia' : 'base';
	if (anyRecipient) {
		const res = await verifyEvmUsdcPayment({
			txHash: signature, chain, recipient: null, expectedAmount: BigInt(amountAtomic),
		});
		if (res.status === 'match') return { status: 'match', credited: res.actualAmount };
		if (res.status === 'pending') return { status: 'pending', reason: 'the settlement is not confirmed on-chain yet' };
		return { status: 'mismatch', reason: res.message || 'this transaction did not move the amount claimed' };
	}
	// Any one of the recipient wallets satisfying the amount is a match: a surface
	// may legitimately hold both an agent wallet and its owner's payout address.
	let lastReason = 'no USDC transfer to the recipient wallet found in this transaction';
	for (const recipient of recipients) {
		if (!/^0x[0-9a-fA-F]{40}$/.test(recipient || '')) continue;
		const res = await verifyEvmUsdcPayment({
			txHash: signature, chain, recipient, expectedAmount: BigInt(amountAtomic),
		});
		if (res.status === 'match') return { status: 'match', credited: res.actualAmount };
		if (res.status === 'pending') return { status: 'pending', reason: 'the settlement is not confirmed on-chain yet' };
		lastReason = res.message || lastReason;
	}
	return { status: 'mismatch', reason: lastReason };
}

/**
 * Verify that `signature` really moved at least `amountAtomic` of `mint` to one of
 * `recipients`.
 *
 * @param {object} a
 * @param {string} a.signature      base58 Solana signature or 0x EVM tx hash
 * @param {string} a.mint           the settlement asset ($THREE or USDC)
 * @param {bigint|number|string} a.amountAtomic  atomic units the caller claims
 * @param {string[]} a.recipients   wallets that may legitimately receive it
 * @param {string} [a.network]      network hint from the caller
 * @param {boolean} [a.allowAnyRecipient]  when the destination is genuinely not
 *   knowable server-side (an x402 service whose payout address we do not hold),
 *   accept a transfer of the right asset and size to anyone. Strictly stronger
 *   than the shape-only check it replaces, and never used where a payout wallet
 *   IS on record.
 * @returns {Promise<{status:'match'|'pending'|'mismatch', credited?:string, reason?:string}>}
 */
export async function verifySettlement({ signature, mint, amountAtomic, recipients, network, allowAnyRecipient = false }) {
	const sig = typeof signature === 'string' ? signature.trim() : '';
	const wallets = [...new Set((recipients || []).filter((r) => typeof r === 'string' && r))];
	const anyRecipient = !wallets.length && allowAnyRecipient;
	if (!wallets.length && !anyRecipient) {
		return { status: 'mismatch', reason: 'this agent has no payout wallet on record, so a payment to it cannot be verified' };
	}
	let amount;
	try {
		amount = BigInt(amountAtomic);
	} catch {
		return { status: 'mismatch', reason: 'amount must be an integer in atomic units' };
	}
	if (amount <= 0n) return { status: 'mismatch', reason: 'amount must be positive' };

	if (EVM_TX_RE.test(sig)) {
		if (!isEvmMint(mint)) {
			return { status: 'mismatch', reason: 'an EVM transaction hash can only settle USDC on Base' };
		}
		return verifyEvm({ signature: sig, amountAtomic: amount, recipients: wallets, network, anyRecipient });
	}
	if (SOL_SIG_RE.test(sig)) {
		if (isEvmMint(mint)) {
			return { status: 'mismatch', reason: 'a Solana signature cannot settle an EVM asset' };
		}
		return verifySolana({ signature: sig, mint, amountAtomic: amount, recipients: wallets, network, anyRecipient });
	}
	return { status: 'mismatch', reason: 'not a valid on-chain settlement signature' };
}
