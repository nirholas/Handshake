// Datapoint fabric — the registry behind /api/x402/d/<family>/<id>/<metric>.
//
// The Market Data API's category endpoints sell whole payloads; this fabric
// sells SINGLE datapoints. Every (family, id, metric) triple is its own
// individually addressable, individually priced x402 endpoint:
//
//   /api/x402/d/coin/bitcoin/price          → { value: 64346, unit: 'usd', … }
//   /api/x402/d/protocol/lido/tvl
//   /api/x402/d/pool/747c1d2a-…-296708a3dd90/apy
//   /api/x402/d/global/btc-dominance
//
// Families × live catalog sizes × metrics ≈ 400,000+ standalone endpoints
// (~17.5k coins × 20 metrics, ~15k pools × 7, ~6k protocols × 6, plus chains,
// stablecoins, exchanges, and the no-id global/gas/fear-greed families) — all
// served by ONE dynamic route (api/x402/d/[...path].js) reading this registry.
// Ids are supplied at runtime by the caller; nothing here hardcodes a specific
// third-party asset.
//
// Sources reuse the same cached builders the category endpoints and /markets
// pages run on. Where a category builder slices for page rendering (top-100
// protocols/chains/stablecoins), the fabric keeps its own slim FULL-set cache
// of the identical upstream feed so every id is addressable, not just the
// leaderboard.
//
// Error contract (same as ../fetch.js — enforced pre-settle, buyer never
// charged): unknown family/metric → 404 at the route (no 402 issued for a
// resource that cannot exist); malformed id → 422; unknown id → 404; upstream
// outage → 503.

import { fetchGlobalMarket } from '../market-fallbacks.js';
import { isPlausibleCoinId } from '../coingecko.js';
import { buildCoinDetail, MINT_RE } from '../../coin/detail.js';
import { buildExchanges } from '../../coin/exchanges.js';
import { fetchFearGreed } from '../../coin/global.js';
import { buildGasReport } from '../../coin/gas.js';
import { loadYieldPools } from '../../defi/yields.js';

const fail = (status, code, message) => {
	throw Object.assign(new Error(message), { status, code });
};

const finite = (n) => (Number.isFinite(n) ? n : null);

// ── Full-set caches (feeds the category builders slice for page rendering) ──

const TTL_MS = 600_000;
const _full = new Map(); // key → { value, expiresAt }

async function fullSet(key, url, slim) {
	const now = Date.now();
	const hit = _full.get(key);
	if (hit && hit.expiresAt > now) return hit.value;
	const resp = await fetch(url, {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(15_000),
	});
	if (!resp.ok) throw new Error(`${key} upstream ${resp.status}`);
	const value = slim(await resp.json());
	_full.set(key, { value, expiresAt: now + TTL_MS });
	return value;
}

// slug → slim protocol row, over the FULL ~6k-protocol DeFiLlama feed.
// Exported (with the other full-set accessors) for the free enumerator at
// /api/x402/d, which pages through the same cached id space.
export function allProtocols() {
	return fullSet('protocols', 'https://api.llama.fi/protocols', (raw) => {
		if (!Array.isArray(raw)) throw new Error('unexpected upstream shape');
		const bySlug = new Map();
		for (const p of raw) {
			if (typeof p?.slug !== 'string' || !p.slug) continue;
			bySlug.set(p.slug, {
				name: typeof p.name === 'string' ? p.name : p.slug,
				category: typeof p.category === 'string' ? p.category : null,
				tvl: finite(Number(p.tvl)),
				change_1d: finite(Number(p.change_1d)),
				change_7d: finite(Number(p.change_7d)),
				mcap: finite(Number(p.mcap)),
				chain_count: Array.isArray(p.chains) ? p.chains.length : 0,
			});
		}
		return bySlug;
	});
}

// lowercase chain name → slim row + whole-market total for share-pct.
export function allChains() {
	return fullSet('chains', 'https://api.llama.fi/v2/chains', (raw) => {
		if (!Array.isArray(raw)) throw new Error('unexpected upstream shape');
		const byName = new Map();
		let totalTvl = 0;
		for (const c of raw) {
			const tvl = Number(c?.tvl);
			if (typeof c?.name !== 'string' || !Number.isFinite(tvl)) continue;
			totalTvl += Math.max(0, tvl);
			byName.set(c.name.toLowerCase(), {
				name: c.name,
				tvl,
				token_symbol: typeof c.tokenSymbol === 'string' && c.tokenSymbol ? c.tokenSymbol : null,
			});
		}
		for (const row of byName.values()) {
			row.share_pct = totalTvl > 0 ? (Math.max(0, row.tvl) / totalTvl) * 100 : 0;
		}
		return byName;
	});
}

// id AND lowercase symbol → slim stablecoin row, over the full pegged set.
export function allStablecoins() {
	return fullSet(
		'stablecoins',
		'https://stablecoins.llama.fi/stablecoins?includePrices=true',
		(body) => {
			const assets = Array.isArray(body?.peggedAssets) ? body.peggedAssets : null;
			if (!assets) throw new Error('unexpected upstream shape');
			const byKey = new Map();
			for (const a of assets) {
				const pegType = typeof a?.pegType === 'string' ? a.pegType : null;
				const circulating = pegType && a.circulating ? Number(a.circulating[pegType]) : NaN;
				if (!Number.isFinite(circulating)) continue;
				const price = Number(a.price);
				const row = {
					name: typeof a.name === 'string' ? a.name : 'Unknown',
					symbol: typeof a.symbol === 'string' ? a.symbol : '',
					price: Number.isFinite(price) ? price : null,
					peg_type: pegType,
					peg_mechanism: typeof a.pegMechanism === 'string' ? a.pegMechanism : null,
					circulating: circulating,
					chain_count: Array.isArray(a.chains) ? a.chains.length : 0,
				};
				if (a.id != null) byKey.set(String(a.id), row);
				if (row.symbol) byKey.set(row.symbol.toLowerCase(), row);
			}
			return byKey;
		},
	);
}

// ── Row resolvers (throw 404 for an unknown id, 503 for an outage) ──────────

async function resolve(label, id, lookup) {
	let row;
	try {
		row = await lookup();
	} catch (err) {
		if (err?.status && err.status < 500) throw err;
		fail(503, 'data_unavailable', `live ${label} data is temporarily unavailable — retry shortly`);
	}
	if (row == null) fail(404, 'not_found', `no ${label} found for "${id}"`);
	return row;
}

// ── The registry ────────────────────────────────────────────────────────────
//
// Each family: { idKind, describeId, validateId(id) → 422 on garbage,
// row(id) → the object metrics extract from, metrics: { slug → {label, unit,
// extract} }, count() → approximate live id count for the enumerator }.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const m = (label, unit, extract) => ({ label, unit, extract });

export const DATAPOINT_FAMILIES = {
	coin: {
		describeId: 'CoinGecko coin id (e.g. a lowercase slug) or a base58 Solana mint',
		validateId(id) {
			if (!isPlausibleCoinId(id) && !MINT_RE.test(id)) {
				fail(422, 'invalid_id', 'id must be a CoinGecko coin id (lowercase slug) or a base58 Solana mint');
			}
		},
		async row(id) {
			const contract = MINT_RE.test(id) && !isPlausibleCoinId(id) ? id : '';
			return resolve('coin', id, async () => {
				try {
					const { coin } = await buildCoinDetail(contract ? { contract } : { id });
					return coin;
				} catch (err) {
					if (err?.status === 404) return null;
					throw err;
				}
			});
		},
		approxCount: 17_000,
		metrics: {
			price: m('Spot price', 'usd', (c) => num(c.market?.price)),
			'market-cap': m('Market capitalization', 'usd', (c) => num(c.market?.market_cap)),
			fdv: m('Fully diluted valuation', 'usd', (c) => num(c.market?.fdv)),
			'volume-24h': m('24h trading volume', 'usd', (c) => num(c.market?.volume_24h)),
			'change-24h': m('24h price change', 'pct', (c) => num(c.market?.change_pct?.h24)),
			'change-7d': m('7-day price change', 'pct', (c) => num(c.market?.change_pct?.d7)),
			'change-30d': m('30-day price change', 'pct', (c) => num(c.market?.change_pct?.d30)),
			'change-1y': m('1-year price change', 'pct', (c) => num(c.market?.change_pct?.y1)),
			rank: m('Market-cap rank', 'rank', (c) => num(c.rank)),
			ath: m('All-time-high price', 'usd', (c) => num(c.market?.ath)),
			'ath-change': m('Drawdown from all-time high', 'pct', (c) => num(c.market?.ath_change_pct)),
			atl: m('All-time-low price', 'usd', (c) => num(c.market?.atl)),
			'high-24h': m('24h high', 'usd', (c) => num(c.market?.high_24h)),
			'low-24h': m('24h low', 'usd', (c) => num(c.market?.low_24h)),
			'circulating-supply': m('Circulating supply', 'tokens', (c) => num(c.market?.circulating)),
			'total-supply': m('Total supply', 'tokens', (c) => num(c.market?.total)),
			'max-supply': m('Max supply', 'tokens', (c) => num(c.market?.max)),
			'mcap-fdv-ratio': m('Market-cap / FDV ratio', 'ratio', (c) => num(c.market?.mcap_fdv_ratio)),
			'sentiment-up': m('Bullish sentiment votes', 'pct', (c) => num(c.sentiment?.up_pct)),
			'watchlist-users': m('Watchlist portfolio users', 'count', (c) => num(c.sentiment?.watchlist_users)),
		},
	},

	protocol: {
		describeId: 'DeFiLlama protocol slug (e.g. a lowercase-hyphen name)',
		validateId(id) {
			if (!/^[a-z0-9-]{1,100}$/.test(id)) {
				fail(422, 'invalid_id', 'id must be a DeFiLlama protocol slug (lowercase, hyphens)');
			}
		},
		row: (id) => resolve('protocol', id, async () => (await allProtocols()).get(id) ?? null),
		approxCount: 6_000,
		metrics: {
			tvl: m('Total value locked', 'usd', (p) => p.tvl),
			'change-1d': m('1-day TVL change', 'pct', (p) => p.change_1d),
			'change-7d': m('7-day TVL change', 'pct', (p) => p.change_7d),
			mcap: m('Token market cap', 'usd', (p) => p.mcap),
			category: m('Protocol category', 'text', (p) => p.category),
			'chain-count': m('Deployed chain count', 'count', (p) => p.chain_count),
		},
	},

	chain: {
		describeId: 'chain name as DeFiLlama spells it (case-insensitive)',
		validateId(id) {
			if (!/^[a-z0-9 ._-]{1,60}$/i.test(id)) {
				fail(422, 'invalid_id', 'id must be a chain name (letters, digits, spaces, dots, hyphens)');
			}
		},
		row: (id) => resolve('chain', id, async () => (await allChains()).get(id.toLowerCase()) ?? null),
		approxCount: 350,
		metrics: {
			tvl: m('DeFi total value locked', 'usd', (c) => finite(c.tvl)),
			'share-pct': m('Share of all-chain TVL', 'pct', (c) => finite(c.share_pct)),
			'token-symbol': m('Native token symbol', 'text', (c) => c.token_symbol),
		},
	},

	pool: {
		describeId: 'DeFiLlama yield-pool uuid',
		validateId(id) {
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
				fail(422, 'invalid_id', 'id must be a DeFiLlama pool uuid');
			}
		},
		row: (id) =>
			resolve('yield pool', id, async () => {
				const { pools } = await loadYieldPools();
				const key = id.toLowerCase();
				return pools.find((p) => p.pool.toLowerCase() === key) ?? null;
			}),
		approxCount: 15_000,
		metrics: {
			apy: m('Current APY', 'pct', (p) => p.apy),
			'apy-base': m('Base APY (fee-derived)', 'pct', (p) => p.apy_base),
			'apy-reward': m('Reward APY (incentives)', 'pct', (p) => p.apy_reward),
			'apy-mean-30d': m('30-day mean APY', 'pct', (p) => p.apy_mean_30d),
			tvl: m('Pool TVL', 'usd', (p) => finite(p.tvl_usd)),
			'il-risk': m('Impermanent-loss risk', 'text', (p) => p.il_risk),
			outlook: m('Predicted APY outlook', 'text', (p) => p.outlook),
		},
	},

	stablecoin: {
		describeId: 'DeFiLlama stablecoin id (numeric) or its symbol',
		validateId(id) {
			if (!/^[a-z0-9$+._-]{1,30}$/i.test(id)) {
				fail(422, 'invalid_id', 'id must be a DeFiLlama stablecoin id or symbol');
			}
		},
		row: (id) =>
			resolve('stablecoin', id, async () => {
				const set = await allStablecoins();
				return set.get(id) ?? set.get(id.toLowerCase()) ?? null;
			}),
		approxCount: 400,
		metrics: {
			supply: m('Circulating supply (peg units)', 'peg-units', (s) => finite(s.circulating)),
			price: m('Current price', 'usd', (s) => s.price),
			'peg-deviation-bps': m('Deviation from $1 peg', 'bps', (s) =>
				s.price == null ? null : Math.round((s.price - 1) * 10_000),
			),
			'peg-mechanism': m('Peg mechanism', 'text', (s) => s.peg_mechanism),
			'chain-count': m('Deployed chain count', 'count', (s) => s.chain_count),
		},
	},

	exchange: {
		describeId: 'CoinGecko exchange id (e.g. a lowercase slug)',
		validateId(id) {
			if (!/^[a-z0-9_-]{1,60}$/.test(id)) {
				fail(422, 'invalid_id', 'id must be a CoinGecko exchange id (lowercase slug)');
			}
		},
		row: (id) =>
			resolve('exchange', id, async () => {
				const { exchanges } = await buildExchanges();
				return exchanges.find((e) => e.id === id) ?? null;
			}),
		approxCount: 100,
		metrics: {
			'volume-24h': m('24h volume', 'usd', (e) => e.volume_24h_usd),
			'volume-24h-btc': m('24h volume', 'btc', (e) => e.volume_24h_btc),
			'trust-score': m('Trust score (0–10)', 'score', (e) => e.trust_score),
			'trust-rank': m('Trust-score rank', 'rank', (e) => e.trust_score_rank),
			country: m('Registered country', 'text', (e) => e.country),
		},
	},

	global: {
		describeId: null, // no id segment — /api/x402/d/global/<metric>
		row: () => resolve('global market', 'global', () => fetchGlobalMarket()),
		approxCount: 1,
		metrics: {
			'market-cap': m('Total crypto market cap', 'usd', (g) => num(g.market_cap_usd)),
			'volume-24h': m('Total 24h volume', 'usd', (g) => num(g.volume_24h_usd)),
			'market-cap-change-24h': m('24h market-cap change', 'pct', (g) => num(g.market_cap_change_pct_24h)),
			'active-coins': m('Active tracked coins', 'count', (g) => num(g.active_coins)),
			'btc-dominance': m('BTC dominance', 'pct', (g) => num(g.dominance?.[0]?.pct)),
			'eth-dominance': m('ETH dominance', 'pct', (g) => num(g.dominance?.[1]?.pct)),
		},
	},

	'fear-greed': {
		describeId: null,
		row: () => resolve('fear & greed', 'fear-greed', () => fetchFearGreed()),
		approxCount: 1,
		metrics: {
			index: m('Fear & Greed index (0–100)', 'index', (f) => num(f.value)),
			label: m('Fear & Greed classification', 'text', (f) => f.label),
		},
	},

	gas: {
		describeId: null,
		row: () => resolve('gas', 'gas', () => buildGasReport()),
		approxCount: 1,
		metrics: {
			slow: m('Slow tier gas price', 'gwei', (g) => finite(g.tiers?.[0]?.gas_price_gwei)),
			standard: m('Standard tier gas price', 'gwei', (g) => finite(g.tiers?.[1]?.gas_price_gwei)),
			fast: m('Fast tier gas price', 'gwei', (g) => finite(g.tiers?.[2]?.gas_price_gwei)),
			'base-fee': m('Current base fee', 'gwei', (g) => finite(g.base_fee_gwei)),
			'eth-price': m('ETH spot price', 'usd', (g) => g.eth_price_usd),
		},
	},
};

// $0.0005 USDC per datapoint by default — half the category-call price, since
// a datapoint is one scalar. Ops override per family: X402_PRICE_DATAPOINT_<FAMILY>.
export const DATAPOINT_DEFAULT_ATOMICS = '500';

// ── Path parsing ─────────────────────────────────────────────────────────────
//
// /api/x402/d/<family>/<id>/<metric> for id families,
// /api/x402/d/<family>/<metric> for the no-id families.
// Returns { family, familyDef, id, metric, metricDef } or throws
// { status: 404 } for a shape that cannot exist / { status: 422 } for a
// malformed id — both BEFORE any 402 is issued, so nobody is asked to pay for
// a resource that does not exist.

export function parseDatapointPath(segments) {
	const [familySlug, ...rest] = segments;
	const familyDef = DATAPOINT_FAMILIES[familySlug];
	if (!familyDef) {
		fail(404, 'unknown_family', `unknown datapoint family "${familySlug}" — GET /api/x402/d for the catalog`);
	}
	const needsId = familyDef.describeId != null;
	const expected = needsId ? 2 : 1;
	if (rest.length !== expected) {
		fail(
			404,
			'bad_path',
			needsId
				? `expected /api/x402/d/${familySlug}/<id>/<metric>`
				: `expected /api/x402/d/${familySlug}/<metric>`,
		);
	}
	const id = needsId ? decodeURIComponent(rest[0]) : null;
	const metric = rest[needsId ? 1 : 0];
	const metricDef = familyDef.metrics[metric];
	if (!metricDef) {
		fail(
			404,
			'unknown_metric',
			`unknown metric "${metric}" for ${familySlug} — valid: ${Object.keys(familyDef.metrics).join(', ')}`,
		);
	}
	if (needsId) familyDef.validateId(id);
	return { family: familySlug, familyDef, id, metric, metricDef };
}

// Fetch + extract one datapoint. The paid handler's whole job.
export async function readDatapoint({ family, familyDef, id, metric, metricDef }) {
	const row = await familyDef.row(id);
	const value = metricDef.extract(row);
	return {
		family,
		...(id != null ? { id } : {}),
		metric,
		label: metricDef.label,
		unit: metricDef.unit,
		value: value === undefined ? null : value,
		as_of: new Date().toISOString(),
		source: 'three.ws market-data',
	};
}

// Storefront description for one (family, metric) datapoint listing — shared
// by the live 402 (api/x402/d/[...path].js) and the discovery-doc entries
// (api/wk.js) so the two surfaces can never drift.
export function datapointDescription({ family, metric, priceAtomics }) {
	const familyDef = DATAPOINT_FAMILIES[family];
	const metricDef = familyDef.metrics[metric];
	const price = (Number(priceAtomics) / 1_000_000)
		.toFixed(4)
		.replace(/0+$/, '')
		.replace(/\.$/, '');
	const idPart = familyDef.describeId
		? ` Pass the ${familyDef.describeId} as the path id — supplied at runtime by the caller.`
		: '';
	return (
		`Single datapoint: ${metricDef.label.toLowerCase()} for one ${family} — ` +
		`pay $${price} USDC per call and get back one machine-readable value ` +
		`(unit: ${metricDef.unit}) with a timestamp.${idPart} ` +
		`Part of the three.ws datapoint fabric — 400,000+ addressable endpoints, cataloged free at /api/x402/d.`
	);
}

// Approximate count of addressable datapoint endpoints, for the enumerator.
export function datapointEndpointCount() {
	let total = 0;
	for (const def of Object.values(DATAPOINT_FAMILIES)) {
		total += def.approxCount * Object.keys(def.metrics).length;
	}
	return total;
}
