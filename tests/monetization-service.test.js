// Unit + integration tests for the monetization service layer.
//
// The financial core of monetization lives in three places, none of which had
// direct coverage before this suite:
//
//   • api/_lib/fee.js          — platform fee split (calculateFee, getFeeBps)
//   • api/_lib/monetization.js — recordRevenueEvent (revenue attribution +
//                                fee/net split) and getAvailableBalance
//                                (withdrawable-balance aggregation)
//   • api/monetization/*.js    — the unified REST surface: prices.js (set/list
//                                skill prices) and revenue.js (creator sales
//                                aggregation)
//
// Money math is unforgiving, so every branch — validation, rounding, the
// owner/non-owner gate, and the earned − pending − withdrawn arithmetic — is
// exercised here. The DB client is mocked with a queue-driven `sql` stub
// (shared by the directly-called service functions and the HTTP handlers) so
// the logic is tested in isolation from Neon, exactly as Prompt 18 specifies.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestAgent, createTestUser, invoke } from './_helpers/monetization.js';

// ── Mock state ────────────────────────────────────────────────────────────────

const authState = { session: null, bearer: null };
const sqlState = { queue: [], calls: [] };
const rlState = { success: true };

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../api/_lib/db.js', () => {
	// Mirrors the real `sql` proxy: a tagged-template call receives the strings
	// array as the first arg; the function form receives a query string. Each
	// call records (query, values) for assertions and shifts the next queued
	// result, defaulting to [] so `const [row] = await sql\`…\`` never throws.
	const sql = vi.fn(async (strings, ...values) => {
		if (typeof strings === 'string') {
			sqlState.calls.push({ query: strings, values: values[0] ?? [] });
		} else {
			sqlState.calls.push({ query: strings.join('?'), values });
		}
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	});
	sql.transaction = (queries) => Promise.all(queries);
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: rlState.success })),
		// Session-scoped reads (api/monetization/revenue.js) moved off the strict
		// credential `authIp` bucket onto `authedReadIp` — without it here the
		// handler throws "limits.authedReadIp is not a function" and 500s.
		authedReadIp: vi.fn(async () => ({ success: rlState.success })),
		publicIp: vi.fn(async () => ({ success: rlState.success })),
		pricingPerIp: vi.fn(async () => ({ success: rlState.success })),
		withdrawalPerUser: vi.fn(async () => ({ success: rlState.success })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async () => true),
	generateToken: vi.fn(async () => 'test-csrf-token'),
}));

// ── Imports under test (after mocks) ───────────────────────────────────────────

const { recordRevenueEvent, getAvailableBalance } = await import('../api/_lib/monetization.js');
const { calculateFee, getFeeBps } = await import('../api/_lib/fee.js');
const { default: pricesHandler } = await import('../api/monetization/prices.js');
const { default: revenueHandler } = await import('../api/monetization/revenue.js');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ── Reset between tests ─────────────────────────────────────────────────────────

beforeEach(() => {
	authState.session = null;
	authState.bearer = null;
	sqlState.queue = [];
	sqlState.calls = [];
	rlState.success = true;
});

// ── 1. Fee calculation (api/_lib/fee.js) ────────────────────────────────────────

describe('calculateFee', () => {
	it('exposes a sane default fee rate (250 bps = 2.5%)', () => {
		const bps = getFeeBps();
		expect(Number.isInteger(bps)).toBe(true);
		expect(bps).toBeGreaterThan(0);
		expect(bps).toBeLessThanOrEqual(10_000);
	});

	it('splits a round amount into platform fee and creator net', () => {
		const bps = getFeeBps();
		const { fee, net } = calculateFee(1_000_000);
		expect(fee).toBe(Math.floor((1_000_000 * bps) / 10_000));
		expect(net).toBe(1_000_000 - fee);
		// With the default 250 bps this is the 25_000 / 975_000 split the rest of
		// the monetization stack asserts against.
		if (bps === 250) {
			expect(fee).toBe(25_000);
			expect(net).toBe(975_000);
		}
	});

	it('floors the fee for amounts that do not divide evenly', () => {
		// 333 * 250 / 10_000 = 8.325 → floored to 8.
		const { fee, net } = calculateFee(333);
		expect(fee).toBe(Math.floor((333 * getFeeBps()) / 10_000));
		expect(Number.isInteger(fee)).toBe(true);
		expect(fee + net).toBe(333);
	});

	it('preserves the invariant fee + net === gross across a range', () => {
		for (const gross of [1, 7, 999, 1_000_000, 123_456_789]) {
			const { fee, net } = calculateFee(gross);
			expect(fee + net).toBe(gross);
			expect(fee).toBeGreaterThanOrEqual(0);
			expect(fee).toBeLessThanOrEqual(gross);
		}
	});

	it('returns a zero split for a zero amount', () => {
		expect(calculateFee(0)).toEqual({ fee: 0, net: 0 });
	});
});

// ── 2. recordRevenueEvent (api/_lib/monetization.js) ────────────────────────────

describe('recordRevenueEvent', () => {
	const baseEvent = {
		agentId: 'agent-uuid-1',
		skillName: 'answer-question',
		callerAddress: 'Payer1111111111111111111111111111111111111',
		amountUsdc: 1_000_000,
		network: 'solana',
		txHash: 'sig-abc',
		intentId: 'intent-xyz',
	};

	function findInsert() {
		return sqlState.calls.find((c) => c.query.includes('agent_revenue_events'));
	}

	it('records the gross amount with the correct fee/net split', async () => {
		sqlState.queue.push([{ id: 'rev-1', agent_id: baseEvent.agentId, skill: baseEvent.skillName }]);

		const row = await recordRevenueEvent(baseEvent);

		const insert = findInsert();
		expect(insert).toBeDefined();
		// VALUES order: agent_id, intent_id, skill, gross, fee, net, mint, chain, payer
		const [agentId, , skill, gross, fee, net, , chain, payer] = insert.values;
		expect(agentId).toBe(baseEvent.agentId);
		expect(skill).toBe(baseEvent.skillName);
		expect(gross).toBe(1_000_000);
		expect(fee).toBe(calculateFee(1_000_000).fee);
		expect(net).toBe(calculateFee(1_000_000).net);
		expect(fee + net).toBe(gross);
		expect(chain).toBe('solana');
		expect(payer).toBe(baseEvent.callerAddress);
		expect(row).toEqual({ id: 'rev-1', agent_id: baseEvent.agentId, skill: baseEvent.skillName });
	});

	it('defaults the currency mint to USDC when none is supplied', async () => {
		sqlState.queue.push([{ id: 'rev-2' }]);

		await recordRevenueEvent({ ...baseEvent, currencyMint: undefined });

		const insert = findInsert();
		expect(insert.values).toContain(USDC_MINT);
	});

	it('uses the explicit intentId as the intent reference', async () => {
		sqlState.queue.push([{ id: 'rev-3' }]);
		await recordRevenueEvent(baseEvent);
		expect(findInsert().values[1]).toBe('intent-xyz');
	});

	it('falls back to the txHash when no intentId is given', async () => {
		sqlState.queue.push([{ id: 'rev-4' }]);
		await recordRevenueEvent({ ...baseEvent, intentId: undefined });
		expect(findInsert().values[1]).toBe('sig-abc');
	});

	it('falls back to a unique direct_ key when neither intentId nor txHash is given', async () => {
		sqlState.queue.push([{ id: 'rev-5' }]);
		await recordRevenueEvent({ ...baseEvent, intentId: undefined, txHash: undefined });
		// intent_id is UNIQUE, so distinct direct credits must NOT collide on a
		// shared literal — each gets its own synthetic key.
		expect(findInsert().values[1]).toMatch(/^direct_[0-9a-f-]{36}$/);
	});

	it('rejects a non-positive amount before touching the database', async () => {
		await expect(recordRevenueEvent({ ...baseEvent, amountUsdc: 0 }))
			.rejects.toMatchObject({ status: 400 });
		await expect(recordRevenueEvent({ ...baseEvent, amountUsdc: -5 }))
			.rejects.toMatchObject({ status: 400 });
		expect(sqlState.calls).toHaveLength(0);
	});

	it('rejects a non-numeric amount', async () => {
		await expect(recordRevenueEvent({ ...baseEvent, amountUsdc: 'abc' }))
			.rejects.toMatchObject({ status: 400 });
		expect(sqlState.calls).toHaveLength(0);
	});

	it('rejects a missing agentId', async () => {
		await expect(recordRevenueEvent({ ...baseEvent, agentId: undefined }))
			.rejects.toThrow(/agentId/);
		expect(sqlState.calls).toHaveLength(0);
	});

	it('rejects a missing skillName', async () => {
		await expect(recordRevenueEvent({ ...baseEvent, skillName: undefined }))
			.rejects.toThrow(/skillName/);
		expect(sqlState.calls).toHaveLength(0);
	});
});

// ── 3. getAvailableBalance (api/_lib/monetization.js) ───────────────────────────

describe('getAvailableBalance', () => {
	function queueBalance({ earned, pending, withdrawn }) {
		sqlState.queue.push([{ earned }]); // revenue events sum
		sqlState.queue.push([{ pending, withdrawn }]); // withdrawals split
	}

	it('computes available = earned − pending − withdrawn', async () => {
		queueBalance({ earned: 5_000_000n, pending: 1_000_000n, withdrawn: 2_000_000n });

		const balance = await getAvailableBalance('user-1');

		expect(balance).toEqual({
			earned: 5_000_000,
			pending: 1_000_000,
			withdrawn: 2_000_000,
			available: 2_000_000,
		});
	});

	it('coerces bigint column sums to plain numbers', async () => {
		queueBalance({ earned: 10_000_000n, pending: 0n, withdrawn: 0n });

		const balance = await getAvailableBalance('user-1');

		expect(typeof balance.earned).toBe('number');
		expect(typeof balance.available).toBe('number');
		expect(balance.available).toBe(10_000_000);
	});

	it('clamps available at zero when withdrawals exceed earnings', async () => {
		queueBalance({ earned: 1_000_000n, pending: 0n, withdrawn: 3_000_000n });

		const balance = await getAvailableBalance('user-1');

		expect(balance.available).toBe(0); // never negative
		expect(balance.earned).toBe(1_000_000);
		expect(balance.withdrawn).toBe(3_000_000);
	});

	it('treats pending/processing withdrawals as reserved against the balance', async () => {
		queueBalance({ earned: 4_000_000n, pending: 4_000_000n, withdrawn: 0n });

		const balance = await getAvailableBalance('user-1');

		expect(balance.available).toBe(0);
		expect(balance.pending).toBe(4_000_000);
	});

	it('queries without a currency filter when no mint is given', async () => {
		queueBalance({ earned: 1n, pending: 0n, withdrawn: 0n });

		await getAvailableBalance('user-1');

		const earnedCall = sqlState.calls.find((c) => c.query.includes('agent_revenue_events'));
		// All-currencies branch binds only the userId.
		expect(earnedCall.values).toEqual(['user-1']);
	});

	it('binds the currency mint when a filter is supplied', async () => {
		queueBalance({ earned: 1n, pending: 0n, withdrawn: 0n });

		await getAvailableBalance('user-1', USDC_MINT);

		const earnedCall = sqlState.calls.find((c) => c.query.includes('agent_revenue_events'));
		const wdrawCall = sqlState.calls.find((c) => c.query.includes('agent_withdrawals'));
		expect(earnedCall.values).toEqual(['user-1', USDC_MINT]);
		expect(wdrawCall.values).toEqual(['user-1', USDC_MINT]);
	});
});

// ── 4. setSkillPrices — api/monetization/prices.js ──────────────────────────────

describe('prices endpoint (setSkillPrices)', () => {
	it('lets an owner set a new price and returns 201', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;

		sqlState.queue.push([{ id: agent.id, user_id: agent.user_id }]); // ownership
		sqlState.queue.push([]); // no existing price
		sqlState.queue.push([]); // upsert
		sqlState.queue.push([
			{
				id: 'price-1',
				skill: 'answer-question',
				currency_mint: USDC_MINT,
				chain: 'solana',
				amount: 50_000,
				is_active: true,
				created_at: '2026-06-18T00:00:00Z',
				updated_at: '2026-06-18T00:00:00Z',
			},
		]);

		const { status, body } = await invoke(pricesHandler, {
			method: 'PUT',
			url: '/api/monetization/prices',
			body: { agent_id: agent.id, skill_name: 'answer-question', price_usdc: 0.05 },
		});

		expect(status).toBe(201);
		expect(body.price.skill_name).toBe('answer-question');
		expect(body.price.amount_atomic).toBe(50_000);
		expect(body.price.price_usdc).toBe(0.05);
	});

	it('converts price_usdc to atomic units in the upsert (0.05 → 50000)', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;

		sqlState.queue.push([{ id: agent.id, user_id: agent.user_id }]);
		sqlState.queue.push([]);
		sqlState.queue.push([]);
		sqlState.queue.push([{ id: 'p', skill: 'echo', currency_mint: USDC_MINT, chain: 'solana', amount: 50_000, is_active: true }]);

		await invoke(pricesHandler, {
			method: 'PUT',
			url: '/api/monetization/prices',
			body: { agent_id: agent.id, skill_name: 'echo', price_usdc: 0.05 },
		});

		const upsert = sqlState.calls.find((c) => c.query.includes('ON CONFLICT'));
		expect(upsert).toBeDefined();
		expect(upsert.values).toContain(50_000); // amountAtomic = round(0.05 * 1e6)
	});

	it('returns 200 when updating an existing price', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;

		sqlState.queue.push([{ id: agent.id, user_id: agent.user_id }]); // ownership
		sqlState.queue.push([{ id: 'price-1' }]); // existing price → update path
		sqlState.queue.push([]); // upsert
		sqlState.queue.push([{ id: 'price-1', skill: 'echo', currency_mint: USDC_MINT, chain: 'solana', amount: 100_000, is_active: true }]);

		const { status } = await invoke(pricesHandler, {
			method: 'PUT',
			url: '/api/monetization/prices',
			body: { agent_id: agent.id, skill_name: 'echo', price_usdc: 0.1 },
		});

		expect(status).toBe(200);
	});

	it('blocks a non-owner with 403', async () => {
		const { agent } = createTestAgent();
		const { session: otherSession } = createTestUser();
		authState.session = otherSession;

		sqlState.queue.push([{ id: agent.id, user_id: agent.user_id }]); // owned by someone else

		const { status, body } = await invoke(pricesHandler, {
			method: 'PUT',
			url: '/api/monetization/prices',
			body: { agent_id: agent.id, skill_name: 'echo', price_usdc: 0.01 },
		});

		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
	});

	it('returns 404 when the agent does not exist', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;

		sqlState.queue.push([]); // no agent row

		const { status, body } = await invoke(pricesHandler, {
			method: 'PUT',
			url: '/api/monetization/prices',
			body: { agent_id: agent.id, skill_name: 'echo', price_usdc: 0.01 },
		});

		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('returns 401 when unauthenticated', async () => {
		const { agent } = createTestAgent();

		const { status, body } = await invoke(pricesHandler, {
			method: 'PUT',
			url: '/api/monetization/prices',
			body: { agent_id: agent.id, skill_name: 'echo', price_usdc: 0.01 },
		});

		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('rejects a price below the minimum atomic unit with 400', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;

		// 0.0000004 USDC rounds to 0 atomic units, under MIN_PRICE_ATOMIC (1).
		const { status, body } = await invoke(pricesHandler, {
			method: 'PUT',
			url: '/api/monetization/prices',
			body: { agent_id: agent.id, skill_name: 'echo', price_usdc: 0.0000004 },
		});

		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('rejects an invalid skill_name with a validation error', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;

		const { status, body } = await invoke(pricesHandler, {
			method: 'PUT',
			url: '/api/monetization/prices',
			body: { agent_id: agent.id, skill_name: 'has spaces!', price_usdc: 0.01 },
		});

		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('soft-deletes a price for the owner', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;

		sqlState.queue.push([{ id: agent.id, user_id: agent.user_id }]); // ownership
		sqlState.queue.push([{ id: 'price-1' }]); // UPDATE … RETURNING id

		const { status, body } = await invoke(pricesHandler, {
			method: 'DELETE',
			url: '/api/monetization/prices',
			body: { agent_id: agent.id, skill_name: 'echo' },
		});

		expect(status).toBe(200);
		expect(body.deleted).toBe(true);
		expect(body.skill_name).toBe('echo');
	});

	it('returns 404 when hard-deleting a price that does not exist', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;

		sqlState.queue.push([{ id: agent.id, user_id: agent.user_id }]); // ownership
		sqlState.queue.push([]); // DELETE … RETURNING id → nothing

		const { status, body } = await invoke(pricesHandler, {
			method: 'DELETE',
			url: '/api/monetization/prices',
			body: { agent_id: agent.id, skill_name: 'ghost', hard: true },
		});

		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('lists active prices publicly via GET', async () => {
		const { agent } = createTestAgent();

		sqlState.queue.push([{ id: agent.id }]); // agent exists
		sqlState.queue.push([
			{ id: 'p1', skill: 'echo', currency_mint: USDC_MINT, chain: 'solana', amount: 1_000_000, is_active: true },
			{ id: 'p2', skill: 'summarize', currency_mint: USDC_MINT, chain: 'solana', amount: 2_500_000, is_active: true },
		]);

		const { status, body } = await invoke(pricesHandler, {
			method: 'GET',
			url: `/api/monetization/prices?agent_id=${agent.id}`,
		});

		expect(status).toBe(200);
		expect(body.prices).toHaveLength(2);
		expect(body.prices[0].price_usdc).toBe(1); // 1_000_000 atomic → 1 USDC
		expect(body.prices[1].amount_atomic).toBe(2_500_000);
	});

	it('returns 400 on GET without a UUID agent_id', async () => {
		const { status, body } = await invoke(pricesHandler, {
			method: 'GET',
			url: '/api/monetization/prices?agent_id=not-a-uuid',
		});

		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('returns 429 when the rate limit is exceeded', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;
		rlState.success = false;

		const { status, body } = await invoke(pricesHandler, {
			method: 'PUT',
			url: '/api/monetization/prices',
			body: { agent_id: agent.id, skill_name: 'echo', price_usdc: 0.01 },
		});

		expect(status).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});

// ── 5. getCreatorSalesData — api/monetization/revenue.js ────────────────────────

describe('revenue endpoint (getCreatorSalesData)', () => {
	it('aggregates totals, per-skill, and per-day breakdowns', async () => {
		authState.session = { id: 'user-1' };

		sqlState.queue.push([
			{ gross_total: 3_000_000n, fee_total: 75_000n, net_total: 2_925_000n, event_count: 3 },
		]); // summary
		sqlState.queue.push([
			{ skill: 'echo', net_total: 1_950_000n, count: 2 },
			{ skill: 'summarize', net_total: 975_000n, count: 1 },
		]); // by_skill
		sqlState.queue.push([
			{ period: '2026-06-17T00:00:00.000Z', net_total: 975_000n, count: 1 },
			{ period: '2026-06-18T00:00:00.000Z', net_total: 1_950_000n, count: 2 },
		]); // by_day

		const { status, body } = await invoke(revenueHandler, {
			method: 'GET',
			url: '/api/monetization/revenue?period=7d',
		});

		expect(status).toBe(200);
		expect(body.total_usdc).toBe(3); // 3_000_000 atomic → 3 USDC
		expect(body.total_fees_usdc).toBe(0.075);
		expect(body.net_usdc).toBe(2.925);
		expect(body.event_count).toBe(3);
		expect(body.net_atomic).toBe(2_925_000);
		expect(body.by_skill).toHaveLength(2);
		expect(body.by_skill[0]).toMatchObject({ skill: 'echo', total: 1.95, count: 2 });
		expect(body.by_day).toHaveLength(2);
		expect(body.by_day[0].date).toBe('2026-06-17');
	});

	it('returns zeroed totals when there is no revenue', async () => {
		authState.session = { id: 'user-1' };

		sqlState.queue.push([{ gross_total: 0n, fee_total: 0n, net_total: 0n, event_count: 0 }]);
		sqlState.queue.push([]); // by_skill
		sqlState.queue.push([]); // by_day

		const { status, body } = await invoke(revenueHandler, {
			method: 'GET',
			url: '/api/monetization/revenue',
		});

		expect(status).toBe(200);
		expect(body.total_usdc).toBe(0);
		expect(body.event_count).toBe(0);
		expect(body.by_skill).toEqual([]);
		expect(body.by_day).toEqual([]);
	});

	it('returns 401 when unauthenticated', async () => {
		const { status, body } = await invoke(revenueHandler, {
			method: 'GET',
			url: '/api/monetization/revenue',
		});

		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('returns 400 on an unknown period', async () => {
		authState.session = { id: 'user-1' };

		const { status, body } = await invoke(revenueHandler, {
			method: 'GET',
			url: '/api/monetization/revenue?period=forever',
		});

		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('returns 400 on a malformed agent_id', async () => {
		authState.session = { id: 'user-1' };

		const { status, body } = await invoke(revenueHandler, {
			method: 'GET',
			url: '/api/monetization/revenue?agent_id=not-a-uuid',
		});

		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('returns 404 when scoped to an agent that does not exist', async () => {
		const { agent } = createTestAgent();
		authState.session = { id: 'user-1' };

		sqlState.queue.push([]); // no agent row

		const { status, body } = await invoke(revenueHandler, {
			method: 'GET',
			url: `/api/monetization/revenue?agent_id=${agent.id}`,
		});

		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('returns 403 when scoped to an agent owned by someone else', async () => {
		const { agent } = createTestAgent();
		authState.session = { id: 'user-1' };

		sqlState.queue.push([{ id: agent.id, user_id: 'a-different-user' }]);

		const { status, body } = await invoke(revenueHandler, {
			method: 'GET',
			url: `/api/monetization/revenue?agent_id=${agent.id}`,
		});

		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
	});

	it('returns 429 when the rate limit is exceeded', async () => {
		authState.session = { id: 'user-1' };
		rlState.success = false;

		const { status, body } = await invoke(revenueHandler, {
			method: 'GET',
			url: '/api/monetization/revenue',
		});

		expect(status).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});
