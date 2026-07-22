// geckoFetch stale-on-error behavior (api/_lib/coingecko.js).
//
// CoinGecko's free/demo tier caps at ~30 req/min. Broad /coin/:id crawling
// saturates it, and before this a 429 threw straight through detail.js into a
// user-facing 502. These tests pin the contract: a value fetched once keeps
// serving (slightly stale) through a rate-limit / upstream / network storm,
// while a genuine 404 still propagates so "unknown coin" stays a real 404.
//
// No live network: global.fetch is stubbed per case. Each test uses a unique
// path so the module-level cache never bleeds between cases.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { geckoFetch } from '../../api/_lib/coingecko.js';
import { cacheSet } from '../../api/_lib/cache.js';

const realFetch = global.fetch;
afterEach(() => {
	global.fetch = realFetch;
	vi.restoreAllMocks();
});

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, json: async () => ({ error: status }) });

describe('geckoFetch — stale-on-error', () => {
	it('serves the last-good value when the upstream is rate-limited (429)', async () => {
		const path = `/coins/stale-429-${Math.round(performance.now())}`;
		global.fetch = vi.fn().mockResolvedValueOnce(ok({ id: 'warm', price: 100 }));
		// Fresh fetch, then expire immediately so the next call re-hits upstream.
		const first = await geckoFetch(path, { ttlMs: 0 });
		expect(first).toEqual({ id: 'warm', price: 100 });

		global.fetch = vi.fn().mockResolvedValue(fail(429));
		const second = await geckoFetch(path, { ttlMs: 0 });
		expect(second).toEqual({ id: 'warm', price: 100 }); // stale, not a throw
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('serves stale on a network failure / timeout', async () => {
		const path = `/coins/stale-net-${Math.round(performance.now())}`;
		global.fetch = vi.fn().mockResolvedValueOnce(ok({ id: 'warm2' }));
		await geckoFetch(path, { ttlMs: 0 });

		global.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
		await expect(geckoFetch(path, { ttlMs: 0 })).resolves.toEqual({ id: 'warm2' });
	});

	it('propagates a 404 as a real error even when a stale value exists', async () => {
		const path = `/coins/stale-404-${Math.round(performance.now())}`;
		global.fetch = vi.fn().mockResolvedValueOnce(ok({ id: 'was-here' }));
		await geckoFetch(path, { ttlMs: 0 });

		global.fetch = vi.fn().mockResolvedValue(fail(404));
		await expect(geckoFetch(path, { ttlMs: 0 })).rejects.toMatchObject({ status: 404 });
	});

	it('throws on the first-ever fetch when there is no stale buffer to fall back on', async () => {
		const path = `/coins/cold-429-${Math.round(performance.now())}`;
		global.fetch = vi.fn().mockResolvedValue(fail(429));
		await expect(geckoFetch(path)).rejects.toMatchObject({ status: 429 });
	});

	it('returns fresh cache without re-hitting upstream inside the TTL', async () => {
		const path = `/coins/fresh-${Math.round(performance.now())}`;
		global.fetch = vi.fn().mockResolvedValue(ok({ id: 'cached' }));
		await geckoFetch(path, { ttlMs: 60_000 });
		await geckoFetch(path, { ttlMs: 60_000 });
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	// The memory stale buffer dies with the instance. The durable last-good copy
	// (shared cache, written on every good fetch) is what keeps a COLD instance
	// serving through an upstream storm instead of 502ing, the exact failure the
	// 2026-07-22 api-sweep caught on /api/coin/exchanges.
	it('falls back to the durable last-good copy when memory has nothing (throttled upstream)', async () => {
		const path = `/coins/durable-429-${Math.round(performance.now())}`;
		await cacheSet(`gecko:last-good:${path}`, { id: 'from-durable' }, 300);
		global.fetch = vi.fn().mockResolvedValue(fail(429));
		await expect(geckoFetch(path)).resolves.toEqual({ id: 'from-durable' });
	});

	it('falls back to the durable last-good copy on a cold network failure', async () => {
		const path = `/coins/durable-net-${Math.round(performance.now())}`;
		await cacheSet(`gecko:last-good:${path}`, { id: 'from-durable-net' }, 300);
		global.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { name: 'TimeoutError' }));
		await expect(geckoFetch(path)).resolves.toEqual({ id: 'from-durable-net' });
	});

	it('never masks a 404 with the durable copy', async () => {
		const path = `/coins/durable-404-${Math.round(performance.now())}`;
		await cacheSet(`gecko:last-good:${path}`, { id: 'ghost' }, 300);
		global.fetch = vi.fn().mockResolvedValue(fail(404));
		await expect(geckoFetch(path)).rejects.toMatchObject({ status: 404 });
	});
});
