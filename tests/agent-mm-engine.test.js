/**
 * agent-mm engine: core decision-path tests.
 *
 * Covers workers/agent-mm/engine.js: the intent ladder (seed → defend → recycle
 * → rebalance), the anti-manipulation gates that make the maker non-manipulative
 * by construction (interval, side-flip, live-volume cap, dust floor), the budget
 * and wallet clamps that bound every buy, and the graduation handoff.
 *
 * The engine's chain + DB edges (market.js, store.js, graduation.js) and the
 * shared trade path (executeAgentTrade) are substituted so the DECISION logic is
 * exercised end to end without RPC, a database, or a signature. The rulebook it
 * reads (GUARDS / SOL from api/_lib/market-maker.js) stays real, so a cap change
 * there fails these tests rather than silently passing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GUARDS, SOL } from '../api/_lib/market-maker.js';
import { mmEventFromOutcome, isFiredKind, MM_ACTION_TYPES } from '../src/shared/mm-render.js';

// ── substituted edges ────────────────────────────────────────────────────────
const mockQuoteMarket = vi.fn();
const mockGetHolding = vi.fn();
const mockGetSolBalance = vi.fn();
const mockGetWindowVolume = vi.fn();

const mockMarkEvaluated = vi.fn(async () => {});
const mockRecordAction = vi.fn(async () => ({ id: 1 }));
const mockMarkSeedDone = vi.fn(async () => {});
const mockMarkGraduation = vi.fn(async () => {});
const mockDeployed24h = vi.fn(async () => 0n);
const mockDefense24h = vi.fn(async () => 0n);

const mockProvideLp = vi.fn();
const mockExecuteAgentTrade = vi.fn();

vi.mock('../workers/agent-mm/market.js', () => ({
	quoteMarket: (...a) => mockQuoteMarket(...a),
	getHolding: (...a) => mockGetHolding(...a),
	getSolBalanceLamports: (...a) => mockGetSolBalance(...a),
	getWindowVolumeLamports: (...a) => mockGetWindowVolume(...a),
}));

vi.mock('../workers/agent-mm/store.js', () => ({
	markEvaluated: (...a) => mockMarkEvaluated(...a),
	recordActionAndAdvance: (...a) => mockRecordAction(...a),
	markSeedDone: (...a) => mockMarkSeedDone(...a),
	markGraduation: (...a) => mockMarkGraduation(...a),
	getDeployedLamports24h: (...a) => mockDeployed24h(...a),
	getDefenseLamports24h: (...a) => mockDefense24h(...a),
}));

vi.mock('../workers/agent-mm/graduation.js', () => ({
	provideLp: (...a) => mockProvideLp(...a),
}));

vi.mock('../api/agents/agent-trade.js', () => ({
	// The real parser normalizes + limit-checks the body; here it passes the shape
	// through so the assertions read the exact numbers the engine sized.
	parseTradeInput: (body) => ({ ...body }),
	executeAgentTrade: (...a) => mockExecuteAgentTrade(...a),
}));

vi.mock('../api/_lib/agent-trade-guards.js', () => ({
	getTradeLimits: () => ({}),
}));

const { runPolicy } = await import('../workers/agent-mm/engine.js');

// ── fixtures ─────────────────────────────────────────────────────────────────
const MINT = 'THREEsynthetic1111111111111111111111111111111';
const OWNER = 'THREEowner11111111111111111111111111111111111';

const AGENT = {
	id: 'agent-1',
	userId: 'user-1',
	meta: { solana_address: OWNER, encrypted_solana_secret: 'v2:sealed' },
};

const CFG = { mode: 'simulate', network: 'mainnet', volumeWindowSeconds: GUARDS.VOLUME_WINDOW_SECONDS };

/** A balanced, live-budgeted policy row in the shape Neon returns (bigints as strings). */
function policy(over = {}) {
	return {
		id: 'policy-1',
		mint: MINT,
		network: 'mainnet',
		mode: 'live',
		floor_price_sol: 0.0001,
		floor_band_pct: 5,
		take_profit_band_pct: 25,
		recycle_pct: 20,
		max_inventory_tokens: 100_000_000,
		slippage_bps: 500,
		seed_lamports: '0',
		seed_done_at: null,
		dip_buy_budget_lamports: String(1 * SOL),
		daily_budget_lamports: String(2 * SOL),
		min_action_interval_seconds: 60,
		last_action_at: null,
		last_action_side: null,
		max_volume_pct: 15,
		graduation_action: 'provide_lp',
		graduation_done_at: null,
		...over,
	};
}

/** The one trade body the engine handed to the shared execution path. */
function executedBody() {
	expect(mockExecuteAgentTrade).toHaveBeenCalledTimes(1);
	return mockExecuteAgentTrade.mock.calls[0][0].input;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockQuoteMarket.mockResolvedValue({ price_sol: 0.0001, graduated: false });
	mockGetHolding.mockResolvedValue({ whole: 1_000_000, raw: 1_000_000_000_000n, decimals: 6 });
	mockGetSolBalance.mockResolvedValue(BigInt(5 * SOL));
	mockGetWindowVolume.mockResolvedValue(BigInt(1_000 * SOL));
	mockDeployed24h.mockResolvedValue(0n);
	mockDefense24h.mockResolvedValue(0n);
	mockExecuteAgentTrade.mockResolvedValue({ ok: true, data: { simulated: true } });
});

describe('runPolicy: observation guards', () => {
	it('does nothing and records no_wallet when the agent has no custodial key', async () => {
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: { ...AGENT, meta: { solana_address: OWNER } } });
		expect(out.tag).toBe('no_wallet');
		expect(mockMarkEvaluated).toHaveBeenCalledWith('policy-1', { error: 'no_wallet' });
		expect(mockExecuteAgentTrade).not.toHaveBeenCalled();
	});

	it('skips the sweep (never treats an unquotable coin as price 0) when the quote fails', async () => {
		mockQuoteMarket.mockResolvedValue(null);
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('no_price');
		expect(out.priceSol).toBeNull();
		expect(mockExecuteAgentTrade).not.toHaveBeenCalled();
	});

	it('holds in band and still writes the price/inventory heartbeat', async () => {
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('in_band');
		expect(out.priceSol).toBe(0.0001);
		expect(mockMarkEvaluated).toHaveBeenCalledWith('policy-1', {
			priceSol: 0.0001,
			inventoryTokens: 1_000_000,
			inventoryValueLamports: BigInt(100 * SOL),
			error: null,
		});
		expect(mockExecuteAgentTrade).not.toHaveBeenCalled();
	});
});

describe('runPolicy: floor defense', () => {
	it('buys a quarter of the dip budget when price breaks the floor band', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });

		expect(out.tag).toBe('defend_buy');
		const input = executedBody();
		expect(input.side).toBe('buy');
		expect(input.amount).toBe(0.25); // 1 SOL dip budget / 4, defends in tranches
		expect(input.slippageBps).toBe(500);
		expect(mockExecuteAgentTrade.mock.calls[0][0].source).toBe('mm:defend_buy');
	});

	it('clamps the tranche to the remaining dip budget', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		mockDefense24h.mockResolvedValue(BigInt(0.9 * SOL));
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('defend_buy');
		expect(executedBody().amount).toBeCloseTo(0.1, 9);
	});

	it('holds once the rolling daily budget is spent', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		mockDeployed24h.mockResolvedValue(BigInt(2 * SOL));
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('daily_budget');
		expect(mockExecuteAgentTrade).not.toHaveBeenCalled();
	});

	it('refuses to buy past the inventory ceiling', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		const out = await runPolicy({ cfg: CFG, policy: policy({ max_inventory_tokens: 1_000_000 }), agent: AGENT });
		expect(out.tag).toBe('at_max_inventory');
		expect(mockExecuteAgentTrade).not.toHaveBeenCalled();
	});

	it('leaves fee headroom in the wallet instead of spending it to zero', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		mockGetSolBalance.mockResolvedValue(BigInt(0.1 * SOL));
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('defend_buy');
		expect(executedBody().amount).toBeCloseTo(0.095, 9); // 0.1 SOL - 0.005 fee headroom
	});

	it('holds when the wallet has no spendable SOL', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		mockGetSolBalance.mockResolvedValue(1_000n);
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('insufficient_sol');
		expect(mockExecuteAgentTrade).not.toHaveBeenCalled();
	});
});

describe('runPolicy: anti-manipulation gates', () => {
	it('will not act twice inside min_action_interval_seconds', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		const out = await runPolicy({
			cfg: CFG,
			agent: AGENT,
			policy: policy({ last_action_at: new Date(Date.now() - 10_000).toISOString(), last_action_side: 'buy' }),
		});
		expect(out.tag).toBe('interval_guard');
		expect(mockExecuteAgentTrade).not.toHaveBeenCalled();
	});

	it('blocks a side flip inside the wash-trade window and records it to the ledger', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		const out = await runPolicy({
			cfg: CFG,
			agent: AGENT,
			policy: policy({ last_action_at: new Date(Date.now() - 70_000).toISOString(), last_action_side: 'sell' }),
		});
		expect(out.tag).toBe('anti_wash_guard');
		expect(mockExecuteAgentTrade).not.toHaveBeenCalled();
		const [{ action }] = mockRecordAction.mock.calls[0];
		expect(action.status).toBe('blocked');
		expect(action.detail).toMatch(/anti-wash guard/);
		expect(action.detail).toContain(String(60 * GUARDS.SIDE_FLIP_INTERVAL_MULTIPLE));
	});

	it('allows the flip once the doubled interval has elapsed', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		const out = await runPolicy({
			cfg: CFG,
			agent: AGENT,
			policy: policy({ last_action_at: new Date(Date.now() - 130_000).toISOString(), last_action_side: 'sell' }),
		});
		expect(out.tag).toBe('defend_buy');
	});

	it('caps a single action at max_volume_pct of live volume', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		mockGetWindowVolume.mockResolvedValue(BigInt(1 * SOL)); // 15% of 1 SOL = 0.15
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('defend_buy');
		expect(executedBody().amount).toBeCloseTo(0.15, 9);
	});

	it('never exceeds the conservative slice when live volume cannot be measured', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		mockGetWindowVolume.mockResolvedValue(null);
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('defend_buy');
		expect(executedBody().amount).toBeCloseTo(GUARDS.NO_VOLUME_FALLBACK_LAMPORTS / SOL, 9);
	});

	it('holds rather than painting a dust trade on an unmeasurable tape', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		mockGetWindowVolume.mockResolvedValue(null);
		const out = await runPolicy({
			cfg: CFG,
			agent: AGENT,
			policy: policy({ dip_buy_budget_lamports: String(0.004 * SOL) }),
		});
		expect(out.tag).toBe('volume_unmeasured');
		expect(mockExecuteAgentTrade).not.toHaveBeenCalled();
	});

	it('reads the volume window from the worker config', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		await runPolicy({ cfg: { ...CFG, volumeWindowSeconds: 900 }, policy: policy(), agent: AGENT });
		expect(mockGetWindowVolume).toHaveBeenCalledWith({ mint: MINT, windowSeconds: 900 });
	});
});

describe('runPolicy: recycle + rebalance', () => {
	it('recycles recycle_pct of inventory into a spike above the take-profit band', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00015, graduated: false });
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('recycle_sell');
		const input = executedBody();
		expect(input.side).toBe('sell');
		expect(input.amount).toBeCloseTo(200_000, 6); // 20% of 1,000,000 tokens
	});

	it('trims back to the inventory ceiling when nothing else fires', async () => {
		const out = await runPolicy({
			cfg: CFG,
			agent: AGENT,
			policy: policy({ max_inventory_tokens: 900_000 }),
		});
		expect(out.tag).toBe('rebalance_trim');
		const input = executedBody();
		expect(input.side).toBe('sell');
		expect(input.amount).toBeCloseTo(100_000, 6);
	});

	it('holds when there is no inventory to recycle', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00015, graduated: false });
		mockGetHolding.mockResolvedValue({ whole: 0, raw: 0n, decimals: 6 });
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('in_band');
		expect(mockExecuteAgentTrade).not.toHaveBeenCalled();
	});
});

describe('runPolicy: seed', () => {
	it('seeds once and stamps the policy so it can never fire twice', async () => {
		const out = await runPolicy({
			cfg: CFG,
			agent: AGENT,
			policy: policy({ seed_lamports: String(0.3 * SOL) }),
		});
		expect(out.tag).toBe('seed');
		expect(executedBody().amount).toBeCloseTo(0.3, 9);
		expect(mockMarkSeedDone).toHaveBeenCalledWith('policy-1');
	});

	it('does not re-seed a policy already seeded', async () => {
		const out = await runPolicy({
			cfg: CFG,
			agent: AGENT,
			policy: policy({ seed_lamports: String(0.3 * SOL), seed_done_at: new Date().toISOString() }),
		});
		expect(out.tag).toBe('in_band');
		expect(mockExecuteAgentTrade).not.toHaveBeenCalled();
	});
});

describe('runPolicy: execution wiring', () => {
	it('paper-fills when the worker is in simulate mode even on a live policy', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.simulate).toBe(true);
		expect(executedBody().simulate).toBe(true);
		const [{ action }] = mockRecordAction.mock.calls[0];
		expect(action.status).toBe('simulated');
	});

	it('signs for real only when BOTH the worker and the policy are live', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		mockExecuteAgentTrade.mockResolvedValue({
			ok: true,
			data: { simulated: false, sol_spent: 0.25, venue: 'pump', signature: 'sig-1', price_impact_pct: 1.2 },
		});
		const out = await runPolicy({ cfg: { ...CFG, mode: 'live' }, policy: policy(), agent: AGENT });
		expect(out.simulate).toBe(false);
		expect(executedBody().simulate).toBe(false);
		const [{ action, effect }] = mockRecordAction.mock.calls[0];
		expect(action.status).toBe('executed');
		expect(action.signature).toBe('sig-1');
		expect(effect.solLamports).toBe(0.25 * SOL);
		expect(out.signature).toBe('sig-1');
		expect(out.sizeSol).toBeCloseTo(0.25, 9);
	});

	it('keys every fill to the interval window so overlapping sweeps cannot double-fire', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(executedBody().idempotencyKey).toMatch(/^mm:policy-1:defend_buy:\d+$/);
	});

	it('records a firewall block without advancing any aggregate', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		mockExecuteAgentTrade.mockResolvedValue({ ok: false, code: 'firewall_blocked', message: 'destination not allowed' });
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('firewall_blocked');
		const [{ action, effect }] = mockRecordAction.mock.calls[0];
		expect(action.status).toBe('blocked');
		expect(effect).toBeUndefined();
	});

	it('survives a crash in the trade path and records it as failed', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		mockExecuteAgentTrade.mockRejectedValue(new Error('rpc exploded'));
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('execute_error');
		const [{ action }] = mockRecordAction.mock.calls[0];
		expect(action.status).toBe('failed');
	});
});

describe('runPolicy: outcome feeds the live screen', () => {
	it('returns the exact shape mm-render projects into a screen event', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00008, graduated: false });
		mockExecuteAgentTrade.mockResolvedValue({
			ok: true,
			data: { simulated: false, sol_spent: 0.25, venue: 'pump', signature: 'sig-2' },
		});
		const out = await runPolicy({ cfg: { ...CFG, mode: 'live' }, policy: policy(), agent: AGENT });

		const ev = mmEventFromOutcome(out);
		expect(MM_ACTION_TYPES).toContain(ev.actionType);
		expect(ev.actionType).toBe('mm_defend');
		expect(isFiredKind(out.tag)).toBe(true);
		expect(ev.context.mint).toBe(MINT);
		expect(ev.context.sideBuy).toBe(true);
		expect(ev.context.sizeSol).toBeCloseTo(0.25, 9);
		expect(ev.context.floorSol).toBe(0.0001);
		expect(ev.context.signature).toBe('sig-2');
		expect(ev.context.simulate).toBe(false);
		expect(ev.summary).toBeTruthy();
	});

	it('projects a non-firing sweep as a quote frame the arena can still draw', async () => {
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		const ev = mmEventFromOutcome(out);
		expect(isFiredKind(out.tag)).toBe(false);
		expect(ev.actionType).toBe('mm_quote');
		expect(ev.context.priceSol).toBe(0.0001);
		expect(ev.context.sizeSol).toBe(0);
	});
});

describe('runPolicy: graduation handoff', () => {
	it('runs hold once and keeps the maker two-sided on the AMM', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00012, graduated: true });
		const out = await runPolicy({ cfg: CFG, policy: policy({ graduation_action: 'hold' }), agent: AGENT });
		expect(out.tag).toBe('graduation_hold');
		expect(mockMarkGraduation).toHaveBeenCalledWith('policy-1', { status: 'done', terminal: false });
		expect(mockExecuteAgentTrade).not.toHaveBeenCalled();
	});

	it('provides LP from the managed inventory and closes the policy out', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00012, graduated: true });
		mockProvideLp.mockResolvedValue({
			signature: null, baseDeposited: '1000000000000', quoteLamports: String(2 * SOL), simulated: true,
		});
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('graduation_lp');
		expect(mockProvideLp).toHaveBeenCalledWith(expect.objectContaining({ mint: MINT, simulate: true, slippagePct: 5 }));
		expect(mockMarkGraduation).toHaveBeenCalledWith('policy-1', { status: 'done', signature: null, terminal: true });
	});

	it('retries the LP handoff on the next sweep instead of losing it', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00012, graduated: true });
		mockProvideLp.mockRejectedValue(Object.assign(new Error('pool missing'), { code: 'pool_not_found' }));
		const out = await runPolicy({ cfg: CFG, policy: policy(), agent: AGENT });
		expect(out.tag).toBe('graduation_lp_failed');
		expect(mockMarkGraduation).toHaveBeenCalledWith('policy-1', { status: 'failed:pool_not_found', terminal: false });
	});

	it('liquidates inventory to SOL on distribute', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00012, graduated: true });
		const out = await runPolicy({ cfg: CFG, policy: policy({ graduation_action: 'distribute' }), agent: AGENT });
		expect(out.tag).toBe('graduation_distribute');
		const input = executedBody();
		expect(input.side).toBe('sell');
		expect(input.amount).toBe('max');
		expect(input.idempotencyKey).toBe('mm:policy-1:graduation_distribute');
		expect(mockMarkGraduation).toHaveBeenCalledWith('policy-1', { status: 'done', signature: null, terminal: true });
	});

	it('does not re-run a graduation that already happened', async () => {
		mockQuoteMarket.mockResolvedValue({ price_sol: 0.00012, graduated: true });
		const out = await runPolicy({
			cfg: CFG,
			agent: AGENT,
			policy: policy({ graduation_done_at: new Date().toISOString(), graduation_action: 'hold' }),
		});
		expect(out.tag).toBe('in_band');
		expect(mockMarkGraduation).not.toHaveBeenCalled();
	});
});
