// Unit tests for the $THREE server-enforcement helper (api/_lib/require-three.js).
//
// requireFeatureAccess is the keystone gate: it turns the three-access registry
// into a real entitlement check. These prove the resolution order (pass-first,
// then on-chain, then anonymous Member), the hold-or-pay 402 payload, the typed
// 404 for an unknown feature, and that a valid pass is never blocked by an RPC
// outage. Balance/price reads and the session lookup are mocked — no DB, no RPC.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBalances = vi.fn();
const getTokenPriceUsd = vi.fn();
const getSessionUser = vi.fn();
vi.mock('../api/_lib/balances.js', () => ({ getBalances: (...a) => getBalances(...a) }));
vi.mock('../api/_lib/token/price.js', () => ({ getTokenPriceUsd: (...a) => getTokenPriceUsd(...a) }));
// hasSessionCookie gates the comped-access lookup (api/_lib/comp-access.js): it
// reads the real cookie header, so an anonymous mockReq() skips the lookup and a
// case that sets a cookie exercises it against the mocked getSessionUser.
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUser(...a),
	hasSessionCookie: (req) => Boolean(req?.headers?.cookie),
}));

import { requireFeatureAccess } from '../api/_lib/require-three.js';
import { signTierPass } from '../api/_lib/three-tier.js';
import { TOKEN_MINT } from '../api/_lib/token/config.js';

const WALLET = 'So11111111111111111111111111111111111111112';

function mockRes() {
	return {
		statusCode: 200, _headers: {}, _body: '', _ended: false,
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(b) { this._body = b || ''; this._ended = true; },
		get json() { try { return JSON.parse(this._body); } catch { return null; } },
	};
}

function mockReq({ headers = {} } = {}) {
	return { method: 'POST', url: '/api/forge', headers: { ...headers } };
}

// Drive resolveUserTier(user) → tierForUsd via the mocked balance read.
function balancesWorthUsd(usd) {
	getBalances.mockResolvedValue({ tokens: [{ mint: TOKEN_MINT, amount: 1, usd, price: usd }] });
}

beforeEach(() => {
	vi.clearAllMocks();
	// Symmetric sign/verify + bypass the prod secret guard.
	process.env.HOLDER_PASS_SECRET = 'three-require-test-secret';
	process.env.NODE_ENV = 'test';
	getSessionUser.mockResolvedValue(null); // anonymous unless a case overrides it
});

describe('requireFeatureAccess — pass-first resolution', () => {
	it('allows a valid pass at/above the required level and writes nothing', async () => {
		const pass = signTierPass({ wallet: WALLET, level: 1, tierId: 'bronze', usd: 30 });
		const res = mockRes();
		const gate = await requireFeatureAccess(
			mockReq({ headers: { 'x-three-tier-pass': pass } }),
			res,
			'forge.high',
		);
		expect(gate.ok).toBe(true);
		expect(gate.level).toBe(1);
		expect(gate.wallet).toBe(WALLET);
		expect(res._ended).toBe(false); // nothing written on the allow path
		expect(getSessionUser).not.toHaveBeenCalled(); // pass short-circuits before auth/RPC
	});

	it('blocks a valid pass BELOW the required level — 402 with the full payload', async () => {
		const pass = signTierPass({ wallet: WALLET, level: 0, tierId: 'member', usd: 0 });
		const res = mockRes();
		const gate = await requireFeatureAccess(
			mockReq({ headers: { 'x-three-tier-pass': pass } }),
			res,
			'forge.high',
		);
		expect(gate.ok).toBe(false);
		expect(res.statusCode).toBe(402);
		const b = res.json;
		expect(b.error).toBe('three_hold_required');
		expect(b.feature).toBe('forge.high');
		expect(b.required).toMatchObject({ level: 1, id: 'bronze', min_usd: 25 });
		expect(b.held).toMatchObject({ level: 0, id: 'member', usd: 0 });
		expect(b.reason).toBe('insufficient_tier'); // a presented pass is not "sign in"
		expect(b.pay_per_use).toMatchObject({ action: 'forge.high', usd: 0.5 });
	});

	it('does NOT block a valid pass holder when the balance RPC throws', async () => {
		getBalances.mockRejectedValue(new Error('rpc down'));
		const pass = signTierPass({ wallet: WALLET, level: 2, tierId: 'silver', usd: 150 });
		const res = mockRes();
		const gate = await requireFeatureAccess(
			mockReq({ headers: { 'x-three-tier-pass': pass } }),
			res,
			'forge.high',
		);
		expect(gate.ok).toBe(true);
		expect(getBalances).not.toHaveBeenCalled(); // pass path never reaches the RPC
	});
});

describe('requireFeatureAccess — on-chain fallback (no pass)', () => {
	it('allows a holder resolved via their linked wallet (mock balances → Bronze)', async () => {
		getSessionUser.mockResolvedValue({ id: 'u1', wallet_address: WALLET });
		balancesWorthUsd(30); // ≥ $25 → Bronze
		const res = mockRes();
		const gate = await requireFeatureAccess(mockReq(), res, 'forge.high');
		expect(gate.ok).toBe(true);
		expect(gate.level).toBe(1);
		expect(res._ended).toBe(false);
	});

	it('blocks a signed-in holder whose wallet is below the threshold — reason insufficient_tier', async () => {
		getSessionUser.mockResolvedValue({ id: 'u1', wallet_address: WALLET });
		balancesWorthUsd(10); // < $25 → Member
		const res = mockRes();
		const gate = await requireFeatureAccess(mockReq(), res, 'forge.high');
		expect(gate.ok).toBe(false);
		expect(res.statusCode).toBe(402);
		expect(res.json.reason).toBe('insufficient_tier');
		expect(res.json.held).toMatchObject({ level: 0, usd: 10 });
		expect(res.json.usd_to_go).toBe(15); // 25 − 10
	});

	it('blocks a signed-in user with no linked wallet — reason link_wallet', async () => {
		getSessionUser.mockResolvedValue({ id: 'u1', wallet_address: null });
		const res = mockRes();
		const gate = await requireFeatureAccess(mockReq(), res, 'forge.high');
		expect(gate.ok).toBe(false);
		expect(res.statusCode).toBe(402);
		expect(res.json.reason).toBe('link_wallet');
	});
});

describe('requireFeatureAccess — anonymous + options + errors', () => {
	it('blocks an anonymous caller — 402 reason sign_in + canonical acquire block', async () => {
		const res = mockRes();
		const gate = await requireFeatureAccess(mockReq(), res, 'forge.high');
		expect(gate.ok).toBe(false);
		expect(res.statusCode).toBe(402);
		const b = res.json;
		expect(b.reason).toBe('sign_in');
		expect(b.acquire.mint).toBe(TOKEN_MINT);
		expect(b.acquire.swap_url).toContain(TOKEN_MINT);
		expect(b.acquire.pump_url).toContain(TOKEN_MINT);
		expect(b.acquire.symbol).toBe('THREE');
		expect(b.usd_to_go).toBe(25);
	});

	it('omits pay-per-use when allowPayPerUse is false', async () => {
		const res = mockRes();
		const gate = await requireFeatureAccess(mockReq(), res, 'forge.high', { allowPayPerUse: false });
		expect(gate.ok).toBe(false);
		expect(res.json.pay_per_use).toBeNull();
	});

	it('reads the pass from opts.body.tier_pass as well as the header', async () => {
		const pass = signTierPass({ wallet: WALLET, level: 1, tierId: 'bronze', usd: 30 });
		const res = mockRes();
		const gate = await requireFeatureAccess(mockReq(), res, 'forge.high', { body: { tier_pass: pass } });
		expect(gate.ok).toBe(true);
	});

	it('returns a typed 404 for an unknown feature id', async () => {
		const res = mockRes();
		const gate = await requireFeatureAccess(mockReq(), res, 'forge.nope');
		expect(gate.ok).toBe(false);
		expect(res.statusCode).toBe(404);
		expect(res.json.error).toBe('unknown_feature');
	});

	it('gates a higher-tier feature (worlds.private, Silver) for a Bronze holder', async () => {
		const pass = signTierPass({ wallet: WALLET, level: 1, tierId: 'bronze', usd: 30 });
		const res = mockRes();
		const gate = await requireFeatureAccess(
			mockReq({ headers: { 'x-three-tier-pass': pass } }),
			res,
			'worlds.private',
		);
		expect(gate.ok).toBe(false);
		expect(res.statusCode).toBe(402);
		expect(res.json.required).toMatchObject({ level: 2, id: 'silver' });
		// worlds.private has no pay-per-use path — it's hold-only.
		expect(res.json.pay_per_use).toBeNull();
	});
});
