/**
 * Per-coin failover (CoinPaprika + DefiLlama) — unit tests.
 *
 * /api/coin/detail, /tickers and /ohlc were single-source CoinGecko, so a
 * throttle on its shared keyless tier 502'd the whole /coin/:id page at once
 * (production, 2026-07-28). api/_lib/coin-fallbacks.js is the second source.
 *
 * The contract these tests pin:
 *   - id resolution is STRICT: a wrong-coin match would serve one coin's market
 *     cap under another's name, which is worse than an error;
 *   - each normalizer emits the exact shape its CoinGecko-backed endpoint
 *     already emits, so the page renders identically either way;
 *   - fields a backup cannot supply are null, never invented — with the one
 *     exception of circulating supply, which is recovered exactly (not
 *     estimated) from market cap ÷ price.
 *
 * Fixtures are trimmed captures of the real live APIs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	slugify,
	paprikaEntryMatches,
	pickPaprikaId,
	resolvePaprikaId,
	resetPaprikaIdMemo,
	normalizePaprikaDetail,
	normalizePaprikaMarket,
	normalizeLlamaChart,
	fetchLlamaChart,
	fetchFallbackTickers,
} from '../api/_lib/coin-fallbacks.js';

const jsonResponse = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ── Fixtures (trimmed captures of the live APIs, 2026-07-29) ────────────────

const PAPRIKA_COIN = {
	id: 'sol-solana',
	name: 'Solana',
	symbol: 'SOL',
	rank: 7,
	logo: 'https://static.coinpaprika.com/coin/sol-solana/logo.png',
	tags: [{ id: 'smart-contracts', name: 'Smart Contracts' }],
	description: 'Solana (SOL) is a high-performance blockchain platform.',
	started_at: '2020-04-10T00:00:00Z',
	hash_algorithm: 'Tower BFT',
	links: {
		explorer: ['https://explorer.solana.com', 'https://solanabeach.io'],
		reddit: ['https://reddit.com/r/solana'],
		source_code: ['https://github.com/solana-labs/'],
		website: ['https://solana.com'],
	},
	links_extended: [
		{ url: 'https://reddit.com/r/solana', type: 'reddit', stats: { subscribers: 170050 } },
		{ url: 'https://twitter.com/solana', type: 'twitter', stats: { followers: 2219988 } },
		{ url: 'https://t.me/solanaio', type: 'telegram', stats: { members: 3178 } },
	],
	whitepaper: { link: 'https://static.coinpaprika.com/storage/cdn/whitepapers/10608577.pdf' },
};

const PAPRIKA_TICKER = {
	id: 'sol-solana',
	name: 'Solana',
	symbol: 'SOL',
	rank: 7,
	total_supply: 630740924,
	max_supply: 0,
	last_updated: '2026-07-29T04:59:24Z',
	quotes: {
		USD: {
			price: 73.2833885475882,
			volume_24h: 1324964016.32,
			market_cap: 42465636552,
			market_cap_change_24h: 0.11,
			percent_change_1h: -0.05,
			percent_change_24h: 0.07,
			percent_change_7d: -2.1,
			percent_change_30d: 4.5,
			percent_change_1y: -12.3,
			ath_price: 294.1631972172844,
			ath_date: '2025-01-19T08:50:00Z',
			percent_from_price_ath: -75.09,
		},
	},
};

const PAPRIKA_MARKET = {
	exchange_id: 'binance',
	exchange_name: 'Binance',
	pair: 'SOL/USDT',
	base_currency_id: 'sol-solana',
	quote_currency_id: 'usdt-tether',
	market_url: 'https://www.binance.com/en/trade/SOL_USDT',
	category: 'Spot',
	outlier: false,
	quotes: { USD: { price: 73.33, volume_24h: 117752997.98 } },
	trust_score: 'high',
	last_updated: '2026-07-29T04:59:24Z',
};

// ── id resolution ───────────────────────────────────────────────────────────

describe('CoinGecko id → CoinPaprika id', () => {
	it('slugifies names to CoinGecko-style ids', () => {
		expect(slugify('Bitcoin')).toBe('bitcoin');
		expect(slugify('Wrapped Solana (Universal)')).toBe('wrapped-solana-universal');
		expect(slugify('  Yearn.Finance  ')).toBe('yearn-finance');
	});

	it('matches on the paprika id slug half', () => {
		expect(paprikaEntryMatches({ id: 'sol-solana', name: 'Solana' }, 'solana')).toBe(true);
		expect(paprikaEntryMatches({ id: 'btc-bitcoin', name: 'Bitcoin' }, 'bitcoin')).toBe(true);
	});

	it('matches on the slugified name when the id slug differs', () => {
		expect(paprikaEntryMatches({ id: 'uni-uniswap-protocol', name: 'Uniswap' }, 'uniswap')).toBe(true);
	});

	it('rejects a near-miss rather than serving the wrong coin', () => {
		// The exact hazard: a search for "solana" also returns these.
		expect(paprikaEntryMatches({ id: 'usol-wrapped-solana-universal', name: 'Wrapped Solana (Universal)' }, 'solana')).toBe(false);
		expect(paprikaEntryMatches({ id: 'summer-solana-summer', name: 'Solana Summer' }, 'solana')).toBe(false);
		expect(paprikaEntryMatches({ id: '', name: 'Solana' }, 'solana')).toBe(false);
		expect(paprikaEntryMatches({ id: 'sol-solana' }, '')).toBe(false);
	});

	it('prefers the active, best-ranked strict match', () => {
		const raw = {
			currencies: [
				{ id: 'sol-solana-dead', name: 'Solana', rank: 3, is_active: false },
				{ id: 'sol-solana', name: 'Solana', rank: 7, is_active: true },
				{ id: 'xxx-solana', name: 'Solana', rank: 0, is_active: true },
			],
		};
		expect(pickPaprikaId(raw, 'solana')).toBe('sol-solana');
	});

	it('returns null when nothing matches strictly', () => {
		expect(pickPaprikaId({ currencies: [{ id: 'usol-wrapped-solana-universal', name: 'Wrapped Solana' }] }, 'solana')).toBeNull();
		expect(pickPaprikaId({}, 'solana')).toBeNull();
	});
});

describe('resolvePaprikaId', () => {
	beforeEach(() => resetPaprikaIdMemo());
	afterEach(() => vi.unstubAllGlobals());

	it('resolves once and memoizes, so an outage does not re-search per request', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ currencies: [{ id: 'sol-solana', name: 'Solana', rank: 7 }] }));
		vi.stubGlobal('fetch', fetchMock);
		expect(await resolvePaprikaId('solana')).toBe('sol-solana');
		expect(await resolvePaprikaId('solana')).toBe('sol-solana');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('does not cache a negative when CoinPaprika itself is unreachable', async () => {
		let attempt = 0;
		vi.stubGlobal('fetch', vi.fn(async () => {
			attempt += 1;
			if (attempt === 1) throw new Error('network down');
			return jsonResponse({ currencies: [{ id: 'btc-bitcoin', name: 'Bitcoin', rank: 1 }] });
		}));
		expect(await resolvePaprikaId('bitcoin')).toBeNull();
		// A cached miss here would outlive the outage and keep the fallback dark.
		expect(await resolvePaprikaId('bitcoin')).toBe('btc-bitcoin');
	});
});

// ── coin profile ────────────────────────────────────────────────────────────

describe('normalizePaprikaDetail', () => {
	it('emits the /api/coin/detail shape with the CoinGecko id preserved', () => {
		const out = normalizePaprikaDetail(PAPRIKA_COIN, PAPRIKA_TICKER, 'solana');
		expect(out.id).toBe('solana'); // page links key off this, not the paprika id
		expect(out.symbol).toBe('SOL');
		expect(out.name).toBe('Solana');
		expect(out.rank).toBe(7);
		expect(out.image).toBe(PAPRIKA_COIN.logo);
		expect(out.categories).toEqual(['Smart Contracts']);
		expect(out.market.price).toBeCloseTo(73.2833885, 5);
		expect(out.market.market_cap).toBe(42465636552);
		expect(out.market.change_pct.h24).toBe(0.07);
		expect(out.market.change_pct.d7).toBe(-2.1);
		expect(out.market.ath).toBeCloseTo(294.163, 2);
		expect(out.meta.genesis_date).toBe('2020-04-10');
		expect(out.meta.hashing_algorithm).toBe('Tower BFT');
		expect(out.last_updated).toBe('2026-07-29T04:59:24Z');
	});

	it('recovers circulating supply exactly from market cap ÷ price', () => {
		const out = normalizePaprikaDetail(PAPRIKA_COIN, PAPRIKA_TICKER, 'solana');
		expect(out.market.circulating).toBeCloseTo(42465636552 / 73.2833885475882, 6);
	});

	it('reads 0 max_supply as "no cap", not a supply of zero', () => {
		const out = normalizePaprikaDetail(PAPRIKA_COIN, PAPRIKA_TICKER, 'solana');
		expect(out.market.max).toBeNull();
		expect(out.market.total).toBe(630740924);
	});

	it('leaves fields this source cannot supply null rather than inventing them', () => {
		const out = normalizePaprikaDetail(PAPRIKA_COIN, PAPRIKA_TICKER, 'solana');
		expect(out.market.fdv).toBeNull();
		expect(out.market.high_24h).toBeNull();
		expect(out.market.change_pct.d14).toBeNull();
		expect(out.developer).toBeNull();
		expect(out.sentiment).toEqual({ up_pct: null, down_pct: null, watchlist_users: null });
		expect(out.platforms).toEqual({});
	});

	it('extracts social handles and community stats from links_extended', () => {
		const out = normalizePaprikaDetail(PAPRIKA_COIN, PAPRIKA_TICKER, 'solana');
		expect(out.links.twitter).toBe('solana');
		expect(out.links.telegram).toBe('solanaio');
		expect(out.links.homepage).toBe('https://solana.com');
		expect(out.links.github).toBe('https://github.com/solana-labs/');
		expect(out.links.whitepaper).toBe(PAPRIKA_COIN.whitepaper.link);
		expect(out.links.explorers).toHaveLength(2);
		expect(out.community).toEqual({
			twitter_followers: 2219988,
			reddit_subscribers: 170050,
			telegram_users: 3178,
		});
	});

	it('collapses an all-empty community block to null so the section hides', () => {
		const out = normalizePaprikaDetail({ ...PAPRIKA_COIN, links_extended: [] }, PAPRIKA_TICKER, 'solana');
		expect(out.community).toBeNull();
	});

	it('is a miss (null) without a headline price, so the caller keeps looking', () => {
		expect(normalizePaprikaDetail(PAPRIKA_COIN, { quotes: { USD: {} } }, 'solana')).toBeNull();
		expect(normalizePaprikaDetail(PAPRIKA_COIN, {}, 'solana')).toBeNull();
		expect(normalizePaprikaDetail(null, PAPRIKA_TICKER, 'solana')).toBeNull();
	});
});

// ── exchange listings ───────────────────────────────────────────────────────

describe('normalizePaprikaMarket', () => {
	it('emits the /api/coin/tickers row shape', () => {
		const out = normalizePaprikaMarket(PAPRIKA_MARKET);
		expect(out.exchange).toEqual({ id: 'binance', name: 'Binance', logo: null });
		expect(out.base).toBe('SOL');
		expect(out.target).toBe('USDT');
		expect(out.pair).toBe('SOL/USDT');
		expect(out.price_usd).toBe(73.33);
		expect(out.volume_usd).toBe(117752997.98);
		expect(out.trade_url).toBe(PAPRIKA_MARKET.market_url);
		expect(out.spread_pct).toBeNull();
		expect(out.depth_up_usd).toBeNull();
	});

	it('maps trust grades to the badge vocabulary the table renders', () => {
		expect(normalizePaprikaMarket({ ...PAPRIKA_MARKET, trust_score: 'high' }).trust).toBe('green');
		expect(normalizePaprikaMarket({ ...PAPRIKA_MARKET, trust_score: 'medium' }).trust).toBe('yellow');
		expect(normalizePaprikaMarket({ ...PAPRIKA_MARKET, trust_score: 'low' }).trust).toBe('red');
		expect(normalizePaprikaMarket({ ...PAPRIKA_MARKET, trust_score: 'unknown' }).trust).toBeNull();
	});

	it('flags an outlier market as stale and drops a non-http trade url', () => {
		const out = normalizePaprikaMarket({ ...PAPRIKA_MARKET, outlier: true, market_url: 'javascript:alert(1)' });
		expect(out.stale).toBe(true);
		expect(out.trade_url).toBeNull();
	});
});

describe('fetchFallbackTickers', () => {
	beforeEach(() => resetPaprikaIdMemo());
	afterEach(() => vi.unstubAllGlobals());

	const stub = (markets) =>
		vi.stubGlobal('fetch', vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('/search/')) return jsonResponse({ currencies: [{ id: 'sol-solana', name: 'Solana', rank: 7 }] });
			if (u.includes('/markets')) return jsonResponse(markets);
			throw new Error(`unexpected ${u}`);
		}));

	it('keeps spot markets only and orders them by 24h volume', async () => {
		stub([
			{ ...PAPRIKA_MARKET, exchange_name: 'Small Spot', quotes: { USD: { price: 73, volume_24h: 10 } } },
			{ ...PAPRIKA_MARKET, exchange_name: 'Perp Venue', category: 'Derivatives', quotes: { USD: { price: 73, volume_24h: 9_000_000 } } },
			{ ...PAPRIKA_MARKET, exchange_name: 'Big Spot', quotes: { USD: { price: 73, volume_24h: 500 } } },
		]);
		const rows = await fetchFallbackTickers('solana');
		expect(rows.map((r) => r.exchange.name)).toEqual(['Big Spot', 'Small Spot']);
	});

	it('paginates in 100-row pages like the endpoint it stands in for', async () => {
		stub(
			Array.from({ length: 250 }, (_, i) => ({
				...PAPRIKA_MARKET,
				exchange_name: `Venue ${i}`,
				quotes: { USD: { price: 73, volume_24h: 1000 - i } },
			})),
		);
		expect(await fetchFallbackTickers('solana', { page: 1 })).toHaveLength(100);
		const page3 = await fetchFallbackTickers('solana', { page: 3 });
		expect(page3).toHaveLength(50);
		expect(page3[0].exchange.name).toBe('Venue 200');
	});

	it('returns null when CoinPaprika does not list the coin', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ currencies: [] })));
		expect(await fetchFallbackTickers('not-a-real-coin')).toBeNull();
	});
});

// ── price series ────────────────────────────────────────────────────────────

describe('DefiLlama chart fallback', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('normalizes to [[timestamp_ms, price], …] oldest-first', () => {
		const out = normalizeLlamaChart(
			{
				coins: {
					'coingecko:solana': {
						symbol: 'SOL',
						prices: [
							{ timestamp: 1785225291, price: 73.13 },
							{ timestamp: 1785214500, price: 73.15 },
						],
					},
				},
			},
			'solana',
		);
		expect(out).toEqual([
			[1785214500000, 73.15],
			[1785225291000, 73.13],
		]);
	});

	it('drops non-positive prices and treats a lone point as no data', () => {
		const raw = (prices) => ({ coins: { 'coingecko:x': { prices } } });
		expect(normalizeLlamaChart(raw([{ timestamp: 1, price: 5 }, { timestamp: 2, price: 0 }]), 'x')).toBeNull();
		expect(normalizeLlamaChart(raw([]), 'x')).toBeNull();
		expect(normalizeLlamaChart({ coins: {} }, 'x')).toBeNull();
	});

	it('requests the window granularity the chart expects and never throws', async () => {
		const urls = [];
		vi.stubGlobal('fetch', vi.fn(async (url) => {
			urls.push(String(url));
			return jsonResponse({
				coins: { 'coingecko:solana': { prices: [{ timestamp: 100, price: 1 }, { timestamp: 200, price: 2 }] } },
			});
		}));
		const now = 1_785_000_000_000;
		await fetchLlamaChart('solana', 1, now);
		await fetchLlamaChart('solana', 365, now);
		expect(urls[0]).toContain('period=15m');
		expect(urls[0]).toContain('span=96');
		expect(urls[0]).toContain(`start=${Math.floor(now / 1000) - 86_400}`);
		expect(urls[1]).toContain('period=1d');
		expect(urls[1]).toContain('span=365');
	});

	it('resolves null (not a throw) on an unsupported window or a dead upstream', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
		expect(await fetchLlamaChart('solana', 42)).toBeNull();
		expect(await fetchLlamaChart('solana', 30)).toBeNull();
		expect(await fetchLlamaChart('', 30)).toBeNull();
	});
});
