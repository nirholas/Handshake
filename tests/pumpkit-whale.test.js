import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted creates variables before the mock factories run (needed because
// vi.mock is hoisted above import statements).
// Shared mutable state accessible from mock factories and tests.
// The `conn` singleton ensures that `new Connection()` always returns the
// same object — so `const mockInstance = new Connection()` in a test and
// the instance created inside `watchWhaleTrades` are identical objects.
const state = vi.hoisted(() => ({
	logCallback: null,
	fakeEvents: [],
	conn: {
		onLogs: vi.fn(function(_, cb) { state.logCallback = cb; return 1; }),
		removeOnLogsListener: vi.fn().mockResolvedValue(undefined),
	},
}));

// SOL/USD comes from the shared provider chain. Pin it so the USD thresholds
// under test are arithmetic, not a live network read.
vi.mock('../src/shared/usd-price.js', () => ({
	getSolPriceUsd: vi.fn(async () => 200),
	solToUsd: vi.fn(async (sol) => sol * 200),
}));

vi.mock('@solana/web3.js', () => ({
	// Regular function (not arrow) for `new` compatibility; returns shared singleton.
	Connection: vi.fn(function() { return state.conn; }),
	PublicKey: vi.fn(function(s) {
		this.toString = () => s;
		this.toBase58 = () => s;
	}),
}));

vi.mock('@coral-xyz/anchor', () => ({
	BorshCoder: vi.fn(function() { return {}; }),
	EventParser: vi.fn(function() {
		return { parseLogs: vi.fn(() => state.fakeEvents) };
	}),
}));

vi.mock('@pump-fun/pump-sdk', () => ({
	PUMP_PROGRAM_ID: { toString: () => '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' },
	pumpIdl: {},
}));

globalThis.fetch = vi.fn().mockResolvedValue({
	json: () =>
		Promise.resolve({
			data: { So11111111111111111111111111111111111111112: { price: 100 } },
		}),
});

const { watchWhaleTrades } = await import('../src/pump/pumpkit-whale.js');

function makeTrade(mintStr, solLamports, isBuy = true) {
	return {
		name: 'TradeEvent',
		data: {
			mint: { toString: () => mintStr },
			isBuy,
			solAmount: { toString: () => String(solLamports) },
			user: { toString: () => 'wallet1234567890' },
			timestamp: { toString: () => '1700000000' },
		},
	};
}

const MINT = 'TESTMINT1111111111111111111111111111111111';

describe('watchWhaleTrades', () => {
	beforeEach(() => {
		state.logCallback = null;
		state.fakeEvents = [];
		state.conn.onLogs.mockClear();
		state.conn.removeOnLogsListener.mockClear();
	});

	function fireLog(signature = 'sig1') {
		state.logCallback?.({ signature, logs: [], err: null });
	}

	it('reports a blind feed instead of silently dropping every trade when SOL/USD is unavailable', async () => {
		const { getSolPriceUsd } = await import('../src/shared/usd-price.js');
		getSolPriceUsd.mockResolvedValueOnce(0);
		const trades = [];
		const statuses = [];
		const ac = new AbortController();
		state.fakeEvents = [makeTrade(MINT, 60_000_000_000)];

		await watchWhaleTrades({
			mint: MINT,
			minUsd: 5000,
			onTrade: (t) => trades.push(t),
			onStatus: (s) => statuses.push(s),
			signal: ac.signal,
		});
		fireLog();

		// No USD price means no honest way to apply a USD threshold, so nothing
		// fires; the caller is told why rather than being shown an empty list that
		// is indistinguishable from a quiet market.
		expect(trades).toHaveLength(0);
		expect(statuses).toEqual([expect.objectContaining({ code: 'usd_price_unavailable' })]);
		ac.abort();
	});

	it('calls onTrade for trades >= minUsd', async () => {
		const trades = [];
		const ac = new AbortController();

		// 60 SOL × $100/SOL = $6000 ≥ $5000
		state.fakeEvents = [makeTrade(MINT, 60_000_000_000)];

		await watchWhaleTrades({ mint: MINT, minUsd: 5000, onTrade: (t) => trades.push(t), signal: ac.signal });

		fireLog();

		expect(trades).toHaveLength(1);
		expect(trades[0].usd).toBeGreaterThanOrEqual(5000);
		expect(trades[0].sideBuy).toBe(true);
		expect(trades[0].signature).toBe('sig1');
		expect(trades[0].sol).toBeCloseTo(60);

		ac.abort();
	});

	it('skips trades below minUsd', async () => {
		const trades = [];
		const ac = new AbortController();

		// 0.01 SOL × $100 = $1 < $5000
		state.fakeEvents = [makeTrade(MINT, 10_000_000)];

		await watchWhaleTrades({ mint: MINT, minUsd: 5000, onTrade: (t) => trades.push(t), signal: ac.signal });

		fireLog();

		expect(trades).toHaveLength(0);

		ac.abort();
	});

	it('skips TradeEvents for a different mint', async () => {
		const trades = [];
		const ac = new AbortController();

		state.fakeEvents = [makeTrade('OTHERMINT1111111111111111111111111111111111', 60_000_000_000)];

		await watchWhaleTrades({ mint: MINT, minUsd: 5000, onTrade: (t) => trades.push(t), signal: ac.signal });

		fireLog();

		expect(trades).toHaveLength(0);

		ac.abort();
	});

	it('skips errored log entries', async () => {
		const trades = [];
		const ac = new AbortController();

		state.fakeEvents = [makeTrade(MINT, 60_000_000_000)];

		await watchWhaleTrades({ mint: MINT, minUsd: 5000, onTrade: (t) => trades.push(t), signal: ac.signal });

		// Simulate a log with an error — should be ignored
		state.logCallback?.({ signature: 'sig1', logs: [], err: new Error('rpc error') });

		expect(trades).toHaveLength(0);

		ac.abort();
	});

	it('skips non-TradeEvent Anchor events', async () => {
		const trades = [];
		const ac = new AbortController();

		state.fakeEvents = [{ name: 'CreateEvent', data: {} }];

		await watchWhaleTrades({ mint: MINT, minUsd: 5000, onTrade: (t) => trades.push(t), signal: ac.signal });

		fireLog();

		expect(trades).toHaveLength(0);

		ac.abort();
	});

	it('calls onTrade for sell trades that meet minUsd', async () => {
		const trades = [];
		const ac = new AbortController();

		state.fakeEvents = [makeTrade(MINT, 100_000_000_000, false)]; // 100 SOL sell

		await watchWhaleTrades({ mint: MINT, minUsd: 5000, onTrade: (t) => trades.push(t), signal: ac.signal });

		fireLog();

		expect(trades).toHaveLength(1);
		expect(trades[0].sideBuy).toBe(false);
		expect(trades[0].usd).toBeGreaterThanOrEqual(5000);

		ac.abort();
	});

	it('does not fire after abort', async () => {
		const trades = [];
		const ac = new AbortController();

		state.fakeEvents = [makeTrade(MINT, 60_000_000_000)];

		await watchWhaleTrades({ mint: MINT, minUsd: 5000, onTrade: (t) => trades.push(t), signal: ac.signal });

		ac.abort();
		fireLog(); // fires after abort

		expect(trades).toHaveLength(0);
	});

	it('cleans up the onLogs listener on abort', async () => {
		const { Connection } = await import('@solana/web3.js');
		const mockInstance = new Connection();

		const ac = new AbortController();
		await watchWhaleTrades({ mint: MINT, minUsd: 5000, onTrade: () => {}, signal: ac.signal });
		ac.abort();

		expect(mockInstance.removeOnLogsListener).toHaveBeenCalled();
	});
});
