import { describe, it, expect } from 'vitest';
import { optedInAgentIds, agentPerTradeSol } from '../workers/agent-sniper/auto-funder.js';
import { fundTriggerSol, fundTargetSol, antiOscillationFloorSol, autoFundMinSol } from '../api/_lib/agent-funding-policy.js';
import { MIN_OPERATIONAL_WALLET_SOL } from '../api/_lib/agent-trade-guards.js';

// The auto-funder may only move SOL to agents whose strategy has EXPLICITLY
// opted in (auto_fund_enabled === true). Arming a strategy must never, on its
// own, make the launcher master push funds — that implicit trigger was the
// documented footgun. These tests pin the fail-safe default.

describe('optedInAgentIds — explicit auto-fund consent', () => {
	it('excludes an enabled strategy that did NOT opt in (the footgun case)', () => {
		const strategies = [
			{ agent_id: 'a1', network: 'mainnet', enabled: true, auto_fund_enabled: false },
		];
		expect(optedInAgentIds(strategies, 'mainnet')).toEqual([]);
	});

	it('includes only strategies that explicitly opted in', () => {
		const strategies = [
			{ agent_id: 'a1', network: 'mainnet', auto_fund_enabled: true },
			{ agent_id: 'a2', network: 'mainnet', auto_fund_enabled: false },
			{ agent_id: 'a3', network: 'mainnet' }, // flag absent → treated as no
		];
		expect(optedInAgentIds(strategies, 'mainnet')).toEqual(['a1']);
	});

	it('treats a missing flag as no-consent (fail-safe mid-migration)', () => {
		const strategies = [{ agent_id: 'a1', network: 'mainnet', auto_fund_enabled: undefined }];
		expect(optedInAgentIds(strategies, 'mainnet')).toEqual([]);
	});

	it('never treats a truthy-but-not-true value as consent', () => {
		// Guards against a stringy DB value ('t', 1, 'true') silently authorizing funds.
		const strategies = [
			{ agent_id: 'a1', network: 'mainnet', auto_fund_enabled: 'true' },
			{ agent_id: 'a2', network: 'mainnet', auto_fund_enabled: 1 },
		];
		expect(optedInAgentIds(strategies, 'mainnet')).toEqual([]);
	});

	it('scopes to the requested network', () => {
		const strategies = [
			{ agent_id: 'a1', network: 'mainnet', auto_fund_enabled: true },
			{ agent_id: 'a2', network: 'devnet', auto_fund_enabled: true },
		];
		expect(optedInAgentIds(strategies, 'devnet')).toEqual(['a2']);
	});

	it('dedupes an agent that has multiple opted-in strategies', () => {
		const strategies = [
			{ agent_id: 'a1', network: 'mainnet', auto_fund_enabled: true },
			{ agent_id: 'a1', network: 'mainnet', auto_fund_enabled: true },
		];
		expect(optedInAgentIds(strategies, 'mainnet')).toEqual(['a1']);
	});

	it('handles empty/nullish input', () => {
		expect(optedInAgentIds(undefined, 'mainnet')).toEqual([]);
		expect(optedInAgentIds([], 'mainnet')).toEqual([]);
	});
});

describe('agentPerTradeSol (funding levels are sized off the arm, not a flat floor)', () => {
	const strategies = [
		{ agent_id: 'a1', network: 'mainnet', auto_fund_enabled: true, per_trade_lamports: 2_000_000 },
		{ agent_id: 'a1', network: 'mainnet', auto_fund_enabled: true, per_trade_lamports: 130_000_000 },
		{ agent_id: 'a1', network: 'devnet', auto_fund_enabled: true, per_trade_lamports: 999_000_000 },
		{ agent_id: 'a2', network: 'mainnet', auto_fund_enabled: false, per_trade_lamports: 500_000_000 },
	];

	it('takes the largest size across an agent’s opted-in strategies on that network', () => {
		expect(agentPerTradeSol(strategies, 'a1', 'mainnet')).toBe(0.13);
	});

	it('ignores strategies the funder does not manage', () => {
		expect(agentPerTradeSol(strategies, 'a2', 'mainnet')).toBe(0);
	});

	it('returns 0 for an unknown agent or empty input', () => {
		expect(agentPerTradeSol(strategies, 'nope', 'mainnet')).toBe(0);
		expect(agentPerTradeSol(undefined, 'a1', 'mainnet')).toBe(0);
	});
});

describe('funding levels vs the reclaim floor (the invariant that stops the ping-pong)', () => {
	// The production shape: an arm sized at 0.13 SOL/trade sitting on 0.035 SOL was
	// above the flat 0.02 floor, so the funder called it healthy while every entry
	// it attempted had to be clamped down to whatever was left.
	it('treats a wallet that cannot cover its own trade size as needing a refill', () => {
		const perTradeSol = 0.13;
		expect(fundTriggerSol({ perTradeSol })).toBeGreaterThan(perTradeSol);
		expect(fundTriggerSol({ perTradeSol })).toBeGreaterThan(0.035);
	});

	it('keeps the same hysteresis band at any size, so a big arm is not refilled more often', () => {
		const band = (perTradeSol) => fundTargetSol({ perTradeSol }) - fundTriggerSol({ perTradeSol });
		expect(band(0.002)).toBeCloseTo(band(0.5), 9);
	});

	it('never lets the reclaim floor sit below what the funder will restore', () => {
		for (const perTradeSol of [0, 0.002, 0.01, 0.13, 0.5]) {
			const floor = antiOscillationFloorSol({ autoFundEnabled: true, perTradeSol });
			expect(floor).toBeGreaterThanOrEqual(fundTargetSol({ perTradeSol }));
		}
	});

	it('leaves wallets the funder does not manage free to be swept', () => {
		expect(antiOscillationFloorSol({ autoFundEnabled: false, perTradeSol: 0.5 })).toBe(0);
	});

	it('never drops below the flat configured floor or the operational minimum', () => {
		expect(fundTriggerSol({})).toBeGreaterThanOrEqual(autoFundMinSol());
		expect(fundTriggerSol({ perTradeSol: 0.001 })).toBeGreaterThanOrEqual(MIN_OPERATIONAL_WALLET_SOL);
	});
});
