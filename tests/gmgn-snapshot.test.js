/**
 * gmgnSmartMoneySnapshot backs the JSON lane of /api/agents/gmgn: the same live
 * smart-money board the SSE lane streams, read one-shot. Pinned here: the
 * minSmartBuys floor, the limit cap, the normalized item shape, and the two
 * degraded paths (Cloudflare 403 failing over to DexScreener, and a dead upstream
 * reporting ok:false instead of throwing).
 *
 * fetch is stubbed at the network boundary so the test exercises the real
 * failover and normalization code without depending on a third party being up.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { gmgnSmartMoneySnapshot } from '../api/_lib/gmgn-feed.js';

// $THREE, the only coin this platform references.
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

function jsonResponse(body, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('gmgnSmartMoneySnapshot', () => {
	it('returns normalized items above the smart-buy floor (main path)', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({
			data: {
				rank: [
					{ address: THREE, symbol: 'THREE', name: 'three.ws', price: 0.5, market_cap: 1000, smart_buy_24h: 7 },
					{ address: 'QuietMint1111111111111111111111111111111111', symbol: 'QUIET', smart_buy_24h: 1 },
				],
			},
		}));

		const snap = await gmgnSmartMoneySnapshot({ minSmartBuys: 2 });
		expect(snap.ok).toBe(true);
		expect(snap.source).toBe('gmgn');
		expect(snap.items).toHaveLength(1);
		expect(snap.items[0]).toMatchObject({
			address: THREE,
			symbol: 'THREE',
			smart_buy_24h: 7,
			// A one-shot read has no prior snapshot, so the whole count is the delta.
			smart_buy_delta: 7,
			is_new: true,
			chain: 'sol',
			interval: '1h',
			source: 'gmgn',
		});
	});

	it('caps the result at the requested limit', async () => {
		const rank = Array.from({ length: 10 }, (_, i) => ({
			address: `Mint${i}1111111111111111111111111111111111111`,
			symbol: `M${i}`,
			smart_buy_24h: 5,
		}));
		globalThis.fetch = vi.fn(async () => jsonResponse({ data: { rank } }));

		const snap = await gmgnSmartMoneySnapshot({ limit: 3 });
		expect(snap.items).toHaveLength(3);
	});

	it('skips entries with no address', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({
			data: { rank: [{ symbol: 'GHOST', smart_buy_24h: 99 }] },
		}));

		const snap = await gmgnSmartMoneySnapshot();
		expect(snap.ok).toBe(true);
		expect(snap.items).toEqual([]);
	});

	it('reports ok:false when every upstream is down (failure path)', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({}, 500));

		const snap = await gmgnSmartMoneySnapshot();
		expect(snap.ok).toBe(false);
		expect(snap.status).toBe(500);
		expect(snap.items).toEqual([]);
		expect(snap.source).toBe(null);
	});

	it('fails over to the DexScreener board when Cloudflare returns 403', async () => {
		globalThis.fetch = vi.fn(async (url) => {
			if (String(url).includes('gmgn.ai')) return jsonResponse({}, 403);
			if (String(url).includes('token-boosts')) {
				return jsonResponse([{ chainId: 'solana', tokenAddress: THREE, totalAmount: 100 }]);
			}
			return jsonResponse([{
				baseToken: { address: THREE, symbol: 'THREE', name: 'three.ws' },
				priceUsd: '0.5',
				marketCap: 1000,
				volume: { h24: 42 },
				liquidity: { usd: 100 },
				txns: { h1: { buys: 9, sells: 1 } },
			}]);
		});

		const snap = await gmgnSmartMoneySnapshot({ minSmartBuys: 1 });
		expect(snap.ok).toBe(true);
		expect(snap.source).toBe('dexscreener');
		expect(snap.items[0].address).toBe(THREE);
	});
});
