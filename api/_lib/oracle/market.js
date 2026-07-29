// Oracle — live market intel aggregator for one coin.
//
// Oracle's conviction store (store.js/sources.js) answers "should I trust this
// launch" from the platform's own on-chain brain. It deliberately holds NO live
// market data — no price, market cap, liquidity, holder count, bonding-curve
// progress or security posture. This module fills that gap: it fans out to every
// public market source we have a key (or keyless access) for, in parallel, and
// fuses them into one fully-populated `CoinMarket` shape so the Oracle coin page
// can render every field a trader expects.
//
// Sources (all real, no mocks), each isolated so one being down/rate-limited
// degrades that slice to null instead of failing the whole read:
//   · DexScreener  (keyless) — price, 5m/1h/6h/24h changes + txns + volume,
//                              liquidity, FDV, market cap, DEX pairs, image, socials
//   · pump.fun v3  (keyless) — bonding-curve progress, SOL reserves, replies,
//                              live-status, ATH market cap, creator, socials
//   · GeckoTerminal(keyless) — total supply, FDV, graduation %, CoinGecko id
//   · GoPlus       (keyless) — mint/freeze authority, mutable metadata, transfer
//                              fee, holder count + top-10 concentration
//   · Birdeye      (keyed)   — holders + circulating supply + price (redundancy)
//   · CoinGecko    (keyed)   — ATH/ATL, market-cap rank, categories (listed coins)
//
// Merge precedence favors the richest/most-specific source per field; every
// number traces to a live upstream. Cached L1 (per-instance) + L2 (Upstash) so a
// coin page poll almost never fans out to six upstreams.

import { cacheGet, cacheSet } from '../cache.js';
import { createCache } from '../mem-cache.js';
import { bondingProgressPct } from '../pump-bonding.js';

const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens';
const PUMP_V3 = 'https://frontend-api-v3.pump.fun';
const GECKOTERMINAL = 'https://api.geckoterminal.com/api/v2/networks/solana/tokens';
const GOPLUS = 'https://api.gopluslabs.io/api/v1/solana/token_security';
const BIRDEYE = 'https://public-api.birdeye.so';
const COINGECKO = 'https://api.coingecko.com/api/v3';

const FETCH_TIMEOUT_MS = 6000;
const WSOL = 'So11111111111111111111111111111111111111112';

// True LRU bounding: the previous Map was trimmed with
// `delete(keys().next().value)`, evicting the oldest INSERTED key rather than
// the least recently used one.
const L1 = createCache({ max: 256 }); // key -> { value, expires }
const L1_TTL_MS = 20_000;
const L2_TTL_S = 45;

const num = (v) => {
	if (v == null) return null;
	const n = typeof v === 'string' ? parseFloat(v) : Number(v);
	return Number.isFinite(n) ? n : null;
};
const clampPct = (n) => (n == null ? null : Math.max(0, Math.min(100, n)));

async function fetchJson(url, opts = {}) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
	try {
		const r = await fetch(url, { ...opts, signal: ctrl.signal });
		if (!r.ok) throw new Error(String(r.status));
		return await r.json();
	} finally {
		clearTimeout(timer);
	}
}

// ── per-source adapters (each returns a partial CoinMarket or null) ───────────

async function fromDexScreener(mint) {
	const data = await fetchJson(`${DEXSCREENER}/${mint}`);
	const pairs = Array.isArray(data?.pairs) ? data.pairs.filter((p) => p.chainId === 'solana') : [];
	if (!pairs.length) return null;
	// Deepest-liquidity pair is the canonical market for price/volume/change.
	const best = pairs.reduce((a, b) => ((b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a));
	const price = num(best.priceUsd);
	const info = best.info || {};
	const socials = Array.isArray(info.socials) ? info.socials : [];
	const websites = Array.isArray(info.websites) ? info.websites : [];
	const twitter = socials.find((s) => /twitter|^x$/i.test(s.type))?.url || null;
	const telegram = socials.find((s) => /telegram/i.test(s.type))?.url || null;
	return {
		sources: ['dexscreener'],
		identity: {
			name: best.baseToken?.name || null,
			symbol: best.baseToken?.symbol || null,
			image: info.imageUrl || null,
		},
		price_usd: price,
		price_native: num(best.priceNative),
		change: {
			m5: num(best.priceChange?.m5),
			h1: num(best.priceChange?.h1),
			h6: num(best.priceChange?.h6),
			h24: num(best.priceChange?.h24),
		},
		volume: {
			m5: num(best.volume?.m5),
			h1: num(best.volume?.h1),
			h6: num(best.volume?.h6),
			h24: num(best.volume?.h24),
		},
		txns: best.txns || null,
		liquidity_usd: num(best.liquidity?.usd),
		market_cap_usd: num(best.marketCap),
		fdv_usd: num(best.fdv),
		pair_created_at: num(best.pairCreatedAt),
		links: { website: websites[0]?.url || null, twitter, telegram },
		pairs: pairs
			.slice()
			.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
			.slice(0, 6)
			.map((p) => ({
				dex: p.dexId || null,
				pair_address: p.pairAddress || null,
				url: p.url || null,
				quote_symbol: p.quoteToken?.symbol || null,
				price_usd: num(p.priceUsd),
				liquidity_usd: num(p.liquidity?.usd),
				volume_h24: num(p.volume?.h24),
			})),
	};
}

async function fromPumpFun(mint) {
	const d = await fetchJson(`${PUMP_V3}/coins-v2/${mint}`, { headers: { accept: 'application/json' } });
	if (!d || !d.mint) return null;
	const complete = Boolean(d.complete);
	// Graduation progress: 100 once complete; otherwise the share of the curve's
	// initial token float that's been bought out (shared curve math — pump-bonding.js).
	const bondingPct = complete ? 100 : bondingProgressPct(d.real_token_reserves);
	return {
		sources: ['pumpfun'],
		identity: {
			name: d.name || null,
			symbol: d.symbol || null,
			image: d.image_uri || null,
			description: d.description || null,
		},
		links: {
			website: d.website || null,
			twitter: d.twitter || null,
			telegram: d.telegram || null,
		},
		creator: d.creator || null,
		created_at: d.created_timestamp ? new Date(Number(d.created_timestamp)).toISOString() : null,
		supply_total: num(d.total_supply) != null ? num(d.total_supply) / 1e6 : null,
		pumpfun: {
			is_pump: true,
			complete,
			graduated: complete,
			bonding_curve_pct: bondingPct,
			real_sol_reserves: num(d.real_sol_reserves) != null ? num(d.real_sol_reserves) / 1e9 : null,
			virtual_sol_reserves: num(d.virtual_sol_reserves) != null ? num(d.virtual_sol_reserves) / 1e9 : null,
			reply_count: num(d.reply_count),
			is_live: Boolean(d.is_currently_live),
			nsfw: Boolean(d.nsfw),
			is_banned: Boolean(d.is_banned),
			ath_market_cap_usd: num(d.ath_market_cap),
			ath_market_cap_at: d.ath_market_cap_timestamp ? new Date(Number(d.ath_market_cap_timestamp)).toISOString() : null,
			king_of_the_hill_at: d.king_of_the_hill_timestamp ? new Date(Number(d.king_of_the_hill_timestamp)).toISOString() : null,
			last_trade_at: d.last_trade_timestamp ? new Date(Number(d.last_trade_timestamp)).toISOString() : null,
			pump_swap_pool: d.pump_swap_pool || null,
			quote_mint: d.quote_mint || null,
		},
	};
}

async function fromGeckoTerminal(mint) {
	const data = await fetchJson(`${GECKOTERMINAL}/${mint}`, { headers: { accept: 'application/json' } });
	const a = data?.data?.attributes;
	if (!a) return null;
	const decimals = num(a.decimals) ?? 6;
	const lp = a.launchpad_details || {};
	return {
		sources: ['geckoterminal'],
		identity: { name: a.name || null, symbol: a.symbol || null, image: a.image_url || null, decimals },
		price_usd: num(a.price_usd),
		market_cap_usd: num(a.market_cap_usd) ?? num(a.fdv_usd),
		fdv_usd: num(a.fdv_usd),
		volume: { h24: num(a.volume_usd?.h24) },
		liquidity_usd: num(a.total_reserve_in_usd),
		supply_total: num(a.normalized_total_supply),
		coingecko_id: a.coingecko_coin_id || null,
		pumpfun: lp && Object.keys(lp).length
			? { graduation_pct: clampPct(num(lp.graduation_percentage)), complete: Boolean(lp.completed) }
			: undefined,
	};
}

function goplusAuthorityRevoked(field) {
	// GoPlus encodes an authority-controlled risk as status "1" (present/active).
	// "0" = the authority is renounced/absent, i.e. the safe state.
	if (!field || field.status == null) return null;
	return String(field.status) === '0';
}

async function fromGoPlus(mint) {
	const data = await fetchJson(`${GOPLUS}?contract_addresses=${mint}`, { headers: { accept: 'application/json' } });
	const r = data?.result?.[mint];
	if (!r) return null;
	const holders = Array.isArray(r.holders) ? r.holders : [];
	// Holders are returned already ranked; sum their share for a top-10 read.
	const top10Pct = holders.length
		? clampPct(holders.slice(0, 10).reduce((s, h) => s + (num(h.percent) || 0) * 100, 0))
		: null;
	const fee = r.transfer_fee && typeof r.transfer_fee === 'object' ? num(r.transfer_fee.fee_rate ?? r.transfer_fee.rate) : null;
	return {
		sources: ['goplus'],
		holders: num(r.holder_count),
		supply_total: num(r.total_supply),
		security: {
			mint_authority_revoked: goplusAuthorityRevoked(r.mintable),
			freeze_authority_revoked: goplusAuthorityRevoked(r.freezable),
			metadata_mutable: r.metadata_mutable?.status != null ? String(r.metadata_mutable.status) === '1' : null,
			transfer_fee_pct: fee != null ? fee * 100 : (r.transfer_fee && Object.keys(r.transfer_fee).length ? null : 0),
			transfer_hook: r.transfer_hook?.status != null ? String(r.transfer_hook.status) === '1' : null,
			non_transferable: r.non_transferable != null ? String(r.non_transferable) === '1' : null,
			trusted_token: r.trusted_token != null ? String(r.trusted_token) === '1' : null,
			top10_holder_pct: top10Pct,
			source: 'goplus',
		},
		top_holders: holders.slice(0, 10).map((h) => ({
			account: h.account || null,
			pct: num(h.percent) != null ? num(h.percent) * 100 : null,
			is_locked: Boolean(h.is_locked),
			tag: h.tag || null,
		})),
	};
}

async function fromBirdeye(mint) {
	const key = process.env.BIRDEYE_API_KEY;
	if (!key) return null;
	const data = await fetchJson(`${BIRDEYE}/defi/token_overview?address=${mint}`, {
		headers: { 'X-API-KEY': key, 'x-chain': 'solana', accept: 'application/json' },
	});
	const ov = data?.data;
	if (!ov) return null;
	return {
		sources: ['birdeye'],
		price_usd: num(ov.price),
		change: { h24: num(ov.priceChange24hPercent) },
		market_cap_usd: num(ov.mc ?? ov.marketCap),
		fdv_usd: num(ov.fdv),
		volume: { h24: num(ov.v24hUSD ?? ov.volume24h) },
		liquidity_usd: num(ov.liquidity),
		holders: num(ov.holder),
		supply_total: num(ov.supply),
		supply_circulating: num(ov.circulatingSupply),
	};
}

// CoinGecko only knows *listed* tokens — most fresh pump.fun coins 404 here.
// We only call it when GeckoTerminal handed us a coingecko id (proof it's
// listed), so we never burn quota on unlisted mints. Adds the "real market"
// fields nothing else has: ATH/ATL, market-cap rank, categories.
async function fromCoinGecko(coingeckoId) {
	if (!coingeckoId) return null;
	const key = process.env.COINGECKO_API_KEY;
	const headers = { accept: 'application/json' };
	if (key) headers['x-cg-demo-api-key'] = key;
	const d = await fetchJson(
		`${COINGECKO}/coins/${encodeURIComponent(coingeckoId)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`,
		{ headers },
	);
	const md = d?.market_data;
	if (!md) return null;
	return {
		sources: ['coingecko'],
		listing: {
			coingecko_id: d.id || coingeckoId,
			market_cap_rank: num(d.market_cap_rank),
			categories: Array.isArray(d.categories) ? d.categories.filter(Boolean).slice(0, 6) : [],
			ath_usd: num(md.ath?.usd),
			ath_date: md.ath_date?.usd || null,
			ath_change_pct: num(md.ath_change_percentage?.usd),
			atl_usd: num(md.atl?.usd),
			atl_date: md.atl_date?.usd || null,
			atl_change_pct: num(md.atl_change_percentage?.usd),
			circulating_supply: num(md.circulating_supply),
			total_supply: num(md.total_supply),
			max_supply: num(md.max_supply),
			change_7d: num(md.price_change_percentage_7d),
			change_30d: num(md.price_change_percentage_30d),
		},
	};
}

// ── merge ─────────────────────────────────────────────────────────────────────

// First non-null across the given partials for a dotted path. Sources are passed
// in precedence order so the richest source wins each field.
function pick(partials, path) {
	const keys = path.split('.');
	for (const p of partials) {
		if (!p) continue;
		let v = p;
		for (const k of keys) v = v == null ? undefined : v[k];
		if (v != null) return v;
	}
	return null;
}

/**
 * Fuse the per-source partials into one fully-populated CoinMarket. Pure given
 * its inputs (no network / clock) so it can be unit-tested against fixtures.
 *
 * @param {string} mint
 * @param {string} network
 * @param {{dex?:object,pump?:object,gecko?:object,goplus?:object,birdeye?:object,coingecko?:object}} p
 * @param {string} fetchedAt ISO timestamp (injected so the merge stays pure)
 */
export function mergeMarketSources(mint, network, p, fetchedAt) {
	const { dex, pump, gecko, goplus, birdeye, coingecko } = p;
	// Precedence chains per field family (richest/most-specific first).
	const idOrder = [pump, dex, gecko, birdeye];
	const priceOrder = [dex, birdeye, gecko];
	const mcOrder = [dex, gecko, birdeye];
	const liqOrder = [dex, gecko, birdeye];
	const supplyOrder = [gecko, birdeye, pump, goplus];

	const sources = [...new Set([dex, pump, gecko, goplus, birdeye, coingecko].filter(Boolean).flatMap((s) => s.sources || []))];

	// pump.fun graduation truth: prefer the explicit flag, fall back to Gecko's %.
	const pf = pump?.pumpfun || {};
	const graduationPct = pf.bonding_curve_pct ?? gecko?.pumpfun?.graduation_pct ?? null;
	const pumpfun = pump?.pumpfun
		? { ...pf, bonding_curve_pct: graduationPct }
		: (gecko?.pumpfun ? { is_pump: /pump$/.test(mint), ...gecko.pumpfun, bonding_curve_pct: graduationPct } : (/pump$/.test(mint) ? { is_pump: true, bonding_curve_pct: graduationPct } : null));

	// DexScreener's socials are curated (project handle); pump.fun's `twitter`
	// is often the launch-tweet URL — so prefer Dex for links, pump as fallback.
	const linkOrder = [dex, pump, gecko, birdeye];
	const links = {
		website: pick(linkOrder, 'links.website'),
		twitter: pick(linkOrder, 'links.twitter'),
		telegram: pick(linkOrder, 'links.telegram'),
		dexscreener: dex?.pairs?.[0]?.url || `https://dexscreener.com/solana/${mint}`,
		geckoterminal: `https://www.geckoterminal.com/solana/pools/${mint}`,
		birdeye: `https://birdeye.so/token/${mint}?chain=solana`,
		solscan: `https://solscan.io/token/${mint}`,
		pumpfun: `https://pump.fun/coin/${mint}`,
	};

	const priceUsd = num(pick(priceOrder, 'price_usd'));
	const holders = num(pick([goplus, birdeye], 'holders'));

	return {
		mint,
		network,
		fetched_at: fetchedAt,
		sources,
		identity: {
			name: pick(idOrder, 'identity.name'),
			symbol: pick(idOrder, 'identity.symbol'),
			image: pick(idOrder, 'identity.image'),
			description: pick([pump, gecko], 'identity.description'),
			decimals: num(pick([gecko, birdeye], 'identity.decimals')) ?? 6,
			creator: pump?.creator || null,
			created_at: pump?.created_at || (dex?.pair_created_at ? new Date(dex.pair_created_at).toISOString() : null),
		},
		price: {
			usd: priceUsd,
			native_sol: num(dex?.price_native),
			change: {
				m5: num(pick([dex], 'change.m5')),
				h1: num(pick([dex], 'change.h1')),
				h6: num(pick([dex], 'change.h6')),
				h24: num(pick([dex, birdeye], 'change.h24')),
				d7: num(coingecko?.listing?.change_7d),
				d30: num(coingecko?.listing?.change_30d),
			},
		},
		market_cap_usd: num(pick(mcOrder, 'market_cap_usd')),
		fdv_usd: num(pick([dex, gecko, birdeye], 'fdv_usd')),
		liquidity_usd: num(pick(liqOrder, 'liquidity_usd')),
		volume: {
			m5: num(dex?.volume?.m5),
			h1: num(dex?.volume?.h1),
			h6: num(dex?.volume?.h6),
			h24: num(pick([dex, gecko, birdeye], 'volume.h24')),
		},
		activity: activityFrom(dex?.txns),
		holders,
		supply: {
			total: num(pick(supplyOrder, 'supply_total')),
			circulating: num(pick([birdeye, coingecko], 'supply_circulating')) ?? num(coingecko?.listing?.circulating_supply),
			decimals: num(pick([gecko, birdeye], 'identity.decimals')) ?? 6,
		},
		pumpfun,
		security: goplus?.security || null,
		top_holders: goplus?.top_holders || [],
		listing: coingecko?.listing || (gecko?.coingecko_id ? { coingecko_id: gecko.coingecko_id } : null),
		pairs: dex?.pairs || [],
		links,
	};
}

// Roll the per-window DexScreener txn counts into 24h buy/sell totals + a ratio.
function activityFrom(txns) {
	if (!txns || typeof txns !== 'object') return null;
	const h24 = txns.h24 || {};
	const buys = num(h24.buys);
	const sells = num(h24.sells);
	const total = (buys || 0) + (sells || 0);
	return {
		windows: txns,
		buys_24h: buys,
		sells_24h: sells,
		txns_24h: total || null,
		buy_ratio: total ? (buys || 0) / total : null,
	};
}

/**
 * Fully-populated live market intel for one mint, fused across every source.
 * L1 (per-instance) + L2 (Upstash) cached; returns null only when every source
 * is simultaneously unavailable and no price could be established.
 *
 * @param {string} mint
 * @param {string} network
 * @param {{ fresh?: boolean }} [opts]
 */
export async function fetchCoinMarket(mint, network = 'mainnet', { fresh = false } = {}) {
	const key = `oracle:mkt:v1:${network}:${mint}`;
	const now = Date.now();
	if (!fresh) {
		const l1 = L1.get(mint);
		if (l1 && l1.expires > now) return l1.value;
		try {
			const l2 = await cacheGet(key);
			if (l2 && l2.price?.usd != null) {
				L1.set(mint, { value: l2, expires: now + L1_TTL_MS });
				return l2;
			}
		} catch { /* fall through to live fetch */ }
	}

	// Stage 1: every keyless/keyed source that resolves from the mint alone.
	const [dex, pump, gecko, goplus, birdeye] = await Promise.all([
		fromDexScreener(mint).catch(() => null),
		network === 'mainnet' ? fromPumpFun(mint).catch(() => null) : Promise.resolve(null),
		fromGeckoTerminal(mint).catch(() => null),
		network === 'mainnet' ? fromGoPlus(mint).catch(() => null) : Promise.resolve(null),
		fromBirdeye(mint).catch(() => null),
	]);

	// Every upstream missed and we have no price — a true "no market" answer.
	if (!dex && !pump && !gecko && !goplus && !birdeye) return null;

	// Stage 2: CoinGecko, but only for coins Gecko proved are listed (has an id).
	const coingecko = gecko?.coingecko_id
		? await fromCoinGecko(gecko.coingecko_id).catch(() => null)
		: null;

	const merged = mergeMarketSources(mint, network, { dex, pump, gecko, goplus, birdeye, coingecko }, new Date().toISOString());

	// Only cache a read that actually established a live price — never memoize a
	// hollow all-null result that a transient outage produced.
	if (merged.price?.usd != null) {
		L1.set(mint, { value: merged, expires: now + L1_TTL_MS });
		cacheSet(key, merged, L2_TTL_S).catch(() => {});
	}
	return merged;
}

/** Test seam — clear the per-instance cache between cases. */
export function __resetCoinMarketCache() {
	L1.clear();
}

export { WSOL };
