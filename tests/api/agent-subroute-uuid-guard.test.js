import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '../_helpers/monetization.js';

// Every /api/agents/:id/* sub-resource queries `WHERE id = $1` against a uuid
// column. api/agents/[id].js gates that with isUuid() and answers 404, but four
// handlers in this family have their own vercel.json rewrite and never pass
// through that router: economy, skill-prices, skills-pricing, and the X memory
// seeder. Each one used to hand Postgres a malformed id, and error 22P02 reached
// the caller as a 500 (skills-pricing even published the raw SQLSTATE as its
// `error` code). This pins the 404 and pins that no query is attempted.

const authState = { session: null };
const sqlState = { calls: [] };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/db.js', () => {
	const sql = vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: Array.isArray(strings) ? strings.join('?') : String(strings), values });
		return [];
	});
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: true })),
		widgetRead: vi.fn(async () => ({ success: true })),
		xSeed: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

const { default: economyHandler } = await import('../../api/agents/[id]/economy.js');
const { default: skillPricesHandler } = await import('../../api/agents/[id]/skill-prices.js');
const { default: skillsPricingHandler } = await import('../../api/agents/[id]/skills-pricing.js');
const { default: memorySeedXHandler } = await import('../../api/agents/[id]/memory-seed-x.js');

const BAD_ID = 'not-a-uuid';

beforeEach(() => {
	authState.session = { id: 'owner-user' };
	sqlState.calls = [];
});

describe('agent sub-resource uuid guard', () => {
	const cases = [
		{
			name: 'economy',
			handler: () => economyHandler,
			req: { method: 'GET', url: `/api/agents/${BAD_ID}/economy?id=${BAD_ID}`, query: { id: BAD_ID } },
		},
		{
			name: 'skill-prices',
			handler: () => skillPricesHandler,
			req: {
				method: 'POST',
				url: `/api/agents/${BAD_ID}/skill-prices?id=${BAD_ID}`,
				query: { id: BAD_ID },
				body: { skill: 'demo', amount: 1000, currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
			},
		},
		{
			name: 'skills-pricing',
			handler: () => skillsPricingHandler,
			req: { method: 'GET', url: `/api/agents/${BAD_ID}/skills-pricing?id=${BAD_ID}`, query: { id: BAD_ID } },
		},
		{
			name: 'memory-seed-x',
			handler: () => memorySeedXHandler,
			req: { method: 'GET', url: `/api/agents/${BAD_ID}/memory/seed/x?id=${BAD_ID}`, query: { id: BAD_ID } },
		},
	];

	for (const c of cases) {
		it(`${c.name} answers 404 for a malformed agent id instead of a 500`, async () => {
			const { status, body } = await invoke(c.handler(), c.req);
			expect(status).toBe(404);
			expect(body.error).toBe('not_found');
			// Nothing may reach the database: the id can never parse as a uuid.
			expect(sqlState.calls).toHaveLength(0);
		});
	}
});
