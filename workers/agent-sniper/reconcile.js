// agent-sniper, on-chain position reconciliation.
//
// A sell whose confirmation times out may still LAND. The old behaviour trusted
// the DB alone: the position stayed 'open', every sweep retried the sell, and the
// retry simulated a sell of tokens the wallet no longer holds, pump program
// error 6023 (NotEnoughTokensToSell), forever. One stuck position burned RPC
// quota for 37 hours that way. These helpers make the chain the source of truth
// on a retry: read the wallet's REAL base-token balance, and when the bag is
// already gone, find the transaction that emptied it and book its actual
// proceeds instead of retrying a sell that can never succeed.

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';

export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
// Pump coins exist under both token programs; every owner+mint lookup has to
// cover each one or a token-2022 bag reads as no bag at all.
export const TOKEN_PROGRAMS = [
	'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
	'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
];

/**
 * The associated-token addresses a mint can live at for one owner, one per token
 * program. Derived, not looked up, so it works for an account that has since been
 * closed (a closed account's address keeps its signature history).
 * @returns {Array<import('@solana/web3.js').PublicKey>}
 */
export function deriveTokenAccounts(ctx, ownerPk, mintPk) {
	const atp = new ctx.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM);
	return TOKEN_PROGRAMS.map((tokenProgram) => {
		const [ata] = ctx.web3.PublicKey.findProgramAddressSync(
			[ownerPk.toBuffer(), new ctx.web3.PublicKey(tokenProgram).toBuffer(), mintPk.toBuffer()],
			atp,
		);
		return ata;
	});
}

/**
 * The wallet's actual balance of `mint` (raw base units), summed across token
 * accounts (pump coins are token-2022; the mint filter covers both programs).
 * Returns null when the read fails, callers must treat null as "unknown", not 0.
 *
 * A zero from this function means "confirmed: no token account holds this mint",
 * because the caller treats zero as proof the bag is gone and parks the position
 * as unreconcilable. Two ways that proof used to be manufactured out of a bad
 * RPC response, both of which parked healthy positions holding real tokens and
 * wedged their arm's concurrency slot:
 *
 *   1. A malformed response (no `value` array) fell through the `res?.value || []`
 *      default and summed to zero. A shape failure is a failed read, not a zero
 *      balance, so it now returns null like a thrown error does.
 *   2. An EMPTY account list was trusted outright. A lagging or throttled node
 *      serves an empty list for an owner that demonstrably holds the mint, and
 *      this fleet runs degraded RPC often enough for that to be routine. An empty
 *      list is now confirmed against the derived associated-token addresses
 *      before it counts as gone: if one still exists and holds a balance, that
 *      balance wins; if the probe itself fails, the answer is null.
 *
 * @returns {Promise<bigint|null>}
 */
export async function getWalletBaseBalance(ctx, ownerPk, mint) {
	const mintPk = new ctx.web3.PublicKey(mint);
	let res;
	try {
		res = await ctx.connection.getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk });
	} catch (err) {
		log.warn('wallet balance read failed', { mint, err: err?.message });
		return null;
	}
	if (!Array.isArray(res?.value)) {
		log.warn('wallet balance read returned no account list', { mint });
		return null;
	}
	if (res.value.length > 0) {
		let total = 0n;
		for (const { account } of res.value) {
			const amt = account?.data?.parsed?.info?.tokenAmount?.amount;
			if (amt != null) total += BigInt(amt);
		}
		return total;
	}
	// Empty list. Confirm against the derived addresses before calling the bag gone.
	try {
		for (const ata of deriveTokenAccounts(ctx, ownerPk, mintPk)) {
			const info = await ctx.connection.getAccountInfo(ata);
			if (!info) continue; // never opened, or closed on the sell that emptied it
			const bal = await ctx.connection.getTokenAccountBalance(ata);
			const amt = bal?.value?.amount;
			if (amt == null) {
				log.warn('token account exists but its balance is unreadable', { mint, ata: ata.toBase58() });
				return null;
			}
			if (BigInt(amt) > 0n) {
				log.warn('empty account list contradicted by a live token account', {
					mint, ata: ata.toBase58(), amount: amt,
				});
				return BigInt(amt);
			}
		}
	} catch (err) {
		log.warn('token account confirmation failed', { mint, err: err?.message });
		return null;
	}
	return 0n;
}

/**
 * The position's tokens are gone from the wallet, find the transaction that
 * emptied them and close the position with its REAL proceeds. Scans the token
 * account's recent history (newest first), skipping the buy signature, for a
 * successful tx where this owner's balance for the mint dropped to zero, and
 * books the owner's net SOL delta from that tx as the exit.
 *
 * Returns true when the position was closed, false when the emptying tx could
 * not be found (caller leaves the position for the next sweep, never guess).
 */
export async function reconcileVanishedBag({ ctx, position, reason }) {
	const tag = { agent: position.agent_id, mint: position.mint, symbol: position.symbol };
	try {
		const owner = position.wallet;
		const mintPk = new ctx.web3.PublicKey(position.mint);
		const ownerPk = new ctx.web3.PublicKey(owner);
		const accounts = await ctx.connection.getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk });
		const tokenAccounts = (accounts?.value || []).map((a) => a.pubkey);
		// A sell that emptied the bag often CLOSES the token account in the same tx
		// (rent reclaim), so the live-accounts lookup above comes back empty and the
		// emptying tx could never be found: positions pinged reconcile_pending for
		// 30+ hours while their arm's concurrency slot stayed wedged. A closed
		// account's ADDRESS still carries its signature history, so derive the ATA
		// for both token programs and search those addresses too.
		const seen = new Set(tokenAccounts.map((a) => a.toBase58()));
		for (const ata of deriveTokenAccounts(ctx, ownerPk, mintPk)) {
			if (!seen.has(ata.toBase58())) {
				seen.add(ata.toBase58());
				tokenAccounts.push(ata);
			}
		}
		if (!tokenAccounts.length) return false;

		for (const ata of tokenAccounts) {
			const sigs = await ctx.connection.getSignaturesForAddress(ata, { limit: 20 });
			for (const s of sigs || []) {
				if (s.err || s.signature === position.buy_sig) continue;
				const tx = await ctx.connection.getParsedTransaction(s.signature, {
					maxSupportedTransactionVersion: 0,
				});
				if (!tx || tx.meta?.err) continue;
				const pre = (tx.meta?.preTokenBalances || []).find(
					(b) => b.owner === owner && b.mint === position.mint,
				);
				const post = (tx.meta?.postTokenBalances || []).find(
					(b) => b.owner === owner && b.mint === position.mint,
				);
				const preAmt = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;
				const postAmt = post ? BigInt(post.uiTokenAmount.amount) : 0n;
				if (preAmt <= 0n || postAmt !== 0n) continue;

				// This is the tx that emptied the bag. The owner's net SOL delta is the
				// honest proceeds (sale minus fees it paid in the same tx).
				const keys = tx.transaction.message.accountKeys || [];
				const ownerIdx = keys.findIndex((k) => (k.pubkey?.toBase58?.() || String(k.pubkey)) === owner);
				if (ownerIdx < 0) continue;
				const solDelta = BigInt(tx.meta.postBalances[ownerIdx]) - BigInt(tx.meta.preBalances[ownerIdx]);
				const proceeds = solDelta > 0n ? solDelta : 0n;

				const entry = BigInt(position.entry_quote_lamports || '0');
				const prior = BigInt(position.realized_pnl_lamports || '0');
				const realized = prior + proceeds - entry;
				const pct = entry > 0n ? (Number(realized) / Number(entry)) * 100 : 0;
				await sql`
					UPDATE agent_sniper_positions SET
						status = 'closed', exit_reason = ${reason}, sell_sig = ${s.signature},
						exit_quote_lamports = ${proceeds.toString()},
						realized_pnl_lamports = ${realized.toString()},
						realized_pnl_pct = ${pct},
						error = 'reconciled_onchain',
						reconcile_pending_since = NULL,
						closed_at = now()
					WHERE id = ${position.id}
				`;
				log.trade('sell reconciled from chain', {
					...tag, sig: s.signature, proceeds_sol: Number(proceeds) / 1e9, pnl_pct: pct.toFixed(1),
				});
				return true;
			}
		}
		return false;
	} catch (err) {
		log.warn('reconcile failed, will retry next sweep', { ...tag, err: err?.message });
		return false;
	}
}
