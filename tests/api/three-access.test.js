// HTTP-level tests for the hold-to-access read surface in api/three/[action].js:
//   GET /api/three/access                 — full gated-feature matrix in one call
//   GET /api/three/access?feature=<id>     — a single feature's access result
//   GET /api/three/access?wallet=<addr>    — account-less resolution for a connected wallet
//
// The library matrix (every tier × every feature) is unit-tested in
// tests/three-access.test.js. These tests exercise the ENDPOINT: the reason
// taxonomy (anonymous → sign_in, signed-in-no-wallet → link_wallet, wallet in
// hand under the bar → insufficient_tier), the wallet-mode tier resolution, the
// pay-per-use price attached from the catalog, and the typed 404.
//
// Balance/price reads are mocked so the tier resolves deterministically; the
// session user is mocked so the signed-in paths run without a DB.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { COMPED_ACCOUNTS } from '../../api/_lib/comp-access.js';

const getBalances = vi.fn();
const getTokenPriceUsd = vi.fn();
const getSessionUser = vi.fn();
vi.mock('../../api/_lib/balances.js', () => ({ getBalances: (...a) => getBalances(...a) }));
vi.mock('../../api/_lib/token/price.js', () => ({ getTokenPriceUsd: (...a) => getTokenPriceUsd(...a) }));
vi.mock('../../api/_lib/auth.js', async (orig) => ({
	...(await orig()),
	getSessionUser: (...a) => getSessionUser(...a),
}));

let handler, TOKEN_MINT, FEATURE_IDS;

const WALLET = 'So11111111111111111111111111111111111111112';
// The first built-in comped handle (api/_lib/comp-access.js): full platform
// access with no wallet and no holding.
const COMPED = COMPED_ACCOUNTS[0];

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		_ended: false,
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(b) { this._body = b || ''; this._ended = true; },
		get json() { try { return JSON.parse(this._body); } catch { return null; } },
	};
}

function mockReq({ method = 'GET', url = '/' } = {}) {
	const r = Readable.from([]);
	r.method = method;
	r.url = url;
	r.headers = { origin: 'http://localhost:3000' };
	return r;
}

const get = async (url) => {
	const res = mockRes();
	await handler(mockReq({ url }), res);
	return res;
};

// Make a connected wallet resolve to a given held USD (amount==usd, price==1 so
// both the entry-usd and amount×price paths agree). usd=0 → Member floor.
function mockHeldUsd(usd) {
	getBalances.mockResolvedValue({ tokens: [{ mint: TOKEN_MINT, amount: usd, usd, price: 1 }] });
}

beforeAll(async () => {
	process.env.NODE_ENV = 'development';
	process.env.HOLDER_PASS_SECRET = 'three-access-endpoint-test-secret';
	handler = (await import('../../api/three/[action].js')).default;
	({ TOKEN_MINT } = await import('../../api/_lib/token/config.js'));
	({ listGatedFeatures: FEATURE_IDS } = await import('../../api/_lib/three-access.js'));
	FEATURE_IDS = FEATURE_IDS();
});

beforeEach(() => {
	vi.clearAllMocks();
	getSessionUser.mockResolvedValue(null); // anonymous unless a test says otherwise
});

describe('GET /api/three/access — full matrix (anonymous)', () => {
	it('returns every gated feature in one call, all locked with reason sign_in', async () => {
		const res = await get('/api/three/access');
		expect(res.statusCode).toBe(200);
		expect(res.json.signed_in).toBe(false);
		expect(res.json.wallet_linked).toBe(false);
		expect(res.json.tier.id).toBe('member');
		expect(res.json.tier.held_usd).toBe(0);

		const ids = res.json.features.map((f) => f.feature).sort();
		expect(ids).toEqual(FEATURE_IDS.slice().sort());
		for (const f of res.json.features) {
			expect(f.eligible).toBe(false);
			expect(f.reason).toBe('sign_in');
			expect(f.held.id).toBe('member');
			expect(f.required.level).toBeGreaterThanOrEqual(1);
		}
		// Anonymous resolution must not touch the chain.
		expect(getBalances).not.toHaveBeenCalled();
	});

	it('attaches the catalog price to a pay-per-use feature, null-priced for variable ones', async () => {
		const res = await get('/api/three/access');
		const byId = Object.fromEntries(res.json.features.map((f) => [f.feature, f]));

		// forge.high is payable per-use at a fixed catalog price.
		expect(byId['forge.high'].pay_per_use.action).toBe('forge.high');
		expect(byId['forge.high'].pay_per_use.usd).toBeGreaterThan(0);

		// names.first_dibs is payable, but priced per-name (variable) → usd null.
		expect(byId['names.first_dibs'].pay_per_use.action).toBe('name.auction');
		expect(byId['names.first_dibs'].pay_per_use.usd).toBeNull();

		// Hold-only features expose no pay-per-use path.
		expect(byId['worlds.private'].pay_per_use).toBeNull();
	});

	it('surfaces the enforced flag so the page can mark Live vs Planned perks', async () => {
		const res = await get('/api/three/access');
		const byId = Object.fromEntries(res.json.features.map((f) => [f.feature, f]));
		// Only the wired forge.high gate is enforced today; the rest are planned.
		expect(byId['forge.high'].enforced).toBe(true);
		expect(byId['worlds.private'].enforced).toBe(false);
		expect(byId['names.first_dibs'].enforced).toBe(false);
	});
});

describe('GET /api/three/access?feature=<id>', () => {
	it('returns the single feature result for a known id', async () => {
		const res = await get('/api/three/access?feature=forge.high');
		expect(res.statusCode).toBe(200);
		expect(res.json.features).toBeUndefined();
		expect(res.json.access.feature).toBe('forge.high');
		expect(res.json.access.eligible).toBe(false);
		expect(res.json.access.reason).toBe('sign_in');
		expect(res.json.access.required.id).toBe('bronze');
		expect(res.json.access.pay_per_use.action).toBe('forge.high');
	});

	it('returns a typed 404 for an unknown feature', async () => {
		const res = await get('/api/three/access?feature=forge.ultra');
		expect(res.statusCode).toBe(404);
		expect(res.json.error).toBe('unknown_feature');
		expect(res.json.error_description).toContain('forge.ultra');
	});
});

describe('GET /api/three/access?wallet=<addr> — account-less resolution', () => {
	it('rejects a malformed wallet with 400', async () => {
		const res = await get('/api/three/access?wallet=not-a-wallet');
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_wallet');
	});

	it('a Gold wallet unlocks forge.high + worlds.branded, locks names.first_dibs as insufficient_tier', async () => {
		mockHeldUsd(600); // gold (≥ $500)
		const res = await get(`/api/three/access?wallet=${WALLET}`);
		expect(res.statusCode).toBe(200);
		expect(res.json.wallet_linked).toBe(true);
		expect(res.json.tier.id).toBe('gold');
		expect(res.json.tier.held_usd).toBe(600);

		const byId = Object.fromEntries(res.json.features.map((f) => [f.feature, f]));
		expect(byId['forge.high'].eligible).toBe(true);
		expect(byId['forge.high'].reason).toBe('eligible');
		expect(byId['worlds.branded'].eligible).toBe(true);
		// Wallet in hand under the bar → "hold more", never sign_in / link_wallet.
		expect(byId['names.first_dibs'].eligible).toBe(false);
		expect(byId['names.first_dibs'].reason).toBe('insufficient_tier');
	});

	it('a zero-balance wallet is Member, every feature locked with insufficient_tier', async () => {
		mockHeldUsd(0);
		const res = await get(`/api/three/access?wallet=${WALLET}`);
		expect(res.json.tier.id).toBe('member');
		for (const f of res.json.features) {
			expect(f.eligible).toBe(false);
			expect(f.reason).toBe('insufficient_tier');
		}
	});

	it('degrades a wallet to Member (never 500s) on a balance read failure', async () => {
		getBalances.mockRejectedValue(new Error('rpc down'));
		const res = await get(`/api/three/access?feature=forge.high&wallet=${WALLET}`);
		expect(res.statusCode).toBe(200);
		expect(res.json.tier.id).toBe('member');
		expect(res.json.access.eligible).toBe(false);
	});
});

describe('GET /api/three/access — signed-in reasons', () => {
	it('signed-in without a linked wallet → reason link_wallet, no chain read', async () => {
		getSessionUser.mockResolvedValue({ id: 'u1' });
		const res = await get('/api/three/access?feature=forge.high');
		expect(res.json.signed_in).toBe(true);
		expect(res.json.wallet_linked).toBe(false);
		expect(res.json.access.reason).toBe('link_wallet');
		expect(getBalances).not.toHaveBeenCalled();
	});

	it("signed-in holder above the bar is eligible from the session wallet", async () => {
		getSessionUser.mockResolvedValue({ id: 'u2', wallet_address: WALLET });
		mockHeldUsd(30); // bronze (≥ $25)
		const res = await get('/api/three/access?feature=forge.high');
		expect(res.json.signed_in).toBe(true);
		expect(res.json.wallet_linked).toBe(true);
		expect(res.json.tier.id).toBe('bronze');
		expect(res.json.access.eligible).toBe(true);
		expect(res.json.access.reason).toBe('eligible');
	});
});

describe('GET /api/three/access, comped accounts', () => {
	it('reports every gated feature as eligible with no wallet and no chain read', async () => {
		// The production shape of a username-registered account: username null,
		// handle carried in the platform-issued address.
		getSessionUser.mockResolvedValue({
			id: 'u-comp',
			username: null,
			email: `${COMPED}@users.three.ws.local`,
			wallet_address: null,
		});
		const res = await get('/api/three/access');
		expect(res.statusCode).toBe(200);
		expect(res.json.signed_in).toBe(true);
		expect(res.json.wallet_linked).toBe(false);
		expect(res.json.tier.comped).toBe(true);
		for (const f of res.json.features) {
			expect(f.eligible, `${f.feature} should read as unlocked`).toBe(true);
			expect(f.reason).toBe('eligible');
		}
		expect(getBalances).not.toHaveBeenCalled();
	});

	it('stays unlocked in wallet mode, so a connected wallet never shows a false lock', async () => {
		getSessionUser.mockResolvedValue({
			id: 'u-comp',
			username: COMPED,
			email: `${COMPED}@users.three.ws.local`,
			wallet_address: WALLET,
		});
		mockHeldUsd(0); // holds nothing; the comp is the entitlement
		const res = await get(`/api/three/access?feature=forge.high&wallet=${WALLET}`);
		expect(res.json.access.eligible).toBe(true);
		expect(res.json.access.reason).toBe('eligible');
		// The badge still reports what the wallet actually holds.
		expect(res.json.tier.held_usd).toBe(0);
		expect(res.json.tier.comped).toBe(true);
	});

	it('leaves a non-comped signed-in user gated exactly as before', async () => {
		getSessionUser.mockResolvedValue({ id: 'u-plain', username: 'someone-else' });
		const res = await get('/api/three/access?feature=forge.high');
		expect(res.json.tier.comped).toBe(false);
		expect(res.json.access.eligible).toBe(false);
		expect(res.json.access.reason).toBe('link_wallet');
	});
});
