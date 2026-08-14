// Renewal billing: the two faults that made every creator subscription fail.
//
// chargeSubscription() mints the payment intent a subscriber approves to renew.
// It was unable to mint one for anybody, for two independent reasons:
//
//   1. It selected cs.chain and cs.currency_mint off creator_subscriptions, and
//      neither column existed. Every due renewal threw "column cs.chain does not
//      exist". /api/cron/process-subscriptions catches per row, so the run kept
//      answering HTTP 200 with charged = 0 and nothing looked broken.
//      20260814060000_creator_subscriptions_chain_mint.sql creates them.
//   2. It wrote sp.creator_id (a users id) into agent_payment_intents.agent_id,
//      which is NOT NULL and references agent_identities. Even with the columns
//      present the insert could only ever fail a foreign key, and the catch
//      collapsed that to an opaque 'intent_create_failed'.
//
// These tests pin the query shape and the written values, so a future edit
// cannot quietly reintroduce either fault. A plan with no agent must also be
// reported as such rather than being pushed into an insert that cannot succeed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Content-addressed SQL mock ───────────────────────────────────────────────
// Classify by query text so call order never matters, mirroring the house
// pattern in tests/api/agent-subscription-tiers.test.js.
let subscriptionRow = null;
let calls = [];

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	calls.push({ q, values });

	if (/FROM creator_subscriptions cs/i.test(q)) {
		return Promise.resolve(subscriptionRow ? [subscriptionRow] : []);
	}
	if (/INSERT INTO subscription_payments/i.test(q)) {
		return Promise.resolve([{ id: 'pay-1', status: 'pending', amount_usd: 5 }]);
	}
	if (/INSERT INTO agent_payment_intents/i.test(q)) {
		return Promise.resolve([]);
	}
	if (/INSERT INTO user_notifications/i.test(q)) {
		return Promise.resolve([]);
	}
	if (/UPDATE creator_subscriptions/i.test(q)) {
		return Promise.resolve([]);
	}
	return Promise.resolve([]);
});

vi.mock('../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a) }));
vi.mock('../api/_lib/email.js', () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR_ID = '22222222-2222-4222-8222-222222222222';
const SUBSCRIBER_ID = '33333333-3333-4333-8333-333333333333';

function dueSubscription(overrides = {}) {
	return {
		id: 'sub-1',
		plan_id: 'plan-1',
		subscriber_user_id: SUBSCRIBER_ID,
		wallet_address: null,
		current_period_end: new Date('2026-09-01T00:00:00Z'),
		payment_method: 'x402',
		chain: 'solana',
		currency_mint: 'THREEsyntheticMint1111',
		price_usd: 5,
		creator_id: CREATOR_ID,
		agent_id: AGENT_ID,
		subscriber_email: 'subscriber@proof.invalid',
		payout_address: 'THREEsyntheticPayout1111',
		...overrides,
	};
}

const findCall = (re) => calls.find((c) => re.test(c.q));

describe('chargeSubscription renewal intent', () => {
	beforeEach(() => {
		calls = [];
		subscriptionRow = dueSubscription();
		sqlMock.mockClear();
	});

	it('reads the chain and mint columns the migration creates', async () => {
		const { chargeSubscription } = await import('../api/_lib/subscription-billing.js');
		await chargeSubscription('sub-1');

		const lookup = findCall(/FROM creator_subscriptions cs/i);
		expect(lookup).toBeTruthy();
		// Both columns are load-bearing: chain picks the creator's payout wallet
		// for that chain, currency_mint denominates the intent.
		expect(lookup.q).toMatch(/cs\.chain/);
		expect(lookup.q).toMatch(/cs\.currency_mint/);
		expect(lookup.q).toMatch(/payout\.chain = cs\.chain/);
	});

	it('bills the plan agent, never the creator user id', async () => {
		const { chargeSubscription } = await import('../api/_lib/subscription-billing.js');
		const result = await chargeSubscription('sub-1');

		const lookup = findCall(/FROM creator_subscriptions cs/i);
		expect(lookup.q).toMatch(/sp\.agent_id/);

		const insert = findCall(/INSERT INTO agent_payment_intents/i);
		expect(insert).toBeTruthy();
		// agent_payment_intents.agent_id references agent_identities, so the
		// creator's user id in that slot is an unpayable row.
		expect(insert.values).toContain(AGENT_ID);
		expect(insert.values).not.toContain(CREATOR_ID);

		expect(result.pending).toBe(true);
		expect(result.intentId).toMatch(/^sub_/);
	});

	it('reports a plan with no agent instead of attempting an impossible insert', async () => {
		subscriptionRow = dueSubscription({ agent_id: null });
		const { chargeSubscription } = await import('../api/_lib/subscription-billing.js');
		const result = await chargeSubscription('sub-1');

		expect(result.success).toBe(false);
		expect(result.error).toBe('plan_agent_missing');
		// Nothing payable may be written when the intent could never be created.
		expect(findCall(/INSERT INTO agent_payment_intents/i)).toBeUndefined();
		expect(findCall(/INSERT INTO subscription_payments/i)).toBeUndefined();
	});

	it('still refuses when the creator has no payout wallet', async () => {
		subscriptionRow = dueSubscription({ payout_address: null });
		const { chargeSubscription } = await import('../api/_lib/subscription-billing.js');
		const result = await chargeSubscription('sub-1');

		expect(result.success).toBe(false);
		expect(result.error).toBe('creator_payout_wallet_missing');
	});
});
