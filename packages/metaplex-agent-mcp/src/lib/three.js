// $THREE: the deploy fee, the holder waiver, and the live protocol read.
//
// Two things live here, and they point the same way:
//
//   1. THE FEE. A mainnet deploy pays a flat SOL fee to the wallet the three.ws
//      $THREE buyback lane signs from. It rides in the SAME transaction that
//      creates the Core asset, so a mint that fails pays nothing, and it is
//      always disclosed in the preview before anything is broadcast.
//   2. THE WAIVER. Hold $THREE in the paying wallet and the fee halves, then
//      disappears. The balance is read live from the chain at build time.
//      Nothing is escrowed, transferred, locked, or spent to earn it.
//
// Devnet is free, always: a full end-to-end rehearsal costs nothing but rent.
//
// Browser-safe: no node built-ins, RPC through the Umi instance you pass in.

import {
	THREE_MINT,
	THREE_DECIMALS,
	DEPLOY_FEE_WALLET,
	DEPLOY_FEE_SOL,
	DEPLOY_FEE_ENABLED,
	THREE_HALF_PRICE_AT,
	THREE_FREE_AT,
	THREE_WS_BASE,
	HTTP_TIMEOUT_MS,
	USER_AGENT,
} from '../config.js';
import { LAMPORTS_PER_SOL } from './solana.js';

export const THREE_STATS_URL = `${THREE_WS_BASE}/api/three-token/stats`;

/** The fee schedule as configured, with no chain reads. Safe to render anywhere. */
export function feeSchedule() {
	const lamports = Math.round(DEPLOY_FEE_SOL * LAMPORTS_PER_SOL);
	return {
		enabled: DEPLOY_FEE_ENABLED && lamports > 0,
		mint: THREE_MINT,
		fee_wallet: DEPLOY_FEE_WALLET,
		standard_sol: lamports / LAMPORTS_PER_SOL,
		standard_lamports: lamports,
		half_price_at_three: THREE_HALF_PRICE_AT,
		free_at_three: THREE_FREE_AT,
		devnet_sol: 0,
		funds: 'the three.ws $THREE buyback wallet',
		ledger: THREE_STATS_URL,
	};
}

/**
 * Live $THREE balance of a wallet, in whole tokens.
 * Sums every token account the owner holds for the mint, so a wallet with both
 * a legacy and a Token-2022 account reports its real total.
 * @returns {Promise<{ tokens: number, atomics: bigint, accounts: number }>}
 */
export async function threeBalance(umi, address, { mint = THREE_MINT } = {}) {
	const res = await umi.rpc.call('getTokenAccountsByOwner', [
		String(address),
		{ mint: String(mint) },
		{ encoding: 'jsonParsed' },
	]);
	const accounts = res?.value || [];
	let atomics = 0n;
	for (const acct of accounts) {
		const raw = acct?.account?.data?.parsed?.info?.tokenAmount?.amount;
		if (raw !== undefined) atomics += BigInt(raw);
	}
	return {
		tokens: Number(atomics) / 10 ** THREE_DECIMALS,
		atomics,
		accounts: accounts.length,
	};
}

/** Which tier a $THREE balance earns. Pure; the discount math lives here alone. */
export function tierFor(tokens) {
	if (tokens >= THREE_FREE_AT) return { tier: 'holder_free', multiplier: 0 };
	if (tokens >= THREE_HALF_PRICE_AT) return { tier: 'holder_half', multiplier: 0.5 };
	return { tier: 'standard', multiplier: 1 };
}

/** How much $THREE the wallet still needs for the next discount, or null at the top. */
export function nextTier(tokens) {
	if (tokens >= THREE_FREE_AT) return null;
	const target = tokens >= THREE_HALF_PRICE_AT ? THREE_FREE_AT : THREE_HALF_PRICE_AT;
	const tier = tokens >= THREE_HALF_PRICE_AT ? 'holder_free' : 'holder_half';
	const need = Math.max(0, target - tokens);
	return { tier, at_three: target, need_three: Math.round(need * 10 ** THREE_DECIMALS) / 10 ** THREE_DECIMALS };
}

const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * Resolve what THIS deploy pays, from live chain state.
 *
 * Never throws on an unreadable balance: an RPC that cannot answer means the
 * discount cannot be proven, so the deploy pays standard and the response says
 * exactly why, instead of silently charging full price or silently waiving it.
 *
 * @returns {Promise<{ lamports: number, sol: number, tier: string, wallet: string|null,
 *   three_tokens: number|null, three_balance_error?: string, reason: string }>}
 */
export async function resolveDeployFee(umi, { network, payer } = {}) {
	const schedule = feeSchedule();
	const base = { schedule, three_tokens: null, wallet: schedule.fee_wallet };

	if (!schedule.enabled) {
		return { ...base, lamports: 0, sol: 0, tier: 'disabled', wallet: null, reason: 'DEPLOY_FEE_ENABLED is off' };
	}
	if (network !== 'mainnet') {
		return { ...base, lamports: 0, sol: 0, tier: 'devnet', wallet: null, reason: 'devnet deploys are free' };
	}
	if (!payer) {
		return {
			...base,
			lamports: schedule.standard_lamports,
			sol: schedule.standard_sol,
			tier: 'standard',
			reason: 'no paying wallet to check for $THREE',
		};
	}

	let balance = null;
	let balanceError = null;
	try {
		balance = await threeBalance(umi, payer);
	} catch (err) {
		balanceError = err?.message || String(err);
	}

	if (balance === null) {
		return {
			...base,
			lamports: schedule.standard_lamports,
			sol: schedule.standard_sol,
			tier: 'standard',
			three_balance_error: balanceError,
			reason: 'could not read the wallet $THREE balance, so the holder discount could not be applied',
		};
	}

	const { tier, multiplier } = tierFor(balance.tokens);
	const lamports = Math.round(schedule.standard_lamports * multiplier);
	const reason =
		tier === 'holder_free'
			? `wallet holds ${fmt(balance.tokens)} $THREE: deploy fee waived`
			: tier === 'holder_half'
				? `wallet holds ${fmt(balance.tokens)} $THREE: deploy fee halved`
				: `wallet holds ${fmt(balance.tokens)} $THREE, under the ${fmt(THREE_HALF_PRICE_AT)} half-price threshold`;

	return {
		...base,
		lamports,
		sol: lamports / LAMPORTS_PER_SOL,
		tier,
		three_tokens: balance.tokens,
		next_tier: nextTier(balance.tokens),
		wallet: lamports > 0 ? schedule.fee_wallet : null,
		reason,
	};
}

/**
 * The live $THREE protocol read: market data plus the public buyback ledger.
 * Real numbers from three.ws; there is no cached or synthetic fallback.
 */
export async function threeStats() {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
	try {
		const res = await fetch(THREE_STATS_URL, {
			signal: ctrl.signal,
			headers: { accept: 'application/json', 'user-agent': USER_AGENT },
		});
		if (!res.ok) {
			throw Object.assign(new Error(`$THREE stats returned ${res.status}`), {
				code: 'three_stats_error',
				status: res.status,
			});
		}
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}
