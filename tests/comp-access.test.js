// Tests for comped platform access (api/_lib/comp-access.js) and its two wirings:
// the enforcement keystone (requireFeatureAccess) and the read the UI consumes.
//
// A comped account must clear every gated feature with NO wallet, NO $THREE
// holding, and NO payment, and it must do so without ever touching an RPC or a
// price feed. These prove exactly that, plus the two properties that keep the
// allowlist safe: an anonymous request never pays for the lookup, and a
// non-comped signed-in user is still gated normally.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBalances = vi.fn();
const getTokenPriceUsd = vi.fn();
const getSessionUser = vi.fn();
vi.mock('../api/_lib/balances.js', () => ({ getBalances: (...a) => getBalances(...a) }));
vi.mock('../api/_lib/token/price.js', () => ({ getTokenPriceUsd: (...a) => getTokenPriceUsd(...a) }));
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUser(...a),
	hasSessionCookie: (req) => Boolean(req?.headers?.cookie),
}));

import {
	COMPED_ACCOUNTS,
	COMP_TIER,
	COMP_TIER_LEVEL,
	compedIdentifiers,
	isCompedUser,
	resolveCompAccess,
} from '../api/_lib/comp-access.js';
import { requireFeatureAccess } from '../api/_lib/require-three.js';
import { listGatedFeatures } from '../api/_lib/three-access.js';
import { TIERS } from '../api/_lib/three-tier.js';

const COMPED = COMPED_ACCOUNTS[0];
const SESSION_COOKIE = '__Host-sid=abc';

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

// A request that carries a session cookie, so the comp lookup actually runs.
function signedInReq(headers = {}) {
	return mockReq({ headers: { cookie: SESSION_COOKIE, ...headers } });
}

beforeEach(() => {
	vi.clearAllMocks();
	delete process.env.THREE_COMP_ACCOUNTS;
	process.env.HOLDER_PASS_SECRET = 'comp-access-test-secret';
	process.env.NODE_ENV = 'test';
	getSessionUser.mockResolvedValue(null);
});

describe('comp-access: the allowlist', () => {
	it('grants the top tier of the ladder', () => {
		expect(COMP_TIER).toBe(TIERS[TIERS.length - 1]);
		expect(COMP_TIER_LEVEL).toBe(TIERS[TIERS.length - 1].level);
	});

	it('matches a built-in account by username, case-insensitively', () => {
		expect(isCompedUser({ id: 'u1', username: COMPED })).toBe(true);
		expect(isCompedUser({ id: 'u1', username: COMPED.toUpperCase() })).toBe(true);
		expect(isCompedUser({ id: 'u1', username: `  ${COMPED}  ` })).toBe(true);
	});

	it('matches the handle in a platform-issued @users.three.ws.local address', () => {
		// A username-registered account leaves users.username null and carries its
		// handle in the server-minted address (api/auth/[action].js handleRegister).
		expect(isCompedUser({ id: 'u1', username: null, email: `${COMPED}@users.three.ws.local` })).toBe(true);
		expect(isCompedUser({ id: 'u1', username: null, email: `${COMPED.toUpperCase()}@users.three.ws.local` })).toBe(true);
	});

	it('does not match anyone else', () => {
		expect(isCompedUser({ id: 'u2', username: 'someone-else', email: 'a@b.co' })).toBe(false);
		expect(isCompedUser(null)).toBe(false);
		expect(isCompedUser({})).toBe(false);
	});

	it('cannot be claimed by a lookalike on a domain we do not issue', () => {
		// Only the platform-issued domain grants the local-part match; email is
		// uniquely indexed, so the real address can never be registered twice.
		expect(isCompedUser({ id: 'u4', email: `${COMPED}@gmail.com` })).toBe(false);
		expect(isCompedUser({ id: 'u5', email: `${COMPED}@users.three.ws.local.evil.com` })).toBe(false);
	});

	it('ignores display_name, which is user-settable and not unique', () => {
		expect(isCompedUser({ id: 'u6', display_name: COMPED, email: 'impostor@b.co' })).toBe(false);
		expect(isCompedUser({ id: 'u7', display_name: COMPED.toUpperCase(), username: 'impostor' })).toBe(false);
	});

	it('matches an env-listed account by email or id, merged with the built-ins', () => {
		process.env.THREE_COMP_ACCOUNTS = 'extra@three.ws, 11111111-2222-3333-4444-555555555555';
		expect(isCompedUser({ id: 'u3', email: 'Extra@three.ws' })).toBe(true);
		expect(isCompedUser({ id: '11111111-2222-3333-4444-555555555555' })).toBe(true);
		// The env list never revokes a committed comp.
		expect(isCompedUser({ id: 'u1', username: COMPED })).toBe(true);
		expect(compedIdentifiers().has(COMPED)).toBe(true);
	});

	it('ignores blank env entries', () => {
		process.env.THREE_COMP_ACCOUNTS = ' , ,, ';
		expect(compedIdentifiers().size).toBe(COMPED_ACCOUNTS.length);
		expect(isCompedUser({ id: '', username: '' })).toBe(false);
	});
});

describe('comp-access: resolveCompAccess', () => {
	it('costs an anonymous request nothing (no session cookie → no lookup)', async () => {
		const out = await resolveCompAccess(mockReq());
		expect(out).toEqual({ comped: false, user: null });
		expect(getSessionUser).not.toHaveBeenCalled();
	});

	it('resolves a comped session user', async () => {
		getSessionUser.mockResolvedValue({ id: 'u1', username: COMPED, wallet_address: null });
		const out = await resolveCompAccess(signedInReq());
		expect(out.comped).toBe(true);
		expect(out.user.username).toBe(COMPED);
	});

	it('resolves the real account shape: null username, platform-issued email', async () => {
		getSessionUser.mockResolvedValue({
			id: 'b2db97f8-a212-4719-9f48-0df8996e3836',
			username: null,
			display_name: COMPED.toUpperCase(),
			email: `${COMPED}@users.three.ws.local`,
			wallet_address: null,
		});
		const out = await resolveCompAccess(signedInReq());
		expect(out.comped).toBe(true);
	});

	it('fails closed on the perk when the session lookup throws', async () => {
		getSessionUser.mockRejectedValue(new Error('db down'));
		const out = await resolveCompAccess(signedInReq());
		expect(out).toEqual({ comped: false, user: null });
	});
});

describe('requireFeatureAccess: a comped account', () => {
	it('clears EVERY gated feature with no wallet and no holding', async () => {
		// The production account shape: username null, handle in the platform email.
		getSessionUser.mockResolvedValue({
			id: 'u1',
			username: null,
			email: `${COMPED}@users.three.ws.local`,
			wallet_address: null,
		});
		for (const feature of listGatedFeatures()) {
			const res = mockRes();
			const gate = await requireFeatureAccess(signedInReq(), res, feature);
			expect(gate.ok, `${feature} should be comped`).toBe(true);
			expect(gate.level).toBe(COMP_TIER_LEVEL);
			expect(res._ended, `${feature} must write nothing on the allow path`).toBe(false);
		}
		// Never reads a balance or a price; the comp is pure account state.
		expect(getBalances).not.toHaveBeenCalled();
		expect(getTokenPriceUsd).not.toHaveBeenCalled();
	});

	it('clears forge.high without a wallet, where a normal signed-in user is 402d', async () => {
		getSessionUser.mockResolvedValue({ id: 'u9', username: 'regular-user', wallet_address: null });
		const blocked = mockRes();
		const blockedGate = await requireFeatureAccess(signedInReq(), blocked, 'forge.high');
		expect(blockedGate.ok).toBe(false);
		expect(blocked.statusCode).toBe(402);
		expect(blocked.json.reason).toBe('link_wallet');

		getSessionUser.mockResolvedValue({ id: 'u1', username: COMPED, wallet_address: null });
		const allowed = mockRes();
		const allowedGate = await requireFeatureAccess(signedInReq(), allowed, 'forge.high');
		expect(allowedGate.ok).toBe(true);
		expect(allowed._ended).toBe(false);
	});

	it('is not under-resolved by a stale low-tier pass in the client', async () => {
		// A Member-level pass would short-circuit the old resolution at level 0; the
		// comp check runs first, so a comped caller is never blocked by stale storage.
		const { signTierPass } = await import('../api/_lib/three-tier.js');
		const stale = signTierPass({
			wallet: 'So11111111111111111111111111111111111111112',
			level: 0,
			tierId: 'member',
			usd: 0,
		});
		getSessionUser.mockResolvedValue({ id: 'u1', username: COMPED, wallet_address: null });
		const res = mockRes();
		const gate = await requireFeatureAccess(signedInReq({ 'x-three-tier-pass': stale }), res, 'forge.high');
		expect(gate.ok).toBe(true);
		expect(res.statusCode).toBe(200);
	});

	it('leaves the anonymous 402 exactly as it was', async () => {
		const res = mockRes();
		const gate = await requireFeatureAccess(mockReq(), res, 'forge.high');
		expect(gate.ok).toBe(false);
		expect(res.statusCode).toBe(402);
		expect(res.json.error).toBe('three_hold_required');
		expect(res.json.reason).toBe('sign_in');
	});
});
