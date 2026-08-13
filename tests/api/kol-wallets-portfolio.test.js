// GET /api/kol/wallets (api/kol/[action].js -> handleWallets).
//
// The regression this pins: the row used to advertise a P&L card that Birdeye
// never supplies. `/v1/wallet/portfolio` is a holdings endpoint, so
// `realizedPnl`, `winRate` and `totalTrades` were hardcoded zeros,
// `unrealizedPnl` was really the portfolio's total USD value under a P&L name,
// and `topToken.pnl` was the top holding's value. `get_wallet_portfolio` in
// packages/kol-mcp handed all four to agents as measured numbers, so a wallet
// with a real losing record and a wallet we had never measured looked identical.
//
// Now the row states its sources: holdings from Birdeye, and P&L FIFO-computed
// from the wallet's own on-chain trades, with every P&L field null when there is
// no trade history to measure.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getWalletPnl = vi.fn();
vi.mock('../../src/kol/wallet-pnl.js', () => ({ getWalletPnl }));
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));
vi.mock('../../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: vi.fn() }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { mcpIp: async () => ({ success: true }) },
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../../api/kol/[action].js');

// A verbatim-shaped Birdeye /v1/wallet/portfolio payload: positions and their
// USD value, and not one P&L field anywhere in it.
const BIRDEYE_PORTFOLIO = {
	success: true,
	data: {
		wallet: 'THREEsynthetic1111111111111111111111111111',
		totalUsd: 38120.5,
		items: [
			{ symbol: 'SOL', valueUsd: 16620.5 },
			{ symbol: 'THREE', valueUsd: 21500 },
		],
	},
};

const WALLET = 'THREEsynthetic1111111111111111111111111111';

function call(url) {
	const res = {
		statusCode: 0,
		body: null,
		headers: {},
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(b) {
			this.body = b ? JSON.parse(b) : null;
		},
		get headersSent() {
			return this.body !== null;
		},
		get writableEnded() {
			return this.body !== null;
		},
	};
	const req = { method: 'GET', url, headers: { host: 'three.ws' }, query: { action: 'wallets' } };
	return handler(req, res).then(() => res);
}

// Each test uses a distinct address so the handler's 60s per-address cache
// (module state, shared across tests in this file) never serves a stale row.
function addrFor(tag) {
	return `${WALLET.slice(0, 20)}${tag}`.padEnd(43, '1');
}

beforeEach(() => {
	process.env.BIRDEYE_API_KEY = 'test-birdeye-key';
	getWalletPnl.mockReset();
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({ ok: true, status: 200, json: async () => BIRDEYE_PORTFOLIO })),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.BIRDEYE_API_KEY;
});

describe('GET /api/kol/wallets', () => {
	it('requires a Birdeye key and says so', async () => {
		delete process.env.BIRDEYE_API_KEY;
		const res = await call(`/api/kol/wallets?addresses=${addrFor('a')}`);
		expect(res.statusCode).toBe(503);
		expect(res.body.error).toBe('birdeye_not_configured');
	});

	it('rejects a request with no addresses', async () => {
		const res = await call('/api/kol/wallets?addresses=');
		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('validation_error');
	});

	it('reports Birdeye holdings under holdings names', async () => {
		const addr = addrFor('b');
		getWalletPnl.mockResolvedValue({ trades: 0, closedTrades: 0 });
		const res = await call(`/api/kol/wallets?addresses=${addr}`);
		expect(res.statusCode).toBe(200);
		const [row] = res.body.data;
		expect(row.address).toBe(addr);
		expect(row.totalUsd).toBe(38120.5);
		expect(row.holdings).toBe(2);
		expect(row.topToken).toEqual({ symbol: 'THREE', valueUsd: 21500 });
	});

	it('never emits a P&L number Birdeye did not supply', async () => {
		const addr = addrFor('c');
		getWalletPnl.mockResolvedValue({ trades: 0, closedTrades: 0 });
		const res = await call(`/api/kol/wallets?addresses=${addr}`);
		const [row] = res.body.data;
		// No trade history: unknown, not flat. A zero here is the old bug.
		expect(row.realizedPnl).toBeNull();
		expect(row.winRate).toBeNull();
		expect(row.totalTrades).toBeNull();
		expect(row.volumeUsd).toBeNull();
		expect(row.pnlSource).toBeNull();
		// The field that used to carry the portfolio value under a P&L name is gone.
		expect(row).not.toHaveProperty('unrealizedPnl');
	});

	it('merges real FIFO P&L when the wallet has on-chain trades', async () => {
		const addr = addrFor('d');
		getWalletPnl.mockResolvedValue({
			trades: 412,
			closedTrades: 200,
			realizedUsd: 124300,
			winRate: 0.64,
			volumeUsd: 2840000,
		});
		const res = await call(`/api/kol/wallets?addresses=${addr}`);
		const [row] = res.body.data;
		expect(row.realizedPnl).toBe(124300);
		expect(row.winRate).toBe(0.64);
		expect(row.totalTrades).toBe(412);
		expect(row.volumeUsd).toBe(2840000);
		expect(row.pnlSource).toBe('onchain-fifo');
		expect(row.pnlWindow).toBe('30d');
	});

	it('leaves win rate unknown when the wallet has closed nothing', async () => {
		const addr = addrFor('e');
		getWalletPnl.mockResolvedValue({
			trades: 9,
			closedTrades: 0,
			realizedUsd: 0,
			winRate: 0,
			volumeUsd: 1500,
		});
		const res = await call(`/api/kol/wallets?addresses=${addr}`);
		const [row] = res.body.data;
		expect(row.totalTrades).toBe(9);
		expect(row.winRate).toBeNull();
	});

	it('omits a wallet whose Birdeye fetch failed rather than zeroing it', async () => {
		const addr = addrFor('f');
		getWalletPnl.mockResolvedValue({ trades: 0, closedTrades: 0 });
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })),
		);
		const res = await call(`/api/kol/wallets?addresses=${addr}`);
		expect(res.statusCode).toBe(200);
		expect(res.body.data).toEqual([]);
	});
});
