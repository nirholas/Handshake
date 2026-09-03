/**
 * The two gates POST /api/copy/subscriptions runs before it will attach a
 * copier's money to a leader, and the resume path that the drawdown breaker
 * would otherwise turn into a dead button.
 *
 *  1. SELF-COPY. Following an agent you own routes the performance fee back to
 *     yourself while inflating that leader's public copier count and its
 *     "earned X for being copied" figure. There is no legitimate version of it.
 *  2. COPYABLE BAR. A leader with no real closed record cannot be followed, and
 *     the refusal names every unmet criterion so the UI can say what is missing.
 *  3. RESUME. Resuming a breaker-paused subscription while the leader is still
 *     past the copier's limit is refused, instead of un-pausing a row the next
 *     fanout tick would immediately re-pause.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const LEADER = '33333333-3333-4333-8333-333333333333';
const SUB = '11111111-1111-4111-8111-111111111111';

let sessionUser = { id: 'copier-1' };
let leaderRow = [{ id: LEADER, user_id: 'owner-2', name: 'Steady', is_public: true }];
let pausedRow = [];
const sqlCalls = [];

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
	limits: { publicIp: async () => ({ success: true }) },
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
		if (text.includes('from agent_identities')) return Promise.resolve(leaderRow);
		if (text.includes('select id, network, leader_agent_id')) return Promise.resolve(pausedRow);
		if (text.includes('insert into copy_subscriptions')) {
			return Promise.resolve([{ id: SUB, leader_agent_id: LEADER, max_drawdown_pct: values.at(-2) }]);
		}
		if (text.includes('update copy_subscriptions set status')) {
			return Promise.resolve([{ id: values[0] === undefined ? SUB : SUB, status: values[0] }]);
		}
		return Promise.resolve([]);
	},
}));

// The leader's real closed-trade profile, swapped per test.
let profile = { settled: 30, span_hours: 200, deployed_sol: 2, max_drawdown_pct: 12 };
vi.mock('../api/_lib/copy-eligibility.js', async (importOriginal) => {
	const real = await importOriginal();
	return { ...real, leaderCopyProfile: async () => profile };
});

const subscriptions = (await import('../api/copy/subscriptions.js')).default;

const res = () => ({ setHeader() {}, _json: null });
const post = (body) => ({ method: 'POST', url: '/api/copy/subscriptions', headers: {}, body });

const validBody = (over = {}) => ({
	leader_agent_id: LEADER,
	copier_wallet: 'So11111111111111111111111111111111111111112',
	sizing_rule: 'fixed',
	fixed_sol: 0.1,
	per_trade_cap_sol: 0.5,
	daily_budget_sol: 1,
	...over,
});

beforeEach(() => {
	sqlCalls.length = 0;
	sessionUser = { id: 'copier-1' };
	leaderRow = [{ id: LEADER, user_id: 'owner-2', name: 'Steady', is_public: true }];
	pausedRow = [];
	profile = { settled: 30, span_hours: 200, deployed_sol: 2, max_drawdown_pct: 12 };
});

describe('self-copy guard', () => {
	it('refuses a copier who owns the leader agent', async () => {
		leaderRow = [{ id: LEADER, user_id: 'copier-1', name: 'My Own Bot', is_public: true }];
		const r = res();
		await subscriptions(post(validBody()), r);
		expect(r._json.status).toBe(403);
		expect(r._json.body.error).toBe('self_copy');
		// Refused BEFORE any row is written: a wash-trade edge must never exist.
		expect(sqlCalls.some((c) => c.text.includes('insert into copy_subscriptions'))).toBe(false);
	});

	it('allows a copier following someone else\'s agent', async () => {
		const r = res();
		await subscriptions(post(validBody()), r);
		expect(r._json.status).toBe(200);
		expect(r._json.body.subscription).toMatchObject({ id: SUB });
	});
});

describe('copyable bar', () => {
	it('refuses a leader with no verified history and names what is missing', async () => {
		profile = { settled: 1, span_hours: 0, deployed_sol: 0.002, max_drawdown_pct: 28 };
		const r = res();
		await subscriptions(post(validBody()), r);
		expect(r._json.status).toBe(409);
		expect(r._json.body.error).toBe('leader_not_copyable');
		expect(r._json.body.error_description).toContain('1 of 5 closed round-trips');
		// The structured form is what the UI renders a checklist from.
		expect(r._json.body.eligibility.unmet.map((u) => u.criterion).sort())
			.toEqual(['deployed_sol', 'settled', 'span_hours']);
		expect(r._json.body.eligibility.requirements.minSettled).toBe(5);
		expect(sqlCalls.some((c) => c.text.includes('insert into copy_subscriptions'))).toBe(false);
	});

	it('still refuses a private or deleted leader before it ever asks for a profile', async () => {
		leaderRow = [];
		const r = res();
		await subscriptions(post(validBody()), r);
		expect(r._json.status).toBe(404);
		expect(r._json.body.error).toBe('leader_not_found');
	});
});

describe('drawdown limit', () => {
	it('persists the copier\'s limit on the subscription', async () => {
		const r = res();
		await subscriptions(post(validBody({ max_drawdown_pct: 35 })), r);
		expect(r._json.status).toBe(200);
		const insert = sqlCalls.find((c) => c.text.includes('insert into copy_subscriptions'));
		expect(insert.values).toContain(35);
	});

	it('rejects a limit outside 0-100 without writing anything', async () => {
		const r = res();
		await subscriptions(post(validBody({ max_drawdown_pct: 150 })), r);
		expect(r._json.status).toBe(400);
		expect(r._json.body.error).toBe('invalid_config');
		expect(sqlCalls.some((c) => c.text.includes('insert into copy_subscriptions'))).toBe(false);
	});
});

describe('resuming a breaker-paused subscription', () => {
	it('refuses while the leader is still past the copier\'s limit, and says what would clear it', async () => {
		pausedRow = [{
			id: SUB, network: 'mainnet', leader_agent_id: LEADER,
			max_drawdown_pct: 10, paused_reason: 'leader_drawdown_breach',
		}];
		profile = { settled: 30, span_hours: 200, deployed_sol: 2, max_drawdown_pct: 42 };
		const r = res();
		await subscriptions(post({ id: SUB, status: 'active' }), r);
		expect(r._json.status).toBe(409);
		expect(r._json.body.error).toBe('drawdown_still_breached');
		expect(r._json.body.error_description).toContain('Raise or clear your drawdown limit');
		expect(r._json.body.breaker.drawdown_pct).toBe(42);
		expect(sqlCalls.some((c) => c.text.includes('update copy_subscriptions set status'))).toBe(false);
	});

	it('resumes once the leader has recovered inside the limit', async () => {
		pausedRow = [{
			id: SUB, network: 'mainnet', leader_agent_id: LEADER,
			max_drawdown_pct: 50, paused_reason: 'leader_drawdown_breach',
		}];
		profile = { settled: 30, span_hours: 200, deployed_sol: 2, max_drawdown_pct: 12 };
		const r = res();
		await subscriptions(post({ id: SUB, status: 'active' }), r);
		expect(r._json.status).toBe(200);
		expect(sqlCalls.some((c) => c.text.includes('update copy_subscriptions set status'))).toBe(true);
	});

	it('does not re-check a subscription the copier paused themselves', async () => {
		// paused_reason is null for a manual pause, so resuming is unconditional.
		pausedRow = [{ id: SUB, network: 'mainnet', leader_agent_id: LEADER, max_drawdown_pct: 10, paused_reason: null }];
		profile = { settled: 30, span_hours: 200, deployed_sol: 2, max_drawdown_pct: 99 };
		const r = res();
		await subscriptions(post({ id: SUB, status: 'active' }), r);
		expect(r._json.status).toBe(200);
	});

	it('pausing never consults the breaker', async () => {
		const r = res();
		await subscriptions(post({ id: SUB, status: 'paused' }), r);
		expect(r._json.status).toBe(200);
		expect(sqlCalls.some((c) => c.text.includes('select id, network, leader_agent_id'))).toBe(false);
	});
});
