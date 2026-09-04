import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { planRebalance, resolveSelfPayFloors } from '../api/_lib/economy-rebalance.js';
import { loadSignerKeypair, SOLANA_SIGNERS } from '../api/_lib/solana-signers.js';

// Fixed bounds so the test doesn't depend on env: $3/swap, $6/run, keep 0.03 SOL
// and $2 USDC in reserve, skip needs under $0.50.
const bounds = { solReserve: 0.03, usdcReserve: 2, perSwapUsd: 3, runCapUsd: 6, dustUsd: 0.5 };
const SOL = 150; // $/SOL

describe('planRebalance', () => {
	it('converts SOL → USDC for a wallet below its USDC floor, capped per-swap', () => {
		const { plan } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [{ name: 'ring', pubkey: 'R', sol: 1, usdc: 0, wants: 'usdc', floorUsd: 10 }],
		});
		expect(plan).toHaveLength(1);
		expect(plan[0].dir).toBe('sol->usdc');
		// shortfall $10 but per-swap cap is $3
		expect(plan[0].inUsd).toBe(3);
	});

	it('never swaps the SOL reserve away', () => {
		// Only 0.05 SOL total; reserve is 0.03 → 0.02 SOL ($3) swappable, but the
		// need is $10 so it converts the whole $3 surplus and no more.
		const { plan } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [{ name: 'ring', pubkey: 'R', sol: 0.05, usdc: 0, wants: 'usdc', floorUsd: 10 }],
		});
		expect(plan[0].inUsd).toBeCloseTo(3, 5); // min($10 need, $3 surplus, $3 per-swap)
	});

	it('skips a wallet already at/above its floor (dust)', () => {
		const { plan, skipped } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [{ name: 'ring', pubkey: 'R', sol: 1, usdc: 9.8, wants: 'usdc', floorUsd: 10 }],
		});
		expect(plan).toHaveLength(0);
		expect(skipped[0].reason).toBe('above_floor');
	});

	it('honors the per-run cap across multiple wallets, neediest first', () => {
		const { plan } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [
				{ name: 'a2a', pubkey: 'A', sol: 1, usdc: 4, wants: 'usdc', floorUsd: 5 }, // need $1
				{ name: 'ring', pubkey: 'R', sol: 1, usdc: 0, wants: 'usdc', floorUsd: 10 }, // need $10
			],
		});
		// run cap $6: ring (neediest) takes $3, a2a takes $1 → total $4 ≤ $6, both served
		const total = plan.reduce((s, p) => s + p.inUsd, 0);
		expect(total).toBeLessThanOrEqual(6);
		expect(plan.find((p) => p.name === 'ring').inUsd).toBe(3);
		expect(plan[0].name).toBe('ring'); // neediest first
	});

	it('converts USDC → SOL when a SOL-spending wallet is starved but holds USDC', () => {
		const { plan } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			// 0.01 SOL: under its floor, but still able to fund the wSOL account
			// the swap output lands in (see the rent guard below).
			wallets: [{ name: 'gas', pubkey: 'G', sol: 0.01, usdc: 20, wants: 'sol', floorUsd: 5 }],
		});
		expect(plan[0].dir).toBe('usdc->sol');
		expect(plan[0].inUsd).toBe(3); // per-swap cap
	});

	// The ring payer deadlock of 2026-09-04: 1,253,408 lamports, 4.18 USDC it
	// could not convert, and a usdc->sol leg planned every 30 minutes that died
	// in simulation creating the wSOL account it could not afford. A plan that
	// cannot execute is worse than an honest skip, because the reason an
	// operator reads has to name the SOL that unlocks the USDC.
	it('skips a USDC → SOL rescue the wallet cannot pay the output rent for', () => {
		const { plan, skipped } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [{ name: 'ring-payer', pubkey: 'X', sol: 0.001253408, usdc: 4.18, wants: 'sol', floorUsd: 5 }],
		});
		expect(plan).toHaveLength(0);
		expect(skipped[0].name).toBe('ring-payer');
		expect(skipped[0].reason).toBe('below_swap_rent:1253408<1870569');
	});

	it('plans the rescue anyway when the wallet already holds a wSOL account', () => {
		// The rent is already paid, so the create is a no-op and only fees remain.
		const { plan } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [
				{ name: 'ring-payer', pubkey: 'X', sol: 0.001253408, usdc: 4.18, wants: 'sol', floorUsd: 5, hasWsolAccount: true },
			],
		});
		expect(plan).toHaveLength(1);
		expect(plan[0].dir).toBe('usdc->sol');
	});

	it('never plans opposing swaps on the same wallet in one run', () => {
		// The 2026-07-28 churn: the ring payer sat below BOTH floors, so the cron
		// submitted a wants:'usdc' row and a wants:'sol' row for the same pubkey.
		// The planner executed both directions back to back, paying two swap fees
		// to mostly undo itself and ending FURTHER from the USDC floor. The
		// neediest leg must win the run; the opposing leg is deferred.
		const { plan, skipped } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [
				{ name: 'ring', pubkey: 'R', sol: 0.05, usdc: 9.9, wants: 'usdc', floorUsd: 12 },
				{ name: 'ring', pubkey: 'R', sol: 0.05, usdc: 9.9, wants: 'sol', floorUsd: 15 },
			],
		});
		expect(plan).toHaveLength(1);
		expect(plan[0].dir).toBe('usdc->sol'); // SOL shortfall ($7.50) beats USDC ($2.10)
		expect(skipped).toContainEqual({ name: 'ring', reason: 'opposing_leg_same_run' });
	});

	it('still serves same-direction rows on one wallet without deferral', () => {
		// Two rows, same pubkey, both wanting USDC: no opposition, both plan.
		const { plan, skipped } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [
				{ name: 'ring', pubkey: 'R', sol: 1, usdc: 0, wants: 'usdc', floorUsd: 10 },
				{ name: 'ring', pubkey: 'R', sol: 1, usdc: 0, wants: 'usdc', floorUsd: 4 },
			],
		});
		expect(plan).toHaveLength(2);
		expect(skipped.find((s) => s.reason === 'opposing_leg_same_run')).toBeUndefined();
	});

	it('never dips into a self-pay wallet fee-SOL target to feed the USDC floor', () => {
		// 0.08 SOL against a 0.09 SOL target: everything the wallet holds is fee
		// runway, so the sol->usdc leg must stand down despite a real USDC
		// shortfall instead of stripping the SOL the usdc->sol leg would then
		// re-buy next run.
		const { plan, skipped } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [{ name: 'ring', pubkey: 'R', sol: 0.08, usdc: 3, wants: 'usdc', floorUsd: 10, solFloor: 0.09 }],
		});
		expect(plan).toHaveLength(0);
		expect(skipped[0].reason).toBe('insufficient_sol_surplus');
	});

	it('cannot oscillate across runs: refilled fee SOL is never clawed back', () => {
		// The 2026-07-28 burn after the same-run guard landed: run N refills fee
		// SOL from USDC, run N+1 sees USDC under its floor and reverses the swap,
		// forever (~134 reversing swaps, ~$900 churned in 2.5 h). Run 1: SOL below
		// its floor with USDC available, only the SOL leg plans.
		const run1 = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [
				{ name: 'ring', pubkey: 'R', sol: 0.01, usdc: 12, wants: 'usdc', floorUsd: 10, solFloor: 0.09 },
				{ name: 'ring', pubkey: 'R', sol: 0.01, usdc: 12, wants: 'sol', floorUsd: 0.09 * SOL },
			],
		});
		expect(run1.plan).toHaveLength(1);
		expect(run1.plan[0].dir).toBe('usdc->sol');
		// Run 2 against the post-swap balances: SOL sits at its target, USDC has
		// dropped under its floor. The USDC leg has no surplus above the fee
		// target, so nothing reverses and the wallet holds steady.
		const run2 = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [{ name: 'ring', pubkey: 'R', sol: 0.09, usdc: 9, wants: 'usdc', floorUsd: 10, solFloor: 0.09 }],
		});
		expect(run2.plan).toHaveLength(0);
		expect(run2.skipped[0].reason).toBe('insufficient_sol_surplus');
	});

	it('aborts everything if the SOL price is unavailable', () => {
		const { plan, skipped } = planRebalance({
			solPriceUsd: 0,
			bounds,
			wallets: [{ name: 'ring', pubkey: 'R', sol: 1, usdc: 0, wants: 'usdc', floorUsd: 10 }],
		});
		expect(plan).toHaveLength(0);
		expect(skipped[0].reason).toBe('no_sol_price');
	});
});

// The 2026-08-06 deadlock: the ring payer held 0.140 SOL and $0.23 USDC against a
// 0.18 SOL fee target and a $12 USDC floor. planRebalance holds back the fee
// target on the sol->usdc leg, and the usdc->sol leg can only sell USDC above the
// $2 reserve, so BOTH legs skipped on every run. Production logged zero rebalance
// swaps for eight days while insufficient_payer_usdc climbed to ~2,900 a day.
// resolveSelfPayFloors is the escape: when a wallet cannot afford both floors,
// both legs aim at the bare fee reserve instead, so they converge on one
// equilibrium rather than reversing each other.
describe('resolveSelfPayFloors', () => {
	const P = 150; // $/SOL
	const base = { solPriceUsd: P, targetSol: 0.18, usdcFloorUsd: 12, solReserve: 0.05 };

	it('leaves the fee target alone while the wallet can afford both floors', () => {
		// 0.30 SOL ($45) + $12 = $57 against a $39 combined need.
		const r = resolveSelfPayFloors({ ...base, sol: 0.3, usdc: 12 });
		expect(r.constrained).toBe(false);
		expect(r.solFloor).toBe(0.18);
	});

	it('drops both legs to the bare fee reserve when the wallet cannot afford both', () => {
		const r = resolveSelfPayFloors({ ...base, sol: 0.140089663, usdc: 0.23205 });
		expect(r.constrained).toBe(true);
		expect(r.solFloor).toBe(0.05);
	});

	it('unblocks the deadlocked payer with a single converging swap', () => {
		const bounds2 = { solReserve: 0.05, usdcReserve: 2, perSwapUsd: 50, runCapUsd: 100, dustUsd: 0.5 };
		const rows = (sol, usdc) => {
			const f = resolveSelfPayFloors({ ...base, sol, usdc });
			const out = [{ name: 'ring', pubkey: 'R', sol, usdc, wants: 'usdc', floorUsd: 12, solFloor: f.solFloor }];
			if (f.rescueArmed) out.push({ name: 'ring', pubkey: 'R', sol, usdc, wants: 'sol', floorUsd: f.solFloor * P });
			return out;
		};
		const run1 = planRebalance({ solPriceUsd: P, bounds: bounds2, wallets: rows(0.140089663, 0.23205) });
		expect(run1.plan).toHaveLength(1);
		expect(run1.plan[0].dir).toBe('sol->usdc');
		// Run 2 against the post-swap balances: at the USDC floor, nothing reverses.
		const sol2 = 0.140089663 - run1.plan[0].inUsd / P;
		const usdc2 = 0.23205 + run1.plan[0].inUsd;
		const run2 = planRebalance({ solPriceUsd: P, bounds: bounds2, wallets: rows(sol2, usdc2) });
		expect(run2.plan).toHaveLength(0);
		expect(run2.skipped[0].reason).toBe('above_floor');
	});

	it('arms the usdc->sol rescue only under the bare fee reserve, not the topup floor', () => {
		// 0.14 SOL is under the registry minSol (0.15) that used to arm this leg, and
		// that is what made the payer sell working capital for gas it did not need.
		expect(resolveSelfPayFloors({ ...base, sol: 0.14, usdc: 0.23 }).rescueArmed).toBe(false);
		expect(resolveSelfPayFloors({ ...base, sol: 0.01, usdc: 12 }).rescueArmed).toBe(true);
	});

	it('never raises the floor above the fee target', () => {
		const r = resolveSelfPayFloors({ ...base, targetSol: 0.02, sol: 0.001, usdc: 0 });
		expect(r.solFloor).toBe(0.02);
	});

	it('keeps the unconstrained target when the SOL price is unavailable', () => {
		const r = resolveSelfPayFloors({ ...base, solPriceUsd: 0, sol: 0.14, usdc: 0.23 });
		expect(r.constrained).toBe(false);
		expect(r.solFloor).toBe(0.18);
	});
});

// Regression guard for the ring-payer refill crash: the rebalance cron once
// assigned loadSignerKeypair's WRAPPER ({ configured, keypair, decodeError }) to
// `keypair` and then read `keypair.publicKey`, which is undefined — so every
// executeSwap crashed with "Cannot read properties of undefined (reading
// 'toBase58')" and the ring payer never got refilled. This pins the contract:
// the signable Keypair lives on `.keypair`, and the wrapper itself has no
// `.publicKey`. executeSwap must be handed `.keypair`, never the wrapper.
describe('loadSignerKeypair return shape (ring-payer refill seam)', () => {
	const ringSpec = SOLANA_SIGNERS.find((s) => s.name === 'x402-ring-payer');

	it('names the x402-ring-payer signer with a decodable env', () => {
		expect(ringSpec).toBeTruthy();
		expect(ringSpec.env).toBe('X402_SEED_SOLANA_SECRET_BASE58');
	});

	it('returns { keypair } whose .keypair carries publicKey, not the wrapper', async () => {
		// Deterministic key from a fixed 32-byte seed — no randomness.
		const seed = new Uint8Array(32).fill(7);
		const kp = Keypair.fromSeed(seed);
		const prev = process.env[ringSpec.env];
		process.env[ringSpec.env] = bs58.encode(kp.secretKey);
		try {
			const loaded = await loadSignerKeypair(ringSpec);
			// The wrapper does NOT expose publicKey — reading it (the old bug) is undefined.
			expect(loaded.publicKey).toBeUndefined();
			// The signable Keypair is on .keypair, and it round-trips to the pubkey.
			expect(loaded.configured).toBe(true);
			expect(loaded.decodeError).toBe(false);
			expect(loaded.keypair).toBeTruthy();
			expect(loaded.keypair.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
		} finally {
			if (prev === undefined) delete process.env[ringSpec.env];
			else process.env[ringSpec.env] = prev;
		}
	});

	it('reports unconfigured when the env is unset', async () => {
		const prev = process.env[ringSpec.env];
		const prevFallback = ringSpec.fallbackEnv ? process.env[ringSpec.fallbackEnv] : undefined;
		delete process.env[ringSpec.env];
		if (ringSpec.fallbackEnv) delete process.env[ringSpec.fallbackEnv];
		try {
			const loaded = await loadSignerKeypair(ringSpec);
			expect(loaded.configured).toBe(false);
			expect(loaded.keypair).toBeNull();
		} finally {
			if (prev !== undefined) process.env[ringSpec.env] = prev;
			if (ringSpec.fallbackEnv && prevFallback !== undefined) {
				process.env[ringSpec.fallbackEnv] = prevFallback;
			}
		}
	});
});
