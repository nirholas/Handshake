// GET /api/marketplace/agents/:id must surface per-skill pricing so the
// marketplace detail page can render a premium badge next to paid skills.
//
// handleDetail() reads the agent's active rows from agent_skill_prices and
// folds them into a `skill_prices` map keyed by skill name. These tests pin
// that contract from the outside — driving the real router default export with
// DB / auth / rate-limit / r2 mocked so the suite stays offline:
//
//   • a priced agent → skill_prices[skill] = { amount, currency_mint, … }
//   • an agent with no priced skills → skill_prices === {}  (never null/absent)
//   • an unpublished agent stays 404 for an anonymous viewer (access unchanged)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeReq, makeRes } from '../_helpers/monetization.js';

// ── Content-addressed SQL mock ───────────────────────────────────────────────
// handleDetail issues two queries for an anonymous viewer: the agent_identities
// detail row, then the active agent_skill_prices rows. Classify by query text so
// call order never matters; the purchased/bookmark queries only run when a
// session exists, which these anonymous cases never reach.
let agentRow = null;       // agent_identities detail → the row, or null (404)
let activePrices = [];     // rows returned from agent_skill_prices

const sqlMock = vi.fn((strings) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (/FROM agent_skill_prices/i.test(q)) return Promise.resolve(activePrices);
	if (/FROM agent_identities/i.test(q)) return Promise.resolve(agentRow ? [agentRow] : []);
	return Promise.resolve([]);
});
vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

// Anonymous viewer: every auth probe returns null.
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => null),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { widgetRead: vi.fn(async () => ({ success: true, reset: Date.now() + 1000, limit: 60, remaining: 59 })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

// publicUrl is only hit when a storage key is present; the fixtures keep keys
// null, but mock it so the test never depends on R2 env config.
vi.mock('../../api/_lib/r2.js', () => ({
	publicUrl: (k) => (k ? `https://cdn.test/${k}` : null),
	// thumbnailUrl mirrors r2.js: null for a missing key or the legacy *_og.png form.
	thumbnailUrl: (k) => (!k || /^https?:\/\/.*_og\.png$/i.test(k) ? null : `https://cdn.test/${k}`),
}));

// Force the skill-price cache to always miss → every detail read re-queries the
// (mocked) DB. Without this, the module-level cache would carry case 1's prices
// into case 2 (these cases reuse one AGENT_ID with different active prices), so
// the cache mock is what keeps each case isolated. The caching/invalidation
// behaviour itself is covered directly in skill-price-cache.test.js.
vi.mock('../../api/_lib/cache.js', () => ({
	cacheGet: vi.fn(async () => null),
	cacheSet: vi.fn(async () => {}),
	cacheDel: vi.fn(async () => {}),
}));

const { default: router } = await import('../../api/marketplace/[action].js');

// $THREE — the only coin this platform references.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const AGENT_ID = '11111111-2222-4333-8444-555555555555';

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
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
	sqlMock.mockClear();
	agentRow = detailRow();
	activePrices = [];
});

describe('GET /api/marketplace/agents/:id — skill_prices', () => {
	it('folds active prices into a skill_prices map keyed by skill name', async () => {
		activePrices = [
			{ skill: 'translate', amount: 50000, currency_mint: THREE_MINT, chain: 'solana', mint_decimals: 6, trial_uses: 2, time_pass_hours: null, time_pass_amount: null },
			{ skill: 'summarize', amount: 100000, currency_mint: THREE_MINT, chain: 'solana', mint_decimals: 6, trial_uses: 0, time_pass_hours: 24, time_pass_amount: 250000 },
		];

		const { status, body } = await getDetail();
		expect(status).toBe(200);

		const prices = body.data.agent.skill_prices;
		expect(Object.keys(prices).sort()).toEqual(['summarize', 'translate']);
		// Each priced skill carries at minimum its atomic amount + currency mint.
		expect(prices.translate).toMatchObject({ amount: 50000, currency_mint: THREE_MINT });
		expect(prices.summarize).toMatchObject({ amount: 100000, currency_mint: THREE_MINT });
		// Richer pricing dimensions ride along for the purchase UI.
		expect(prices.translate.chain).toBe('solana');
		expect(prices.translate.trial_uses).toBe(2);
		expect(prices.summarize.time_pass_hours).toBe(24);
	});

	it('returns an empty object (never null) when the agent has no priced skills', async () => {
		activePrices = [];
		const { status, body } = await getDetail();
		expect(status).toBe(200);
		expect(body.data.agent.skill_prices).toEqual({});
	});

	it('defaults mint_decimals to 6 and trial_uses to 0 when the row omits them', async () => {
		activePrices = [{ skill: 'translate', amount: 50000, currency_mint: THREE_MINT, chain: 'solana' }];
		const { body } = await getDetail();
		expect(body.data.agent.skill_prices.translate.mint_decimals).toBe(6);
		expect(body.data.agent.skill_prices.translate.trial_uses).toBe(0);
	});

	it('still 404s an unpublished agent for an anonymous viewer (access unchanged)', async () => {
		agentRow = detailRow({ is_published: false });
		const { status, body } = await getDetail();
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});
});
