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
// Families × live catalog sizes × metrics ≈ 1,000,000+ standalone endpoints
// (~17.5k coins × 20 metrics, ~15k pools × 7, ~6k protocols × 6, per-contract
// token market + security for any Solana mint / EVM address, plus chains,
// stablecoins, exchanges, categories, DEXs, fees/revenue, derivative venues, and
// the no-id global/gas/fear-greed families) — all served by ONE dynamic route
// (api/x402/d/[...path].js) reading this registry.
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
import { buildCategories } from '../../coin/categories.js';
import { buildDexVolumes } from '../../defi/dex-volumes.js';
import { buildFees } from '../../defi/fees.js';
import { buildDerivativeExchanges } from '../../coin/derivatives.js';
import { composeTokenSnapshot } from '../crypto-token-snapshot.js';
import { composeTokenSecurity } from '../crypto-token-security.js';
import { isResolvableAddress, chainOf } from '../token-market.js';
import { isValidSolanaAddress } from '../validate.js';

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

// slug/id → row, over any of our own list-returning builders (categories, DEX
// volumes, fees/revenue, derivative venues). These builders already cache their
// own upstream fetch; we memoize the id→row map on top so a per-id lookup is a
// Map.get, not a linear scan of the whole list on every datapoint call.
const _listMaps = new Map(); // key → { value: Map, expiresAt }

async function listMap(key, builder, toEntries) {
	const now = Date.now();
	const hit = _listMaps.get(key);
	if (hit && hit.expiresAt > now) return hit.value;
	const built = await builder();
	const map = new Map();
	for (const [k, row] of toEntries(built)) {
		if (typeof k === 'string' && k) map.set(k, row);
	}
	_listMaps.set(key, { value: map, expiresAt: now + TTL_MS });
	return map;
}

// The full DeFiLlama category list keyed by CoinGecko category id.
export function allCategories() {
	return listMap('categories', buildCategories, ({ categories }) =>
		(Array.isArray(categories) ? categories : []).map((c) => [c.id, c]),
	);
}

// Top-100 DEXs keyed by DeFiLlama protocol slug.
export function allDexes() {
	return listMap('dexes', buildDexVolumes, ({ protocols }) =>
		(Array.isArray(protocols) ? protocols : [])
			.filter((p) => p.slug)
			.map((p) => [p.slug, p]),
	);
}

// Top protocols keyed by slug, merging the fees and revenue series into one row
// so a single id exposes both fees-* and revenue-* metrics.
export function allFees() {
	return listMap(
		'fees',
		async () => {
			const [fees, revenue] = await Promise.all([buildFees('fees'), buildFees('revenue')]);
			const bySlug = new Map();
			for (const p of fees.protocols || []) {
				if (p.slug) bySlug.set(p.slug, { name: p.name, category: p.category, fees: p, revenue: null });
			}
			for (const p of revenue.protocols || []) {
				if (!p.slug) continue;
				const row = bySlug.get(p.slug);
				if (row) row.revenue = p;
				else bySlug.set(p.slug, { name: p.name, category: p.category, fees: null, revenue: p });
			}
			return bySlug;
		},
		(bySlug) => bySlug.entries(),
	);
}

// Derivative (perp) venues keyed by CoinGecko exchange id.
export function allDerivativeExchanges() {
	return listMap('derivative-exchanges', buildDerivativeExchanges, ({ exchanges }) =>
		(Array.isArray(exchanges) ? exchanges : []).map((e) => [e.id, e]),
	);
}

// ── Per-address compose memo (token / token-security families) ───────────────
//
// composeTokenSnapshot / composeTokenSecurity each fan out to several upstreams
// per call. An agent that walks all metrics of one mint would otherwise repeat
// that fan-out per metric; a short per-address memo collapses it to one.
const COMPOSE_TTL_MS = 60_000;
const COMPOSE_CACHE_MAX = 500;
const _composeMemo = new Map(); // `${kind}:${address}` → { value, expiresAt }

async function composeMemo(kind, address, compose) {
	const key = `${kind}:${address}`;
	const now = Date.now();
	const hit = _composeMemo.get(key);
	if (hit && hit.expiresAt > now) return hit.value;
	const result = await compose();
	if (_composeMemo.size >= COMPOSE_CACHE_MAX) {
		// Evict the oldest ~10% to bound memory without a full LRU.
		let drop = Math.ceil(COMPOSE_CACHE_MAX / 10);
		for (const k of _composeMemo.keys()) {
			_composeMemo.delete(k);
			if (--drop <= 0) break;
		}
	}
	_composeMemo.set(key, { value: result, expiresAt: now + COMPOSE_TTL_MS });
	return result;
}

// Map a compose-style result ({status:'ok'|'not_found'|'upstream_down'}) onto
// the resolver contract: ok → the row, not_found → null (404), down → 503.
function fromCompose(label, id, result, pick) {
	if (result.status === 'upstream_down') {
		fail(503, 'data_unavailable', `live ${label} data is temporarily unavailable — retry shortly`);
	}
	if (result.status !== 'ok') return null;
	return pick(result);
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

	token: {
		// The coin family resolves CoinGecko-listed assets; this one resolves ANY
		// on-chain token by contract address — DexScreener + pump.fun + Helius, keyless
		// where possible — so freshly launched mints with no CoinGecko id are addressable.
		describeId: 'token contract address — a base58 Solana mint or an EVM 0x address',
		validateId(id) {
			if (!isResolvableAddress(id)) {
				fail(422, 'invalid_id', 'id must be a Solana mint or EVM 0x contract address');
			}
		},
		row: (id) =>
			resolve('token', id, async () => {
				const chain = chainOf(id) === 'evm' ? null : 'solana';
				const result = await composeMemo('snapshot', id, () =>
					composeTokenSnapshot({ address: id, chain: chain === 'solana' ? null : chain }),
				);
				return fromCompose('token', id, result, (r) => r.snapshot);
			}),
		approxCount: 40_000, // unbounded in practice — any indexed contract resolves
		metrics: {
			price: m('Spot price', 'usd', (s) => num(s.priceUsd)),
			'change-24h': m('24h price change', 'pct', (s) => num(s.change24h)),
			'market-cap': m('Market capitalization', 'usd', (s) => num(s.marketCapUsd)),
			fdv: m('Fully diluted valuation', 'usd', (s) => num(s.fdvUsd)),
			liquidity: m('Pooled DEX liquidity', 'usd', (s) => num(s.liquidityUsd)),
			'volume-24h': m('24h trading volume', 'usd', (s) => num(s.volume24hUsd)),
			name: m('Token name', 'text', (s) => s.name ?? null),
			symbol: m('Token symbol', 'text', (s) => s.symbol ?? null),
			chain: m('Host chain', 'text', (s) => s.chain ?? null),
			dex: m('Deepest-liquidity DEX', 'text', (s) => s.dexId ?? null),
		},
	},

	'token-security': {
		// Rug-lever safety checks for one Solana mint — mint/freeze authority,
		// metadata mutability, holder concentration, liquidity depth, risk verdict.
		describeId: 'base58 Solana mint address',
		validateId(id) {
			if (!isValidSolanaAddress(id)) {
				fail(422, 'invalid_id', 'id must be a base58 Solana mint address');
			}
		},
		row: (id) =>
			resolve('token security', id, async () => {
				const result = await composeMemo('security', id, () => composeTokenSecurity({ address: id }));
				return fromCompose('token security', id, result, (r) => r);
			}),
		approxCount: 40_000, // unbounded — any Solana mint
		metrics: {
			'risk-level': m('Overall risk verdict', 'text', (r) => r.riskLevel),
			'mint-authority-revoked': m('Mint authority revoked', 'bool', (r) => r.checks.mintAuthorityRevoked),
			'freeze-authority-revoked': m('Freeze authority revoked', 'bool', (r) => r.checks.freezeAuthorityRevoked),
			'metadata-mutable': m('Metadata still mutable', 'bool', (r) => r.checks.metadataMutable),
			'liquidity-usd': m('Pooled liquidity', 'usd', (r) => num(r.checks.liquidityUsd)),
			'holders-concentrated': m('Top-holder concentration flag', 'bool', (r) => r.checks.topHolderPctFlag),
		},
	},

	category: {
		describeId: 'CoinGecko category id (e.g. a lowercase-hyphen sector slug)',
		validateId(id) {
			if (!/^[a-z0-9-]{1,80}$/.test(id)) {
				fail(422, 'invalid_id', 'id must be a CoinGecko category id (lowercase, hyphens)');
			}
		},
		row: (id) => resolve('category', id, async () => (await allCategories()).get(id) ?? null),
		approxCount: 300,
		metrics: {
			'market-cap': m('Sector market cap', 'usd', (c) => num(c.market_cap)),
			'market-cap-change-24h': m('24h sector market-cap change', 'pct', (c) => num(c.market_cap_change_24h)),
			'volume-24h': m('24h sector volume', 'usd', (c) => num(c.volume_24h)),
		},
	},

	dex: {
		describeId: 'DeFiLlama DEX slug (e.g. a lowercase-hyphen protocol key)',
		validateId(id) {
			if (!/^[a-z0-9.-]{1,100}$/.test(id)) {
				fail(422, 'invalid_id', 'id must be a DeFiLlama DEX slug (lowercase, hyphens)');
			}
		},
		row: (id) => resolve('DEX', id, async () => (await allDexes()).get(id) ?? null),
		approxCount: 100,
		metrics: {
			'volume-24h': m('24h trading volume', 'usd', (d) => finite(d.total24h)),
			'volume-7d': m('7-day trading volume', 'usd', (d) => finite(d.total7d)),
			'change-7d': m('7d-over-prior-7d volume change', 'pct', (d) => finite(d.change_7d)),
			'share-pct': m('Share of all-DEX volume', 'pct', (d) => finite(d.share_pct)),
		},
	},

	fees: {
		describeId: 'DeFiLlama protocol slug (e.g. a lowercase-hyphen name)',
		validateId(id) {
			if (!/^[a-z0-9-]{1,100}$/.test(id)) {
				fail(422, 'invalid_id', 'id must be a DeFiLlama protocol slug (lowercase, hyphens)');
			}
		},
		row: (id) => resolve('fees', id, async () => (await allFees()).get(id) ?? null),
		approxCount: 150,
		metrics: {
			'fees-24h': m('24h fees paid by users', 'usd', (r) => finite(r.fees?.total24h)),
			'fees-7d': m('7-day fees', 'usd', (r) => finite(r.fees?.total7d)),
			'fees-30d': m('30-day fees', 'usd', (r) => finite(r.fees?.total30d)),
			'revenue-24h': m('24h protocol revenue', 'usd', (r) => finite(r.revenue?.total24h)),
			'revenue-7d': m('7-day protocol revenue', 'usd', (r) => finite(r.revenue?.total7d)),
			'revenue-30d': m('30-day protocol revenue', 'usd', (r) => finite(r.revenue?.total30d)),
		},
	},

	'derivative-exchange': {
		describeId: 'CoinGecko derivatives exchange id (e.g. a lowercase slug)',
		validateId(id) {
			if (!/^[a-z0-9_-]{1,60}$/.test(id)) {
				fail(422, 'invalid_id', 'id must be a CoinGecko derivatives exchange id');
			}
		},
		row: (id) => resolve('derivatives exchange', id, async () => (await allDerivativeExchanges()).get(id) ?? null),
		approxCount: 50,
		metrics: {
			'open-interest-btc': m('Open interest', 'btc', (e) => num(e.open_interest_btc)),
			'volume-24h-btc': m('24h trade volume', 'btc', (e) => num(e.trade_volume_24h_btc)),
			'perpetual-pairs': m('Listed perpetual pairs', 'count', (e) => num(e.perpetual_pairs)),
			'futures-pairs': m('Listed futures pairs', 'count', (e) => num(e.futures_pairs)),
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
		`Part of the three.ws datapoint fabric — 1,000,000+ addressable endpoints, cataloged free at /api/x402/d.`
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
