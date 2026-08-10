// Regression guards for DELETE /api/auth/wallets/<address>.
//
// Two defects found in the 2026-08-10 auth audit, both reproduced live against
// a real password-less SIWS account before the fix:
//
//   1. The last-wallet guard never fired. Postgres `count(*)` is a bigint and
//      the Neon driver returns it as the STRING "1", so `walletCount === 1`
//      was always false and an account whose only credential is a wallet could
//      unlink it, removing its own way back in.
//   2. Unlinking the primary wallet left the account with no primary at all.
//      Royalty payouts (api/_lib/royalty.js), agent-wallet resolution
//      (api/_lib/agent-wallet.js) and x402 skill calls (api/x402/skill-call.js)
//      all select the payout address by `is_primary = true`, so the account
//      silently lost its payout target.

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.APP_ORIGIN = 'https://three.ws';
process.env.JWT_SECRET ||= 'vitest-ephemeral-jwt-secret-00000000000000';

vi.mock('../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { walletLink: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => ({ id: 'user-1', email: 'sol-abc@wallet.local' })),
}));

// The fixture models user_wallets for one account. Queries are matched on the
// distinctive text of each statement the handler issues, and `count(*)` is
// returned in the driver's real shape (a string) so the coercion bug cannot
// come back unnoticed.
let wallets = [];
const sqlMock = vi.fn(async (strings, ...values) => {
	const text = Array.isArray(strings) ? strings.join(' ') : String(strings);

	if (text.includes('select id, address, is_primary from user_wallets')) {
		const candidates = values[1] || [];
		const hit = wallets.find((w) => candidates.includes(w.address));
		return hit ? [{ id: hit.id, address: hit.address, is_primary: hit.is_primary }] : [];
	}
	if (text.includes('select count(*) as n from user_wallets')) {
		return [{ n: String(wallets.length) }];
	}
	if (text.includes('select password_hash from users')) {
		return [{ password_hash: passwordHash }];
	}
	if (text.includes('delete from user_wallets')) {
		wallets = wallets.filter((w) => w.id !== values[0]);
		return [];
	}
	if (text.includes('update user_wallets set is_primary = true')) {
		const oldest = [...wallets].sort((a, b) => a.created_at - b.created_at)[0];
		if (!oldest) return [];
		oldest.is_primary = true;
		return [{ address: oldest.address }];
	}
	return [];
});
vi.mock('../api/_lib/db.js', () => ({ sql: (strings, ...values) => sqlMock(strings, ...values) }));

let passwordHash = null;

const { default: handler } = await import('../api/auth/wallets/[action].js');

function makeReq(address) {
	return {
		method: 'DELETE',
		url: `/api/auth/wallets/${address}`,
		query: { action: address },
		headers: { 'x-csrf-token': 'csrf-token' },
		socket: { remoteAddress: '127.0.0.1' },
	};
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => {
		r._h[k] = v;
	};
	r.getHeader = (k) => r._h[k];
	r.end = (b) => {
		r._b = b;
	};
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}

beforeEach(() => {
	sqlMock.mockClear();
	passwordHash = null;
	wallets = [
		{ id: 'w-a', address: 'AaaaSolanaAddressAaaa', is_primary: true, created_at: 1 },
		{ id: 'w-b', address: 'BbbbSolanaAddressBbbb', is_primary: false, created_at: 2 },
	];
});

describe('DELETE /api/auth/wallets/<address>: last-wallet guard', () => {
	it('refuses to remove the only wallet of an account with no password', async () => {
		wallets = [wallets[0]];
		const res = makeRes();
		await handler(makeReq('AaaaSolanaAddressAaaa'), res);

		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('cannot_remove_last_wallet');
		expect(wallets).toHaveLength(1);
	});

	it('allows removing the only wallet when the account has a password', async () => {
		wallets = [wallets[0]];
		passwordHash = '$argon2id$v=19$m=65536,t=3,p=4$fake-hash-for-this-fixture';
		const res = makeRes();
		await handler(makeReq('AaaaSolanaAddressAaaa'), res);

		expect(res.statusCode).toBe(200);
		expect(res.json().removed).toBe(true);
		expect(wallets).toHaveLength(0);
	});

	it('allows removing a wallet while others remain', async () => {
		const res = makeRes();
		await handler(makeReq('BbbbSolanaAddressBbbb'), res);

		expect(res.statusCode).toBe(200);
		expect(wallets.map((w) => w.id)).toEqual(['w-a']);
	});

	it('404s an address the caller does not own', async () => {
		const res = makeRes();
		await handler(makeReq('ZzzzNotYourAddressZzzz'), res);

		expect(res.statusCode).toBe(404);
		expect(res.json().error).toBe('not_found');
	});
});

describe('DELETE /api/auth/wallets/<address>: primary succession', () => {
	it('promotes the oldest survivor when the primary wallet is removed', async () => {
		wallets[0].is_primary = false;
		wallets[1].is_primary = true;

		const res = makeRes();
		await handler(makeReq('BbbbSolanaAddressBbbb'), res);

		expect(res.statusCode).toBe(200);
		expect(res.json().primary).toBe('AaaaSolanaAddressAaaa');
		expect(wallets.filter((w) => w.is_primary).map((w) => w.address)).toEqual([
			'AaaaSolanaAddressAaaa',
		]);
	});

	it('leaves the primary alone when a non-primary wallet is removed', async () => {
		const res = makeRes();
		await handler(makeReq('BbbbSolanaAddressBbbb'), res);

		expect(res.json().primary).toBeNull();
		expect(wallets.filter((w) => w.is_primary).map((w) => w.address)).toEqual([
			'AaaaSolanaAddressAaaa',
		]);
	});

	it('does not attempt a promotion when the removed wallet was the last one', async () => {
		wallets = [wallets[0]];
		passwordHash = '$argon2id$v=19$m=65536,t=3,p=4$fake-hash-for-this-fixture';
		const res = makeRes();
		await handler(makeReq('AaaaSolanaAddressAaaa'), res);

		expect(res.json().primary).toBeNull();
		expect(
			sqlMock.mock.calls.some((c) =>
				(Array.isArray(c[0]) ? c[0].join(' ') : '').includes('set is_primary = true'),
			),
		).toBe(false);
	});
});
