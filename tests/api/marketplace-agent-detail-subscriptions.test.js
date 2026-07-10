// GET /api/marketplace/agents/:id must surface the creator's active
// subscription tiers and the signed-in viewer's current subscription so the
// detail page can render the "Subscribe for exclusive perks" section and mark
// the plan the viewer already holds.
//
// handleDetail() reads active rows from subscription_plans (scoped to the
// agent) and the viewer's active creator_subscriptions row. These tests pin
// that contract from the outside — driving the real router default export with
// DB / auth / rate-limit / r2 / cache mocked so the suite stays offline:
//
//   • active tiers → agent.subscription_tiers[] (cheapest first, price_usd numeric)
//   • a subscribed viewer → agent.user_subscription = { id, plan_id, … }
//   • no tiers and no subscription → [] and null (never absent/undefined)
//   • a missing subscription_plans table (pre-migration) degrades to [] / null,
//     it never 500s the whole detail read

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeReq, makeRes } from '../_helpers/monetization.js';

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const USER_ID = 'viewer-uuid';
const PLAN_BASIC = 'aaaaaaaa-1111-4111-8111-111111111111';
const PLAN_PRO = 'bbbbbbbb-2222-4222-8222-222222222222';
const SUB_ID = 'cccccccc-3333-4333-8333-333333333333';

// ── Content-addressed SQL mock ───────────────────────────────────────────────
// Classify by query text so call order never matters. The creator_subscriptions
// query JOINs subscription_plans, so it MUST be matched before the plain
// subscription_plans (tiers) query or the tiers branch would swallow it.
let agentRow = null;
let activePrices = [];
let purchasedRows = [];
let tierRows = [];
let subRows = [];
let tiersThrowUndefinedTable = false;

const sqlMock = vi.fn((strings) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/FROM agent_skill_prices/i.test(q)) return Promise.resolve(activePrices);
	if (/FROM agent_identities/i.test(q)) return Promise.resolve(agentRow ? [agentRow] : []);
	if (/FROM skill_purchases/i.test(q)) return Promise.resolve(purchasedRows);
	if (/FROM agent_bookmarks/i.test(q)) return Promise.resolve([]);
	if (/FROM creator_subscriptions/i.test(q)) {
		if (tiersThrowUndefinedTable) {
			return Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
		}
		return Promise.resolve(subRows);
	}
	if (/FROM subscription_plans/i.test(q)) {
		if (tiersThrowUndefinedTable) {
			return Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
		}
		return Promise.resolve(tierRows);
	}
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

// Signed-in viewer for every probe.
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => ({ id: USER_ID })),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { widgetRead: vi.fn(async () => ({ success: true, reset: Date.now() + 1000, limit: 60, remaining: 59 })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/r2.js', () => ({
	publicUrl: (k) => (k ? `https://cdn.test/${k}` : null),
	// thumbnailUrl mirrors r2.js: null for a missing key or the legacy *_og.png form.
	thumbnailUrl: (k) => (!k || /^https?:\/\/.*_og\.png$/i.test(k) ? null : `https://cdn.test/${k}`),
}));

// Always-miss cache so getSkillPrices re-queries the mocked DB each read.
vi.mock('../../api/_lib/cache.js', () => ({
	cacheGet: vi.fn(async () => null),
	cacheSet: vi.fn(async () => {}),
	cacheDel: vi.fn(async () => {}),
}));

const { default: router } = await import('../../api/marketplace/[action].js');

function detailRow(overrides = {}) {
	return {
		id: AGENT_ID,
		name: 'Polyglot',
		description: 'Translates and summarizes.',
		category: 'translation',
		tags: ['translate'],
		skills: ['translate', 'summarize'],
		user_id: 'owner-uuid',
		is_published: true,
		thumbnail_key: null,
		avatar_storage_key: null,
		avatar_visibility: 'public',
		asset_price_amount: null,
		system_prompt: 'You translate.',
		greeting: 'Hola',
		capabilities: {},
		rating_avg: 0,
		rating_count: 0,
		...overrides,
	};
}

async function getDetail(id = AGENT_ID) {
	const req = makeReq({ method: 'GET', url: `/api/marketplace/agents/${id}` });
	const res = makeRes();
	await router(req, res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

beforeEach(() => {
	sqlMock.mockClear();
	agentRow = detailRow();
	activePrices = [];
	purchasedRows = [];
	tierRows = [];
	subRows = [];
	tiersThrowUndefinedTable = false;
});

describe('GET /api/marketplace/agents/:id — subscription tiers', () => {
	it('returns active tiers in subscription_tiers with price_usd normalised to a number', async () => {
		// numeric(8,2) arrives from postgres as a string — the handler coerces it.
		tierRows = [
			{ id: PLAN_BASIC, name: 'Supporter', price_usd: '5.00', interval: 'monthly', perks: ['Priority replies'], included_skills: ['translate'] },
			{ id: PLAN_PRO, name: 'Pro', price_usd: '20.00', interval: 'monthly', perks: ['Everything in Supporter', 'Early access'], included_skills: ['translate', 'summarize'] },
		];

		const { status, body } = await getDetail();
		expect(status).toBe(200);

		const tiers = body.data.agent.subscription_tiers;
		expect(Array.isArray(tiers)).toBe(true);
		expect(tiers).toHaveLength(2);
		expect(tiers[0]).toMatchObject({ id: PLAN_BASIC, name: 'Supporter', interval: 'monthly' });
		expect(tiers[0].price_usd).toBe(5); // number, not "5.00"
		expect(typeof tiers[0].price_usd).toBe('number');
		expect(tiers[0].perks).toEqual(['Priority replies']);
		expect(tiers[1].included_skills).toEqual(['translate', 'summarize']);
	});

	it('marks the viewer current subscription in user_subscription', async () => {
		tierRows = [{ id: PLAN_BASIC, name: 'Supporter', price_usd: '5.00', interval: 'monthly', perks: [], included_skills: [] }];
		const periodEnd = '2026-07-18T00:00:00.000Z';
		subRows = [{ id: SUB_ID, plan_id: PLAN_BASIC, status: 'active', current_period_end: periodEnd }];

		const { body } = await getDetail();
		const sub = body.data.agent.user_subscription;
		expect(sub).toMatchObject({ id: SUB_ID, plan_id: PLAN_BASIC, status: 'active' });
		expect(sub.current_period_end).toBe(periodEnd);
	});

	it('returns [] tiers and null user_subscription when none exist (never absent)', async () => {
		const { body } = await getDetail();
		expect(body.data.agent.subscription_tiers).toEqual([]);
		expect(body.data.agent.user_subscription).toBeNull();
	});

	it('serves authenticated reads with a private cache so viewer state never leaks', async () => {
		const { headers } = await getDetail();
		expect(headers['cache-control']).toMatch(/private/);
	});

	it('degrades to [] / null (not 500) when the subscription tables are missing', async () => {
		tiersThrowUndefinedTable = true;
		const { status, body } = await getDetail();
		expect(status).toBe(200);
		expect(body.data.agent.subscription_tiers).toEqual([]);
		expect(body.data.agent.user_subscription).toBeNull();
	});
});
