// Coverage for the wallet-link nonce store (api/auth/wallets/_link-nonces.js),
// the single-use gate behind /api/auth/wallets (SIWE link) and
// /api/auth/wallets/link-solana (SIWS link).
//
// Both backends matter and behave differently at the seams: Upstash Redis
// (production, atomic GETDEL so two instances can't both burn one nonce) and
// the in-memory Map fallback (local dev / tests, where Redis is unconfigured).
// Each is exercised here on its success path and its failure paths: replay,
// wrong user, unknown nonce, non-string input.

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.JWT_SECRET ||= 'vitest-ephemeral-jwt-secret-00000000000000';

// Minimal in-process stand-in for the two Upstash commands the store uses.
// `set` honors the { ex } TTL argument the module passes; `getdel` is
// read-and-delete in one step, which is the property the module relies on.
function makeFakeRedis() {
	const store = new Map();
	return {
		store,
		async set(key, value, opts) {
			store.set(key, { value: String(value), ex: opts?.ex ?? null });
			return 'OK';
		},
		async getdel(key) {
			const hit = store.get(key);
			if (!hit) return null;
			store.delete(key);
			return hit.value;
		},
	};
}

let redisImpl = null;
vi.mock('../api/_lib/redis.js', () => ({ getRedis: () => redisImpl }));

const { issueNonce, consumeNonce, NONCE_TTL_SEC } = await import(
	'../api/auth/wallets/_link-nonces.js'
);

beforeEach(() => {
	redisImpl = null;
});

describe('_link-nonces: in-memory fallback (Redis unconfigured)', () => {
	it('issues an opaque alphanumeric nonce and consumes it once for its owner', async () => {
		const nonce = await issueNonce('user-1');
		expect(nonce).toMatch(/^[A-Za-z0-9]{16}$/);

		expect(await consumeNonce(nonce, 'user-1')).toEqual({
			userId: 'user-1',
			issuedAt: expect.any(Number),
		});
	});

	it('refuses a replay of an already-consumed nonce', async () => {
		const nonce = await issueNonce('user-1');
		expect(await consumeNonce(nonce, 'user-1')).not.toBeNull();
		expect(await consumeNonce(nonce, 'user-1')).toBeNull();
	});

	it('refuses a nonce presented by a different user', async () => {
		const nonce = await issueNonce('user-1');
		expect(await consumeNonce(nonce, 'user-2')).toBeNull();
		// The rightful owner can still use it.
		expect(await consumeNonce(nonce, 'user-1')).not.toBeNull();
	});

	it('matches a numeric user id against its string form', async () => {
		const nonce = await issueNonce(42);
		expect(await consumeNonce(nonce, '42')).toEqual({
			userId: '42',
			issuedAt: expect.any(Number),
		});
	});

	it('returns null for an unknown nonce and for non-string input', async () => {
		expect(await consumeNonce('nonexistent-nonce', 'user-1')).toBeNull();
		expect(await consumeNonce('', 'user-1')).toBeNull();
		expect(await consumeNonce(null, 'user-1')).toBeNull();
		expect(await consumeNonce(undefined, 'user-1')).toBeNull();
		expect(await consumeNonce({ nonce: 'x' }, 'user-1')).toBeNull();
	});

	it('issues a distinct nonce every time', async () => {
		const seen = new Set();
		for (let i = 0; i < 50; i++) seen.add(await issueNonce('user-1'));
		expect(seen.size).toBe(50);
	});
});

describe('_link-nonces: Redis backend', () => {
	it('stores the owner under a namespaced key with the module TTL', async () => {
		const r = makeFakeRedis();
		redisImpl = r;

		const nonce = await issueNonce('user-1');
		expect(r.store.get(`wallet:link:nonce:${nonce}`)).toEqual({
			value: 'user-1',
			ex: NONCE_TTL_SEC,
		});
		expect(NONCE_TTL_SEC).toBe(300);
	});

	it('consumes once and burns the key so a replay finds nothing', async () => {
		const r = makeFakeRedis();
		redisImpl = r;

		const nonce = await issueNonce('user-1');
		expect(await consumeNonce(nonce, 'user-1')).toEqual({ userId: 'user-1' });
		expect(r.store.has(`wallet:link:nonce:${nonce}`)).toBe(false);
		expect(await consumeNonce(nonce, 'user-1')).toBeNull();
	});

	it('refuses a nonce issued to a different user', async () => {
		redisImpl = makeFakeRedis();
		const nonce = await issueNonce('user-1');
		expect(await consumeNonce(nonce, 'user-2')).toBeNull();
	});

	it('returns null for an unknown nonce', async () => {
		redisImpl = makeFakeRedis();
		expect(await consumeNonce('never-issued', 'user-1')).toBeNull();
	});

	it('does not fall back to the in-memory map for a Redis-issued nonce', async () => {
		redisImpl = makeFakeRedis();
		const viaRedis = await issueNonce('user-1');

		redisImpl = null;
		expect(await consumeNonce(viaRedis, 'user-1')).toBeNull();
	});
});
