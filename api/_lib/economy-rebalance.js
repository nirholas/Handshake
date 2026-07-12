// Economy rebalancer — keeps each engine wallet stocked in the ASSET it spends.
//
// The topup cron (economy-master.js) moves SOL from the funding root down to any
// engine below its SOL floor. But some engines spend USDC, not SOL: the x402 ring
// payer and the a2a settlement payer settle invoices in USDC. Loading the economy
// with SOL alone leaves those wallets unable to work once their USDC runs out.
//
// This module closes that gap. For every wallet that spends USDC, when its USDC
// drops below a floor AND it holds SOL above its own operating reserve, it swaps a
// slice of that SOL into USDC on Jupiter — a SELF-swap, no cross-wallet transfer,
// so it composes cleanly with the topup: load SOL → topup spreads it → rebalance
// converts it to USDC exactly where a wallet needs USDC. The reverse also holds: a
// SOL-spending wallet starved of SOL while sitting on excess USDC swaps USDC → SOL.
//
// Safe by construction:
//   • OFF by default — inert until ECONOMY_REBALANCE_ENABLED=1.
//   • Never swaps a wallet below its SOL reserve (fee/rent headroom) or its USDC
//     reserve — only the surplus above a floor is ever converted.
//   • Per-swap and per-run USD caps bound every run; a dust-sized need is skipped.
//   • Slippage-capped Jupiter quote; a missing route or a quote past the cap aborts
//     that leg without touching a key.
//   • Only operates on wallets whose pubkey resolves from the signer registry.
//   • planRebalance() is PURE (no chain, no keys) so the decision is unit-testable
//     and the cron can log the plan before executing.

import { USDC_MINT_BY_NETWORK, USDC_DECIMALS, jupQuote, buildSwapTx } from './vault-jupiter.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_ATOMICS = 10 ** USDC_DECIMALS;

function num(name, dflt) {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v >= 0 ? v : dflt;
}

/** Global bounds — every value env-overridable so the owner can tune without a deploy. */
export const REBALANCE = {
	get enabled() {
		return process.env.ECONOMY_REBALANCE_ENABLED === '1';
	},
	// Keep this much SOL on any wallet for fees/rent — never swap it away.
	get solReserve() {
		return num('ECONOMY_REBALANCE_SOL_RESERVE', 0.03);
	},
	// Keep this much USDC on a USDC wallet before converting USDC → SOL.
	get usdcReserve() {
		return num('ECONOMY_REBALANCE_USDC_RESERVE', 2);
	},
	// Most USD-value the rebalancer converts in a single swap.
	get perSwapUsd() {
		return num('ECONOMY_REBALANCE_PER_SWAP_USD', 3);
	},
	// Most USD-value converted across all wallets in one run.
	get runCapUsd() {
		return num('ECONOMY_REBALANCE_RUN_CAP_USD', 6);
	},
	// A need smaller than this in USD isn't worth a swap's fee — skip honestly.
	get dustUsd() {
		return num('ECONOMY_REBALANCE_DUST_USD', 0.5);
	},
	get slippageBps() {
		return num('ECONOMY_REBALANCE_SLIPPAGE_BPS', 100);
	},
};

/**
 * Compute the swaps that would bring each wallet's spend-asset back to its floor,
 * honoring reserves, per-swap and per-run caps, and the dust floor. PURE.
 *
 * @param {object} p
 * @param {number} p.solPriceUsd                 live SOL/USD price
 * @param {Array<{name:string,pubkey:string,sol:number,usdc:number,wants:'usdc'|'sol',floorUsd:number}>} p.wallets
 * @param {object} [p.bounds]                     REBALANCE snapshot (injectable for tests)
 * @returns {{ plan:Array<{name:string,pubkey:string,dir:'sol->usdc'|'usdc->sol',inUsd:number,reason:string}>,
 *             skipped:Array<{name:string,reason:string}> }}
 */
export function planRebalance({ solPriceUsd, wallets, bounds }) {
	const B = bounds || {
		solReserve: REBALANCE.solReserve,
		usdcReserve: REBALANCE.usdcReserve,
		perSwapUsd: REBALANCE.perSwapUsd,
		runCapUsd: REBALANCE.runCapUsd,
		dustUsd: REBALANCE.dustUsd,
	};
	const plan = [];
	const skipped = [];
	let runRemainingUsd = B.runCapUsd;
	if (!(solPriceUsd > 0)) {
		return { plan: [], skipped: wallets.map((w) => ({ name: w.name, reason: 'no_sol_price' })) };
	}

	// Neediest first (largest shortfall), so a tight run cap serves the worst-off.
	const rows = wallets
		.map((w) => {
			const haveUsd = w.wants === 'usdc' ? w.usdc : w.sol * solPriceUsd;
			return { w, shortfallUsd: Math.max(0, w.floorUsd - haveUsd) };
		})
		.sort((a, b) => b.shortfallUsd - a.shortfallUsd);

	for (const { w, shortfallUsd } of rows) {
		if (runRemainingUsd <= 0) {
			skipped.push({ name: w.name, reason: 'run_cap_reached' });
			continue;
		}
		if (shortfallUsd < B.dustUsd) {
			skipped.push({ name: w.name, reason: 'above_floor' });
			continue;
		}
		if (w.wants === 'usdc') {
			// Convert SOL → USDC, but keep the SOL reserve untouched.
			const swappableSolUsd = Math.max(0, (w.sol - B.solReserve) * solPriceUsd);
			const inUsd = Math.min(shortfallUsd, swappableSolUsd, B.perSwapUsd, runRemainingUsd);
			if (inUsd < B.dustUsd) {
				skipped.push({ name: w.name, reason: 'insufficient_sol_surplus' });
				continue;
			}
			plan.push({
				name: w.name,
				pubkey: w.pubkey,
				dir: 'sol->usdc',
				inUsd: round(inUsd),
				reason: `usdc ${w.usdc.toFixed(2)} < floor ${w.floorUsd}`,
			});
			runRemainingUsd = round(runRemainingUsd - inUsd);
		} else {
			// Convert USDC → SOL, keeping the USDC reserve untouched.
			const swappableUsdcUsd = Math.max(0, w.usdc - B.usdcReserve);
			const inUsd = Math.min(shortfallUsd, swappableUsdcUsd, B.perSwapUsd, runRemainingUsd);
			if (inUsd < B.dustUsd) {
				skipped.push({ name: w.name, reason: 'insufficient_usdc_surplus' });
				continue;
			}
			plan.push({
				name: w.name,
				pubkey: w.pubkey,
				dir: 'usdc->sol',
				inUsd: round(inUsd),
				reason: `sol ${(w.sol * solPriceUsd).toFixed(2)}USD < floor ${w.floorUsd}`,
			});
			runRemainingUsd = round(runRemainingUsd - inUsd);
		}
	}
	return { plan, skipped };
}

function round(n) {
	return Math.round(n * 1e6) / 1e6;
}

/**
 * Execute one planned swap as a self-swap on the wallet that owns `keypair`.
 * Quotes on Jupiter, aborts if there's no route; builds, signs, submits, confirms.
 * Returns a structured outcome — never throws for a business-rule skip.
 */
export async function executeSwap({ connection, keypair, leg, solPriceUsd, network = 'mainnet' }) {
	const usdcMint = USDC_MINT_BY_NETWORK[network] || USDC_MINT_BY_NETWORK.mainnet;
	const slippageBps = REBALANCE.slippageBps;
	let inputMint;
	let outputMint;
	let amountRaw;
	if (leg.dir === 'sol->usdc') {
		inputMint = WSOL_MINT;
		outputMint = usdcMint;
		amountRaw = BigInt(Math.floor((leg.inUsd / solPriceUsd) * LAMPORTS_PER_SOL));
	} else {
		inputMint = usdcMint;
		outputMint = WSOL_MINT;
		amountRaw = BigInt(Math.floor(leg.inUsd * USDC_ATOMICS));
	}
	if (amountRaw <= 0n) return { name: leg.name, status: 'skipped', reason: 'amount_zero' };

	let quote;
	try {
		quote = await jupQuote({ inputMint, outputMint, amountRaw: amountRaw.toString(), slippageBps });
	} catch (err) {
		return { name: leg.name, status: 'skipped', reason: err.code || 'no_route' };
	}
	const tx = await buildSwapTx({ quote, userPublicKey: keypair.publicKey });
	tx.sign([keypair]);
	const { confirmOrThrow } = await import('./solana/confirm.js');
	const bh = await connection.getLatestBlockhash('confirmed');
	const sig = await connection.sendRawTransaction(tx.serialize(), {
		skipPreflight: false,
		maxRetries: 3,
	});
	await confirmOrThrow(connection, { signature: sig, ...bh }, 'confirmed');
	return {
		name: leg.name,
		status: 'swapped',
		dir: leg.dir,
		inUsd: leg.inUsd,
		outAmount: quote.outAmount,
		signature: sig,
	};
}
