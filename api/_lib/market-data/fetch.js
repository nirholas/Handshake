// Market Data API fetchers — one per registry slug (see ./registry.js).
//
// Each fetcher takes the request's URLSearchParams and returns the JSON body
// the paid endpoint sells. They delegate to the SAME exported builders the
// free /markets pages run on (api/coin/*, api/defi/*) — one implementation,
// two surfaces, zero drift. Builders keep their own in-memory caches, so a
// paid call is usually served warm.
//
// Error contract (enforced by api/_lib/x402-paid-endpoint.js ordering —
// verify → handler → settle — so a failed call never charges the buyer):
//   • invalid params  → throw { status: 422, code: 'invalid_<param>' }
//   • upstream outage → throw { status: 503, code: 'data_unavailable' }

import { fetchGlobalMarket, fetchMarketsTable } from '../market-fallbacks.js';
import { isPlausibleCoinId } from '../coingecko.js';
import { searchCoins } from '../../coin/markets.js';
import { buildCoinDetail, MINT_RE } from '../../coin/detail.js';
import { buildPriceChart, VALID_DAYS } from '../../coin/ohlc.js';
import { buildCategories } from '../../coin/categories.js';
import { buildExchanges } from '../../coin/exchanges.js';
import { buildDerivativeTickers, buildDerivativeExchanges } from '../../coin/derivatives.js';
import { fetchFearGreed } from '../../coin/global.js';
import { buildGasReport } from '../../coin/gas.js';
import { buildTrending } from '../../coin/trending.js';
import { buildProtocols } from '../../defi/protocols.js';
import { buildChains } from '../../defi/chains.js';
import { queryYieldPools, queryYieldChart } from '../../defi/yields.js';
import { buildStablecoins } from '../../defi/stablecoins.js';
import { buildFees } from '../../defi/fees.js';
import { buildDexVolumes } from '../../defi/dex-volumes.js';
import { queryHacks } from '../../defi/hacks.js';

const fail = (status, code, message) => {
	throw Object.assign(new Error(message), { status, code });
};

const invalid = (code, message) => fail(422, code, message);

// Wrap an upstream call so an outage surfaces as a 503 the payment wrapper
// short-circuits BEFORE settling — a paid endpoint never charges for downtime.
// 4xx errors thrown by builders (unknown coin, unknown pool) pass through.
async function upstream(label, fn) {
	try {
		return await fn();
	} catch (err) {
		if (err?.status && err.status < 500) throw err;
		fail(503, 'data_unavailable', `live ${label} data is temporarily unavailable — retry shortly`);
	}
}

function clampInt(raw, { def, min, max }) {
	const n = Number.parseInt(raw ?? '', 10);
	if (!Number.isFinite(n)) return def;
	return Math.max(min, Math.min(max, n));
}

function parseBool(v) {
	if (v == null) return undefined;
	const s = String(v).toLowerCase();
	if (s === 'true' || s === '1') return true;
	if (s === 'false' || s === '0') return false;
	return undefined;
}

export const MARKET_FETCHERS = {
	'market-coins': async (params) => {
		const q = (params.get('q') || '').trim();
		if (q) {
			if (q.length > 64) invalid('invalid_query', 'q must be 64 characters or fewer');
			return upstream('coin search', () => searchCoins(q));
		}
		const category = (params.get('category') || '').trim().toLowerCase();
		if (category && !/^[a-z0-9-]{1,80}$/.test(category)) {
			invalid('invalid_category', 'category must be a CoinGecko category id (lowercase slug)');
		}
		const page = clampInt(params.get('page'), { def: 1, min: 1, max: 20 });
		const perPage = clampInt(params.get('per_page'), { def: 100, min: 10, max: 250 });
		const { rows } = await upstream('coin market', () =>
			fetchMarketsTable({ page, perPage, category }),
		);
		return { coins: rows, page, per_page: perPage, category: category || null };
	},

	'market-coin': async (params) => {
		const contract = (params.get('contract') || '').trim();
		const id = (params.get('id') || '').trim().toLowerCase();
		if (contract && !MINT_RE.test(contract)) {
			invalid('invalid_contract', 'contract must be a base58 Solana address (32–44 chars)');
		}
		if (!contract && !isPlausibleCoinId(id)) {
			invalid('invalid_id', 'id must be a CoinGecko coin id (lowercase slug)');
		}
		try {
			return await buildCoinDetail({ id, contract });
		} catch (err) {
			if (err?.status === 404) fail(404, 'not_found', `no coin found for "${contract || id}"`);
			fail(503, 'data_unavailable', 'live coin data is temporarily unavailable — retry shortly');
		}
	},

	'market-chart': async (params) => {
		const id = (params.get('id') || '').trim().toLowerCase();
		if (!isPlausibleCoinId(id)) {
			invalid('invalid_id', 'id must be a CoinGecko coin id (lowercase slug)');
		}
		const days = Number.parseInt(params.get('days') || '30', 10);
		if (!VALID_DAYS.has(days)) invalid('invalid_days', 'days must be one of 1, 7, 30, 90, 365');
		let payload;
		try {
			payload = await buildPriceChart(id, days);
		} catch (err) {
			if (err?.status === 404) fail(404, 'not_found', `no coin with id "${id}"`);
			fail(503, 'data_unavailable', 'live chart data is temporarily unavailable — retry shortly');
		}
		if (!payload.data.length) {
			fail(503, 'data_unavailable', 'no price history for this coin right now — retry shortly');
		}
		return payload;
	},

	'market-categories': () => upstream('sector', () => buildCategories()),

	'market-exchanges': () => upstream('exchange', () => buildExchanges()),

	'market-derivatives': async (params) => {
		const view = (params.get('view') || '').trim().toLowerCase();
		if (view && view !== 'exchanges') {
			invalid('invalid_view', "view must be 'exchanges' or omitted");
		}
		return upstream('derivatives', () =>
			view === 'exchanges' ? buildDerivativeExchanges() : buildDerivativeTickers(),
		);
	},

	'market-global': async () => {
		const [globalResult, fngResult] = await Promise.allSettled([
			fetchGlobalMarket(),
			fetchFearGreed(),
		]);
		const market = globalResult.status === 'fulfilled' ? globalResult.value : null;
		const fear_greed = fngResult.status === 'fulfilled' ? fngResult.value : null;
		if (!market && !fear_greed) {
			fail(503, 'data_unavailable', 'live global market data is temporarily unavailable — retry shortly');
		}
		return { market, fear_greed };
	},

	'market-gas': () => upstream('gas', () => buildGasReport()),

	'market-trending': () => upstream('trending', () => buildTrending()),

	'market-defi': () => upstream('DeFi protocol', () => buildProtocols()),

	'market-chains': () => upstream('chain TVL', () => buildChains()),

	'market-yields': async (params) => {
		const pool = (params.get('pool') || '').trim();
		if (pool) {
			try {
				return await queryYieldChart(pool);
			} catch (err) {
				if (err?.status === 400) invalid('invalid_pool', err.message);
				if (err?.status === 404) fail(404, 'pool_not_found', err.message);
				fail(503, 'data_unavailable', 'live yield history is temporarily unavailable — retry shortly');
			}
		}
		return upstream('yield pool', () =>
			queryYieldPools({
				chain: (params.get('chain') || '').trim().toLowerCase(),
				project: (params.get('project') || '').trim().toLowerCase(),
				stablecoin: parseBool(params.get('stablecoin')),
				search: (params.get('search') || '').trim().toLowerCase(),
				minTvl: Math.max(0, Number(params.get('minTvl')) || 0),
				sort: params.get('sort') === 'apy' ? 'apy' : 'tvl',
				limit: clampInt(params.get('limit'), { def: 100, min: 1, max: 200 }),
				offset: clampInt(params.get('offset'), { def: 0, min: 0, max: 1_000_000 }),
			}),
		);
	},

	'market-stablecoins': () => upstream('stablecoin', () => buildStablecoins()),

	'market-fees': async (params) => {
		const type = params.get('type') === 'revenue' ? 'revenue' : 'fees';
		return upstream('protocol fee', () => buildFees(type));
	},

	'market-dex-volumes': () => upstream('DEX volume', () => buildDexVolumes()),

	'market-hacks': async (params) => {
		return upstream('exploit', () =>
			queryHacks({
				search: (params.get('search') || '').trim().toLowerCase(),
				limit: clampInt(params.get('limit'), { def: 100, min: 1, max: 200 }),
				offset: clampInt(params.get('offset'), { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER }),
			}),
		);
	},

	// The flagship bundle. Sections resolve independently (allSettled) so one
	// upstream hiccup nulls its section instead of failing the whole call; only
	// a total blackout refuses (and therefore never charges) the buyer.
	'market-pulse': async () => {
		const [global, fng, coins, trending, gas, defi, stables, dex, fees] =
			await Promise.allSettled([
				fetchGlobalMarket(),
				fetchFearGreed(),
				fetchMarketsTable({ page: 1, perPage: 10, category: '' }),
				buildTrending(),
				buildGasReport(),
				buildProtocols(),
				buildStablecoins(),
				buildDexVolumes(),
				buildFees('fees'),
			]);
		const ok = (r) => (r.status === 'fulfilled' ? r.value : null);

		const topCoins = ok(coins)?.rows?.map(({ sparkline, ...row }) => row) ?? null;
		const gasReport = ok(gas);
		const standardTier = gasReport?.tiers?.find((t) => t.key === 'standard') ?? null;
		const defiReport = ok(defi);
		const stableReport = ok(stables);
		const dexReport = ok(dex);
		const feesReport = ok(fees);
		const trendingReport = ok(trending);

		const sections = {
			global: ok(global),
			fear_greed: ok(fng),
			top_coins: topCoins,
			trending: trendingReport
				? { coins: trendingReport.coins.slice(0, 7), categories: trendingReport.categories.slice(0, 5) }
				: null,
			gas: gasReport
				? {
						standard_gwei: standardTier?.gas_price_gwei ?? null,
						base_fee_gwei: gasReport.base_fee_gwei,
						eth_price_usd: gasReport.eth_price_usd,
					}
				: null,
			defi: defiReport
				? {
						total_tvl: defiReport.total_tvl,
						protocol_count: defiReport.protocol_count,
						top_protocols: defiReport.protocols.slice(0, 10).map((p) => ({
							slug: p.slug, name: p.name, category: p.category, tvl: p.tvl, change_7d: p.change_7d,
						})),
					}
				: null,
			stablecoins: stableReport
				? {
						total_mcap: stableReport.total_mcap,
						top: stableReport.stablecoins.slice(0, 5).map((s) => ({
							symbol: s.symbol, name: s.name, price: s.price, circulating_usd: s.circulating_usd,
						})),
					}
				: null,
			dex: dexReport ? { total24h: dexReport.total24h, total7d: dexReport.total7d } : null,
			fees: feesReport ? { total24h: feesReport.total24h, total7d: feesReport.total7d } : null,
		};

		if (Object.values(sections).every((v) => v == null)) {
			fail(503, 'data_unavailable', 'live market data is temporarily unavailable — retry shortly');
		}
		return { ...sections, ts: new Date().toISOString() };
	},
};
