// Tests for the x402 ring PAYER POOL — the reused rotating payer wallets
// (api/_lib/x402/pool.js) and their threshold funder (pipelines/ring-pool-fund.js).
// Pure logic only; no DB, no chain, no network.
//
// What these lock down:
//   • config gates — enable flag + target size parse exactly, off by default.
//   • balance decode — the SPL token-account amount is read from the right offset.
//   • funding planner — the pure decision (who needs SOL/USDC, who is overfull) is
//     correct, respects the controlled-set gate, and honors the per-run cap.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ringPoolEnabled, ringPoolTargetSize, ringPoolMaxGenerate } from '../api/_lib/x402/pool.js';
import { planPoolFunding, tokenAmountFromAccountData } from '../api/_lib/x402/pipelines/ring-pool-fund.js';

const FLOORS = {
	solFloor: 8_000_000, solTarget: 12_000_000,
	usdcFloor: 500_000, usdcTarget: 2_000_000, usdcCeil: 4_000_000,
	maxPerRun: 60,
};

describe('ring pool config gates', () => {
	const saved = {};
	beforeEach(() => { for (const k of ['X402_RING_POOL_ENABLED', 'X402_RING_POOL_SIZE', 'X402_RING_POOL_MAX_GENERATE']) saved[k] = process.env[k]; });
	afterEach(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

	it('is disabled by default and only "true" enables it', () => {
		delete process.env.X402_RING_POOL_ENABLED;
		expect(ringPoolEnabled()).toBe(false);
		process.env.X402_RING_POOL_ENABLED = '1';
		expect(ringPoolEnabled()).toBe(false);
		process.env.X402_RING_POOL_ENABLED = 'TRUE';
		expect(ringPoolEnabled()).toBe(true);
	});

	it('parses target size, rejecting junk and negatives', () => {
		delete process.env.X402_RING_POOL_SIZE;
		expect(ringPoolTargetSize()).toBe(0);
		process.env.X402_RING_POOL_SIZE = '750';
		expect(ringPoolTargetSize()).toBe(750);
		process.env.X402_RING_POOL_SIZE = '-5';
		expect(ringPoolTargetSize()).toBe(0);
		process.env.X402_RING_POOL_SIZE = 'abc';
		expect(ringPoolTargetSize()).toBe(0);
	});

	it('caps a single generate call (default 2000)', () => {
		delete process.env.X402_RING_POOL_MAX_GENERATE;
		expect(ringPoolMaxGenerate()).toBe(2000);
		process.env.X402_RING_POOL_MAX_GENERATE = '500';
		expect(ringPoolMaxGenerate()).toBe(500);
	});
});

describe('SPL token amount decode', () => {
	it('reads the u64 amount at byte offset 64, little-endian', () => {
		const data = Buffer.alloc(165); // SPL token account size
		data.writeBigUInt64LE(1_234_567n, 64);
		expect(tokenAmountFromAccountData(data)).toBe(1_234_567n);
	});
	it('treats a too-short / missing buffer as zero', () => {
		expect(tokenAmountFromAccountData(null)).toBe(0n);
		expect(tokenAmountFromAccountData(Buffer.alloc(10))).toBe(0n);
	});
});

describe('planPoolFunding (pure)', () => {
	const allowed = new Set(['A', 'B', 'C', 'D']);

	it('funds SOL below floor up to target', () => {
		const sol = new Map([['A', 1_000_000], ['B', 9_000_000]]); // A low, B fine
		const usdc = new Map([['A', 2_000_000n], ['B', 2_000_000n]]);
		const { solNeed } = planPoolFunding({ pubkeys: ['A', 'B'], solByPubkey: sol, usdcByPubkey: usdc, allowed, floors: FLOORS });
		expect(solNeed).toEqual([{ pk: 'A', add: 11_000_000 }]);
	});

	it('funds USDC below floor up to target and sweeps overfull back', () => {
		const sol = new Map([['A', 12_000_000], ['B', 12_000_000], ['C', 12_000_000]]);
		const usdc = new Map([['A', 100_000n], ['B', 2_000_000n], ['C', 5_000_000n]]); // A low, B fine, C overfull
		const { usdcNeed, usdcSweep } = planPoolFunding({ pubkeys: ['A', 'B', 'C'], solByPubkey: sol, usdcByPubkey: usdc, allowed, floors: FLOORS });
		expect(usdcNeed).toEqual([{ pk: 'A', add: 1_900_000n }]);
		expect(usdcSweep).toEqual([{ pk: 'C', take: 3_000_000n }]);
	});

	it('never funds a wallet outside the controlled set', () => {
		const sol = new Map([['A', 0], ['X', 0]]);
		const usdc = new Map([['A', 0n], ['X', 0n]]);
		const { solNeed, usdcNeed } = planPoolFunding({ pubkeys: ['A', 'X'], solByPubkey: sol, usdcByPubkey: usdc, allowed, floors: FLOORS });
		expect(solNeed.map((w) => w.pk)).toEqual(['A']);
		expect(usdcNeed.map((w) => w.pk)).toEqual(['A']);
	});

	it('honors the per-run cap', () => {
		const pks = Array.from({ length: 100 }, (_, i) => `w${i}`);
		const allowAll = new Set(pks);
		const sol = new Map(pks.map((p) => [p, 0]));
		const usdc = new Map(pks.map((p) => [p, 0n]));
		const { solNeed, usdcNeed } = planPoolFunding({ pubkeys: pks, solByPubkey: sol, usdcByPubkey: usdc, allowed: allowAll, floors: { ...FLOORS, maxPerRun: 10 } });
		expect(solNeed).toHaveLength(10);
		expect(usdcNeed).toHaveLength(10);
	});
});
