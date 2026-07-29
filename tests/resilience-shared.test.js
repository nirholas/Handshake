// The shared backend primitives that replaced the hand-rolled retry loops,
// Map+timestamp caches, and concurrency pools scattered across api/.
import { describe, it, expect, vi } from 'vitest';
import {
	withRetry,
	isRetryableError,
	parseRetryAfter,
} from '../api/_lib/resilience.js';
import { createCache, cached } from '../api/_lib/mem-cache.js';
import { mapPool, mapPoolSettled } from '../api/_lib/pool.js';

describe('isRetryableError', () => {
	it('retries transient HTTP statuses', () => {
		for (const status of [408, 425, 429, 500, 502, 503, 504]) {
			expect(isRetryableError({ status })).toBe(true);
		}
	});

	it('does not retry client errors', () => {
		for (const status of [400, 401, 403, 404, 422]) {
			expect(isRetryableError({ status })).toBe(false);
		}
	});

	it('reads the status off an axios-style response', () => {
		expect(isRetryableError({ response: { status: 503 } })).toBe(true);
	});

	it('retries network errno codes and aborts', () => {
		expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
		expect(isRetryableError({ code: 'UND_ERR_CONNECT_TIMEOUT' })).toBe(true);
		expect(isRetryableError({ cause: { code: 'ETIMEDOUT' } })).toBe(true);
		expect(isRetryableError({ name: 'AbortError' })).toBe(true);
	});

	it('does not retry ordinary bugs', () => {
		expect(isRetryableError(new TypeError('x is not a function'))).toBe(false);
		expect(isRetryableError(null)).toBe(false);
	});
});

describe('parseRetryAfter', () => {
	it('parses delta-seconds', () => {
		expect(parseRetryAfter('30')).toBe(30_000);
		expect(parseRetryAfter('0')).toBe(0);
	});

	it('parses an HTTP-date into a forward-looking delay', () => {
		const at = new Date(Date.now() + 5_000).toUTCString();
		const ms = parseRetryAfter(at);
		expect(ms).toBeGreaterThan(3_000);
		expect(ms).toBeLessThanOrEqual(6_000);
	});

	it('clamps a past date to zero', () => {
		expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
	});

	it('returns null for missing or unparseable values', () => {
		expect(parseRetryAfter(null)).toBeNull();
		expect(parseRetryAfter('')).toBeNull();
		expect(parseRetryAfter('soon')).toBeNull();
	});
});

describe('withRetry', () => {
	it('returns the value without retrying on success', async () => {
		const fn = vi.fn().mockResolvedValue('ok');
		await expect(withRetry(fn)).resolves.toBe('ok');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('retries a transient failure and succeeds', async () => {
		let n = 0;
		const fn = vi.fn(async () => {
			if (++n < 3) throw Object.assign(new Error('boom'), { status: 503 });
			return 'ok';
		});
		await expect(withRetry(fn, { attempts: 3, initialDelayMs: 1, maxDelayMs: 5 }))
			.resolves.toBe('ok');
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('does not retry a non-retryable error', async () => {
		const fn = vi.fn(async () => {
			throw Object.assign(new Error('bad request'), { status: 400 });
		});
		await expect(withRetry(fn, { attempts: 5, initialDelayMs: 1 })).rejects.toThrow('bad request');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('gives up after the attempt budget and surfaces the last error', async () => {
		const fn = vi.fn(async () => {
			throw Object.assign(new Error('still down'), { status: 500 });
		});
		await expect(withRetry(fn, { attempts: 3, initialDelayMs: 1, maxDelayMs: 2 }))
			.rejects.toThrow('still down');
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('labels the surfaced error once', async () => {
		const fn = async () => {
			throw Object.assign(new Error('down'), { status: 500 });
		};
		await expect(withRetry(fn, { attempts: 1, label: 'birdeye' })).rejects.toThrow('birdeye: down');
	});

	it('honours a custom shouldRetry predicate', async () => {
		let n = 0;
		const fn = vi.fn(async () => {
			if (++n < 2) throw new Error('custom');
			return 'done';
		});
		await expect(
			withRetry(fn, { attempts: 3, initialDelayMs: 1, shouldRetry: () => true }),
		).resolves.toBe('done');
		expect(fn).toHaveBeenCalledTimes(2);
	});
});

describe('createCache', () => {
	it('evicts least-recently-USED, not first-inserted', () => {
		const c = createCache({ max: 2 });
		c.set('a', 1);
		c.set('b', 2);
		c.get('a'); // 'a' is now the most recently used, so 'b' should go first
		c.set('c', 3);
		expect(c.get('a')).toBe(1);
		expect(c.get('b')).toBeUndefined();
		expect(c.get('c')).toBe(3);
	});

	it('enforces the item cap', () => {
		const c = createCache({ max: 3 });
		for (let i = 0; i < 50; i++) c.set(`k${i}`, i);
		expect(c.size).toBe(3);
	});

	it('expires entries after the ttl', async () => {
		const c = createCache({ max: 8, ttlMs: 20 });
		c.set('k', 'v');
		expect(c.get('k')).toBe('v');
		await new Promise((r) => setTimeout(r, 40));
		expect(c.get('k')).toBeUndefined();
	});
});

describe('cached', () => {
	it('loads once, then serves from cache', async () => {
		const c = createCache({ max: 4 });
		const load = vi.fn().mockResolvedValue('v');
		expect(await cached(c, 'k', load)).toBe('v');
		expect(await cached(c, 'k', load)).toBe('v');
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('de-duplicates concurrent misses into a single load', async () => {
		const c = createCache({ max: 4 });
		let calls = 0;
		const load = async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 20));
			return 'v';
		};
		const all = await Promise.all([
			cached(c, 'k', load),
			cached(c, 'k', load),
			cached(c, 'k', load),
		]);
		expect(all).toEqual(['v', 'v', 'v']);
		expect(calls).toBe(1);
	});

	it('does not cache a rejection', async () => {
		const c = createCache({ max: 4 });
		await expect(cached(c, 'k', async () => {
			throw new Error('nope');
		})).rejects.toThrow('nope');
		expect(await cached(c, 'k', async () => 'second')).toBe('second');
	});
});

describe('mapPool', () => {
	it('preserves input order', async () => {
		const out = await mapPool([5, 1, 3], 2, async (n) => {
			await new Promise((r) => setTimeout(r, n));
			return n * 2;
		});
		expect(out).toEqual([10, 2, 6]);
	});

	it('never exceeds the concurrency limit', async () => {
		let inFlight = 0;
		let peak = 0;
		await mapPool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
			peak = Math.max(peak, ++inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
		});
		expect(peak).toBeLessThanOrEqual(3);
	});

	it('keeps slots busy rather than draining in batches', async () => {
		// One slow item must not block the other slots: with batch chunking, 8
		// items at concurrency 4 would take 2 * slow. With a real pool it takes
		// about one slow item's time.
		const started = Date.now();
		const durations = [60, 1, 1, 1, 1, 1, 1, 1];
		await mapPool(durations, 4, (ms) => new Promise((r) => setTimeout(r, ms)));
		expect(Date.now() - started).toBeLessThan(110);
	});

	it('rejects on the first error', async () => {
		await expect(
			mapPool([1, 2, 3], 2, async (n) => {
				if (n === 2) throw new Error('item failed');
				return n;
			}),
		).rejects.toThrow('item failed');
	});
});

describe('mapPoolSettled', () => {
	it('isolates failures per item', async () => {
		const out = await mapPoolSettled([1, 2, 3], 2, async (n) => {
			if (n === 2) throw new Error('bad row');
			return n;
		});
		expect(out[0]).toEqual({ ok: true, value: 1 });
		expect(out[1].ok).toBe(false);
		expect(out[1].error.message).toBe('bad row');
		expect(out[2]).toEqual({ ok: true, value: 3 });
	});
});
