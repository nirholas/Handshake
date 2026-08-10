/**
 * Guard rails on the copy-trading endpoints (api/copy/*).
 *
 * Three behaviors that are cheap to get wrong and expensive to ship wrong:
 *
 *  1. settle-fee must only ratchet a subscription's high-water mark from a quote
 *     that was actually issued FOR that subscription's performance fee. The
 *     generic quote surfaces let a caller pick ref_id, so an unbound settle lets
 *     a copier pay cents on an unrelated purpose and erase every fee they owe
 *     their leader.
 *  2. subscriptions must treat { id, status } as a status change even when the
 *     cookie client also carries its CSRF token in the body.
 *  3. smart-wallets must not resolve ?sort= against Object.prototype.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let sessionUser = { id: 'copier-1' };
const sqlCalls = [];
let ownedSubscription = [{ id: '11111111-1111-4111-8111-111111111111' }];

vi.mock('../api/_lib/http.js', () => ({
	wrap: (fn) => fn,
	cors: () => false,
	method: () => true,
	readJson: async (req) => req.body ?? {},
	rateLimited: (res) => { res._json = { status: 429, body: { error: 'rate_limited' } }; return res; },
	error: (res, status, code, message, extra = {}) => {
		res._json = { status, body: { error: code, error_description: message, ...extra } };
		return res;
	},
	json: (res, status, body) => { res._json = { status, body }; return res; },
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: async () => ({ success: true }), mcpIp: async () => ({ success: true }) },
	clientIp: () => '1.2.3.4',
}));
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: async () => sessionUser,
	authenticateBearer: async () => null,
	extractBearer: () => null,
}));
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: async () => true }));
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		const text = strings.join('?');
		sqlCalls.push({ text, values });
		if (text.includes('select id from copy_subscriptions')) return Promise.resolve(ownedSubscription);
		if (text.includes('update copy_subscriptions set status')) {
			return Promise.resolve([{ id: values[1], status: values[0] }]);
		}
		return Promise.resolve([]);
	},
}));

const verifyQuote = vi.fn();
const verifyAndSettlePayment = vi.fn(async () => ({ ok: true, payment_id: 'pay-7' }));
vi.mock('../api/_lib/token/quote.js', () => ({ verifyQuote: (...a) => verifyQuote(...a) }));
vi.mock('../api/_lib/token/payments.js', () => ({
	verifyAndSettlePayment: (...a) => verifyAndSettlePayment(...a),
}));
vi.mock('../api/_lib/copy-earnings.js', () => ({
	subscriptionOwed: async () => ({ fee_sol: 0, cumulative_profit_sol: 0 }),
	accruedLeaderEarnings: async () => ({ copiers: 0, accrued_fee_sol: 0, copier_profit_sol: 0 }),
}));
vi.mock('../api/_lib/avatar-wallet.js', () => ({ solUsdPrice: async () => 100 }));
vi.mock('../api/_lib/copy-engine.js', () => ({
	normalizeSubscriptionInput: () => ({ ok: false, error: 'create path reached' }),
}));

const settleFee = (await import('../api/copy/settle-fee.js')).default;
const subscriptions = (await import('../api/copy/subscriptions.js')).default;
const smartWallets = (await import('../api/copy/smart-wallets.js')).default;

const SUB = '11111111-1111-4111-8111-111111111111';
const res = () => ({ setHeader() {}, _json: null });
const post = (url, body) => ({ method: 'POST', url, headers: {}, body });
const get = (url) => ({ method: 'GET', url, headers: {} });

const copyQuote = (over = {}) => ({
	purpose: 'copy_performance_fee', refType: 'copy_perf_fee', refId: `${SUB}|0.5`, ...over,
});

beforeEach(() => {
	sqlCalls.length = 0;
	sessionUser = { id: 'copier-1' };
	ownedSubscription = [{ id: SUB }];
	verifyQuote.mockReset();
	verifyAndSettlePayment.mockClear();
});

describe('POST /api/copy/settle-fee settle phase: quote binding', () => {
	it('settles and ratchets the HWM for a quote bound to the caller\'s subscription', async () => {
		verifyQuote.mockReturnValue(copyQuote());
		const r = res();
		await settleFee(post('/api/copy/settle-fee', { quoteToken: 'q', tx_signature: 'sig' }), r);
		expect(r._json.status).toBe(200);
		expect(r._json.body).toMatchObject({ paid: true, payment_id: 'pay-7', subscription_id: SUB, high_water_mark_sol: 0.5 });
		expect(verifyAndSettlePayment).toHaveBeenCalledTimes(1);
		const ratchet = sqlCalls.find((c) => c.text.includes('high_water_mark_sol = greatest'));
		expect(ratchet).toBeTruthy();
		expect(ratchet.values).toEqual([0.5, SUB, 'copier-1']);
	});

	it('refuses a quote minted for another purpose, before any settlement', async () => {
		verifyQuote.mockReturnValue(copyQuote({ purpose: 'spin', refType: 'spin' }));
		const r = res();
		await settleFee(post('/api/copy/settle-fee', { quoteToken: 'q', tx_signature: 'sig' }), r);
		expect(r._json.status).toBe(400);
		expect(r._json.body.error).toBe('wrong_quote');
		expect(verifyAndSettlePayment).not.toHaveBeenCalled();
		expect(sqlCalls.some((c) => c.text.includes('high_water_mark_sol = greatest'))).toBe(false);
	});

	it('refuses a copy-fee quote whose refId is not a subscription reference', async () => {
		verifyQuote.mockReturnValue(copyQuote({ refId: 'not-a-ref' }));
		const r = res();
		await settleFee(post('/api/copy/settle-fee', { quoteToken: 'q', tx_signature: 'sig' }), r);
		expect(r._json.status).toBe(400);
		expect(r._json.body.error).toBe('wrong_quote');
		expect(verifyAndSettlePayment).not.toHaveBeenCalled();
	});

	it('refuses a copy-fee quote bound to someone else\'s subscription', async () => {
		verifyQuote.mockReturnValue(copyQuote({ refId: '22222222-2222-4222-8222-222222222222|9' }));
		ownedSubscription = [];
		const r = res();
		await settleFee(post('/api/copy/settle-fee', { quoteToken: 'q', tx_signature: 'sig' }), r);
		expect(r._json.status).toBe(404);
		expect(verifyAndSettlePayment).not.toHaveBeenCalled();
	});

	it('surfaces a tampered quote token as an invalid-quote error', async () => {
		verifyQuote.mockImplementation(() => {
			const e = new Error('quote signature invalid');
			e.status = 422; e.code = 'invalid_quote';
			throw e;
		});
		const r = res();
		await settleFee(post('/api/copy/settle-fee', { quoteToken: 'q', tx_signature: 'sig' }), r);
		expect(r._json.status).toBe(422);
		expect(r._json.body.error).toBe('invalid_quote');
		expect(verifyAndSettlePayment).not.toHaveBeenCalled();
	});
});

describe('POST /api/copy/subscriptions: status-only update', () => {
	it('pauses when the CSRF token rides along in the body', async () => {
		const r = res();
		await subscriptions(post('/api/copy/subscriptions', { id: SUB, status: 'paused', _csrf: 'tok' }), r);
		expect(r._json.status).toBe(200);
		expect(r._json.body.subscription).toMatchObject({ id: SUB, status: 'paused' });
		expect(sqlCalls.some((c) => c.text.includes('update copy_subscriptions set status'))).toBe(true);
	});

	it('still rejects an unknown status', async () => {
		const r = res();
		await subscriptions(post('/api/copy/subscriptions', { id: SUB, status: 'banana', _csrf: 'tok' }), r);
		expect(r._json.status).toBe(400);
		expect(r._json.body.error).toBe('invalid_status');
	});

	it('takes the create path when leader_agent_id is present', async () => {
		const r = res();
		await subscriptions(post('/api/copy/subscriptions', { id: SUB, status: 'paused', leader_agent_id: 'nope' }), r);
		expect(r._json.status).toBe(400);
		expect(r._json.body.error).toBe('invalid_leader');
	});
});

describe('GET /api/copy/smart-wallets: sort parameter', () => {
	const wallets = async (query) => {
		const r = res();
		await smartWallets(get(`/api/copy/smart-wallets${query}`), r);
		return r;
	};

	it.each(['__proto__', 'valueOf', 'hasOwnProperty', 'constructor', 'toString'])(
		'answers 200 for the inherited key %s instead of throwing',
		async (key) => {
			const r = await wallets(`?sort=${key}&limit=3`);
			expect(r._json.status).toBe(200);
			expect(r._json.body.wallets).toHaveLength(3);
		},
	);

	it('falls back to the score ranking for an unknown sort', async () => {
		const fallback = await wallets('?sort=__proto__&limit=5');
		const scored = await wallets('?sort=score&limit=5');
		expect(fallback._json.body.wallets.map((w) => w.address))
			.toEqual(scored._json.body.wallets.map((w) => w.address));
	});

	it('still honors a real sort key', async () => {
		const r = await wallets('?sort=profit&limit=5');
		const profits = r._json.body.wallets.map((w) => w.realized_profit_30d_usd);
		expect([...profits].sort((a, b) => b - a)).toEqual(profits);
	});
});
