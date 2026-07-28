/**
 * CoinGecko demo-key health — unit tests.
 *
 * The demo tier caps at 10,000 calls per MONTH. When that cap is hit every
 * request carrying the key comes back 429 for the rest of the billing period,
 * while the identical request WITHOUT the key is still served by the keyless
 * public tier. On 2026-07-28 that took every /api/coin/detail, /tickers and
 * /exchange call to a 502 for hours.
 *
 * These tests pin the recovery contract: a keyed rejection benches the key,
 * retries the same URL keyless, and later calls skip the key until the cooldown
 * expires — so a monthly reset heals with no redeploy and no human.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	geckoFetch,
	geckoHeaders,
	isGeckoKeyBenched,
	resetGeckoKeyHealth,
} from '../api/_lib/coingecko.js';

const KEY = 'CG-test-key';
const jsonResponse = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The demo-tier quota-exhausted reply, verbatim in shape.
const quotaExhausted = () =>
	jsonResponse({ status: { error_code: 10006, error_message: "You've reached 10,000 calls limit." } }, 429);

let calls;

beforeEach(() => {
	resetGeckoKeyHealth();
	process.env.COINGECKO_API_KEY = KEY;
	calls = [];
	vi.stubGlobal('fetch', vi.fn(async (url, init) => {
		calls.push({ url: String(url), key: init?.headers?.['x-cg-demo-api-key'] ?? null });
		return calls.at(-1).key ? quotaExhausted() : jsonResponse({ id: 'coin-a' });
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
	resetGeckoKeyHealth();
	delete process.env.COINGECKO_API_KEY;
});

describe('geckoHeaders', () => {
	it('attaches the demo key when one is configured and healthy', () => {
		expect(geckoHeaders()['x-cg-demo-api-key']).toBe(KEY);
	});

	it('omits the key when explicitly asked for the keyless tier', () => {
		expect(geckoHeaders(false)['x-cg-demo-api-key']).toBeUndefined();
	});

	it('omits the key when none is configured', () => {
		delete process.env.COINGECKO_API_KEY;
		expect(geckoHeaders()['x-cg-demo-api-key']).toBeUndefined();
	});

	it('always carries the accept + user-agent identity headers', () => {
		expect(geckoHeaders()).toMatchObject({ accept: 'application/json', 'user-agent': 'three.ws/1.0' });
	});
});

describe('geckoFetch demo-key failover', () => {
	it('retries keyless and serves the live payload when the keyed call is 429d', async () => {
		const value = await geckoFetch('/coins/kh-live', { ttlMs: 0 });
		expect(value).toEqual({ id: 'coin-a' });
		expect(calls.map((c) => c.key)).toEqual([KEY, null]);
	});

	it('benches the key so the next call goes out keyless on the first try', async () => {
		await geckoFetch('/coins/kh-bench-a', { ttlMs: 0 });
		expect(isGeckoKeyBenched()).toBe(true);
		calls.length = 0;
		await geckoFetch('/coins/kh-bench-b', { ttlMs: 0 });
		expect(calls.map((c) => c.key)).toEqual([null]);
	});

	it('benches on a revoked key (401/403), not only on quota exhaustion', async () => {
		vi.stubGlobal('fetch', vi.fn(async (url, init) => {
			calls.push({ url: String(url), key: init?.headers?.['x-cg-demo-api-key'] ?? null });
			return calls.at(-1).key ? jsonResponse({ error: 'unauthorized' }, 401) : jsonResponse({ id: 'coin-a' });
		}));
		await geckoFetch('/coins/kh-revoked', { ttlMs: 0 });
		expect(isGeckoKeyBenched()).toBe(true);
	});

	it('leaves the key alone when a keyed call succeeds', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ id: 'coin-a' })));
		await geckoFetch('/coins/kh-healthy', { ttlMs: 0 });
		expect(isGeckoKeyBenched()).toBe(false);
	});

	it('does not bench on a 404 — an unknown coin is not a key fault', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'coin not found' }, 404)));
		await expect(geckoFetch('/coins/kh-unknown', { ttlMs: 0 })).rejects.toMatchObject({ status: 404 });
		expect(isGeckoKeyBenched()).toBe(false);
	});

	it('surfaces the original status when the keyless retry also fails', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => quotaExhausted()));
		await expect(geckoFetch('/coins/kh-both-down', { ttlMs: 0 })).rejects.toMatchObject({ status: 429 });
	});
});
