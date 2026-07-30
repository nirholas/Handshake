// A USDC balance the refuel lane could not READ must never be planned as a
// wallet that is empty.
//
// The two states are indistinguishable in the old return shape and need opposite
// responses from the operator: `no_spare_usdc` means the revenue is spent and
// only owner funding fixes it, while an unreadable balance means an RPC lane is
// cooling and nothing needs funding at all. Production 2026-07-30 hit the second
// and reported the first: the economy master held 46 USDC while the refuel lane
// declined to act, so the circulation treasury stayed at 0.012 SOL, the
// pulse-tick governor held the paid-action budget at zero, and the Money Pulse
// ran reviews and trials only, with its own cure sitting in its own wallet.
//
// Covers the read itself (indexed scan unsupported, lane failure, genuine zero)
// through the real refuelMasterFromUsdc entrypoint.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { MASTER } = vi.hoisted(() => ({
	MASTER: 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW',
}));

vi.mock('../api/_lib/economy-master.js', () => ({
	loadEconomyMaster: vi.fn(async () => {
		const { Keypair } = await import('@solana/web3.js');
		return Keypair.generate();
	}),
	RESERVE_SOL: 0.02,
	RUN_CAP_SOL: 2,
}));

// The master reads as nearly dry, so there is always a real gap to refuel.
vi.mock('../api/_lib/avatar-wallet.js', () => ({
	getSolBalance: vi.fn(async () => ({ sol: 0.021, lamports: 21_000_000 })),
}));
vi.mock('../api/_lib/sol-price.js', () => ({ solPriceUsd: vi.fn(async () => 74) }));
vi.mock('../api/_lib/solana/confirm.js', () => ({ confirmOrThrow: vi.fn(async () => {}) }));
vi.mock('../api/_lib/vault-jupiter.js', () => ({
	USDC_MINT_BY_NETWORK: {
		mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		devnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	},
	USDC_DECIMALS: 6,
	// A route the lane refuses on price impact: it proves planning got past the
	// balance read without letting the test broadcast anything.
	jupQuote: vi.fn(async () => ({ priceImpactPct: 99, outAmount: 0 })),
	buildSwapTx: vi.fn(async () => { throw new Error('swap must not be reached in these cases'); }),
}));
vi.mock('../api/_lib/db.js', () => ({
	sql: Object.assign(vi.fn(async () => []), { unsafe: vi.fn(async () => []) }),
}));

import { refuelMasterFromUsdc } from '../api/_lib/economy-fuel.js';

/** A connection whose indexed scan and account read behave as configured. */
function conn({ scan, account }) {
	return {
		getParsedTokenAccountsByOwner: vi.fn(async () => {
			if (scan === 'throw') throw new Error('410 Gone: getParsedTokenAccountsByOwner is not supported');
			return { value: scan };
		}),
		getAccountInfo: vi.fn(async () => {
			if (account === 'throw') throw new Error('429 Too Many Requests: lane cooling');
			return account;
		}),
	};
}

/** An SPL token account buffer holding `whole` USDC (6 decimals). */
function tokenAccount(whole) {
	const data = Buffer.alloc(165);
	data.writeBigUInt64LE(BigInt(Math.round(whole * 1e6)), 64);
	return { data };
}

beforeEach(() => {
	delete process.env.ECONOMY_FUEL_ENABLED;
});

describe('refuel USDC balance read', () => {
	it('reports usdc_read_failed (not no_spare_usdc) when every read path fails', async () => {
		const res = await refuelMasterFromUsdc({
			connection: conn({ scan: 'throw', account: 'throw' }),
			deficitSol: 0.99,
			network: 'mainnet',
		});

		expect(res.acted).toBe(false);
		// The whole point: the operator must not be told the wallet is empty.
		expect(res.reason).toBe('usdc_read_failed');
		expect(res.reason).not.toBe('no_spare_usdc');
		expect(res.readError).toMatch(/429|cooling/i);
	});

	it('falls back to the derived ATA when the indexed scan is unsupported', async () => {
		const res = await refuelMasterFromUsdc({
			connection: conn({ scan: 'throw', account: tokenAccount(46.242025) }),
			deficitSol: 0.99,
			network: 'mainnet',
		});

		// 46 USDC is real spendable fuel, so the lane plans a swap rather than
		// declining. It stops at the quote, which these mocks refuse to serve.
		expect(res.reason).not.toBe('no_spare_usdc');
		expect(res.reason).not.toBe('usdc_read_failed');
		expect(res.usdcAvailable).toBeCloseTo(46.242025, 4);
	});

	it('still reports no_spare_usdc when the wallet is genuinely empty', async () => {
		// A null account from a DERIVED address is the chain confirming there is
		// nothing there, which is the one case that really needs owner funding.
		const res = await refuelMasterFromUsdc({
			connection: conn({ scan: 'throw', account: null }),
			deficitSol: 0.99,
			network: 'mainnet',
		});

		expect(res.acted).toBe(false);
		expect(res.reason).toBe('no_spare_usdc');
		expect(res.usdcAvailable).toBe(0);
	});

	it('prefers the indexed scan, summing every USDC account the owner holds', async () => {
		const acct = (amount) => ({ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } });
		const res = await refuelMasterFromUsdc({
			connection: conn({ scan: [acct('40000000'), acct('6242025')], account: 'throw' }),
			deficitSol: 0.99,
			network: 'mainnet',
		});

		expect(res.usdcAvailable).toBeCloseTo(46.242025, 4);
		expect(res.reason).not.toBe('usdc_read_failed');
	});
});
