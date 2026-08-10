import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from './_helpers/monetization.js';

// Owner-isolation guard for the dynamic pricing-rules endpoint that powers the
// Creator Studio price editor. A creator must only ever touch pricing rules for
// agents they own — never another creator's. The server gate is mandatory; this
// pins it so a refactor can't silently drop the 403.

const authState = { session: null };
const sqlState = { queue: [], calls: [] };
const rlState = { success: true };

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
}));

vi.mock('../api/_lib/db.js', () => {
	const sql = vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: Array.isArray(strings) ? strings.join('?') : String(strings), values });
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	});
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: rlState.success })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async () => true),
}));

const { default: pricingRulesHandler } = await import('../api/agents/[id]/pricing-rules.js');

const AGENT_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
	authState.session = null;
	sqlState.queue = [];
	sqlState.calls = [];
	rlState.success = true;
});

describe('pricing-rules owner isolation', () => {
	it('rejects an unauthenticated create with 401', async () => {
		authState.session = null;
		const { status, body } = await invoke(pricingRulesHandler, {
			method: 'POST',
			url: `/api/agents/${AGENT_ID}/pricing-rules`,
			query: { id: AGENT_ID },
			body: { skill_name: 'do_thing', rule_type: 'first_n_purchases', threshold: 5, price_amount: 500000, currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
		});
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('returns 403 when a non-owner tries to create a rule', async () => {
		authState.session = { id: 'attacker-user' };
		// Ownership lookup returns no row → not this user's agent.
		sqlState.queue = [[]];
		const { status, body } = await invoke(pricingRulesHandler, {
			method: 'POST',
			url: `/api/agents/${AGENT_ID}/pricing-rules`,
			query: { id: AGENT_ID },
			body: { skill_name: 'do_thing', rule_type: 'first_n_purchases', threshold: 5, price_amount: 500000, currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
		});
		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
		// The INSERT must never run for a non-owner.
		expect(sqlState.calls.some((c) => /INSERT INTO skill_pricing_rules/i.test(c.query))).toBe(false);
	});

	it('lets the owner create a rule', async () => {
		authState.session = { id: 'owner-user' };
		sqlState.queue = [
			[{ id: AGENT_ID }], // ownership lookup → owns it
			[{ id: 'rule-1', skill_name: 'do_thing', rule_type: 'first_n_purchases', threshold: 5, price_amount: 500000, currency_mint: 'm', chain: 'solana', is_active: true }], // INSERT RETURNING
		];
		const { status, body } = await invoke(pricingRulesHandler, {
			method: 'POST',
			url: `/api/agents/${AGENT_ID}/pricing-rules`,
			query: { id: AGENT_ID },
			body: { skill_name: 'do_thing', rule_type: 'first_n_purchases', threshold: 5, price_amount: 500000, currency_mint: 'm' },
		});
		expect(status).toBe(201);
		expect(body.data.rule.id).toBe('rule-1');
		expect(sqlState.calls.some((c) => /INSERT INTO skill_pricing_rules/i.test(c.query))).toBe(true);
	});

	it('rejects an unauthenticated list with 401', async () => {
		authState.session = null;
		const { status, body } = await invoke(pricingRulesHandler, {
			method: 'GET',
			url: `/api/agents/${AGENT_ID}/pricing-rules`,
			query: { id: AGENT_ID },
		});
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
		// A rule set names scheduled and deactivated prices, never read it for an
		// anonymous caller.
		expect(sqlState.calls.some((c) => /FROM skill_pricing_rules/i.test(c.query))).toBe(false);
	});

	it('returns 403 when a non-owner tries to list rules', async () => {
		authState.session = { id: 'attacker-user' };
		sqlState.queue = [[]]; // ownership lookup → empty
		const { status, body } = await invoke(pricingRulesHandler, {
			method: 'GET',
			url: `/api/agents/${AGENT_ID}/pricing-rules`,
			query: { id: AGENT_ID },
		});
		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
		expect(sqlState.calls.some((c) => /FROM skill_pricing_rules/i.test(c.query))).toBe(false);
	});

	it('returns 403 when a non-owner tries to delete a rule', async () => {
		authState.session = { id: 'attacker-user' };
		sqlState.queue = [[]]; // ownership lookup → empty
		const ruleId = '00000000-0000-4000-8000-0000000000aa';
		const { status, body } = await invoke(pricingRulesHandler, {
			method: 'DELETE',
			url: `/api/agents/${AGENT_ID}/pricing-rules/${ruleId}`,
			query: { id: AGENT_ID, rule_id: ruleId },
		});
		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
		expect(sqlState.calls.some((c) => /UPDATE skill_pricing_rules/i.test(c.query))).toBe(false);
	});
});

// A PATCH body distinguishes three intents per timestamp: omit the key (keep the
// current value), send a timestamp (set it), send null (clear it). COALESCE alone
// collapses the last two, so the clear used to return 200 and change nothing.
describe('pricing-rules PATCH timestamp clearing', () => {
	const RULE_ID = '00000000-0000-4000-8000-0000000000bb';

	async function patch(body) {
		authState.session = { id: 'owner-user' };
		sqlState.queue = [
			[{ id: AGENT_ID }],  // ownership lookup
			[{ id: RULE_ID }],   // existing-rule lookup
			[],                  // UPDATE
		];
		const result = await invoke(pricingRulesHandler, {
			method: 'PATCH',
			url: `/api/agents/${AGENT_ID}/pricing-rules/${RULE_ID}`,
			query: { id: AGENT_ID, rule_id: RULE_ID },
			body,
		});
		const update = sqlState.calls.find((c) => /UPDATE skill_pricing_rules/i.test(c.query));
		return { ...result, update };
	}

	it('clears start_at when the caller sends an explicit null', async () => {
		const { status, update } = await patch({ start_at: null });
		expect(status).toBe(200);
		// [threshold, price_amount, clearStart, start_at, clearEnd, end_at, …]
		expect(update.values[2]).toBe(true);
		expect(update.values[4]).toBe(false);
	});

	it('clears end_at when the caller sends an explicit null', async () => {
		const { status, update } = await patch({ end_at: null });
		expect(status).toBe(200);
		expect(update.values[2]).toBe(false);
		expect(update.values[4]).toBe(true);
	});

	it('keeps both timestamps when neither key is sent', async () => {
		const { status, update } = await patch({ price_amount: 650 });
		expect(status).toBe(200);
		expect(update.values[1]).toBe(650);
		expect(update.values[2]).toBe(false);
		expect(update.values[4]).toBe(false);
	});

	it('sets start_at when the caller sends a timestamp', async () => {
		const { status, update } = await patch({ start_at: '2026-10-01T00:00:00.000Z' });
		expect(status).toBe(200);
		expect(update.values[2]).toBe(false);
		expect(update.values[3]).toBe('2026-10-01T00:00:00.000Z');
	});
});
