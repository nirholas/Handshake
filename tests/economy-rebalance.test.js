import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { planRebalance } from '../api/_lib/economy-rebalance.js';
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
			wallets: [{ name: 'gas', pubkey: 'G', sol: 0.0, usdc: 20, wants: 'sol', floorUsd: 5 }],
		});
		expect(plan[0].dir).toBe('usdc->sol');
		expect(plan[0].inUsd).toBe(3); // per-swap cap
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
