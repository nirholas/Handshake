// $THREE on-chain token layer — shared config + split policy.
//
// Centralizes the mint, decimals, treasury wallet, and burn address so no
// literal addresses are scattered across the paid-action endpoints (Task 19
// paid spins, Task 20 token-priced listings). Mirrors the HOLDER_PASS_SECRET
// boot guard: a value that, if wrong/unset, would route real funds to the
// wrong place fails loudly in production rather than silently mis-paying.

import { env } from '../env.js';

export const TOKEN_MINT = env.THREE_TOKEN_MINT;
export const TOKEN_DECIMALS = env.THREE_TOKEN_DECIMALS;
export const TOKEN_SYMBOL = '$THREE';

// Smallest-unit multiplier (10 ** decimals) as a BigInt for atomics math.
export const ATOMICS_PER_TOKEN = 10n ** BigInt(TOKEN_DECIMALS);

function badRequest(message) {
	const e = new Error(message);
	e.status = 400;
	e.code = 'bad_request';
	return e;
}

// ── Required addresses (fail-closed in production) ──────────────────────────

let _treasuryWarned = false;
/**
 * Treasury wallet that receives the treasury share of every split.
 * Production MUST set THREE_TREASURY_WALLET; otherwise we'd route the platform's
 * cut to a placeholder. In dev we fall back to the burn address so the split
 * still has two valid destinations and no real wallet is silently credited.
 */
export function treasuryWallet() {
	const w = env.THREE_TREASURY_WALLET;
	if (w) return w;
	if (process.env.NODE_ENV === 'production') {
		throw new Error(
			'[token] THREE_TREASURY_WALLET is required in production — refusing to route treasury funds to an unset address.',
		);
	}
	if (!_treasuryWarned) {
		_treasuryWarned = true;
		console.warn(
			'[token] THREE_TREASURY_WALLET is not set — falling back to the burn address for dev. ' +
				'Set THREE_TREASURY_WALLET in production or the treasury share is burned.',
		);
	}
	return burnAddress();
}

/** The burn sink. Defaults to the Solana incinerator (unspendable ATA). */
export function burnAddress() {
	return env.THREE_BURN_ADDRESS;
}

// ── Split policy ────────────────────────────────────────────────────────────
//
// Each policy is an ordered list of legs { role, bps }. bps across legs must
// sum to 10_000. Roles 'burn' and 'treasury' resolve to the config addresses
// above; 'seller' resolves to a per-call address (a marketplace listing's
// payout wallet). Tasks 19/20 reuse the same verified-payment path by naming a
// different policy here — the split ratio is a parameter, not a fork of logic.
export const SPLIT_POLICIES = Object.freeze({
	// Task 19 — paid wheel spins: half burned, half to treasury.
	spin: [
		{ role: 'burn', bps: 5000 },
		{ role: 'treasury', bps: 5000 },
	],
	// Task 20 — token-priced marketplace sales: seller keeps 95%, 5% to treasury.
	marketplace_sale: [
		{ role: 'seller', bps: 9500 },
		{ role: 'treasury', bps: 500 },
	],
});

function resolveRole(role, { sellerWallet } = {}) {
	if (role === 'burn') return burnAddress();
	if (role === 'treasury') return treasuryWallet();
	if (role === 'seller') {
		if (!sellerWallet) throw badRequest('sellerWallet is required for this split policy');
		return sellerWallet;
	}
	throw new Error(`[token] unknown split role: ${role}`);
}

/**
 * Resolve a named policy into concrete legs with destination addresses.
 * @returns {{ role: string, bps: number, address: string }[]}
 */
export function resolveSplitLegs(policyName, opts = {}) {
	const policy = SPLIT_POLICIES[policyName];
	if (!policy) throw badRequest(`unknown split policy: ${policyName}`);
	const sum = policy.reduce((s, l) => s + l.bps, 0);
	// Defensive: a mis-edited policy must never silently under/over-allocate.
	if (sum !== 10_000)
		throw new Error(`[token] split policy ${policyName} bps sum ${sum} != 10000`);
	return policy.map((leg) => ({
		role: leg.role,
		bps: leg.bps,
		address: resolveRole(leg.role, opts),
	}));
}

/**
 * Distribute a total (atomics) across legs by bps. Any rounding remainder is
 * assigned to the highest-bps leg so the per-leg atomics always sum to exactly
 * the total — no dust is created or lost.
 * @param {bigint|string|number} totalAtomics
 * @param {{ role: string, bps: number, address: string }[]} legs
 * @returns {{ role: string, bps: number, address: string, atomics: bigint }[]}
 */
export function applySplit(totalAtomics, legs) {
	const total = BigInt(totalAtomics);
	let allocated = 0n;
	const out = legs.map((leg) => {
		const atomics = (total * BigInt(leg.bps)) / 10_000n;
		allocated += atomics;
		return { ...leg, atomics };
	});
	const remainder = total - allocated;
	if (remainder !== 0n && out.length > 0) {
		let idx = 0;
		for (let i = 1; i < out.length; i++) if (out[i].bps > out[idx].bps) idx = i;
		out[idx].atomics += remainder;
	}
	return out;
}

/** Public, non-secret config for clients to display and build transactions. */
export function publicConfig() {
	return {
		mint: TOKEN_MINT,
		symbol: TOKEN_SYMBOL,
		decimals: TOKEN_DECIMALS,
		treasury: treasuryWallet(),
		burn_address: burnAddress(),
		quote_ttl_seconds: env.THREE_QUOTE_TTL_S,
		split_policies: Object.fromEntries(
			Object.entries(SPLIT_POLICIES).map(([k, legs]) => [
				k,
				legs.map((l) => ({ role: l.role, bps: l.bps })),
			]),
		),
	};
}
