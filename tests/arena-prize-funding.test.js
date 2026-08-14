// The Arena's payout authorization rule.
//
// POST /api/tournaments accepts `prize_pool_three` on the creator's word: nothing
// is escrowed, nothing is deposited, no balance is checked. Settlement then pays
// winners real $THREE out of the PLATFORM prize wallet. Left unbounded, those two
// facts compose into a withdrawal form on the treasury: declare a large pool,
// enter an agent you own, clear the verification gates with a handful of cheap
// pump.fun trades, close, settle. poolBacked() is the rule that says the platform
// only pays what it actually stands behind.
//
// Ranking, attestation, and the competition itself are deliberately NOT gated by
// this. Only the payout is, and it is refused loudly (BLOCKED with a reason on the
// entry) rather than silently.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { poolBacked, settlementBlockReason } from '../api/_lib/tournament-settlement.js';

const DECIMALS = 6;
const withPool = (three, entry_rules = {}) => ({
	network: 'mainnet',
	prize_pool_three: (BigInt(three) * 10n ** BigInt(DECIMALS)).toString(),
	entry_rules,
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('poolBacked', () => {
	it('refuses a user-declared pool nobody deposited', () => {
		expect(poolBacked(withPool(1_000_000))).toBe(false);
		expect(poolBacked(withPool(1))).toBe(false);
	});

	it('allows the house bracket, which the platform runs and funds itself', () => {
		expect(poolBacked(withPool(500, { house: 'daily' }))).toBe(true);
	});

	it('allows a zero pool, which has nothing to pay', () => {
		expect(poolBacked({ prize_pool_three: '0', entry_rules: {} })).toBe(true);
		expect(poolBacked({})).toBe(true);
	});

	it('honors an explicit sponsorship ceiling, and only up to it', () => {
		vi.stubEnv('ARENA_UNFUNDED_PRIZE_MAX_THREE', '1000');
		expect(poolBacked(withPool(1000))).toBe(true);
		expect(poolBacked(withPool(1001))).toBe(false);
	});
});

describe('settlementBlockReason', () => {
	it('reports the unfunded pool as the block reason on mainnet', () => {
		vi.stubEnv('THREE_PRIZE_PAYOUT_KEY', '');
		// Wallet unconfigured wins: it is the more fundamental blocker.
		expect(settlementBlockReason('mainnet', withPool(10))).toBe('payout_unconfigured');
	});

	it('never pays devnet prizes regardless of funding', () => {
		expect(settlementBlockReason('devnet', withPool(0, { house: 'daily' }))).toBe('devnet_no_prizes');
	});

	it('answers the environment question alone when given no tournament', () => {
		vi.stubEnv('THREE_PRIZE_PAYOUT_KEY', '');
		expect(settlementBlockReason('mainnet')).toBe('payout_unconfigured');
	});
});
