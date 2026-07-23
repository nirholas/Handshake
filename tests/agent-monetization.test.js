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
	const sql = vi.fn(async (strings, ...values) => {
		if (typeof strings === 'string') {
			sqlState.calls.push({ query: strings, values: values[0] ?? [] });
		} else {
			sqlState.calls.push({ query: strings.join('?'), values });
		}
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	});
	// postgres.js array-form transaction: `sql.transaction([q1, q2])` runs the
	// queries atomically and resolves to their results in order. In this mock the
	// tagged-template calls have already executed (each shifting the queue) by the
	// time the array literal is built, so awaiting them in order is faithful.
	sql.transaction = (queries) => Promise.all(queries);
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: rlState.success })),
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

// skill-runtime only runs for skills NOT in the handler's built-in HANDLERS
// map (the tests all use the built-in 'echo' except the consume-first revert
// case, which drives this mock to a throw).
const runtimeState = { fail: false };
vi.mock('../api/_lib/skill-runtime.js', () => ({
	makeRuntime: vi.fn(() => ({
		invoke: vi.fn(async () => {
			if (runtimeState.fail) throw new Error('provider down');
			return { ok: true };
		}),
	})),
}));

// ── Handler imports (after mocks) ─────────────────────────────────────────────

const { default: pricingSkillHandler } = await import('../api/agents/_id/pricing/[skill].js');
const { default: pricingIndexHandler } = await import('../api/agents/_id/pricing/index.js');
const { default: x402Handler } = await import('../api/agents/x402/[action].js');
const { default: revenueHandler } = await import('../api/billing/revenue.js');
const { default: withdrawalsHandler } = await import('../api/billing/withdrawals/index.js');

// ── Reset between tests ───────────────────────────────────────────────────────

beforeEach(() => {
	authState.session = null;
	authState.bearer = null;
	sqlState.queue = [];
	sqlState.calls = [];
	rlState.success = true;
});

// ── 1. Pricing CRUD ───────────────────────────────────────────────────────────

describe('Pricing CRUD', () => {
	it('owner can set a new skill price', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;

		sqlState.queue.push([{ id: agent.id, user_id: agent.user_id }]); // agent lookup
		sqlState.queue.push([]); // no existing price
		sqlState.queue.push([]); // upsert (no RETURNING)
		sqlState.queue.push([
			{
				id: 'price-1',
				skill: 'answer-question',
				currency_mint: 'USDC-MINT',
				chain: 'solana',
				amount: 1000000,
				is_active: true,
			},
		]);

		const { status, body } = await invoke(pricingSkillHandler, {
			method: 'PUT',
			url: `/api/agents/${agent.id}/pricing/answer-question`,
			body: { currency_mint: 'USDC-MINT', chain: 'solana', amount: 1000000 },
		});

		expect(status).toBe(201);
		expect(body.amount).toBe(1000000);
		expect(body.skill).toBe('answer-question');
	});

	it('owner can update an existing skill price', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;

		sqlState.queue.push([{ id: agent.id, user_id: agent.user_id }]);
		sqlState.queue.push([{ id: 'price-1' }]); // existing price
		sqlState.queue.push([]); // upsert
		sqlState.queue.push([{ id: 'price-1', skill: 'echo', currency_mint: 'MINT', chain: 'solana', amount: 500000, is_active: true }]);

		const { status } = await invoke(pricingSkillHandler, {
			method: 'PUT',
			url: `/api/agents/${agent.id}/pricing/echo`,
			body: { currency_mint: 'MINT', chain: 'solana', amount: 500000 },
		});

		expect(status).toBe(200);
	});

	it('non-owner gets 403', async () => {
		const { agent } = createTestAgent();
		const { session: otherSession } = createTestUser();
		authState.session = otherSession;

		// agent belongs to a different user_id
		sqlState.queue.push([{ id: agent.id, user_id: agent.user_id }]);

		const { status, body } = await invoke(pricingSkillHandler, {
			method: 'PUT',
			url: `/api/agents/${agent.id}/pricing/echo`,
			body: { currency_mint: 'MINT', chain: 'solana', amount: 1000 },
		});

		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
	});

	it('returns 401 when unauthenticated', async () => {
		const { status, body } = await invoke(pricingSkillHandler, {
			method: 'PUT',
			url: '/api/agents/agent-1/pricing/echo',
			body: { currency_mint: 'MINT', chain: 'solana', amount: 1000 },
		});

		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('owner can list active skill prices', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;

		sqlState.queue.push([{ id: agent.id }]); // agent lookup
		sqlState.queue.push([
			{ id: 'price-1', skill: 'echo', currency_mint: 'MINT', chain: 'solana', amount: 1000000, is_active: true },
			{ id: 'price-2', skill: 'summarize', currency_mint: 'MINT', chain: 'solana', amount: 2000000, is_active: true },
		]);

		const { status, body } = await invoke(pricingIndexHandler, {
			method: 'GET',
			url: `/api/agents/${agent.id}/pricing`,
		});

		expect(status).toBe(200);
		expect(body.prices).toHaveLength(2);
		expect(body.prices[0].amount).toBe(1000000);
	});

	it('owner can soft-delete a skill price', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;

		sqlState.queue.push([{ id: agent.id, user_id: agent.user_id }]);
		sqlState.queue.push([]); // update

		const { status, body } = await invoke(pricingSkillHandler, {
			method: 'DELETE',
			url: `/api/agents/${agent.id}/pricing/echo`,
		});

		expect(status).toBe(200);
		expect(body.deleted).toBe(true);
	});
});

// ── 2. x402 Manifest ──────────────────────────────────────────────────────────

describe('x402 Manifest', () => {
	it('returns manifest when agent has payments configured', async () => {
		const { agent } = createTestAgent();

		sqlState.queue.push([agent]);

		const { status, body } = await invoke(x402Handler, {
			method: 'GET',
			url: `/api/agents/x402/manifest?agent_id=${agent.id}&skill=echo`,
		});

		expect(status).toBe(200);
		expect(body.agent_id).toBe(agent.id);
		expect(body.skill).toBe('echo');
		expect(body.amount).toBeDefined();
		expect(body.intent_url).toBe('/api/agents/payments/pay-prep');
	});

	it('uses skill-level price from meta.skill_prices when available', async () => {
		const { agent } = createTestAgent({
			meta: {
				payments: { configured: true, receiver: 'recv-wallet', cluster: 'mainnet' },
				skill_prices: { 'answer-question': { amount: '5000000', currency: 'USDC-MINT' } },
			},
		});

		sqlState.queue.push([agent]);

		const { status, body } = await invoke(x402Handler, {
			method: 'GET',
			url: `/api/agents/x402/manifest?agent_id=${agent.id}&skill=answer-question`,
		});

		expect(status).toBe(200);
		expect(body.amount).toBe('5000000');
		expect(body.currency).toBe('USDC-MINT');
	});

	it('uses the canonical agent_skill_prices row when present', async () => {
		const { agent } = createTestAgent();

		sqlState.queue.push([agent]); // agent lookup
		sqlState.queue.push([
			{ amount: 2500000, currency_mint: 'USDC-MINT', chain: 'solana', is_active: true },
		]); // canonical price row
		sqlState.queue.push([{ address: 'PayoutWa11et1111111111111111111111111111111' }]); // payout wallet

		const { status, body } = await invoke(x402Handler, {
			method: 'GET',
			url: `/api/agents/x402/manifest?agent_id=${agent.id}&skill=answer-question`,
		});

		expect(status).toBe(200);
		expect(body.amount).toBe('2500000');
		expect(body.currency).toBe('USDC-MINT');
		expect(body.chain).toBe('solana');
		expect(body.recipient).toBe('PayoutWa11et1111111111111111111111111111111');
	});

	it('falls back to the agent wallet_address when no payout wallet is set', async () => {
		const { agent } = createTestAgent();

		sqlState.queue.push([agent]); // agent lookup
		sqlState.queue.push([
			{ amount: 1000000, currency_mint: 'USDC-MINT', chain: 'solana', is_active: true },
		]); // canonical price row
		sqlState.queue.push([]); // no payout wallet
		sqlState.queue.push([{ wallet_address: 'AgentOwnWa11et11111111111111111111111111111' }]); // agent fallback

		const { status, body } = await invoke(x402Handler, {
			method: 'GET',
			url: `/api/agents/x402/manifest?agent_id=${agent.id}&skill=answer-question`,
		});

		expect(status).toBe(200);
		expect(body.recipient).toBe('AgentOwnWa11et11111111111111111111111111111');
	});

	it('returns 404 when agent does not exist', async () => {
		sqlState.queue.push([]); // no agent

		const { status, body } = await invoke(x402Handler, {
			method: 'GET',
			url: '/api/agents/x402/manifest?agent_id=nonexistent&skill=echo',
		});

		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('returns 404 skill_not_priced when the skill has no price', async () => {
		const { agent } = createTestAgent({ meta: { payments: { configured: false } } });

		sqlState.queue.push([agent]); // agent lookup
		sqlState.queue.push([]); // no canonical price row

		const { status, body } = await invoke(x402Handler, {
			method: 'GET',
			url: `/api/agents/x402/manifest?agent_id=${agent.id}&skill=echo`,
		});

		expect(status).toBe(404);
		expect(body.error).toBe('skill_not_priced');
	});

	it('returns 404 skill_not_available when the price row is inactive', async () => {
		const { agent } = createTestAgent();

		sqlState.queue.push([agent]); // agent lookup
		sqlState.queue.push([
			{ amount: 2500000, currency_mint: 'USDC-MINT', chain: 'solana', is_active: false },
		]); // deactivated price row

		const { status, body } = await invoke(x402Handler, {
			method: 'GET',
			url: `/api/agents/x402/manifest?agent_id=${agent.id}&skill=answer-question`,
		});

		expect(status).toBe(404);
		expect(body.error).toBe('skill_not_available');
	});

	it('returns 400 when agent_id or skill is missing', async () => {
		const { status, body } = await invoke(x402Handler, {
			method: 'GET',
			url: '/api/agents/x402/manifest?agent_id=agent-1',
		});

		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});
});

// ── 3. Revenue Attribution ────────────────────────────────────────────────────

describe('Revenue Attribution', () => {
	it('consuming a paid intent creates a revenue event with correct fee', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;
		const intentId = 'intent-test-001';

		// agent lookup (needs user_id for insertNotification)
		sqlState.queue.push([agent]);
		// priceFor: agent_skill_prices lookup → no explicit price, falls back to meta
		sqlState.queue.push([]);
		// hasSkillAccess: echo has no canonical agent_skill_prices row → paid:false, x402 path
		sqlState.queue.push([]);
		// verifyPaid: intent is paid, amount matches default_price
		sqlState.queue.push([
			{
				id: intentId,
				agent_id: agent.id,
				currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
				amount: '1000000',
				status: 'paid',
				paid_at: new Date().toISOString(),
				payload: null,
				end_time: null,
			},
		]);
		// consumeIntent UPDATE ... RETURNING id → this request wins the
		// paid→consumed claim, so the revenue insert proceeds (gating the credit
		// on the claim is what prevents double-credit under concurrency).
		sqlState.queue.push([{ id: intentId }]);
		// revenue event INSERT (ON CONFLICT DO NOTHING) → []

		const { status, body } = await invoke(x402Handler, {
			method: 'POST',
			url: '/api/agents/x402/invoke',
			headers: { 'x-payment-intent': intentId },
			body: { agent_id: agent.id, skill: 'echo', args: { msg: 'hello' } },
		});

		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.intent_id).toBe(intentId);

		// Verify revenue event INSERT was called with correct fee (2.5% of 1_000_000)
		const revenueCall = sqlState.calls.find((c) =>
			c.query.includes('agent_revenue_events'),
		);
		expect(revenueCall).toBeDefined();
		expect(revenueCall.values).toContain(25000); // fee: floor(1_000_000 * 250 / 10_000)
		expect(revenueCall.values).toContain(975000); // net: 1_000_000 - 25_000
	});

	it('unpaid request (no intent header) receives 402', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;

		sqlState.queue.push([agent]); // agent lookup
		sqlState.queue.push([]); // priceFor: agent_skill_prices → no row, use meta
		sqlState.queue.push([]); // hasSkillAccess: no canonical price → paid:false, x402 path

		const { status } = await invoke(x402Handler, {
			method: 'POST',
			url: '/api/agents/x402/invoke',
			// no x-payment-intent header → verifyPaid returns null → emit402
			body: { agent_id: agent.id, skill: 'echo', args: {} },
		});

		expect(status).toBe(402);
	});

	it('second invoke with already-consumed intent returns 402', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;
		const intentId = 'intent-double-001';

		// First invoke: intent is paid → succeeds
		sqlState.queue.push([agent]);
		sqlState.queue.push([]); // priceFor: agent_skill_prices → no row, use meta
		sqlState.queue.push([]); // hasSkillAccess: no canonical price → paid:false, x402 path
		sqlState.queue.push([{
			id: intentId,
			agent_id: agent.id,
			currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			amount: '1000000',
			status: 'paid',
			paid_at: new Date().toISOString(),
			payload: null,
			end_time: null,
		}]);
		// consumeIntent UPDATE ... RETURNING id → this request wins the
		// paid→consumed claim before the skill executes.
		sqlState.queue.push([{ id: intentId }]);

		const { status: first } = await invoke(x402Handler, {
			method: 'POST',
			url: '/api/agents/x402/invoke',
			headers: { 'x-payment-intent': intentId },
			body: { agent_id: agent.id, skill: 'echo', args: {} },
		});
		expect(first).toBe(200);

		// Second invoke: intent is consumed → verifyPaid finds no 'paid' row → 402
		sqlState.queue.push([agent]);
		sqlState.queue.push([]); // priceFor: agent_skill_prices → no row, use meta
		sqlState.queue.push([]); // hasSkillAccess: no canonical price → paid:false, x402 path
		sqlState.queue.push([]); // empty result: no 'paid' intent → verifyPaid returns null

		const { status: second } = await invoke(x402Handler, {
			method: 'POST',
			url: '/api/agents/x402/invoke',
			headers: { 'x-payment-intent': intentId },
			body: { agent_id: agent.id, skill: 'echo', args: {} },
		});
		expect(second).toBe(402);
	});

	// ── consume-first single-use lock (2026-07-23 audit) ─────────────────────
	// The handler used to execute the skill BEFORE consuming the intent: two
	// concurrent invokes both passed verifyPaid and BOTH delivered the paid
	// work for one on-chain payment. The atomic paid→consumed transition now
	// happens first; only the winner executes.

	it('concurrent loser of the paid→consumed race gets 409 and the skill never executes', async () => {
		const { agent, session } = createTestAgent();
		authState.session = session;
		const intentId = 'intent-race-001';

		sqlState.queue.push([agent]);
		sqlState.queue.push([]); // priceFor → meta fallback
		sqlState.queue.push([]); // hasSkillAccess → x402 path
		sqlState.queue.push([{
			id: intentId,
			agent_id: agent.id,
			currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			amount: '1000000',
			status: 'paid',
			paid_at: new Date().toISOString(),
			payload: null,
			end_time: null,
		}]);
		// consumeIntent UPDATE ... RETURNING id → EMPTY: another in-flight
		// request already won the transition.
		sqlState.queue.push([]);

		const { status, body } = await invoke(x402Handler, {
			method: 'POST',
			url: '/api/agents/x402/invoke',
			headers: { 'x-payment-intent': intentId },
			body: { agent_id: agent.id, skill: 'echo', args: {} },
		});

		expect(status).toBe(409);
		expect(body.error).toBe('payment_in_flight');
		// No revenue insert may happen for the loser.
		expect(sqlState.calls.some((c) => String(c.query).includes('agent_revenue_events'))).toBe(false);
	});

	it('a handler failure after winning the claim restores the intent to paid', async () => {
		// 'summarize' must be DECLARED on the agent or invoke 404s at the
		// unknown-skill gate before ever reaching the payment path.
		const { agent, session } = createTestAgent({ skills: ['summarize'] });
		authState.session = session;
		const intentId = 'intent-revert-001';
		runtimeState.fail = true;

		sqlState.queue.push([agent]);
		sqlState.queue.push([]); // priceFor → meta fallback
		sqlState.queue.push([]); // hasSkillAccess → x402 path
		sqlState.queue.push([{
			id: intentId,
			agent_id: agent.id,
			currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			amount: '1000000',
			status: 'paid',
			paid_at: new Date().toISOString(),
			payload: null,
			end_time: null,
		}]);
		sqlState.queue.push([{ id: intentId }]); // consumeIntent wins
		sqlState.queue.push([{ id: intentId }]); // releaseIntent reverts consumed→paid

		try {
			await invoke(x402Handler, {
				method: 'POST',
				url: '/api/agents/x402/invoke',
				headers: { 'x-payment-intent': intentId },
				// 'summarize' is not a built-in handler → executeSkill goes through
				// the mocked runtime, which throws.
				body: { agent_id: agent.id, skill: 'summarize', args: {} },
			});
		} catch {
			// invoke() may surface the 500 envelope as a thrown error depending on
			// the wrap() mapping; the assertions below target the SQL trail.
		} finally {
			runtimeState.fail = false;
		}

		const updates = sqlState.calls
			.map((c) => String(c.query))
			.filter((q) => q.includes('update agent_payment_intents'));
		expect(updates).toHaveLength(2);
		expect(updates[0]).toContain("set status = 'consumed'");
		expect(updates[1]).toContain("set status = 'paid'");
		// No revenue for a call that never delivered.
		expect(sqlState.calls.some((c) => String(c.query).includes('agent_revenue_events'))).toBe(false);
	});
});

// ── 4. Revenue Dashboard ──────────────────────────────────────────────────────

describe('Revenue Dashboard', () => {
	it('returns correct revenue totals', async () => {
		authState.session = { id: 'user-1' };

		// summary query
		sqlState.queue.push([
			{
				gross_total: 1000000n,
				fee_total: 25000n,
				net_total: 975000n,
				payment_count: 1,
				currency_mint: 'USDC-MINT',
				chain: 'solana',
			},
		]);
		// by_skill query
		sqlState.queue.push([{ skill: 'echo', net_total: 975000n, count: 1 }]);
		// timeseries query
		sqlState.queue.push([{ period: '2026-04-01T00:00:00.000Z', net_total: 975000n, count: 1 }]);

		const { status, body } = await invoke(revenueHandler, {
			method: 'GET',
			url: '/api/billing/revenue',
		});

		expect(status).toBe(200);
		expect(body.summary.gross_total).toBe(1000000);
		expect(body.summary.net_total).toBe(975000);
		expect(body.summary.payment_count).toBe(1);
		expect(body.by_skill).toHaveLength(1);
		expect(body.by_skill[0].skill).toBe('echo');
		expect(body.timeseries).toHaveLength(1);
	});

	it('returns 401 when unauthenticated', async () => {
		const { status, body } = await invoke(revenueHandler, {
			method: 'GET',
			url: '/api/billing/revenue',
		});

		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('returns 400 on invalid granularity param', async () => {
		authState.session = { id: 'user-1' };

		// granularity is read from req.query, pass it via query option
		const { status, body } = await invoke(revenueHandler, {
			method: 'GET',
			url: '/api/billing/revenue',
			query: { granularity: 'invalid' },
		});

		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});
});

// ── 5. Withdrawals ────────────────────────────────────────────────────────────

describe('Withdrawals', () => {
	const VALID_WITHDRAWAL = {
		amount: 1_000_000, // minimum withdrawal is 1 USDC (1_000_000 raw units)
		currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		chain: 'solana',
		to_address: 'So11111111111111111111111111111111111111112',
	};

	it('owner can request a withdrawal when balance is sufficient', async () => {
		authState.session = { id: 'user-1' };

		// payout wallet resolution (destination is server-resolved, not client-supplied)
		sqlState.queue.push([{ address: 'So11111111111111111111111111111111111111112' }]);
		// balance check
		sqlState.queue.push([{ earned: 10_000_000n, pending_amount: 0n }]);
		// insert withdrawal
		sqlState.queue.push([
			{
				id: 'w-1',
				agent_id: null,
				amount: 1_000_000,
				currency_mint: VALID_WITHDRAWAL.currency_mint,
				chain: 'solana',
				to_address: VALID_WITHDRAWAL.to_address,
				status: 'pending',
				tx_signature: null,
				created_at: '2026-04-30T00:00:00Z',
				updated_at: '2026-04-30T00:00:00Z',
			},
		]);

		const { status, body } = await invoke(withdrawalsHandler, {
			method: 'POST',
			url: '/api/billing/withdrawals',
			body: VALID_WITHDRAWAL,
		});

		expect(status).toBe(201);
		expect(body.withdrawal.status).toBe('pending');
		expect(body.withdrawal.amount).toBe(1_000_000);
	});

	it('over-withdrawal is rejected with 422', async () => {
		authState.session = { id: 'user-1' };

		// payout wallet resolution (destination is server-resolved, not client-supplied)
		sqlState.queue.push([{ address: 'So11111111111111111111111111111111111111112' }]);
		// available: 2_000_000, request: 9_999_999_999
		sqlState.queue.push([{ earned: 2_000_000n, pending_amount: 0n }]);

		const { status, body } = await invoke(withdrawalsHandler, {
			method: 'POST',
			url: '/api/billing/withdrawals',
			body: { ...VALID_WITHDRAWAL, amount: 9_999_999_999 },
		});

		expect(status).toBe(422);
		expect(body.error).toBe('insufficient_balance');
	});

	it('below-minimum withdrawal is rejected with 422', async () => {
		authState.session = { id: 'user-1' };

		const { status, body } = await invoke(withdrawalsHandler, {
			method: 'POST',
			url: '/api/billing/withdrawals',
			body: { ...VALID_WITHDRAWAL, amount: 500_000 },
		});

		expect(status).toBe(422);
		expect(body.error).toBe('below_minimum');
	});

	it('returns 401 when unauthenticated', async () => {
		const { status, body } = await invoke(withdrawalsHandler, {
			method: 'POST',
			url: '/api/billing/withdrawals',
			body: VALID_WITHDRAWAL,
		});

		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('owner can list withdrawal history', async () => {
		authState.session = { id: 'user-1' };

		sqlState.queue.push([
			{ id: 'w-1', amount: 1_000_000, status: 'pending', created_at: '2026-04-30T00:00:00Z' },
		]);
		sqlState.queue.push([{ total: 1 }]);

		const { status, body } = await invoke(withdrawalsHandler, {
			method: 'GET',
			url: '/api/billing/withdrawals',
		});

		expect(status).toBe(200);
		expect(body.withdrawals).toHaveLength(1);
		expect(body.total).toBe(1);
	});
});

// ── 6. Rate Limiting ──────────────────────────────────────────────────────────

describe('Rate Limiting', () => {
	it('manifest endpoint returns 429 when rate limit is exceeded', async () => {
		rlState.success = false;

		const { status, body } = await invoke(x402Handler, {
			method: 'GET',
			url: '/api/agents/x402/manifest?agent_id=agent-1&skill=echo',
		});

		expect(status).toBe(429);
		expect(body.error).toBe('rate_limited');
	});

	it('withdrawals endpoint returns 429 when rate limit is exceeded', async () => {
		authState.session = { id: 'user-1' };
		rlState.success = false;

		const { status, body } = await invoke(withdrawalsHandler, {
			method: 'POST',
			url: '/api/billing/withdrawals',
			body: { amount: 1_000_000, currency_mint: 'MINT', chain: 'solana', to_address: 'addr' },
		});

		expect(status).toBe(429);
		expect(body.error).toBe('rate_limited');
	});

	it('pricing endpoint returns 429 when rate limit is exceeded', async () => {
		authState.session = { id: 'user-1' };
		rlState.success = false;

		const { status, body } = await invoke(pricingIndexHandler, {
			method: 'GET',
			url: '/api/agents/agent-1/pricing',
		});

		expect(status).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});
