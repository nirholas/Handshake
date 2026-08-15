/**
 * GET /api/premium/mine: which passes the billing dashboard is allowed to show.
 *
 * The handler has to answer for two kinds of purchase: passes bought while
 * signed in (user_id-linked) and passes bought wallet-only, which carry no
 * user_id at all and can only be matched by wallet address.
 *
 * The wallet half is the part that broke. It used to read `users.wallet_address`
 * alone, but a Solana wallet reaches an account through the SIWS lane, which
 * writes `user_wallets` and never touches that column; the column is only
 * written by the SIWE lane, as a lowercased EVM address that can never look like
 * a Solana key. So the clause was dead for every Solana buyer on the platform.
 * These tests pin the resolution to the linked-wallet set, and pin the negative
 * case too: an EVM-only account must not splice a hex address into a Solana
 * address match.
 *
 * The DB and the session are mocked; linkedSolanaWallets() runs for real against
 * the mocked DB, so the user_wallets lookup itself is under test rather than
 * assumed. The HTTP envelope helpers run for real, so status codes and bodies
 * are genuine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = '9c1f0a52-2c41-4a2c-9c65-9f6f8f5a4d10';
const SOL_A = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const SOL_B = 'THREEsynthetic1111111111111111111111111111';
const EVM = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';

const db = vi.hoisted(() => ({ handlers: [], calls: [] }));
const session = vi.hoisted(() => ({ user: null }));

vi.mock('../api/_lib/db.js', () => ({
	sql: async (strings, ...values) => {
		const text = strings.join(' $ ').replace(/\s+/g, ' ').trim();
		db.calls.push({ text, values });
		for (const h of db.handlers) {
			if (h.match.test(text)) return h.result(values, text);
		}
		return [];
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));
vi.mock('../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => session.user) }));

const { default: handler } = await import('../api/premium/mine.js');

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, '_s', { get() { return this.statusCode; } });
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}
async function call() {
	const req = {
		method: 'GET',
		url: '/api/premium/mine',
		headers: { origin: 'https://three.ws' },
		socket: { remoteAddress: '127.0.0.1' },
	};
	const res = makeRes();
	await handler(req, res);
	return res;
}

/** The `or wallet = any(...)` fragment, if the handler built one. */
function walletClause() {
	return db.calls.find((c) => /wallet = any/.test(c.text)) || null;
}

beforeEach(() => {
	db.handlers = [];
	db.calls = [];
	session.user = { id: USER_ID, email: 'buyer@three.ws', wallet_address: null };
	vi.clearAllMocks();
});

describe('GET /api/premium/mine: authentication', () => {
	it('answers 401 and touches no table when there is no session', async () => {
		session.user = null;
		const r = await call();
		expect(r._s).toBe(401);
		expect(r.json()).toEqual({ error: 'unauthenticated' });
		expect(db.calls).toEqual([]);
	});
});

describe('GET /api/premium/mine: which wallets a pass can be matched by', () => {
	it('matches every SIWS-linked Solana wallet, not just the legacy column', async () => {
		db.handlers = [{ match: /from user_wallets/, result: () => [{ address: SOL_A }, { address: SOL_B }] }];
		const r = await call();
		expect(r._s).toBe(200);

		const lookup = db.calls.find((c) => /from user_wallets/.test(c.text));
		expect(lookup.text).toMatch(/chain_type = 'solana'/);
		expect(lookup.values).toEqual([USER_ID]);
		expect(walletClause().values[0].sort()).toEqual([SOL_A, SOL_B].sort());
	});

	it('still honours a legacy wallet_address that is a Solana key', async () => {
		session.user = { ...session.user, wallet_address: SOL_A };
		const r = await call();
		expect(r._s).toBe(200);
		expect(walletClause().values[0]).toEqual([SOL_A]);
	});

	it('never matches on an EVM wallet_address, and omits the clause entirely', async () => {
		session.user = { ...session.user, wallet_address: EVM };
		const r = await call();
		expect(r._s).toBe(200);
		expect(walletClause()).toBe(null);
		expect(db.calls.every((c) => !c.values.includes(EVM))).toBe(true);
	});
});

describe('GET /api/premium/mine: payload', () => {
	const expired = {
		id: 'pass-old', wallet: SOL_A, plan: 'developer', asset: 'USDC', amount_atomics: '19990000',
		usd_price: '19.9900', tx_signature: 'sig-old', api_subscription_id: 'sub_old01',
		started_at: '2026-05-01T00:00:00.000Z', expires_at: '2026-05-31T00:00:00.000Z',
		created_at: '2026-05-01T00:00:00.000Z',
	};
	const live = {
		id: 'pass-live', wallet: SOL_A, plan: 'pro', asset: 'THREE', amount_atomics: '44025221398',
		usd_price: '79.2000', tx_signature: 'sig-live', api_subscription_id: 'sub_live01',
		started_at: '2026-08-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z',
		created_at: '2026-08-01T00:00:00.000Z',
	};

	beforeEach(() => {
		db.handlers = [
			{ match: /from user_wallets/, result: () => [{ address: SOL_A }] },
			{ match: /from premium_passes/, result: () => [live, expired] },
			{
				match: /from x402_subscriptions/,
				result: () => [{
					id: 'sub_live01', name: 'three.ws Pro pass', key_prefix: 'x402_live_ABCDEF',
					rate_limit_per_minute: 600, expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null,
					meta: { source: 'premium-pass', plan: 'pro', wallet: SOL_A },
					granted: '128', denied: '2', last_seen: '2026-08-14T12:00:00.000Z',
				}, {
					id: 'sub_old01', name: 'three.ws Developer pass', key_prefix: 'x402_live_GHIJKL',
					rate_limit_per_minute: 120, expires_at: '2026-05-31T00:00:00.000Z',
					revoked_at: '2026-06-01T00:00:00.000Z', meta: { source: 'premium-pass', wallet: SOL_A },
					granted: null, denied: null, last_seen: null,
				}],
			},
		];
	});

	it('reports the live pass as active and both keys with their usage', async () => {
		const r = await call();
		expect(r._s).toBe(200);
		const body = r.json();

		expect(body.active).toEqual({
			id: 'pass-live', wallet: SOL_A, expires_at: live.expires_at, asset: 'THREE', plan: 'pro',
		});
		expect(body.passes).toHaveLength(2);
		expect(body.plans.map((p) => p.id)).toEqual(['developer', 'pro', 'enterprise']);
		expect(body.plan.id).toBe('developer');
		expect(body.resources.length).toBeGreaterThan(0);

		expect(body.keys).toEqual([
			{
				id: 'sub_live01', name: 'three.ws Pro pass', key_prefix: 'x402_live_ABCDEF',
				rate_limit_per_minute: 600, expires_at: '2099-01-01T00:00:00.000Z', status: 'active',
				wallet: SOL_A, usage: { granted: 128, denied: 2, last_seen: '2026-08-14T12:00:00.000Z' },
			},
			{
				id: 'sub_old01', name: 'three.ws Developer pass', key_prefix: 'x402_live_GHIJKL',
				rate_limit_per_minute: 120, expires_at: '2026-05-31T00:00:00.000Z', status: 'revoked',
				wallet: SOL_A, usage: { granted: 0, denied: 0, last_seen: null },
			},
		]);
	});

	it('never lets the response be cached', async () => {
		const r = await call();
		expect(String(r.getHeader('cache-control'))).toContain('no-store');
	});

	it('skips the key query when no pass carries a subscription', async () => {
		db.handlers = [
			{ match: /from user_wallets/, result: () => [] },
			{ match: /from premium_passes/, result: () => [{ ...live, api_subscription_id: null }] },
		];
		const r = await call();
		expect(r._s).toBe(200);
		expect(r.json().keys).toEqual([]);
		expect(db.calls.some((c) => /from x402_subscriptions/.test(c.text))).toBe(false);
	});
});
