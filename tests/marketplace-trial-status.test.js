// GET /api/marketplace/trial-status is the marketplace's conversion surface, and
// the number a seller acts on is the money sitting in the trial queue. That
// number used to be summed across every mint at once and then labelled with
// whichever mint happened to head the queue, so a seller pricing one skill in
// MINT_6DP and another in an 8-decimal token read a headline that was wrong by
// orders of magnitude. These tests pin the per-mint totals, the trial lifecycle
// states the buyer view renders against, the atomic formatter (token amounts
// overflow a JS number, so they never go through Number()), and the auth wall.

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

const rlOk = { value: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authedReadIp: vi.fn(async () => ({ success: rlOk.value, reset: 1_000 })) },
	clientIp: () => '203.0.113.9',
}));

const mod = await import('../api/marketplace/trial-status.js');
const { trialState, formatAtomic, potentialsByMint, buyerView, sellerView, default: handler } = mod;

const USER = '11111111-1111-4111-8111-111111111111';
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// Clearly synthetic, so no third-party mainnet mint is pinned into a fixture.
const MINT_6DP = 'THREEsynthetic1111111111111111111111111116dp';
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function mkReq({ url = '/api/marketplace/trial-status', headers = {}, method = 'GET' } = {}) {
	return { method, url, headers };
}
function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}
const parseBody = (res) => (res.body ? JSON.parse(res.body) : undefined);

let sqlQueue = [];
beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset();
	sqlMock.mockImplementation(async () => (sqlQueue.length ? sqlQueue.shift() : []));
	getSessionUserMock.mockReset().mockResolvedValue(null);
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	rlOk.value = true;
});

describe('trialState', () => {
	it('calls a spent trial exhausted, the highest-intent state in the funnel', () => {
		expect(trialState(0, 5)).toBe('exhausted');
		expect(trialState(null, 5)).toBe('exhausted');
	});

	it('warns at or below a third of the grant, and on the final run of any grant', () => {
		expect(trialState(1, 3)).toBe('running-low');
		expect(trialState(2, 6)).toBe('running-low');
		expect(trialState(1, 100)).toBe('running-low');
		expect(trialState(1, null)).toBe('running-low');
	});

	it('leaves a barely-used trial fresh', () => {
		expect(trialState(5, 5)).toBe('fresh');
		expect(trialState(3, 6)).toBe('fresh');
	});
});

describe('formatAtomic', () => {
	it('formats atomic token amounts without going through Number()', () => {
		expect(formatAtomic('1500000', 6)).toBe('1.5');
		expect(formatAtomic('1000000', 6)).toBe('1');
		expect(formatAtomic('1234567890123', 6)).toBe('1,234,567.890123');
		expect(formatAtomic('0', 6)).toBe('0');
	});

	it('survives amounts past 2^53, where a float would silently round', () => {
		const huge = '90071992547409910000';
		expect(formatAtomic(huge, 6)).toBe('90,071,992,547,409.91');
	});

	it('groups thousands for a zero-decimal mint too', () => {
		expect(formatAtomic('1234567', 0)).toBe('1,234,567');
	});

	it('clamps a nonsense decimals argument instead of throwing', () => {
		expect(formatAtomic('1000000', 'x')).toBe('1');
		expect(formatAtomic('1000000', -4)).toBe('1,000,000');
	});
});

describe('potentialsByMint', () => {
	it('totals each mint separately and leads with the largest', () => {
		const out = potentialsByMint([
			{ price: { mint: MINT_6DP, decimals: 6 }, potential: { atomic: '2000000' } },
			{ price: { mint: MINT_6DP, decimals: 6 }, potential: { atomic: '3000000' } },
			{ price: { mint: THREE, decimals: 9 }, potential: { atomic: '900000000' } },
		]);
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ mint: MINT_6DP, decimals: 6, atomic: '5000000', display: '5' });
		expect(out[1]).toMatchObject({ mint: THREE, decimals: 9, atomic: '900000000', display: '0.9' });
	});

	it('skips unpriced rows rather than counting them as zero-decimal dust', () => {
		expect(potentialsByMint([{ price: null, potential: null }])).toEqual([]);
	});
});

describe('sellerView', () => {
	it('reports one total per mint and never blends two currencies into one number', async () => {
		sqlQueue = [
			[
				{
					agent_id: AGENT, skill: 'icon-set', agent_name: 'Ink', profile_image_url: null,
					agent_image: null, active_trials: 4, exhausted: 2, last_run: 1,
					last_activity: '2026-08-01T00:00:00.000Z',
					trial_uses: 3, amount: '2000000', currency_mint: MINT_6DP, chain: 'solana', mint_decimals: 6,
				},
				{
					agent_id: AGENT, skill: 'lore', agent_name: 'Ink', profile_image_url: null,
					agent_image: null, active_trials: 1, exhausted: 1, last_run: 0,
					last_activity: '2026-08-02T00:00:00.000Z',
					trial_uses: 2, amount: '500000000', currency_mint: THREE, chain: 'solana', mint_decimals: 9,
				},
			],
			[{ agent_id: AGENT, skill: 'icon-set', sold: 2 }],
		];

		const out = await sellerView(USER);

		expect(out.role).toBe('seller');
		expect(out.summary.warmLeads).toBe(3);
		expect(out.summary.sold).toBe(2);
		// MINT_6DP: 2 exhausted x 2 MINT_6DP. $THREE: 1 exhausted x 0.5.
		expect(out.summary.potentials).toEqual([
			{ mint: MINT_6DP, decimals: 6, atomic: '4000000', display: '4' },
			{ mint: THREE, decimals: 9, atomic: '500000000', display: '0.5' },
		]);
		expect(out.summary.potential).toMatchObject({ mint: MINT_6DP, atomic: '4000000', display: '4' });
		expect(out.queue[0]).toMatchObject({ skill: 'icon-set', sold: 2, exhausted: 2 });
		expect(out.queue[0].conversionRate).toBeCloseTo(2 / 6, 10);
		expect(out.queue[1].sold).toBe(0);
	});

	it('answers an empty queue with a zeroed headline rather than an undefined read', async () => {
		sqlQueue = [[], []];
		const out = await sellerView(USER);
		expect(out.queue).toEqual([]);
		expect(out.summary.potential).toEqual({ atomic: '0', decimals: 6, display: '0', mint: null });
		expect(out.summary.potentials).toEqual([]);
	});
});

describe('buyerView', () => {
	it('returns each trial with its state, price and agent link', async () => {
		sqlQueue = [[
			{
				id: 'p1', agent_id: AGENT, skill: 'icon-set', trial_remaining: 0,
				created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-03T00:00:00.000Z',
				agent_name: 'Ink', agent_image: null,
				trial_uses: 3, amount: '2000000', currency_mint: MINT_6DP, chain: 'solana', mint_decimals: 6,
			},
			{
				id: 'p2', agent_id: AGENT, skill: 'lore', trial_remaining: 3,
				created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-02T00:00:00.000Z',
				agent_name: 'Ink', agent_image: null,
				trial_uses: 3, amount: null, currency_mint: null, chain: null, mint_decimals: null,
			},
		]];

		const out = await buyerView(USER);

		expect(out.role).toBe('buyer');
		expect(out.summary).toEqual({ active: 2, fresh: 1, runningLow: 0, exhausted: 1 });
		expect(out.trials[0]).toMatchObject({
			purchaseId: 'p1', skill: 'icon-set', state: 'exhausted', agentUrl: `/agent/${AGENT}`,
		});
		expect(out.trials[0].price).toEqual({
			atomic: '2000000', decimals: 6, display: '2', mint: MINT_6DP, chain: 'solana',
		});
		// A delisted skill still shows its trial, just without a price to convert at.
		expect(out.trials[1].price).toBeNull();
	});
});

describe('GET /api/marketplace/trial-status', () => {
	it('refuses an anonymous caller', async () => {
		const res = mkRes();
		await handler(mkReq(), res);
		expect(res.statusCode).toBe(401);
		expect(parseBody(res).error).toBe('unauthorized');
	});

	it('rejects a role the two fixed queries do not cover', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		const res = mkRes();
		await handler(mkReq({ url: '/api/marketplace/trial-status?role=everyone' }), res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('validation_error');
	});

	it('rejects a write method', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'POST' }), res);
		expect(res.statusCode).toBe(405);
	});

	it('serves the buyer view to a session caller and forbids caching it', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		sqlQueue = [[]];
		const res = mkRes();
		await handler(mkReq(), res);
		expect(res.statusCode).toBe(200);
		expect(parseBody(res).data.role).toBe('buyer');
		expect(res.headers['cache-control']).toBe('private, no-store');
	});

	it('serves the seller view to a bearer caller', async () => {
		authenticateBearerMock.mockResolvedValue({ userId: USER });
		sqlQueue = [[], []];
		const res = mkRes();
		await handler(mkReq({ url: '/api/marketplace/trial-status?role=seller', headers: { authorization: 'Bearer k' } }), res);
		expect(res.statusCode).toBe(200);
		expect(parseBody(res).data.role).toBe('seller');
	});

	it('answers a throttled caller with 429, not a query', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		rlOk.value = false;
		const res = mkRes();
		await handler(mkReq(), res);
		expect(res.statusCode).toBe(429);
		expect(sqlMock).not.toHaveBeenCalled();
	});
});
