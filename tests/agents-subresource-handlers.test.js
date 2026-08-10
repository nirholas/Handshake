/**
 * Sub-resource handler dispatch + ownership gating for the three agent modules
 * that are never routed directly: api/agents/orders.js and api/agents/portfolio.js
 * (dispatched by api/agents/[id].js) and api/agents/patronage.js (dispatched by
 * api/agents/solana-wallet.js). vercel.json rewrites every
 * /api/agents/<segment>... path to api/agents/[id].js, so these modules are only
 * ever entered as handler(req, res, agentId, action).
 *
 * The engines behind them are covered by orders-engine.test.js, portfolio.test.js,
 * and patronage.test.js. What is pinned here is the layer above: which action maps
 * to which behaviour, and that a visitor can never read or mutate another owner's
 * orders, portfolio, or perk ladder.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const OWNER = 'user-owner';
const AGENT = '11111111-2222-4333-8444-555555555555';
const ORDER = '99999999-8888-4777-8666-555555555555';
// $THREE, the only coin this platform references.
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

let sessionUser = { id: OWNER };
let agentRow = { id: AGENT, user_id: OWNER, name: 'Test Agent', meta: { solana_address: THREE } };

vi.mock('../api/_lib/http.js', () => ({
	wrap: (fn) => fn,
	cors: () => false,
	method: (req, res, allowed) => {
		if (allowed.includes(req.method)) return true;
		res._json = { status: 405, body: { error: 'method_not_allowed' } };
		return false;
	},
	readJson: async (req) => req.body ?? {},
	rateLimited: (res) => {
		res._json = { status: 429, body: { error: 'rate_limited' } };
		return res;
	},
	error: (res, status, code, message, extra = {}) => {
		res._json = { status, body: { error: code, error_description: message, ...extra } };
		return res;
	},
	json: (res, status, body) => {
		res._json = { status, body };
		return res;
	},
	serverError: (res, status, code) => {
		res._json = { status, body: { error: code } };
		return res;
	},
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		walletRead: vi.fn(async () => ({ success: true })),
		tradePerUser: vi.fn(async () => ({ success: true })),
		agentProfileIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '1.2.3.4',
}));

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../api/_lib/db.js', () => ({
	sql: (strings) => {
		const text = strings.join(' ');
		if (/from agent_identities/i.test(text)) return Promise.resolve(agentRow ? [agentRow] : []);
		return Promise.resolve([]);
	},
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

// Orders dependencies. The pure model (normalizeOrder, describeOrder) stays real
// so the 422 case below exercises the actual validator.
vi.mock('../api/_lib/orders.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		listOrders: vi.fn(async () => []),
		ordersSummary: vi.fn(async () => ({ total: 0, active: 0 })),
		getOrder: vi.fn(async () => null),
		listFills: vi.fn(async () => []),
		createOrder: vi.fn(async () => ({ id: ORDER })),
		updateOrder: vi.fn(async () => null),
		cancelOrder: vi.fn(async () => null),
		cancelAllOrders: vi.fn(async () => 0),
	};
});
vi.mock('../api/_lib/agent-wallet.js', () => ({
	getSolanaAddressBalances: vi.fn(async () => ({ sol: 0 })),
}));
vi.mock('../api/_lib/agent-trade-guards.js', () => ({
	getSpendLimits: () => ({ per_tx_usd: 10, daily_usd: 50, frozen: false }),
	getTradeLimits: () => ({ kill_switch: false, per_trade_sol: 1, daily_budget_sol: 5 }),
}));
vi.mock('../api/_lib/pump.js', () => ({ getPumpTradeClient: vi.fn(async () => ({ connection: {} })) }));
vi.mock('../api/_lib/trade-firewall.js', () => ({ assessTradeSafety: vi.fn(async () => null) }));
vi.mock('../workers/agent-orders/market.js', () => ({
	getSignals: vi.fn(async () => ({ market: null, signals: {} })),
	metricValue: vi.fn(() => null),
}));

// Portfolio dependencies.
const portfolioSnapshot = { t: 1, sol_usd: 75, net_worth: { sol: 0, usd: 0 }, holdings: [] };
vi.mock('../api/_lib/portfolio.js', () => ({
	getPortfolio: vi.fn(async () => portfolioSnapshot),
}));

// Patronage dependencies. The tier ladder and entitlement math stay real.
vi.mock('../api/_lib/patronage.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		aggregatePatrons: vi.fn(async () => []),
		patronTotals: vi.fn(async () => ({ patrons: 0, usd: 0, supports: 0 })),
		patronStanding: vi.fn(async () => ({
			usd: 0, supportCount: 0, firstAt: null, lastAt: null, level: null,
			progress: { pct: 0, next: null, remainingUsd: 10 },
		})),
		listPerks: vi.fn(async () => []),
		resolvePatronName: vi.fn(async () => null),
		hiddenWallets: vi.fn(async () => new Set()),
	};
});
vi.mock('../api/_lib/siws.js', () => ({ verifySiwsSignature: vi.fn(() => false) }));
vi.mock('../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));

const ordersHandler = (await import('../api/agents/orders.js')).default;
const portfolioHandler = (await import('../api/agents/portfolio.js')).default;
const patronageHandler = (await import('../api/agents/patronage.js')).default;

function mkReq(method = 'GET', url = `/api/agents/${AGENT}/orders`, body) {
	return { method, url, headers: {}, body, on: () => {} };
}
function mkRes() {
	return { _json: null, setHeader() {}, writeHead() {}, flushHeaders() {}, write() {}, end() {} };
}

beforeEach(() => {
	sessionUser = { id: OWNER };
	agentRow = { id: AGENT, user_id: OWNER, name: 'Test Agent', meta: { solana_address: THREE } };
});

describe('api/agents/orders.js dispatch', () => {
	it('lists the owner orders with the live summary (main path)', async () => {
		const res = mkRes();
		await ordersHandler(mkReq('GET'), res, AGENT, undefined);
		expect(res._json.status).toBe(200);
		expect(res._json.body.data.orders).toEqual([]);
		expect(res._json.body.data.summary.frozen).toBe(false);
		expect(res._json.body.data.summary.kill_switch).toBe(false);
	});

	it('serves the closed condition vocabulary on /schema', async () => {
		const res = mkRes();
		await ordersHandler(mkReq('GET'), res, AGENT, 'schema');
		expect(res._json.status).toBe(200);
		expect(res._json.body.data.order_types).toContain('conditional');
		expect(res._json.body.data.number_ops).toContain('gte');
	});

	it('refuses a visitor who is not the owner (failure path)', async () => {
		sessionUser = { id: 'someone-else' };
		const res = mkRes();
		await ordersHandler(mkReq('GET'), res, AGENT, undefined);
		expect(res._json.status).toBe(403);
		expect(res._json.body.error).toBe('forbidden');
	});

	it('refuses an anonymous caller before touching the agent row', async () => {
		sessionUser = null;
		const res = mkRes();
		await ordersHandler(mkReq('GET'), res, AGENT, undefined);
		expect(res._json.status).toBe(401);
	});

	it('404s an unknown sub-resource rather than falling through to the list', async () => {
		const res = mkRes();
		await ordersHandler(mkReq('GET'), res, AGENT, 'not-a-real-action');
		expect(res._json.status).toBe(404);
		expect(res._json.body.error_description).toMatch(/unknown orders sub-resource/);
	});

	it('rejects an unsupported method on a single order', async () => {
		const res = mkRes();
		await ordersHandler(mkReq('PATCH'), res, AGENT, ORDER);
		expect(res._json.status).toBe(405);
	});

	it('422s an order the engine cannot validate', async () => {
		const res = mkRes();
		await ordersHandler(mkReq('POST', `/api/agents/${AGENT}/orders`, { type: 'limit' }), res, AGENT, undefined);
		expect(res._json.status).toBe(422);
	});
});

describe('api/agents/portfolio.js dispatch', () => {
	it('returns the owner snapshot when no action is given (main path)', async () => {
		const res = mkRes();
		await portfolioHandler(mkReq('GET', `/api/agents/${AGENT}/portfolio`), res, AGENT, undefined);
		expect(res._json.status).toBe(200);
		expect(res._json.body.data).toBe(portfolioSnapshot);
	});

	it('404s an unknown sub-resource (failure path)', async () => {
		const res = mkRes();
		await portfolioHandler(mkReq('GET'), res, AGENT, 'bogus');
		expect(res._json.status).toBe(404);
	});

	it('never exposes another owner attribution ledger', async () => {
		sessionUser = { id: 'someone-else' };
		const res = mkRes();
		await portfolioHandler(mkReq('GET'), res, AGENT, undefined);
		expect(res._json.status).toBe(403);
	});
});

describe('api/agents/patronage.js dispatch', () => {
	it('serves the public ladder and wall on GET (main path)', async () => {
		sessionUser = null;
		const res = mkRes();
		await patronageHandler(mkReq('GET', `/api/agents/${AGENT}/solana/patronage`), res, AGENT);
		expect(res._json.status).toBe(200);
		expect(res._json.body.data.is_owner).toBe(false);
		expect(res._json.body.data.levels.map((l) => l.key)).toContain('benefactor');
		expect(res._json.body.data.wall).toEqual([]);
	});

	it('marks the owner so the editor can render its own payloads', async () => {
		const res = mkRes();
		await patronageHandler(mkReq('GET', `/api/agents/${AGENT}/solana/patronage`), res, AGENT);
		expect(res._json.status).toBe(200);
		expect(res._json.body.data.is_owner).toBe(true);
	});

	it('rejects an unknown POST op (failure path)', async () => {
		const res = mkRes();
		await patronageHandler(
			mkReq('POST', `/api/agents/${AGENT}/solana/patronage`, { op: 'nope' }),
			res,
			AGENT,
		);
		expect(res._json.status).toBe(400);
		expect(res._json.body.error_description).toMatch(/unknown op/);
	});

	it('will not unlock a perk without a wallet signature', async () => {
		const res = mkRes();
		await patronageHandler(
			mkReq('POST', `/api/agents/${AGENT}/solana/patronage`, { op: 'unlock', wallet: THREE }),
			res,
			AGENT,
		);
		expect(res._json.status).toBe(401);
		expect(res._json.body.error_description).toMatch(/missing signature/);
	});

	it('404s a patronage read for an agent that does not exist', async () => {
		agentRow = null;
		const res = mkRes();
		await patronageHandler(mkReq('GET', `/api/agents/${AGENT}/solana/patronage`), res, AGENT);
		expect(res._json.status).toBe(404);
	});
});
