// @ts-check
// Back-an-Agent Vaults — the guarded trade executor + drawdown circuit breaker.
//
// This is what makes a vault watchable: the agent deploys the POOLED backer
// capital into real token positions and harvests them back, but it can NEVER
// exceed its mandate. Every buy is checked against the vault's per-trade ceiling,
// rolling daily budget, on-chain USDC balance and SOL fee headroom BEFORE a key is
// ever touched; every fill is a real Jupiter swap signed by the vault's dedicated
// keypair; and after every trade the vault's NAV is re-derived from chain and run
// through the drawdown circuit breaker — a fall of `max_drawdown_bps` from the
// high-water peak HALTS the vault (pauses autonomous trading) and protects the
// remaining capital. The whole pipeline is the same discipline the agent's own
// wallet trades under (api/agents/agent-trade.js), applied to segregated funds.

import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { solanaConnection } from './agent-pumpfun.js';
import { confirmOrThrow } from './solana/confirm.js';
import { logAudit } from './audit.js';
import { explorerTxUrl } from './avatar-wallet.js';
import {
	getVaultWithSecret, getOpenPositions, getDailyTradeSpend, claimVaultBuyBudget,
	recordVaultEvent, updateVaultEvent, applyVaultShareDelta, setVaultStatus,
	upsertPosition, reducePosition,
} from './vault-store.js';
import { recoverVaultKeypair, computeVaultNav, readVaultUsdcAtomics, hasSolHeadroom } from './vault-wallet.js';
import { quoteBuy, quoteSell, buildSwapTx, validateMint, USDC_MINT_BY_NETWORK } from './vault-jupiter.js';
import {
	toBig, sharePriceE6, isDrawdownBreached, nextPeak,
	tradeExceedsPerTrade, tradeExceedsDailyBudget,
} from './vault-accounting.js';

function netOf(network) {
	return network === 'devnet' ? 'devnet' : 'mainnet';
}

const blocked = (code, message, detail = null) => ({ status: 'blocked', code, message, detail });

/** Resolve a mint's token program + decimals (handles Token-2022). */
async function resolveMintInfo(conn, mintPk) {
	let acc;
	try { acc = await conn.getAccountInfo(mintPk); } catch { acc = null; }
	const programId = acc?.owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
	const decimals = (await getMint(conn, mintPk, 'confirmed', programId)).decimals;
	return { programId, decimals };
}

/** On-chain base-unit balance the vault holds of `mintPk`. */
async function tokenBalance(conn, mintPk, ownerPk, programId) {
	try {
		const ata = getAssociatedTokenAddressSync(mintPk, ownerPk, false, programId);
		const bal = await conn.getTokenAccountBalance(ata);
		return BigInt(bal?.value?.amount ?? '0');
	} catch {
		return 0n;
	}
}

/** Sign, broadcast, and confirm a Jupiter VersionedTransaction. Throws on failure. */
async function signSendConfirm(conn, tx, keypair) {
	tx.sign([keypair]);
	const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
	const bh = await conn.getLatestBlockhash('confirmed');
	// HTTP-polling confirm (no WebSocket) — throws `tx_reverted` on a landed-but-
	// reverted swap, so a revert is never recorded as a successful trade.
	await confirmOrThrow(
		conn,
		{ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
		'confirmed',
	);
	return sig;
}

/**
 * Re-derive NAV from chain, ratchet the high-water peak, and trip the drawdown
 * breaker if NAV has fallen `max_drawdown_bps` from peak. Returns the fresh NAV +
 * whether the vault was halted. Never throws — a transient pricing gap (priced=false)
 * defers the breaker rather than fabricating a halt.
 */
export async function enforceBreaker(vault, { userId = null, reason = 'post_trade' } = {}) {
	const positions = await getOpenPositions(vault.id);
	const nav = await computeVaultNav(vault, positions);
	// The breaker measures SHARE PRICE drawdown (NAV per share), not raw NAV — so
	// deposits/redemptions, which move NAV but not price, can never trip it. Only
	// real trading losses move the share price down.
	const priceE6 = sharePriceE6(nav.navAtomics, vault.total_shares);
	const peak = nextPeak(vault.peak_share_price_e6, priceE6);

	// Ratchet the peak (only rises). Done regardless of breach.
	await applyVaultShareDelta(vault.id, 0n, peak);

	let halted = false;
	if (nav.priced && vault.status === 'open' && toBig(vault.total_shares) > 0n
		&& isDrawdownBreached(peak, priceE6, vault.max_drawdown_bps)) {
		await setVaultStatus(vault.id, 'paused', { haltReason: 'drawdown' });
		await recordVaultEvent({
			vaultId: vault.id, type: 'drawdown_halt', userId,
			navAtomics: nav.navAtomics, sharePriceE6: priceE6,
			reason: 'drawdown circuit breaker tripped — autonomous trading halted to protect capital',
			meta: { peak_share_price_e6: String(peak), share_price_e6: String(priceE6), nav_atomics: String(nav.navAtomics), max_drawdown_bps: vault.max_drawdown_bps, trigger: reason },
		});
		logAudit({ userId, action: 'vault.drawdown_halt', resourceId: vault.id, meta: { peak_share_price_e6: String(peak), share_price_e6: String(priceE6), max_drawdown_bps: vault.max_drawdown_bps } });
		halted = true;
	}
	return { nav, peak, sharePriceE6: priceE6, halted };
}

/**
 * Execute a guarded vault trade. The vault row is loaded fresh (with secret) here.
 *
 * @param {object} a
 * @param {string} a.vaultId
 * @param {string} a.userId            the owner (only the owner can direct trades)
 * @param {'buy'|'sell'} a.side
 * @param {string} a.mint
 * @param {bigint} [a.usdcInAtomics]    buy size in USDC atomics
 * @param {bigint|'max'} [a.amountRaw]  sell size in token base units, or 'max'
 * @param {number} a.slippageBps
 * @param {string} a.idempotencyKey
 * @returns {Promise<object>} a result envelope ({ status, ... })
 */
export async function vaultTrade({ vaultId, userId, side, mint, usdcInAtomics, amountRaw, slippageBps, idempotencyKey }) {
	const vault = await getVaultWithSecret(vaultId);
	if (!vault) return { status: 'failed', code: 'not_found', message: 'vault not found' };
	if (vault.status !== 'open') {
		return blocked('vault_not_open', vault.status === 'paused'
			? 'vault is paused — resume it before trading'
			: `vault is ${vault.status}`);
	}
	const network = netOf(vault.network);
	const slip = Math.max(0, Math.min(5000, Math.round(Number(slippageBps) || 100)));

	const mintB58 = validateMint(mint);
	if (!mintB58) return blocked('invalid_mint', 'not a valid token mint address');
	if (mintB58 === USDC_MINT_BY_NETWORK[network]) return blocked('invalid_mint', 'cannot trade USDC against itself');

	const conn = solanaConnection(network);
	const vaultPk = new PublicKey(vault.vault_address);
	const mintPk = new PublicKey(mintB58);

	let mintInfo;
	try { mintInfo = await resolveMintInfo(conn, mintPk); } catch { return blocked('invalid_mint', 'could not read the token mint on this network'); }

	// ── Guards (pre-signature) ────────────────────────────────────────────────
	if (side === 'buy') {
		const amount = toBig(usdcInAtomics);
		if (amount <= 0n) return blocked('zero_amount', 'buy amount must be positive');
		if (tradeExceedsPerTrade(amount, vault.max_per_trade_atomics)) {
			return blocked('per_trade_cap', 'exceeds the vault per-trade ceiling', { max_per_trade_atomics: String(vault.max_per_trade_atomics) });
		}
		// Pre-flight only, for a fast and specific rejection. The binding check is
		// the atomic claim below, which reserves the headroom under a per-vault lock.
		const spent = await getDailyTradeSpend(vault.id);
		if (tradeExceedsDailyBudget(spent, amount, vault.daily_budget_atomics)) {
			return blocked('daily_budget', 'exceeds the vault rolling 24h budget', { spent_atomics: String(spent), daily_budget_atomics: String(vault.daily_budget_atomics) });
		}
		const usdcBal = await readVaultUsdcAtomics(vault.vault_address, network);
		if (usdcBal < amount) return blocked('insufficient_usdc', 'the vault does not hold enough USDC for this buy', { balance_atomics: String(usdcBal) });
		if (!(await hasSolHeadroom(vault.vault_address, network))) {
			return blocked('insufficient_sol_for_fees', 'the vault needs a little SOL to pay swap fees — fund it with ~0.01 SOL');
		}
	} else if (side !== 'sell') {
		return blocked('invalid_side', 'side must be "buy" or "sell"');
	}

	// ── Quote ─────────────────────────────────────────────────────────────────
	let q; let sellRaw = 0n;
	try {
		if (side === 'buy') {
			q = await quoteBuy({ network, mint: mintB58, usdcAtomics: toBig(usdcInAtomics), slippageBps: slip });
		} else {
			const held = await tokenBalance(conn, mintPk, vaultPk, mintInfo.programId);
			sellRaw = (amountRaw === 'max' || amountRaw == null) ? held : toBig(amountRaw);
			if (sellRaw <= 0n) return blocked('zero_amount', 'sell amount must be positive');
			if (sellRaw > held) return blocked('insufficient_token', 'the vault holds less of this token than requested', { held_raw: String(held) });
			q = await quoteSell({ network, mint: mintB58, amountRaw: sellRaw, slippageBps: slip });
		}
	} catch (e) {
		const code = e?.code === 'no_route' ? 'no_route' : 'quote_failed';
		return blocked(code, code === 'no_route' ? 'no swap route for this token right now' : 'could not price the trade — try again');
	}

	// ── Idempotency claim (pending ledger row) ──────────────────────────────────
	const claimMeta = {
		side, mint: mintB58, slippage_bps: slip,
		price_impact_pct: q.priceImpactPct,
		...(side === 'buy' ? { usdc_in: String(toBig(usdcInAtomics)), expected_out_raw: String(q.expectedOutRaw) } : { sell_raw: String(sellRaw), expected_usdc_out: String(q.expectedOutAtomics) }),
	};
	let claimId;
	if (side === 'buy') {
		// A buy claims daily-budget headroom and its ledger row in ONE statement,
		// so two concurrent buys can never both pass on the same stale 24h total.
		const claim = await claimVaultBuyBudget({
			vaultId: vault.id, userId, idempotencyKey,
			usdcInAtomics: toBig(usdcInAtomics),
			dailyBudgetAtomics: vault.daily_budget_atomics,
			reason: `trade_${side}`, meta: claimMeta,
		});
		if (!claim.ok) {
			if (claim.reason === 'in_flight') {
				return { status: 'failed', code: 'in_flight', message: 'a trade with this id is already recorded, check the ledger before retrying' };
			}
			return blocked('daily_budget', 'exceeds the vault rolling 24h budget', {
				spent_atomics: String(claim.spentBefore ?? '0'),
				daily_budget_atomics: String(vault.daily_budget_atomics),
			});
		}
		claimId = claim.claimId;
	} else {
		claimId = await recordVaultEvent({
			vaultId: vault.id, type: 'trade', userId,
			atomicsDelta: null,
			signature: null, status: 'pending', reason: `trade_${side}`,
			idempotencyKey, meta: claimMeta,
		});
		if (claimId == null) {
			return { status: 'failed', code: 'in_flight', message: 'a trade with this id is already recorded, check the ledger before retrying' };
		}
	}

	// ── Sign + submit the real swap ─────────────────────────────────────────────
	let keypair;
	try {
		keypair = await recoverVaultKeypair(vault.encrypted_secret, { vaultId: vault.id, userId, reason: `trade_${side}`, meta: { mint: mintB58, network } });
	} catch {
		await updateVaultEvent(claimId, { status: 'failed', meta: { error: 'key_recover_failed' } });
		return { status: 'failed', code: 'key_recover_failed', message: 'could not access the vault key — no funds moved' };
	}

	// Snapshot balances to measure the exact fill from chain (never trust the quote).
	const usdcBefore = await readVaultUsdcAtomics(vault.vault_address, network);
	const tokenBefore = await tokenBalance(conn, mintPk, vaultPk, mintInfo.programId);

	let signature;
	try {
		const tx = await buildSwapTx({ quote: q.quote, userPublicKey: vaultPk });
		signature = await signSendConfirm(conn, tx, keypair);
	} catch (e) {
		await updateVaultEvent(claimId, { status: 'failed', signature: e?.signature || null, meta: { error: e?.code || 'send_failed', message: (e?.message || '').slice(0, 200) } });
		logAudit({ userId, action: 'vault.trade_failed', resourceId: vault.id, meta: { side, mint: mintB58, reason: e?.code || 'send_failed' } });
		return { status: 'failed', code: e?.code || 'send_failed', message: 'the swap could not be confirmed — no position change recorded', detail: e?.signature ? { signature: e.signature } : null };
	}

	// ── Settle position bookkeeping from the real on-chain delta ─────────────────
	const usdcAfter = await readVaultUsdcAtomics(vault.vault_address, network);
	const tokenAfter = await tokenBalance(conn, mintPk, vaultPk, mintInfo.programId);

	if (side === 'buy') {
		const received = tokenAfter > tokenBefore ? tokenAfter - tokenBefore : q.expectedOutRaw;
		const spent = usdcBefore > usdcAfter ? usdcBefore - usdcAfter : toBig(usdcInAtomics);
		await upsertPosition({ vaultId: vault.id, mint: mintB58, tokenDecimals: mintInfo.decimals, amountRawDelta: received, costDelta: spent, markAtomics: spent });
		await updateVaultEvent(claimId, { status: 'ok', signature, atomicsDelta: String(-spent), meta: { usdc_in: String(spent), out_raw: String(received) } });
	} else {
		const proceeds = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : q.expectedOutAtomics;
		// Cost basis removed = pro-rata of the open position's cost for the units sold.
		const [pos] = await getOpenPositions(vault.id).then((ps) => ps.filter((p) => p.mint === mintB58));
		const posAmount = pos ? toBig(pos.amount_raw) : sellRaw;
		const posCost = pos ? toBig(pos.cost_atomics) : 0n;
		const costRemoved = posAmount > 0n ? (posCost * sellRaw) / posAmount : 0n;
		await reducePosition({ vaultId: vault.id, mint: mintB58, amountRawDelta: sellRaw, proceedsAtomics: proceeds, costRemovedAtomics: costRemoved });
		await updateVaultEvent(claimId, { status: 'ok', signature, atomicsDelta: String(proceeds), meta: { usdc_out: String(proceeds), sold_raw: String(sellRaw), realized_atomics: String(proceeds - costRemoved) } });
	}

	logAudit({ userId, action: 'vault.trade', resourceId: vault.id, meta: { side, mint: mintB58, signature, network } });

	// ── Re-derive NAV + run the drawdown circuit breaker ─────────────────────────
	const fresh = await getVaultWithSecret(vault.id);
	const breaker = await enforceBreaker(fresh, { userId, reason: `trade_${side}` });

	return {
		status: 'ok',
		signature,
		explorer: explorerTxUrl(signature, network),
		side, mint: mintB58, network,
		price_impact_pct: q.priceImpactPct,
		nav_atomics: String(breaker.nav.navAtomics),
		share_price_e6: String(breaker.sharePriceE6),
		halted: breaker.halted,
		...(breaker.halted ? { halt_reason: 'drawdown' } : {}),
	};
}
