// Core-path smoke tests for the programmable-orders worker (workers/agent-orders).
//
// tests/orders-engine.test.js already covers the pure rule layer (api/_lib/orders.js:
// validation, condition evaluation, price predicates). This suite covers the half
// that actually moves money: runOrderSweep + store.js, i.e. the decision-to-fire
// wiring. It asserts the properties the engine is trusted for:
//
//   * a matched trigger fires ONCE, through executeAgentTrade, with the custody
//     idempotency key `order:<id>:slice:<n>` and simulate=true off ORDERS_MODE
//   * a missing live quote holds the order (never fires on absent data)
//   * a terminal block (firewall rug verdict) halts the order to 'error';
//     a clearable block (daily budget) returns it to active for the next sweep
//   * a DCA slice advances the schedule and re-arms next_fire_at, only going
//     terminal on the last slice
//   * two due orders on one agent are serialized (one wallet, one budget)
//
// Only the two edges are stubbed: the chain/market reads (market.js) and the
// trade executor itself. The real store.js SQL, the real parseTradeInput, and the
// real trigger predicates run, so the queries and the trade body are the ones
// production issues.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── db: record every query the real store.js issues, answer from a router ─────
const dbState = { calls: [], activeOrders: [], agent: null, claimOk: true };

function classify(q) {
	if (q.includes('SELECT * FROM orders')) return 'active_orders';
	if (q.includes("SET status = 'expired'")) return 'expire';
	if (q.includes('SET status = CASE WHEN fill_count')) return 'recover_stale';
	if (q.includes("SET status = 'firing'")) return 'claim';
	if (q.includes('SET last_eval_at = now()')) return 'mark_evaluated';
	if (q.includes('SET reference_price =')) return 'seed_reference';
	if (q.includes('INSERT INTO order_fills')) return 'insert_fill';
	if (q.includes('filled_sol = filled_sol +')) return 'advance';
	if (q.includes('FROM agent_identities')) return 'load_agent';
	if (q.includes('UPDATE orders SET status')) return 'set_status';
	if (q.includes('bot_heartbeat')) return 'heartbeat';
	return 'other';
}

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		const query = strings.join('?');
		const kind = classify(query);
		dbState.calls.push({ kind, values });
		if (kind === 'active_orders') return dbState.activeOrders;
		if (kind === 'claim') return dbState.claimOk ? [{ id: values[0] }] : [];
		if (kind === 'load_agent') return dbState.agent ? [dbState.agent] : [];
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	sqlValues: (rows) => rows,
	isStoragePressured: async () => false,
}));

// ── market: the only chain reads the sweep makes ─────────────────────────────
const marketState = { market: null, signals: {}, holding: null };
vi.mock('../workers/agent-orders/market.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		getSignals: vi.fn(async () => ({ market: marketState.market, signals: marketState.signals })),
		getHolding: vi.fn(async () => marketState.holding),
	};
});

// ── the executor: real parseTradeInput, stubbed execution ────────────────────
const tradeState = { result: null, calls: [], inflight: 0, maxInflight: 0, delayMs: 0 };
vi.mock('../api/agents/agent-trade.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		executeAgentTrade: vi.fn(async (args) => {
			tradeState.calls.push(args);
			tradeState.inflight++;
			tradeState.maxInflight = Math.max(tradeState.maxInflight, tradeState.inflight);
			if (tradeState.delayMs) await new Promise((r) => setTimeout(r, tradeState.delayMs));
			tradeState.inflight--;
			return tradeState.result;
		}),
	};
});

vi.mock('../workers/agent-orders/log.js', () => ({
	log: { info: () => {}, warn: () => {}, error: () => {}, trade: () => {} },
}));

const { runOrderSweep } = await import('../workers/agent-orders/sweep.js');
const { loadConfig } = await import('../workers/agent-orders/config.js');

// ── fixtures ─────────────────────────────────────────────────────────────────
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'; // $THREE
const AGENT_ADDRESS = 'THREEsyntheticAgentWallet11111111111111111111'; // never validated: getHolding is stubbed

const cfg = { network: 'mainnet', mode: 'simulate', concurrency: 4, staleFiringMs: 180_000 };

function order(over = {}) {
	return {
		id: '33333333-3333-4333-8333-333333333333',
		agent_id: AGENT_ID, user_id: USER_ID, network: 'mainnet', mint: MINT,
		type: 'limit', side: 'buy', size_sol: 0.25, size_tokens: null, sell_pct: null,
		trigger_metric: 'mcap_usd', limit_price: 40_000, stop_price: null, trail_pct: null,
		peak_price: null, reference_price: 50_000, schedule: null, next_fire_at: null,
		condition: null, slippage_bps: 500, expires_at: null, status: 'active',
		filled_sol: 0, filled_tokens: 0, fill_count: 0, last_error: null,
		...over,
	};
}

function priceAt(mcapUsd) {
	marketState.market = { price_sol: mcapUsd / 1e9 / 150, mcap_sol: mcapUsd / 150, graduated: false };
	marketState.signals = { ...marketState.market, mcap_usd: mcapUsd, smart_money_score: null, dev_dump: null, price_change_pct: null };
}

const okResult = {
	ok: true, status: 200,
	data: { simulated: true, venue: 'bonding_curve', price_impact_pct: 0.8, signature: 'SIMULATED', custody_event_id: null },
};

const kinds = () => dbState.calls.map((c) => c.kind);
const call = (kind) => dbState.calls.find((c) => c.kind === kind);

beforeEach(() => {
	dbState.calls = [];
	dbState.activeOrders = [];
	dbState.claimOk = true;
	dbState.agent = { id: AGENT_ID, user_id: USER_ID, meta: { solana_address: AGENT_ADDRESS, encrypted_solana_secret: 'enc:v1:test' } };
	marketState.market = null;
	marketState.signals = {};
	marketState.holding = null;
	tradeState.calls = [];
	tradeState.result = okResult;
	tradeState.inflight = 0;
	tradeState.maxInflight = 0;
	tradeState.delayMs = 0;
});

// ── the fire path ────────────────────────────────────────────────────────────
describe('runOrderSweep: a matched trigger fires through the audited trade path', () => {
	it('fires a limit buy once the metric falls to the target, with the custody idempotency key', async () => {
		dbState.activeOrders = [order()];
		priceAt(39_000); // at/below the 40k target

		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(1);
		const args = tradeState.calls[0];
		expect(args.id).toBe(AGENT_ID);
		expect(args.userId).toBe(USER_ID);
		expect(args.source).toBe('order:limit');
		expect(args.sourceMeta).toEqual({ order_id: order().id, slice: 0 });
		// Exactly-once across processes rides on this key.
		expect(args.input.idempotencyKey).toBe(`order:${order().id}:slice:0`);
		// simulate mode must never broadcast.
		expect(args.input.simulate).toBe(true);
		// Real parseTradeInput shaped the body.
		expect(args.input.side).toBe('buy');
		expect(args.input.mint).toBe(MINT);
		expect(args.input.amount).toBe(0.25);
		expect(args.input.slippageBps).toBe(500);

		// Claimed, then a fill receipt, then the order advanced to filled.
		expect(kinds()).toContain('claim');
		expect(kinds()).toContain('insert_fill');
		expect(kinds()).toContain('advance');
		const fill = call('insert_fill');
		expect(fill.values).toContain('simulated');
		expect(fill.values).toContain('limit');
		// terminal single fill → status 'filled', next_fire_at null
		expect(call('advance').values[0]).toBe('filled');
	});

	it('holds (never fires) when the trigger has not been met', async () => {
		dbState.activeOrders = [order()];
		priceAt(55_000); // above a limit-buy target

		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(0);
		expect(kinds()).toContain('mark_evaluated');
		expect(kinds()).not.toContain('claim');
	});

	it('holds on a missing live quote instead of treating it as a price of zero', async () => {
		dbState.activeOrders = [order()];
		marketState.market = null; // quote failed this sweep

		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(0);
		expect(kinds()).not.toContain('claim');
		expect(kinds()).toContain('mark_evaluated');
	});

	it('leaves orders untouched when the agent has no provisioned wallet', async () => {
		dbState.activeOrders = [order()];
		dbState.agent = { id: AGENT_ID, user_id: USER_ID, meta: { solana_address: AGENT_ADDRESS } };
		priceAt(39_000);

		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(0);
		expect(kinds()).not.toContain('claim');
	});

	it('does not fire an order another sweep already claimed', async () => {
		dbState.activeOrders = [order()];
		dbState.claimOk = false;
		priceAt(39_000);

		await runOrderSweep(cfg);

		expect(kinds()).toContain('claim');
		expect(tradeState.calls).toHaveLength(0);
	});

	it('runs housekeeping (expire + stale-firing recovery) before evaluating', async () => {
		dbState.activeOrders = [];
		await runOrderSweep(cfg);
		expect(kinds().slice(0, 3)).toEqual(['expire', 'recover_stale', 'active_orders']);
	});
});

// ── blocked fires ────────────────────────────────────────────────────────────
describe('runOrderSweep: blocked fires', () => {
	it('halts the order to error on a terminal firewall block', async () => {
		dbState.activeOrders = [order()];
		priceAt(39_000);
		tradeState.result = { ok: false, status: 422, code: 'firewall_blocked', message: 'rug indicators' };

		await runOrderSweep(cfg);

		const fill = call('insert_fill');
		expect(fill).toBeTruthy();
		expect(fill.values).toContain('failed');
		const halt = dbState.calls.find((c) => c.kind === 'set_status' && c.values[0] === 'error');
		expect(halt).toBeTruthy();
		expect(kinds()).not.toContain('advance'); // a failed fill never advances the budget
	});

	it('returns the order to active on a clearable block so the next sweep retries', async () => {
		dbState.activeOrders = [order()];
		priceAt(39_000);
		tradeState.result = { ok: false, status: 429, code: 'daily_budget_exceeded', message: 'budget' };

		await runOrderSweep(cfg);

		expect(kinds()).not.toContain('insert_fill');
		const release = dbState.calls.find((c) => c.kind === 'set_status' && c.values[0] === 'active');
		expect(release).toBeTruthy();
		expect(release.values[1]).toContain('daily_budget_exceeded');
	});

	it('releases the claim when a sell cannot be sized (no holding)', async () => {
		dbState.activeOrders = [order({ type: 'limit', side: 'sell', size_sol: null, sell_pct: 50, limit_price: 40_000 })];
		priceAt(45_000); // limit sell fires at/above target
		marketState.holding = { whole: 0, raw: 0n, decimals: 6 };

		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(0);
		const release = dbState.calls.find((c) => c.kind === 'set_status' && c.values[1] === 'no_balance_or_size');
		expect(release).toBeTruthy();
	});

	it('scales a raw size_tokens sell by the mint decimals before handing it to the trade path', async () => {
		// size_tokens is persisted in raw base units; executeAgentTrade takes whole
		// tokens. Unscaled, this would ask for 1e6x the size and bounce off
		// insufficient_token_balance (a clearable code) on every sweep forever.
		dbState.activeOrders = [order({ type: 'limit', side: 'sell', size_sol: null, size_tokens: 2_500_000, limit_price: 40_000 })];
		priceAt(45_000);
		marketState.holding = { whole: 1_000, raw: 1_000_000_000n, decimals: 6 };

		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(1);
		expect(tradeState.calls[0].input.amount).toBe(2.5);
	});

	it('holds a size_tokens sell when the mint decimals cannot be read', async () => {
		dbState.activeOrders = [order({ type: 'limit', side: 'sell', size_sol: null, size_tokens: 2_500_000, limit_price: 40_000 })];
		priceAt(45_000);
		marketState.holding = null; // RPC could not resolve the mint this sweep

		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(0);
		const release = dbState.calls.find((c) => c.kind === 'set_status' && c.values[1] === 'no_balance_or_size');
		expect(release).toBeTruthy();
	});

	it('sizes a percentage sell off the live holding', async () => {
		dbState.activeOrders = [order({ type: 'limit', side: 'sell', size_sol: null, sell_pct: 25, limit_price: 40_000 })];
		priceAt(45_000);
		marketState.holding = { whole: 1_000, raw: 1_000_000_000n, decimals: 6 };

		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(1);
		expect(tradeState.calls[0].input.amount).toBe(250);
		expect(tradeState.calls[0].input.side).toBe('sell');
	});
});

// ── scheduled orders ─────────────────────────────────────────────────────────
describe('runOrderSweep: DCA / TWAP slices', () => {
	const dca = (over = {}) => order({
		type: 'dca', side: 'buy', size_sol: 0.1,
		schedule: { interval_seconds: 3600, slices: 3, filled_slices: 0 },
		next_fire_at: new Date(Date.now() - 1_000).toISOString(),
		...over,
	});

	it('fires a due slice, stays partial, and re-arms the next fire time', async () => {
		dbState.activeOrders = [dca()];
		priceAt(41_000);

		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(1);
		expect(tradeState.calls[0].source).toBe('order:dca');
		expect(tradeState.calls[0].input.idempotencyKey).toBe(`order:${dca().id}:slice:0`);
		const advance = call('advance');
		expect(advance.values[0]).toBe('partial');
		// schedule counter bumped, next_fire_at re-armed
		expect(JSON.parse(advance.values[3]).filled_slices).toBe(1);
		expect(advance.values[4]).toBeTruthy();
	});

	it('marks the last slice terminal and clears next_fire_at', async () => {
		dbState.activeOrders = [dca({ schedule: { interval_seconds: 3600, slices: 3, filled_slices: 2 }, fill_count: 2, status: 'partial' })];
		priceAt(41_000);

		await runOrderSweep(cfg);

		const advance = call('advance');
		expect(advance.values[0]).toBe('filled');
		expect(advance.values[4]).toBeNull();
	});

	it('does not fire a slice before its scheduled time', async () => {
		dbState.activeOrders = [dca({ next_fire_at: new Date(Date.now() + 60_000).toISOString() })];
		priceAt(41_000);

		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(0);
	});

	it('does not fire past the configured slice count', async () => {
		dbState.activeOrders = [dca({ schedule: { interval_seconds: 3600, slices: 3, filled_slices: 3 } })];
		priceAt(41_000);

		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(0);
	});
});

// ── conditional + trailing ───────────────────────────────────────────────────
describe('runOrderSweep: conditional and trailing triggers', () => {
	it('fires a conditional order only when every clause is satisfied', async () => {
		const cond = { all: [{ signal: 'mcap_usd', op: 'lt', value: 40_000 }, { signal: 'smart_money_score', op: 'gt', value: 60 }] };
		dbState.activeOrders = [order({ type: 'conditional', condition: cond, limit_price: null })];
		priceAt(35_000);
		marketState.signals.smart_money_score = 45; // second clause fails

		await runOrderSweep(cfg);
		expect(tradeState.calls).toHaveLength(0);

		dbState.calls = [];
		marketState.signals.smart_money_score = 72;
		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(1);
		expect(tradeState.calls[0].source).toBe('order:conditional');
	});

	it('never fires a conditional order on a missing signal', async () => {
		const cond = { all: [{ signal: 'dev_dump', op: 'is_true' }] };
		dbState.activeOrders = [order({ type: 'conditional', condition: cond, limit_price: null })];
		priceAt(35_000);
		marketState.signals.dev_dump = null; // intel row absent

		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(0);
	});

	it('tracks the trailing high-water mark each sweep and fires on the drawdown', async () => {
		dbState.activeOrders = [order({ type: 'trailing', side: 'sell', size_sol: null, sell_pct: 100, trail_pct: 20, peak_price: 100_000, limit_price: null })];
		priceAt(90_000); // only 10% off the peak
		await runOrderSweep(cfg);
		expect(tradeState.calls).toHaveLength(0);
		expect(call('mark_evaluated').values[1]).toBe(100_000); // peak held

		dbState.calls = [];
		priceAt(75_000); // 25% off the peak
		await runOrderSweep(cfg);
		expect(tradeState.calls).toHaveLength(1);
		expect(tradeState.calls[0].input.isMax).toBe(true); // sell_pct 100 → 'max'
	});
});

// ── one agent, one wallet ────────────────────────────────────────────────────
describe('runOrderSweep: per-agent serialization', () => {
	it('never runs two fills for the same agent concurrently', async () => {
		dbState.activeOrders = [
			order({ id: '44444444-4444-4444-8444-444444444444' }),
			order({ id: '55555555-5555-4555-8555-555555555555' }),
		];
		priceAt(39_000);
		tradeState.delayMs = 5;

		await runOrderSweep(cfg);

		expect(tradeState.calls).toHaveLength(2);
		expect(tradeState.maxInflight).toBe(1);
	});

	it('loads each agent once per sweep', async () => {
		dbState.activeOrders = [
			order({ id: '44444444-4444-4444-8444-444444444444' }),
			order({ id: '55555555-5555-4555-8555-555555555555' }),
		];
		priceAt(55_000);

		await runOrderSweep(cfg);

		expect(dbState.calls.filter((c) => c.kind === 'load_agent')).toHaveLength(1);
	});
});

// ── boot config ──────────────────────────────────────────────────────────────
describe('loadConfig', () => {
	const saved = { ...process.env };

	const withEnv = (over) => {
		process.env = { ...saved, DATABASE_URL: 'postgres://u:p@example.invalid/db', JWT_SECRET: 'test-secret', ...over };
	};

	beforeEach(() => { withEnv({}); });
	afterEach(() => { process.env = { ...saved }; });

	it('defaults to the safe simulate mode on mainnet', () => {
		const cfgOut = loadConfig();
		expect(cfgOut.mode).toBe('simulate');
		expect(cfgOut.network).toBe('mainnet');
		expect(cfgOut.globalKill).toBe(false);
	});

	it('refuses to start without a database or a JWT secret', () => {
		process.env = { ...saved, DATABASE_URL: '', POSTGRES_URL: '', NEON_DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', JWT_SECRET: 'x' };
		expect(() => loadConfig()).toThrow(/DATABASE_URL/);
		withEnv({ JWT_SECRET: '' });
		expect(() => loadConfig()).toThrow(/JWT_SECRET/);
	});

	it('rejects an unknown mode or network', () => {
		withEnv({ ORDERS_MODE: 'yolo' });
		expect(() => loadConfig()).toThrow(/ORDERS_MODE/);
		withEnv({ ORDERS_NETWORK: 'testnet' });
		expect(() => loadConfig()).toThrow(/ORDERS_NETWORK/);
	});

	it('refuses live mode without a real RPC endpoint', () => {
		withEnv({ ORDERS_MODE: 'live', SOLANA_RPC_URL: '', HELIUS_API_KEY: '', WALLET_ENCRYPTION_KEY: 'k' });
		expect(() => loadConfig()).toThrow(/SOLANA_RPC_URL or HELIUS_API_KEY/);
	});

	it('refuses live mode without the custodial wallet key (every fill would die at key recovery)', () => {
		withEnv({ ORDERS_MODE: 'live', SOLANA_RPC_URL: 'https://rpc.example.invalid', WALLET_ENCRYPTION_KEY: '' });
		expect(() => loadConfig()).toThrow(/WALLET_ENCRYPTION_KEY/);
		withEnv({ ORDERS_MODE: 'live', SOLANA_RPC_URL: 'https://rpc.example.invalid', WALLET_ENCRYPTION_KEY: 'k' });
		expect(loadConfig().mode).toBe('live');
	});

	it('clamps the poll, concurrency, and stale-claim windows to safe bounds', () => {
		withEnv({ ORDERS_POLL_MS: '10', ORDERS_CONCURRENCY: '999', ORDERS_STALE_FIRING_MS: '5', ORDERS_HEARTBEAT_MS: '-1' });
		const cfgOut = loadConfig();
		expect(cfgOut.pollMs).toBe(3_000);
		expect(cfgOut.concurrency).toBe(16);
		expect(cfgOut.staleFiringMs).toBe(60_000);
		expect(cfgOut.heartbeatMs).toBe(0);
	});
});

// ── live mode ────────────────────────────────────────────────────────────────
describe('runOrderSweep: live mode', () => {
	it('does not force simulate and records a confirmed fill with the signature', async () => {
		dbState.activeOrders = [order()];
		priceAt(39_000);
		tradeState.result = {
			ok: true, status: 200,
			data: { signature: '5xSigTest', venue: 'bonding_curve', sol_spent: 0.25, tokens_received: 12_345, price_impact_pct: 1.2, custody_event_id: 'ce-1' },
		};

		await runOrderSweep({ ...cfg, mode: 'live' });

		expect(tradeState.calls[0].input.simulate).toBe(false);
		const fill = call('insert_fill');
		expect(fill.values).toContain('confirmed');
		expect(fill.values).toContain('5xSigTest');
		expect(fill.values).toContain('ce-1');
	});
});
