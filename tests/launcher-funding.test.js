import { describe, it, expect } from 'vitest';
import { fundAgentForLaunch, loadMasterSigner, masterReserveSol } from '../api/_lib/launcher-funding.js';

// These exercise the business-rule guards that fire BEFORE any chain/RPC call, so
// they run without a wallet, RPC, or DB. They prove the caps actually refuse —
// the safety contract the engine relies on to record a clean 'skipped' run.

describe('fundAgentForLaunch — caps refuse before spending', () => {
	const base = { agentAddress: 'AgentSoLAddrXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', network: 'devnet' };

	it('refuses a non-positive amount', async () => {
		const r = await fundAgentForLaunch({ ...base, sol: 0, perLaunchCapSol: 1, dailyCapSol: 1 });
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/positive/);
	});

	it('refuses when the per-launch cap is exceeded', async () => {
		const r = await fundAgentForLaunch({ ...base, sol: 2, perLaunchCapSol: 1, dailyCapSol: 100 });
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/per-launch/);
	});

	it('refuses when the daily allowance is exhausted', async () => {
		const r = await fundAgentForLaunch({ ...base, sol: 0.5, perLaunchCapSol: 1, dailyCapSol: 0.1 });
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/daily/);
	});

	it('refuses cleanly (never throws) when the master wallet is unconfigured', async () => {
		const prev = process.env.LAUNCHER_MASTER_SECRET_KEY_B64;
		const prevFb = process.env.PUMP_X402_LAUNCHER_SECRET_KEY_B64;
		delete process.env.LAUNCHER_MASTER_SECRET_KEY_B64;
		delete process.env.PUMP_X402_LAUNCHER_SECRET_KEY_B64;
		try {
			const r = await fundAgentForLaunch({ ...base, sol: 0.02, perLaunchCapSol: 1, dailyCapSol: 1 });
			expect(r.ok).toBe(false);
			expect(r.reason).toMatch(/not configured/);
		} finally {
			if (prev) process.env.LAUNCHER_MASTER_SECRET_KEY_B64 = prev;
			if (prevFb) process.env.PUMP_X402_LAUNCHER_SECRET_KEY_B64 = prevFb;
		}
	});
});

describe('loadMasterSigner', () => {
	it('returns null when no master secret is set', async () => {
		const prev = process.env.LAUNCHER_MASTER_SECRET_KEY_B64;
		const prevFb = process.env.PUMP_X402_LAUNCHER_SECRET_KEY_B64;
		delete process.env.LAUNCHER_MASTER_SECRET_KEY_B64;
		delete process.env.PUMP_X402_LAUNCHER_SECRET_KEY_B64;
		try {
			expect(await loadMasterSigner()).toBeNull();
		} finally {
			if (prev) process.env.LAUNCHER_MASTER_SECRET_KEY_B64 = prev;
			if (prevFb) process.env.PUMP_X402_LAUNCHER_SECRET_KEY_B64 = prevFb;
		}
	});
});

// The funding master is the SAME keypair as the x402 ring payer. A transfer that
// left only fee dust behind pushed that wallet under the facilitator's 0.02 SOL
// settle floor and took every paid endpoint down (2026-07-25 and 2026-07-26,
// with 3+ SOL idle in agent wallets at the time). The reserve is what keeps a
// funding run from cannibalising the payment rail.
describe('masterReserveSol — the shared-wallet operating floor', () => {
	const KEY = 'LAUNCHER_MASTER_RESERVE_SOL';
	const withEnv = (v, fn) => {
		const prev = process.env[KEY];
		if (v === undefined) delete process.env[KEY]; else process.env[KEY] = v;
		try { return fn(); } finally {
			if (prev === undefined) delete process.env[KEY]; else process.env[KEY] = prev;
		}
	};

	it('defaults comfortably above the 0.02 SOL x402 settle floor', () => {
		withEnv(undefined, () => {
			expect(masterReserveSol()).toBe(0.05);
			expect(masterReserveSol()).toBeGreaterThan(0.02);
		});
	});

	it('honors an environment override', () => {
		withEnv('0.15', () => expect(masterReserveSol()).toBe(0.15));
	});

	it('allows an explicit zero (roles split onto separate keypairs)', () => {
		withEnv('0', () => expect(masterReserveSol()).toBe(0));
	});

	it('ignores junk and negatives rather than disabling the floor', () => {
		withEnv('not-a-number', () => expect(masterReserveSol()).toBe(0.05));
		withEnv('-1', () => expect(masterReserveSol()).toBe(0.05));
	});
});
