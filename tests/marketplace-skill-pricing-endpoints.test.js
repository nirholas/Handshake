// The three endpoints a seller's price actually flows through: set-skill-price
// (write), skill-promo (the public read the strikethrough renders from), and
// start-trial (the free-run grant that precedes a sale).
//
// What these pin, in order of how much money each one moves:
//
//   1. Retracting a proceeds split must LAND. All three retraction forms
//      (delist, `split: null`, `split: []`) clear the row, and a clear that
//      fails fails the request instead of leaving removed collaborators
//      attached to the next sale. `split: []` also has to survive validation at
//      all; while the array had a min-length of 1 it was rejected as malformed,
//      so the documented way to retract a split answered 400.
//   2. A split is resolved BEFORE the price row moves, so a rejected split
//      never leaves a repriced skill behind it.
//   3. start-trial answers a lost insert race as the 409 it is, not a 500.
//      `skill_purchases_one_active_per_beneficiary` is the real guard; the
//      SELECTs ahead of it are advisory and two clicks can pass both.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (req) => {
		const h = req?.headers?.authorization || '';
		return h.startsWith('Bearer ') ? h.slice(7) : null;
	},
}));

const csrfOk = { value: true };
vi.mock('../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async (req, res) => {
		if (csrfOk.value) return true;
		res.statusCode = 403;
		res.end(JSON.stringify({ error: 'csrf_missing' }));
		return false;
	}),
}));

const rlOk = { value: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: rlOk.value, reset: 1_000 })),
		authedReadIp: vi.fn(async () => ({ success: rlOk.value, reset: 1_000 })),
	},
	clientIp: () => '203.0.113.11',
}));

const invalidateSkillPriceCacheMock = vi.fn(async () => {});
vi.mock('../api/_lib/skill-price-cache.js', () => ({
	invalidateSkillPriceCache: (...a) => invalidateSkillPriceCacheMock(...a),
}));

const persistListingSplitMock = vi.fn();
const clearListingSplitMock = vi.fn();
vi.mock('../api/_lib/splits.js', () => ({
	persistListingSplit: (...a) => persistListingSplitMock(...a),
	clearListingSplit: (...a) => clearListingSplitMock(...a),
}));

const describeSkillPromoMock = vi.fn();
vi.mock('../api/_lib/skill-pricing-rules.js', () => ({
	describeSkillPromo: (...a) => describeSkillPromoMock(...a),
}));

const { default: setSkillPrice } = await import('../api/marketplace/set-skill-price.js');
const { default: skillPromo } = await import('../api/marketplace/skill-promo.js');
const { default: startTrial } = await import('../api/marketplace/start-trial.js');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// Clearly synthetic, so no third-party mainnet mint is pinned into a fixture.
const MINT = 'THREEsynthetic1111111111111111111111111116dp';

function mkReq({ url = '/', headers = {}, body = null, method = 'POST' } = {}) {
	const hdrs = { ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	return {
		method,
		url,
		headers: hdrs,
		// server/index.mjs pre-parses JSON bodies onto req.body; readJson reads it
		// from there rather than re-draining an already-ended stream.
		body: body == null ? undefined : body,
		on() {},
		destroy() {},
	};
}
function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}
const parseBody = (res) => (res.body ? JSON.parse(res.body) : undefined);

// Every sql`` call in these handlers, in order, so a test can hand back one row
// set per query and then assert on the SQL text that ran.
let sqlQueue = [];
const sqlText = () => sqlMock.mock.calls.map((c) => c[0].join('?').replace(/\s+/g, ' ').trim());

beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset();
	sqlMock.mockImplementation(async () => (sqlQueue.length ? sqlQueue.shift() : []));
	getSessionUserMock.mockReset().mockResolvedValue(null);
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	persistListingSplitMock.mockReset();
	clearListingSplitMock.mockReset().mockResolvedValue(undefined);
	describeSkillPromoMock.mockReset();
	invalidateSkillPriceCacheMock.mockClear();
	csrfOk.value = true;
	rlOk.value = true;
});

const priceReq = (body) => mkReq({ url: '/api/marketplace/set-skill-price', body });
const ownedAgent = () => { sqlQueue = [[{ id: AGENT, user_id: USER }]]; };

describe('POST /api/marketplace/set-skill-price', () => {
	it('refuses an anonymous caller before touching the database', async () => {
		const res = mkRes();
		await setSkillPrice(priceReq({ agent_id: AGENT, skill: 's', amount: 1, currency_mint: MINT }), res);
		expect(res.statusCode).toBe(401);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a write method it does not implement', async () => {
		const res = mkRes();
		await setSkillPrice(mkReq({ url: '/api/marketplace/set-skill-price', method: 'GET' }), res);
		expect(res.statusCode).toBe(405);
	});

	it('demands a CSRF token from a cookie caller', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		csrfOk.value = false;
		const res = mkRes();
		await setSkillPrice(priceReq({ agent_id: AGENT, skill: 's', amount: 1, currency_mint: MINT }), res);
		expect(res.statusCode).toBe(403);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('answers a malformed body with a field-level 400, never a stack trace', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		const res = mkRes();
		await setSkillPrice(priceReq({ agent_id: 'not-a-uuid', skill: '', amount: -1 }), res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('will not price an agent the caller does not own', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		sqlQueue = [[{ id: AGENT, user_id: OTHER_USER }]];
		const res = mkRes();
		await setSkillPrice(priceReq({ agent_id: AGENT, skill: 's', amount: 1, currency_mint: MINT }), res);
		expect(res.statusCode).toBe(403);
		expect(parseBody(res).error).toBe('forbidden');
	});

	it('404s a missing agent', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		sqlQueue = [[]];
		const res = mkRes();
		await setSkillPrice(priceReq({ agent_id: AGENT, skill: 's', amount: 1, currency_mint: MINT }), res);
		expect(res.statusCode).toBe(404);
	});

	it('upserts a price and invalidates the quote cache', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		ownedAgent();
		const res = mkRes();
		await setSkillPrice(priceReq({ agent_id: AGENT, skill: 'icon-set', amount: 2_000_000, currency_mint: MINT }), res);
		expect(res.statusCode).toBe(200);
		expect(parseBody(res).data.ok).toBe(true);
		expect(sqlText()[1]).toMatch(/INSERT INTO agent_skill_prices/);
		expect(invalidateSkillPriceCacheMock).toHaveBeenCalledWith(AGENT);
		expect(clearListingSplitMock).not.toHaveBeenCalled();
	});

	it('deactivates the row on amount 0 and clears the split with it', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		ownedAgent();
		const res = mkRes();
		await setSkillPrice(priceReq({ agent_id: AGENT, skill: 'icon-set', amount: 0, currency_mint: MINT }), res);
		expect(res.statusCode).toBe(200);
		expect(clearListingSplitMock).toHaveBeenCalledWith(expect.anything(), AGENT, 'icon-set');
		expect(sqlText()[1]).toMatch(/UPDATE agent_skill_prices SET is_active = false/);
	});

	it('accepts an empty split array as the retraction it is documented to be', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		ownedAgent();
		const res = mkRes();
		await setSkillPrice(priceReq({ agent_id: AGENT, skill: 'icon-set', amount: 5, currency_mint: MINT, split: [] }), res);
		expect(res.statusCode).toBe(200);
		expect(clearListingSplitMock).toHaveBeenCalledWith(expect.anything(), AGENT, 'icon-set');
		expect(sqlText()[1]).toMatch(/INSERT INTO agent_skill_prices/);
	});

	it('treats an explicit null split as a retraction too', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		ownedAgent();
		const res = mkRes();
		await setSkillPrice(priceReq({ agent_id: AGENT, skill: 'icon-set', amount: 5, currency_mint: MINT, split: null }), res);
		expect(res.statusCode).toBe(200);
		expect(clearListingSplitMock).toHaveBeenCalled();
	});

	it('leaves an existing split alone when the caller does not mention one', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		ownedAgent();
		const res = mkRes();
		await setSkillPrice(priceReq({ agent_id: AGENT, skill: 'icon-set', amount: 5, currency_mint: MINT }), res);
		expect(res.statusCode).toBe(200);
		expect(clearListingSplitMock).not.toHaveBeenCalled();
		expect(persistListingSplitMock).not.toHaveBeenCalled();
	});

	it('fails the request when a retraction cannot be written, rather than repricing over a stale split', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		ownedAgent();
		clearListingSplitMock.mockRejectedValue(new Error('deadlock detected'));
		const res = mkRes();
		await expect(
			setSkillPrice(priceReq({ agent_id: AGENT, skill: 'icon-set', amount: 5, currency_mint: MINT, split: [] }), res),
		).rejects.toThrow('deadlock detected');
		// The price row must NOT have moved: only the ownership SELECT ran.
		expect(sqlText()).toHaveLength(1);
	});

	it('persists a valid split and echoes the recipients back', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		ownedAgent();
		persistListingSplitMock.mockResolvedValue({
			split_mode: 'ledger',
			split_address: null,
			recipients: [
				{ address: 'Aaa', share_bps: 6000, label: 'lead' },
				{ address: 'Bbb', share_bps: 4000, label: null },
			],
		});
		const res = mkRes();
		await setSkillPrice(
			priceReq({
				agent_id: AGENT, skill: 'icon-set', amount: 5, currency_mint: MINT,
				split: [{ address: 'Aaa', share_bps: 6000 }, { address: 'Bbb', share_bps: 4000 }],
			}),
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(parseBody(res).data.split.mode).toBe('ledger');
		expect(parseBody(res).data.split.recipients).toHaveLength(2);
	});

	it('surfaces a split that does not sum to 100% as its own 4xx, before the price moves', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		ownedAgent();
		persistListingSplitMock.mockRejectedValue(
			Object.assign(new Error('shares must sum to 100%'), { status: 400, code: 'invalid_split' }),
		);
		const res = mkRes();
		await setSkillPrice(
			priceReq({
				agent_id: AGENT, skill: 'icon-set', amount: 5, currency_mint: MINT,
				split: [{ address: 'Aaa', share_bps: 6000 }],
			}),
			res,
		);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('invalid_split');
		expect(sqlText()).toHaveLength(1);
		expect(invalidateSkillPriceCacheMock).not.toHaveBeenCalled();
	});

	it('rejects a split larger than the recipient cap', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		const split = Array.from({ length: 51 }, (_, i) => ({ address: `A${i}`, share_bps: 196 }));
		const res = mkRes();
		await setSkillPrice(priceReq({ agent_id: AGENT, skill: 's', amount: 5, currency_mint: MINT, split }), res);
		expect(res.statusCode).toBe(400);
		expect(sqlMock).not.toHaveBeenCalled();
	});
});

describe('GET /api/marketplace/skill-promo', () => {
	const promoReq = (qs) => mkReq({ url: `/api/marketplace/skill-promo${qs}`, method: 'GET' });

	it('rejects a missing or malformed query with a 400, anonymously', async () => {
		const res = mkRes();
		await expect(skillPromo(promoReq('?agent_id=nope&skill='), res)).rejects.toMatchObject({ status: 400 });
		expect(describeSkillPromoMock).not.toHaveBeenCalled();
	});

	it('404s a skill with no active price', async () => {
		describeSkillPromoMock.mockResolvedValue(null);
		const res = mkRes();
		await skillPromo(promoReq(`?agent_id=${AGENT}&skill=icon-set`), res);
		expect(res.statusCode).toBe(404);
		expect(parseBody(res).error).toBe('not_found');
	});

	it('serves the live promo state to an anonymous reader with a short edge cache', async () => {
		describeSkillPromoMock.mockResolvedValue({
			base: { amount: '2000000' },
			effective: { amount: '1000000' },
			promo: { rule_type: 'first_n_purchases', threshold: 10, claimed: 4, spots_left: 6 },
		});
		const res = mkRes();
		await skillPromo(promoReq(`?agent_id=${AGENT}&skill=icon-set`), res);
		expect(res.statusCode).toBe(200);
		expect(parseBody(res).data.promo.spots_left).toBe(6);
		expect(res.headers['cache-control']).toMatch(/max-age=10/);
		expect(describeSkillPromoMock).toHaveBeenCalledWith(AGENT, 'icon-set');
	});

	it('rejects a write method', async () => {
		const res = mkRes();
		await skillPromo(promoReq('?agent_id=x&skill=y'), res, undefined);
		expect(res.statusCode).toBe(404);
	});
});

describe('POST /api/marketplace/start-trial', () => {
	const trialReq = (body, headers) => mkReq({ url: '/api/marketplace/start-trial', body, headers });
	const pricedSkill = (over = {}) => ({
		skill: 'icon-set', trial_uses: 3, amount: '2000000', currency_mint: MINT, chain: 'solana', ...over,
	});

	it('refuses an anonymous caller', async () => {
		const res = mkRes();
		await startTrial(trialReq({ agent_id: AGENT, skill: 'icon-set' }), res);
		expect(res.statusCode).toBe(401);
	});

	it('rejects a write method it does not implement', async () => {
		const res = mkRes();
		await startTrial(mkReq({ url: '/api/marketplace/start-trial', method: 'GET' }), res);
		expect(res.statusCode).toBe(405);
	});

	it('rejects a malformed body with a 400', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		const res = mkRes();
		await expect(startTrial(trialReq({ agent_id: 'nope', skill: '' }), res)).rejects.toMatchObject({ status: 400 });
	});

	it('refuses a skill that grants no free runs', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		sqlQueue = [[{ id: AGENT }], [pricedSkill({ trial_uses: 0 })]];
		const res = mkRes();
		await startTrial(trialReq({ agent_id: AGENT, skill: 'icon-set' }), res);
		expect(res.statusCode).toBe(422);
		expect(parseBody(res).error).toBe('no_trials');
	});

	it('tells an owner they already bought the skill', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		sqlQueue = [[{ id: AGENT }], [pricedSkill()], [{ id: 'p1', status: 'confirmed', trial_remaining: 0 }]];
		const res = mkRes();
		await startTrial(trialReq({ agent_id: AGENT, skill: 'icon-set' }), res);
		expect(res.statusCode).toBe(409);
		expect(parseBody(res).error).toBe('already_owned');
	});

	it('is idempotent for a trial already running', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		sqlQueue = [[{ id: AGENT }], [pricedSkill()], [{ id: 'p1', status: 'trial', trial_remaining: 2 }]];
		const res = mkRes();
		await startTrial(trialReq({ agent_id: AGENT, skill: 'icon-set' }), res);
		expect(res.statusCode).toBe(200);
		expect(parseBody(res).data).toMatchObject({ trial_remaining: 2, already_trialing: true });
	});

	it('grants the trial to a bearer caller, which needs no CSRF token', async () => {
		authenticateBearerMock.mockResolvedValue({ userId: USER });
		sqlQueue = [
			[{ id: AGENT }],
			[pricedSkill()],
			[],
			[],
			[{ id: 'p9', trial_remaining: 3, reference: 'ref', created_at: '2026-08-01T00:00:00.000Z' }],
		];
		const res = mkRes();
		await startTrial(trialReq({ agent_id: AGENT, skill: 'icon-set' }, { authorization: 'Bearer k' }), res);
		expect(res.statusCode).toBe(201);
		expect(parseBody(res).data).toMatchObject({ trial_remaining: 3, purchase_id: 'p9' });
	});

	it('answers a lost insert race with the 409 it is, not a 500', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		sqlQueue = [[{ id: AGENT }], [pricedSkill()], [], []];
		sqlMock.mockImplementation(async () => {
			if (sqlQueue.length) return sqlQueue.shift();
			// The unique index catches the concurrent second click.
			throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
		});
		const res = mkRes();
		await startTrial(trialReq({ agent_id: AGENT, skill: 'icon-set' }), res);
		expect(res.statusCode).toBe(409);
		expect(parseBody(res).error).toBe('trial_used');
	});

	it('lets a genuine database fault through instead of misreporting it as a used trial', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		sqlQueue = [[{ id: AGENT }], [pricedSkill()], [], []];
		sqlMock.mockImplementation(async () => {
			if (sqlQueue.length) return sqlQueue.shift();
			throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
		});
		const res = mkRes();
		await expect(startTrial(trialReq({ agent_id: AGENT, skill: 'icon-set' }), res)).rejects.toThrow('deadlock');
	});
});
