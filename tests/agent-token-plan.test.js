// The rules that decide what an agent token IS before it exists on chain
// (api/_lib/agent-token-plan.js).
//
// These are the rules that stand between an owner and an irreversible mainnet
// mint, so each one is pinned here: normalization must not carry a dev buy in a
// currency the coin is no longer paired with, readiness must refuse a launch the
// chain would reject, and the cost estimate must be the same number the launch
// quote endpoint charges. `markPlanLaunched` must be idempotent, because the
// launch paths call it after a confirmed mint and a retry must not rewrite the
// record of what already happened.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sqlCalls = [];
const sqlQueue = [];

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlCalls.push({ text: strings.join('?'), values });
		return sqlQueue.length ? sqlQueue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const {
	normalizePlanInput,
	planReadiness,
	estimateLaunchCost,
	shapePlan,
	markPlanLaunched,
	upsertPlan,
	FIXED_LAUNCH_TOTAL_SOL,
} = await import('../api/_lib/agent-token-plan.js');

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
// A clearly-synthetic mint placeholder: never a real third-party address.
const PLACEHOLDER_MINT = 'THREEsynthetic1111111111111111111111111111';

beforeEach(() => {
	sqlCalls.length = 0;
	sqlQueue.length = 0;
});

describe('normalizePlanInput', () => {
	it('upper-cases the ticker and trims the identity fields', () => {
		const p = normalizePlanInput({ name: '  Ada Ledger  ', symbol: ' ada ', description: '  hi  ' });
		expect(p.name).toBe('Ada Ledger');
		expect(p.symbol).toBe('ADA');
		expect(p.description).toBe('hi');
	});

	it('zeroes the dev buy that belongs to the other quote currency', () => {
		// The owner set a SOL dev buy, then flipped the pairing to USDC. Carrying
		// the stale SOL amount would silently spend it if they flipped back.
		const usdcPaired = normalizePlanInput({ quote_currency: 'usdc', sol_buy_in: 2, usdc_buy_in: 50 });
		expect(usdcPaired.sol_buy_in).toBe(0);
		expect(usdcPaired.usdc_buy_in).toBe(50);

		const solPaired = normalizePlanInput({ quote_currency: 'sol', sol_buy_in: 2, usdc_buy_in: 50 });
		expect(solPaired.sol_buy_in).toBe(2);
		expect(solPaired.usdc_buy_in).toBe(0);
	});

	it('drops a buyback share on a coin that cannot enforce one', () => {
		// Only an agent-bound coin creates the on-chain pump agent that runs the
		// buyback; storing a share on a plain coin would advertise a promise the
		// chain never made.
		expect(normalizePlanInput({ coin_type: 'regular', buyback_bps: 2500 }).buyback_bps).toBe(0);
		expect(normalizePlanInput({ coin_type: 'agent', buyback_bps: 2500 }).buyback_bps).toBe(2500);
	});

	it('clamps out-of-range numbers instead of discarding the whole edit', () => {
		const p = normalizePlanInput({ coin_type: 'agent', buyback_bps: 999_999, sol_buy_in: 500 });
		expect(p.buyback_bps).toBe(10_000);
		expect(p.sol_buy_in).toBe(50);
	});

	it('falls back to Solana mainnet and an agent coin for unknown enum values', () => {
		const p = normalizePlanInput({ network: 'base', coin_type: 'nonsense', quote_currency: 'eth' });
		expect(p.network).toBe('mainnet');
		expect(p.coin_type).toBe('agent');
		expect(p.quote_currency).toBe('sol');
	});
});

describe('planReadiness', () => {
	const ok = { name: 'Ada Ledger', symbol: 'ADA', description: 'x', coin_type: 'agent', buyback_bps: 1000, sol_buy_in: 1 };

	it('passes a complete plan', () => {
		expect(planReadiness(ok).ready).toBe(true);
		expect(planReadiness(ok).blockers).toEqual([]);
	});

	it('blocks a missing name or ticker', () => {
		expect(planReadiness({ ...ok, name: '' }).ready).toBe(false);
		expect(planReadiness({ ...ok, symbol: '' }).ready).toBe(false);
	});

	it('blocks a ticker the chain would not accept', () => {
		expect(planReadiness({ ...ok, symbol: 'A' }).ready).toBe(false);
		expect(planReadiness({ ...ok, symbol: 'AD A' }).ready).toBe(false);
		expect(planReadiness({ ...ok, symbol: 'AD$' }).ready).toBe(false);
	});

	it('blocks a link that is not a full http URL', () => {
		const r = planReadiness({ ...ok, website: 'three.ws' });
		expect(r.ready).toBe(false);
		expect(r.blockers.join(' ')).toMatch(/Website/);
	});

	it('warns without blocking when the coin has no artwork or description', () => {
		const r = planReadiness({ name: 'Ada', symbol: 'ADA', coin_type: 'agent', buyback_bps: 500, sol_buy_in: 1 });
		expect(r.ready).toBe(true);
		expect(r.warnings.join(' ')).toMatch(/image/i);
	});

	it('warns that an agent coin with a zero buyback buys back nothing', () => {
		const r = planReadiness({ ...ok, buyback_bps: 0 });
		expect(r.ready).toBe(true);
		expect(r.warnings.join(' ')).toMatch(/buy back/i);
	});
});

describe('estimateLaunchCost', () => {
	it('quotes rent and fees alone when there is no dev buy', () => {
		const c = estimateLaunchCost({ quote_currency: 'sol', sol_buy_in: 0 });
		expect(c.total_sol).toBeCloseTo(FIXED_LAUNCH_TOTAL_SOL, 9);
		expect(c.dev_buy_sol).toBe(0);
	});

	it('adds the dev buy and its protocol fee on a SOL-paired coin', () => {
		const c = estimateLaunchCost({ quote_currency: 'sol', sol_buy_in: 1 });
		expect(c.dev_buy_sol).toBe(1);
		expect(c.protocol_fee_sol).toBeCloseTo(0.01, 9);
		expect(c.total_sol).toBeCloseTo(FIXED_LAUNCH_TOTAL_SOL + 1.01, 9);
	});

	it('keeps a USDC dev buy off the SOL total', () => {
		// A USDC-paired dev buy moves no SOL, so the SOL a wallet must hold is
		// still just rent and fees. Folding it in would over-quote the owner.
		const c = estimateLaunchCost({ quote_currency: 'usdc', usdc_buy_in: 100 });
		expect(c.dev_buy_usdc).toBe(100);
		expect(c.dev_buy_sol).toBe(0);
		expect(c.total_sol).toBeCloseTo(FIXED_LAUNCH_TOTAL_SOL, 9);
	});
});

describe('shapePlan', () => {
	it('coerces the numeric columns Postgres returns as strings', () => {
		const shaped = shapePlan({
			id: 'p1', agent_id: AGENT_ID, network: 'mainnet', name: 'Ada Ledger', symbol: 'ADA',
			description: '', coin_type: 'agent', quote_currency: 'sol',
			buyback_bps: '2500', sol_buy_in: '1.500000000', usdc_buy_in: '0.000000',
			status: 'ready',
		});
		expect(shaped.buyback_bps).toBe(2500);
		expect(shaped.sol_buy_in).toBe(1.5);
		expect(shaped.usdc_buy_in).toBe(0);
	});

	it('derives readiness and cost rather than trusting stored values', () => {
		const shaped = shapePlan({
			id: 'p1', agent_id: AGENT_ID, network: 'mainnet', name: '', symbol: 'ADA',
			coin_type: 'agent', quote_currency: 'sol', buyback_bps: 0, sol_buy_in: 0,
			usdc_buy_in: 0, status: 'ready',
		});
		// Stored status says ready; the rules say otherwise, and the rules win.
		expect(shaped.readiness.ready).toBe(false);
		expect(shaped.cost_estimate.total_sol).toBeCloseTo(FIXED_LAUNCH_TOTAL_SOL, 9);
	});

	it('returns null for a missing row', () => {
		expect(shapePlan(null)).toBeNull();
	});
});

describe('markPlanLaunched', () => {
	it('records the mint against the agent plan for that network', async () => {
		sqlQueue.push([{ id: 'p1', status: 'launched', mint: PLACEHOLDER_MINT }]);
		const row = await markPlanLaunched({ agentId: AGENT_ID, network: 'devnet', mint: PLACEHOLDER_MINT });
		expect(row.status).toBe('launched');
		expect(sqlCalls[0].values).toContain(PLACEHOLDER_MINT);
		expect(sqlCalls[0].values).toContain('devnet');
		// The guard that makes a retry a no-op rather than a rewrite.
		expect(sqlCalls[0].text).toMatch(/status <> 'launched'/);
	});

	it('writes nothing when the launch had no saved plan', async () => {
		sqlQueue.push([]);
		expect(await markPlanLaunched({ agentId: AGENT_ID, network: 'mainnet', mint: PLACEHOLDER_MINT })).toBeNull();
	});

	it('refuses a call with no mint or an unknown network, without touching the database', async () => {
		expect(await markPlanLaunched({ agentId: AGENT_ID, network: 'mainnet', mint: '' })).toBeNull();
		expect(await markPlanLaunched({ agentId: AGENT_ID, network: 'base', mint: PLACEHOLDER_MINT })).toBeNull();
		expect(sqlCalls).toHaveLength(0);
	});
});

describe('upsertPlan', () => {
	it('refuses to edit a plan that already minted', async () => {
		sqlQueue.push([{ id: 'p1', status: 'launched', mint: PLACEHOLDER_MINT, network: 'mainnet' }]);
		const { locked, row } = await upsertPlan({
			agentId: AGENT_ID,
			userId: USER_ID,
			input: { name: 'Rewritten', symbol: 'NEW', network: 'mainnet' },
		});
		expect(locked).toBe(true);
		expect(row.mint).toBe(PLACEHOLDER_MINT);
		// One read to find the existing plan, and no write after it.
		expect(sqlCalls).toHaveLength(1);
	});

	it('saves a complete plan as ready and an incomplete one as a draft', async () => {
		sqlQueue.push([]); // no existing plan
		sqlQueue.push([{ id: 'p1', status: 'ready' }]);
		await upsertPlan({
			agentId: AGENT_ID,
			userId: USER_ID,
			input: { name: 'Ada Ledger', symbol: 'ADA', network: 'devnet' },
		});
		expect(sqlCalls[1].values).toContain('ready');

		sqlCalls.length = 0;
		sqlQueue.push([]);
		sqlQueue.push([{ id: 'p2', status: 'draft' }]);
		await upsertPlan({ agentId: AGENT_ID, userId: USER_ID, input: { name: '', symbol: '', network: 'devnet' } });
		expect(sqlCalls[1].values).toContain('draft');
	});
});
