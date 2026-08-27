import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCache, cached, hasLastGood } from '../api/_lib/mem-cache.js';

const json = (body, status = 200, headers = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('cached: stale-on-error', () => {
	it('serves the last-good value when a refresh throws, after the TTL expired', async () => {
		const cache = createCache({ max: 4, ttlMs: 5 });
		expect(await cached(cache, 'k', async () => ({ v: 1 }))).toEqual({ v: 1 });
		expect(hasLastGood(cache, 'k')).toBe(true);
		await new Promise((r) => setTimeout(r, 15));
		expect(cache.get('k')).toBeUndefined();
		const onStale = vi.fn();
		expect(await cached(cache, 'k', async () => { throw new Error('upstream 503'); }, { onStale })).toEqual({ v: 1 });
		expect(onStale).toHaveBeenCalledTimes(1);
	});

	it('still rejects when there is nothing last-good, or when opted out', async () => {
		const cache = createCache({ max: 4, ttlMs: 5 });
		await expect(cached(cache, 'x', async () => { throw new Error('cold'); })).rejects.toThrow('cold');
		await cached(cache, 'y', async () => 'good');
		await new Promise((r) => setTimeout(r, 15));
		await expect(cached(cache, 'y', async () => { throw new Error('opted out'); }, { staleMs: 0 })).rejects.toThrow('opted out');
	});
});
