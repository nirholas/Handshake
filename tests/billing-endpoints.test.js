// Behavioural coverage for the /api/billing/* handlers.
//
// The pre-existing tests/billing.test.js asserts on handler *source text*, which
// cannot catch the class of bug this suite exists for: a path segment or query
// param that reaches Postgres as the wrong type (a non-uuid against a uuid
// column, a NaN against `limit $1::int`) raises a data exception the wrap()
// boundary reports as a 500 instead of a 4xx. Each handler is invoked here with
// a fake req/res so both the success path and the malformed-input path run end
// to end.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: Object.assign((...a) => sqlMock(...a), { transaction: (...a) => sqlMock(...a) }),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
const extractBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (...a) => extractBearerMock(...a),
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

const allow = { success: true, limit: 100, remaining: 99, reset: 0 };
vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '127.0.0.1',
	limits: {
		authIp: async () => allow,
		authedReadIp: async () => allow,
		widgetRead: async () => allow,
		withdrawalPerUser: async () => allow,
	},
}));

const getReceiptMock = vi.fn();
const rollupInvoiceMock = vi.fn();
const reconciliationStatusMock = vi.fn();
vi.mock('../api/_lib/metering.js', () => ({
	getReceipt: (...a) => getReceiptMock(...a),
	rollupInvoice: (...a) => rollupInvoiceMock(...a),
	reconciliationStatus: (...a) => reconciliationStatusMock(...a),
	atomicsToUsd: (v) => (Number(v) / 1e6).toFixed(2),
}));

const { default: feeInfoHandler } = await import('../api/billing/fee-info.js');
const { default: summaryHandler } = await import('../api/billing/summary.js');
const { default: revenueHandler } = await import('../api/billing/revenue.js');
const { default: receiptsHandler } = await import('../api/billing/receipts.js');
const { default: invoicesHandler } = await import('../api/billing/invoices.js');
const { default: payoutWalletsHandler } = await import('../api/billing/payout-wallets/index.js');
const { default: payoutWalletHandler } = await import('../api/billing/payout-wallets/[id].js');
const { default: withdrawalsHandler } = await import('../api/billing/withdrawals/index.js');
const { default: withdrawalHandler } = await import('../api/billing/withdrawals/[id].js');

const USER = { id: '2a1d1a2e-0e1f-4a3b-9c4d-5e6f70819200', plan: 'free' };
const UUID = '11111111-1111-4111-8111-111111111111';

function mkReq({ method = 'GET', url = '/', headers = {}, query = {}, body = null } = {}) {
	return {
		method,
		url,
		query,
		headers: { ...headers },
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => {
					cb(buf);
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
				if (body == null) queueMicrotask(cb);
			}
		},
		destroy() {},
	};
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

// Each handler issues its queries in order; queue one result set per query.
let sqlQueue = [];
function queueSql(...rows) {
	sqlQueue.push(...rows);
}

beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset().mockImplementation(() => Promise.resolve(sqlQueue.length ? sqlQueue.shift() : []));
	getSessionUserMock.mockReset().mockResolvedValue(USER);
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
	getReceiptMock.mockReset().mockResolvedValue(null);
	rollupInvoiceMock.mockReset().mockResolvedValue({
		period: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
		line_items: [],
		totals: {
			charge_count: 0,
			gross_usd: '0.00',
			fee_usd: '0.00',
			net_atomics: '0',
			currency: 'USDC',
		},
	});
	reconciliationStatusMock.mockReset().mockResolvedValue({
		total: 0,
		reconciled: 0,
		unreconciled: 0,
		all_reconciled: true,
	});
});

describe('GET /api/billing/fee-info', () => {
	it('serves the platform fee rate without auth', async () => {
		const res = mkRes();
		await feeInfoHandler(mkReq({ url: '/api/billing/fee-info' }), res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(Number.isInteger(body.fee_bps)).toBe(true);
		expect(body.fee_percent).toBe((body.fee_bps / 100).toFixed(1));
	});

	it('rejects a non-GET method with 405', async () => {
		const res = mkRes();
		await feeInfoHandler(mkReq({ method: 'POST', url: '/api/billing/fee-info' }), res);
		expect(res.statusCode).toBe(405);
	});
});

describe('GET /api/billing/summary', () => {
	it('returns the plan, quotas, and usage roll-ups', async () => {
		queueSql(
			[
				{
					plan: 'free',
					max_avatars: 10,
					max_bytes_per_avatar: 1,
					max_total_bytes: 2,
					mcp_calls_per_day: 1000,
				},
			],
			[{ avatar_count: 3, total_bytes: 42 }],
			[{ agent_count: 1 }],
			[{ calls_24h: 7 }],
			[{ calls_month: 9 }],
		);
		const res = mkRes();
		await summaryHandler(mkReq({ url: '/api/billing/summary' }), res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.plan).toBe('free');
		expect(body.usage).toEqual({
			avatar_count: 3,
			total_bytes: 42,
			agent_count: 1,
			mcp_calls_24h: 7,
			llm_calls_month: 9,
		});
	});

	it('rejects an anonymous caller with 401', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const res = mkRes();
		await summaryHandler(mkReq({ url: '/api/billing/summary' }), res);
		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
	});
});

describe('GET /api/billing/revenue', () => {
	it('rejects a non-uuid agent_id with 400', async () => {
		const res = mkRes();
		await revenueHandler(
			mkReq({ url: '/api/billing/revenue?agent_id=nope', query: { agent_id: 'nope' } }),
			res,
		);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
	});

	it('rejects an unsupported granularity with 400', async () => {
		const res = mkRes();
		await revenueHandler(mkReq({ url: '/api/billing/revenue', query: { granularity: 'hour' } }), res);
		expect(res.statusCode).toBe(400);
	});
});

describe('GET /api/billing/receipts', () => {
	it('rejects a malformed purchase_id with 400 instead of a database error', async () => {
		const res = mkRes();
		await receiptsHandler(mkReq({ url: '/api/billing/receipts?purchase_id=not-a-uuid' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toContain('UUID');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a non-numeric event_id with 400', async () => {
		const res = mkRes();
		await receiptsHandler(mkReq({ url: '/api/billing/receipts?event_id=abc' }), res);
		expect(res.statusCode).toBe(400);
	});

	it('returns the metered receipt for an owned charge', async () => {
		getReceiptMock.mockResolvedValue({ event_id: 5, action: 'forge', gross_usd: '0.10' });
		const res = mkRes();
		await receiptsHandler(mkReq({ url: '/api/billing/receipts?event_id=5' }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).data.event_id).toBe(5);
		expect(getReceiptMock).toHaveBeenCalledWith({ userId: USER.id, eventId: 5 });
	});

	it('never leaks another user purchase receipt', async () => {
		queueSql([{ id: UUID, user_id: 'someone-else' }]);
		const res = mkRes();
		await receiptsHandler(mkReq({ url: `/api/billing/receipts?purchase_id=${UUID}` }), res);
		expect(res.statusCode).toBe(403);
	});
});

describe('GET /api/billing/invoices', () => {
	it('defaults to the current calendar month', async () => {
		const res = mkRes();
		await invoicesHandler(mkReq({ url: '/api/billing/invoices' }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).invoice.period_label).toMatch(/^\d{4}-\d{2}$/);
	});

	it('rejects an unparseable from/to window with 400', async () => {
		const res = mkRes();
		await invoicesHandler(mkReq({ url: '/api/billing/invoices?from=notadate' }), res);
		expect(res.statusCode).toBe(400);
	});

	it('serves the statement as a CSV attachment', async () => {
		const res = mkRes();
		await invoicesHandler(mkReq({ url: '/api/billing/invoices?format=csv' }), res);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toContain('text/csv');
		expect(res.headers['content-disposition']).toContain('attachment');
		expect(String(res.body).split('\n')[0]).toBe(
			'action,label,count,units,gross_usd,fee_usd,discount_bps',
		);
	});
});

describe('/api/billing/payout-wallets', () => {
	it('lists the caller wallets', async () => {
		queueSql([{ id: UUID, address: 'So1anaAddress', chain: 'solana', is_default: true }]);
		const res = mkRes();
		await payoutWalletsHandler(mkReq({ url: '/api/billing/payout-wallets' }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).wallets).toHaveLength(1);
	});

	it('rejects an address that is not valid for the chosen chain', async () => {
		const res = mkRes();
		await payoutWalletsHandler(
			mkReq({
				method: 'POST',
				url: '/api/billing/payout-wallets',
				headers: { 'content-type': 'application/json' },
				body: { address: '0xnothex', chain: 'base' },
			}),
			res,
		);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toContain('EVM');
	});
});

describe('DELETE /api/billing/payout-wallets/:id', () => {
	it('rejects a non-uuid id with 400 instead of a database error', async () => {
		const res = mkRes();
		await payoutWalletHandler(
			mkReq({ method: 'DELETE', url: '/api/billing/payout-wallets/abc', query: { id: 'abc' } }),
			res,
		);
		expect(res.statusCode).toBe(400);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('404s when the wallet is not the caller own', async () => {
		queueSql([]);
		const res = mkRes();
		await payoutWalletHandler(
			mkReq({ method: 'DELETE', url: `/api/billing/payout-wallets/${UUID}`, query: { id: UUID } }),
			res,
		);
		expect(res.statusCode).toBe(404);
	});
});

describe('GET /api/billing/withdrawals', () => {
	it('coerces a non-numeric limit/offset back to the defaults', async () => {
		queueSql([], [{ total: 0 }]);
		const res = mkRes();
		await withdrawalsHandler(mkReq({ url: '/api/billing/withdrawals?limit=abc&offset=abc' }), res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.limit).toBe(20);
		expect(body.offset).toBe(0);
	});

	it('caps an oversized limit at 100', async () => {
		queueSql([], [{ total: 0 }]);
		const res = mkRes();
		await withdrawalsHandler(mkReq({ url: '/api/billing/withdrawals?limit=999' }), res);
		expect(parse(res).limit).toBe(100);
	});

	it('rejects a withdrawal below the 1 USDC minimum', async () => {
		const res = mkRes();
		await withdrawalsHandler(
			mkReq({
				method: 'POST',
				url: '/api/billing/withdrawals',
				headers: { 'content-type': 'application/json' },
				body: { amount: 500000, currency_mint: 'THREEsynthetic1111', chain: 'solana' },
			}),
			res,
		);
		expect(res.statusCode).toBe(422);
		expect(parse(res).error).toBe('below_minimum');
	});

	it('refuses to queue a payout when no wallet is registered for the chain', async () => {
		queueSql([]);
		const res = mkRes();
		await withdrawalsHandler(
			mkReq({
				method: 'POST',
				url: '/api/billing/withdrawals',
				headers: { 'content-type': 'application/json' },
				body: { amount: 2000000, currency_mint: 'THREEsynthetic1111', chain: 'solana' },
			}),
			res,
		);
		expect(res.statusCode).toBe(422);
		expect(parse(res).error).toBe('no_payout_wallet');
	});
});

describe('GET /api/billing/withdrawals/:id', () => {
	it('rejects a non-uuid id with 400 instead of a database error', async () => {
		const res = mkRes();
		await withdrawalHandler(mkReq({ url: '/api/billing/withdrawals/abc', query: { id: 'abc' } }), res);
		expect(res.statusCode).toBe(400);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('returns an owned withdrawal', async () => {
		queueSql([{ id: UUID, amount: 2000000, status: 'pending' }]);
		const res = mkRes();
		await withdrawalHandler(mkReq({ url: `/api/billing/withdrawals/${UUID}`, query: { id: UUID } }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).withdrawal.id).toBe(UUID);
	});

	it('404s when the withdrawal belongs to someone else', async () => {
		queueSql([]);
		const res = mkRes();
		await withdrawalHandler(mkReq({ url: `/api/billing/withdrawals/${UUID}`, query: { id: UUID } }), res);
		expect(res.statusCode).toBe(404);
	});
});
