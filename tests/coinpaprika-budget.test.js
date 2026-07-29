/**
 * Shared CoinPaprika client — free-tier budget guard.
 *
 * CoinPaprika's free tier allows SIXTY requests per hour and then blocks the
 * client for an hour with `402 payment_required`. Three surfaces draw on that
 * one budget — the coin-page profile/listings fallback, the global-stats
 * fallback, and the paid x402 market-heatmap endpoint — so the health state has
 * to be process-wide, exactly like the CoinGecko demo-key health next to it.
 *
 * These tests pin the two properties that matter: a spent budget is recognised
 * however it is reported, and once recognised it costs zero further requests
 * anywhere until the block lifts. An ordinary network fault must NOT bench the
 * source, or one blip would take the fallback out for an hour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	PAPRIKA_BASE,
	paprikaGet,
	isPaprikaBenched,
	benchPaprika,
	notePaprikaStatus,
	resetPaprikaHealth,
} from '../api/_lib/coinpaprika.js';

const URL_A = `${PAPRIKA_BASE}/global`;
const jsonResponse = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => resetPaprikaHealth());
afterEach(() => {
	vi.unstubAllGlobals();
	resetPaprikaHealth();
});

describe('budget detection', () => {
	it('benches on a 402 and stops issuing requests', async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ type: 'payment_required', error: 'request limits were reached' }, 402),
		);
		vi.stubGlobal('fetch', fetchMock);
		expect(await paprikaGet(URL_A)).toBeNull();
		expect(isPaprikaBenched()).toBe(true);
		expect(await paprikaGet(URL_A)).toBeNull();
		expect(await paprikaGet(`${PAPRIKA_BASE}/tickers/btc-bitcoin`)).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('benches on a 429 too', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'too many requests' }, 429)));
		await paprikaGet(URL_A);
		expect(isPaprikaBenched()).toBe(true);
	});

	it('recognises the budget reply by its body even on a 200', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ type: 'payment_required' })));
		expect(await paprikaGet(URL_A)).toBeNull();
		expect(isPaprikaBenched()).toBe(true);
	});

	it('notePaprikaStatus reports whether it acted, for callers that fetch themselves', () => {
		expect(notePaprikaStatus(200)).toBe(false);
		expect(isPaprikaBenched()).toBe(false);
		expect(notePaprikaStatus(402)).toBe(true);
		expect(isPaprikaBenched()).toBe(true);
	});
});

describe('what must NOT bench the source', () => {
	it('a network fault is a miss, not a spent budget', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
		expect(await paprikaGet(URL_A)).toBeNull();
		expect(isPaprikaBenched()).toBe(false);
	});

	it('a 404 or 500 is a miss, not a spent budget', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'nope' }, 500)));
		expect(await paprikaGet(URL_A)).toBeNull();
		expect(isPaprikaBenched()).toBe(false);
	});

	it('malformed JSON is a miss, and never throws at the caller', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>nope</html>', { status: 200 })));
		await expect(paprikaGet(URL_A)).resolves.toBeNull();
		expect(isPaprikaBenched()).toBe(false);
	});
});

describe('recovery', () => {
	it('the bench expires so a fresh hour heals with no redeploy', () => {
		const now = Date.now();
		benchPaprika(now);
		expect(isPaprikaBenched(now + 59 * 60_000)).toBe(true);
		expect(isPaprikaBenched(now + 61 * 60_000)).toBe(false);
	});

	it('serves a normal body once the block has lifted', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ market_cap_usd: 123 })));
		expect(await paprikaGet(URL_A)).toEqual({ market_cap_usd: 123 });
	});
});
