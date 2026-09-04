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

// Rent-exemption for the 165-byte wSOL account a usdc->sol swap creates to
// receive its output. The wallet pays it out of its own lamports inside the
// swap transaction (refunded when the account closes at the end of the same
// transaction), so a wallet holding less than this cannot buy SOL at all:
// simulation dies inside the ATA CreateIdempotent and no swap ever lands.
export const SWAP_OUTPUT_RENT_LAMPORTS = 1_855_569;
// Signature fee plus headroom for the extra instructions a swap carries.
const SWAP_FEE_BUFFER_LAMPORTS = 15_000;
const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_ATOMICS = 10 ** USDC_DECIMALS;

// The USDC-spending engine wallets and their floors: the shared allowlist for
// every USDC refill path (the rebalance cron's swap legs AND the master's
// direct topup in economy-usdc-topup.js), so the two can never disagree on who
// qualifies or at what floor. floorUsd is env-overridable per role.
//
// selfPayFee: this wallet ALSO pays its own SOL network fee on every self-pay
// ring settle, so it has a second, independent need: SOL. Without it the
// planner only ever saw the USDC side, and a payer that drifted under the
// settle floor while holding plenty of USDC deadlocked the whole ring (July
// 2026, twice): the facilitator rejected every settle while the rebalancer
// reported "above_floor".
export const USDC_WALLETS = [
	{ role: 'x402-ring-payer', floorEnv: 'ECONOMY_REBALANCE_RING_USDC_FLOOR', floorDflt: 10, selfPayFee: true },
	{ role: 'a2a-payer', floorEnv: 'ECONOMY_REBALANCE_A2A_USDC_FLOOR', floorDflt: 5 },
];

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
 * Resolve the fee-SOL level a self-pay wallet's BOTH legs aim at, and whether the
 * usdc->sol rescue leg is armed. PURE, so the policy is unit-testable.
 *
 * A self-pay wallet has two competing needs: fee SOL (target `targetSol`, the
 * level treasury-topup refills it to) and USDC working capital (floor
 * `usdcFloorUsd`). While its total value covers both, nothing here changes: the
 * legs use `targetSol` exactly as before.
 *
 * When its total value covers NEITHER, the old resolution deadlocked the wallet.
 * planRebalance holds back `targetSol` on the sol->usdc leg, so a wallet under
 * that target can never buy USDC; and the usdc->sol leg can only sell USDC above
 * the USDC reserve, which a starved wallet does not have. Both legs skip
 * (`insufficient_sol_surplus` + `insufficient_usdc_surplus`) on every run,
 * forever. Production, 2026-07-29 to 2026-08-06: the x402 ring payer sat at 0.140
 * SOL and $0.23 USDC against a 0.18 SOL target and a $12 USDC floor, the
 * rebalancer logged ZERO swaps for eight days, and `insufficient_payer_usdc` rose
 * from 4 to ~2,900 a day while the payer held fee SOL it had no way to spend.
 *
 * The escape is to pick ONE equilibrium and hold it on every run, because two
 * legs chasing two different targets is exactly the ping-pong the 2026-07-28 fix
 * eliminated. This wallet exists to SPEND USDC; fee SOL is instrumental. So the
 * constrained equilibrium is "keep the bare fee reserve, hold the rest as USDC",
 * and BOTH legs aim at that same reserve, so they converge instead of reversing.
 *
 * The rescue leg arms off that same reserve rather than off the registry's
 * `minSol`. `minSol` is the treasury-topup floor (how much SOL the master tries to
 * keep here), not "sell working capital to buy gas": arming on it makes any wallet
 * the master is behind on sell its USDC float for SOL it does not need, which is
 * how the ring's float turned into SOL in the first place (2026-07-28: 66
 * usdc->sol swaps, $438 churned).
 *
 * @param {object} a
 * @param {number} a.sol           live SOL balance
 * @param {number} a.usdc          live USDC balance (whole tokens)
 * @param {number} a.solPriceUsd   live SOL/USD price
 * @param {number} a.targetSol     the wallet's fee-SOL refill target
 * @param {number} a.usdcFloorUsd  the wallet's USDC floor
 * @param {number} [a.solReserve]  bare fee/rent headroom (defaults to REBALANCE)
 * @returns {{ solFloor: number, constrained: boolean, rescueArmed: boolean }}
 */
export function resolveSelfPayFloors({ sol, usdc, solPriceUsd, targetSol, usdcFloorUsd, solReserve }) {
	const reserve = Number.isFinite(solReserve) ? solReserve : REBALANCE.solReserve;
	const totalUsd = sol * solPriceUsd + usdc;
	const bothFloorsUsd = targetSol * solPriceUsd + usdcFloorUsd;
	// No price means no comparable totals; leave the unconstrained target in place
	// and let planRebalance abort the run honestly on `no_sol_price`.
	const constrained = solPriceUsd > 0 && totalUsd < bothFloorsUsd;
	const solFloor = constrained ? Math.min(reserve, targetSol) : targetSol;
	return { solFloor, constrained, rescueArmed: sol < reserve };
}

/**
 * Compute the swaps that would bring each wallet's spend-asset back to its floor,
 * honoring reserves, per-swap and per-run caps, and the dust floor. PURE.
 *
 * @param {object} p
 * @param {number} p.solPriceUsd                 live SOL/USD price
 * @param {Array<{name:string,pubkey:string,sol:number,usdc:number,wants:'usdc'|'sol',floorUsd:number,solFloor?:number,hasWsolAccount?:boolean}>} p.wallets
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

	// A self-pay wallet below BOTH floors submits two rows for the same pubkey
	// wanting opposite assets. Planning both would execute opposing swaps in one
	// run: two fees plus double slippage to mostly undo each other (observed
	// 2026-07-28 on the ring payer: usdc->sol $6.95 then sol->usdc $2.04, netting
	// the wallet AWAY from its USDC floor). The neediest leg wins the run; the
	// opposing leg waits for the next run against fresh balances.
	const plannedDir = new Map();

	for (const { w, shortfallUsd } of rows) {
		const wantDir = w.wants === 'usdc' ? 'sol->usdc' : 'usdc->sol';
		const prior = plannedDir.get(w.pubkey);
		if (prior && prior !== wantDir) {
			skipped.push({ name: w.name, reason: 'opposing_leg_same_run' });
			continue;
		}
		if (runRemainingUsd <= 0) {
			skipped.push({ name: w.name, reason: 'run_cap_reached' });
			continue;
		}
		if (shortfallUsd < B.dustUsd) {
			skipped.push({ name: w.name, reason: 'above_floor' });
			continue;
		}
		if (w.wants === 'usdc') {
			// Convert SOL → USDC, but keep the SOL reserve untouched. A self-pay
			// wallet's own fee-SOL refill target (w.solFloor) is part of that
			// reserve: feeding the USDC floor from SOL below the target just re-arms
			// the usdc->sol leg on the next run, and the two legs ping-pong swap
			// fees and slippage forever (observed 2026-07-28: ~134 reversing swaps,
			// ~$900 churned in 2.5 h, once the ring payer's total balance dropped
			// under the sum of its two floors). With the target held back,
			// sol->usdc can only fire while SOL sits ABOVE the target and
			// usdc->sol only while it sits BELOW minSol, so a reversal pair is
			// structurally impossible. Deliberately asymmetric: the usdc->sol leg
			// may still draw USDC down to the USDC reserve, because fee SOL is
			// what keeps settles alive at all.
			const keepSol = Math.max(B.solReserve, w.solFloor || 0);
			const swappableSolUsd = Math.max(0, (w.sol - keepSol) * solPriceUsd);
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
			plannedDir.set(w.pubkey, 'sol->usdc');
			runRemainingUsd = round(runRemainingUsd - inUsd);
		} else {
			// A wallet too poor to open the account its own swap output lands in
			// can never rescue itself, and planning the leg anyway costs a failed
			// simulation every run while reporting an opaque `failed` that names
			// neither the shortfall nor the fix. Measured on the ring payer
			// 2026-09-04: 1,253,408 lamports against a 1,855,569 rent line, with
			// 4.18 USDC it could not convert and the whole settle rail down
			// behind it. Skip with the numbers instead, so the surface an
			// operator reads says exactly how much SOL unlocks that USDC.
			// Waived when the wallet already holds a wSOL account: the rent is
			// paid, the create is a no-op, and only fees remain.
			const rentFloor = Number.isFinite(B.swapRentLamports)
				? B.swapRentLamports
				: SWAP_OUTPUT_RENT_LAMPORTS;
			const lamports = Math.floor(w.sol * LAMPORTS_PER_SOL);
			const rentNeeded = rentFloor + SWAP_FEE_BUFFER_LAMPORTS;
			if (!w.hasWsolAccount && lamports < rentNeeded) {
				skipped.push({ name: w.name, reason: `below_swap_rent:${lamports}<${rentNeeded}` });
				continue;
			}
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
			plannedDir.set(w.pubkey, 'usdc->sol');
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
