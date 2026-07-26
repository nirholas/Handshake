/**
 * getTrendingSlim (api/_lib/pump-trending.js) — the shared trending feed
 * behind /api/pump/trending and /api/community/worlds.
 *
 * Pins the contract that fixed the 2026-07-26 worlds outage: every upstream
 * fetch asks for the canonical batch (FETCH_LIMIT) rather than the caller's
 * limit, so ONE cache entry serves every consumer and the rate-limited
 * Birdeye key is hit at most once per TTL. Before that, small-limit callers
 * kept the cache too small for the 24-row communities caller, whose own
 * burst of fetches 429'd Birdeye, tripped the breaker, and 503'd the route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async () => []),
}));

const BIRDEYE_ROWS = 20;

function birdeyeResponse(count) {
	return {
		ok: true,
		json: async () => ({
			data: {
				tokens: Array.from({ length: count }, (_, i) => ({
					address: 'Mint'.padEnd(40, String(i % 10)) + i,
					symbol: `T${i}`,
					name: `Token ${i}`,
					logoURI: null,
					price: 1 + i,
					rank: i + 1,
				})),
			},
		}),
	};
}

async function freshModule() {
	vi.resetModules();
	process.env.BIRDEYE_API_KEY = 'test-key';
	return import('../api/_lib/pump-trending.js');
}

beforeEach(() => {
	vi.unstubAllGlobals();
});

describe('getTrendingSlim — one canonical fetch serves every caller', () => {
	it('fetches the canonical batch once and slices it for different limits', async () => {
		const calls = [];
		vi.stubGlobal('fetch', vi.fn(async (url) => {
			calls.push(String(url));
			return birdeyeResponse(BIRDEYE_ROWS);
		}));
		const { getTrendingSlim } = await freshModule();

		const small = await getTrendingSlim(3);
		expect(small.data).toHaveLength(3);

		// The 24-row caller (communities) must be served from the SAME cache
		// entry: no second upstream call, no 503.
		const large = await getTrendingSlim(24);
		expect(large.data).toHaveLength(BIRDEYE_ROWS);
		expect(large.stale).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain('limit=20');
	});

	it('a large-limit caller still gets the full available feed on a cold cache', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => birdeyeResponse(BIRDEYE_ROWS)));
		const { getTrendingSlim } = await freshModule();
		const { data } = await getTrendingSlim(24);
		expect(data).toHaveLength(BIRDEYE_ROWS);
	});

	it('serves a shorter stale cache instead of an outage when every rung fails', async () => {
		let fail = false;
		vi.stubGlobal('fetch', vi.fn(async () => {
			if (fail) throw new Error('down');
			return birdeyeResponse(BIRDEYE_ROWS);
		}));
		const { getTrendingSlim } = await freshModule();
		await getTrendingSlim(3); // warm the cache

		fail = true;
		vi.useFakeTimers();
		try {
			// Past the 30s TTL but inside the 10 min stale window.
			vi.setSystemTime(Date.now() + 60_000);
			const { data, stale } = await getTrendingSlim(24);
			expect(stale).toBe(true);
			expect(data).toHaveLength(BIRDEYE_ROWS);
		} finally {
			vi.useRealTimers();
		}
	});
});
