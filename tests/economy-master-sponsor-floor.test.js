// The sweep must never starve x402 settlement.
//
// In production the economy master IS the x402 sponsor fee wallet
// (X402_FEE_PAYER_SOLANA points at ECONOMY_MASTER_ADDRESS). The self-facilitator
// fail-closes every settle the moment that wallet dips below its own floor
// (X402_SPONSOR_SOL_FLOOR_LAMPORTS, 0.02 SOL), so a sweep that spent the master
// down to RESERVE_SOL parked it AT the settle floor and killed payments seconds
// later. The 2026-07-27 ledger caught it exactly: a transfer to
// pump-x402-launcher took the master 0.05408 -> 0.02000, and every settle after
// it returned fee_wallet_below_floor. Funding the wallet only ever bought hours.
//
// Rule under test: when the master doubles as the sponsor, the sweep floor is
// the settle floor plus working headroom, not the master's bare reserve. When
// it does not (a separate sponsor wallet, or no x402 config), nothing changes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const MASTER = 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW';
const OTHER = 'X4o2UuVNMxnrgkzVy97kPF5gmS6CLRCVJGB48VastML';

const target = (name, currentSol, refillToSol) => ({ name, pubkey: `pk-${name}`, currentSol, refillToSol });

let saved;
beforeEach(() => {
	saved = {
		fee: process.env.X402_FEE_PAYER_SOLANA,
		floor: process.env.X402_SPONSOR_SOL_FLOOR_LAMPORTS,
		headroom: process.env.ECONOMY_MASTER_SPONSOR_HEADROOM_SOL,
	};
});
afterEach(() => {
	for (const [k, v] of [
		['X402_FEE_PAYER_SOLANA', saved.fee],
		['X402_SPONSOR_SOL_FLOOR_LAMPORTS', saved.floor],
		['ECONOMY_MASTER_SPONSOR_HEADROOM_SOL', saved.headroom],
	]) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe('sweepFloorSol', () => {
	it('reserves the settle floor plus headroom when the master is the sponsor', async () => {
		const { sweepFloorSol, RESERVE_SOL } = await import('../api/_lib/economy-master.js');
		process.env.X402_FEE_PAYER_SOLANA = MASTER;
		process.env.X402_SPONSOR_SOL_FLOOR_LAMPORTS = '20000000'; // 0.02 SOL
		process.env.ECONOMY_MASTER_SPONSOR_HEADROOM_SOL = '0.03';

		expect(sweepFloorSol()).toBeCloseTo(0.05, 6);
		// Strictly above the settle floor: that gap is the whole point.
		expect(sweepFloorSol()).toBeGreaterThan(0.02);
		expect(sweepFloorSol()).toBeGreaterThanOrEqual(RESERVE_SOL);
	});

	it('falls back to the plain reserve when a separate wallet sponsors', async () => {
		const { sweepFloorSol, RESERVE_SOL } = await import('../api/_lib/economy-master.js');
		process.env.X402_FEE_PAYER_SOLANA = OTHER;

		expect(sweepFloorSol()).toBe(RESERVE_SOL);
	});

	it('falls back to the plain reserve when x402 is not configured', async () => {
		const { sweepFloorSol, RESERVE_SOL } = await import('../api/_lib/economy-master.js');
		delete process.env.X402_FEE_PAYER_SOLANA;

		expect(sweepFloorSol()).toBe(RESERVE_SOL);
	});
});

describe('planTopUps respects the sponsor floor', () => {
	it('does not plan the transfer that killed settlement on 2026-07-27', async () => {
		const { planTopUps } = await import('../api/_lib/economy-master.js');
		process.env.X402_FEE_PAYER_SOLANA = MASTER;
		process.env.X402_SPONSOR_SOL_FLOOR_LAMPORTS = '20000000';
		process.env.ECONOMY_MASTER_SPONSOR_HEADROOM_SOL = '0.03';

		// The exact production state: master at 0.05408, one hungry engine.
		const { plan, spendableSol } = planTopUps(0.05408, [target('pump-x402-launcher', 0.001, 0.15)]);

		// Spendable is now 0.00408 (below the dust threshold), not 0.03408.
		expect(spendableSol).toBeCloseTo(0.00408, 5);
		expect(plan).toEqual([]);
	});

	it('still funds engines from the surplus above the sponsor floor', async () => {
		const { planTopUps } = await import('../api/_lib/economy-master.js');
		process.env.X402_FEE_PAYER_SOLANA = MASTER;
		process.env.X402_SPONSOR_SOL_FLOOR_LAMPORTS = '20000000';
		process.env.ECONOMY_MASTER_SPONSOR_HEADROOM_SOL = '0.03';

		const { plan, totalSol, spendableSol } = planTopUps(0.5, [target('pump-cron-relayer', 0.001, 0.15)]);

		expect(spendableSol).toBeCloseTo(0.45, 6);
		expect(plan).toHaveLength(1);
		expect(totalSol).toBeGreaterThan(0);
		// And what it leaves behind still clears the settle floor.
		expect(0.5 - totalSol).toBeGreaterThan(0.02);
	});
});
