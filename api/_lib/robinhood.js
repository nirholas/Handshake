// Shared Robinhood Chain data layer for the three.ws /api/v1/robinhood/* endpoints.
//
// Robinhood Chain is a permissionless Arbitrum Orbit L2 (chain ID 4663, ETH
// gas, ~100ms blocks, mainnet live 2026-07-01). It hosts ~95 tokenized Stock
// Tokens — plain ERC-20s with one Chainlink price feed each — plus a memecoin
// ecosystem (NOXA, The Odyssey launchpads). No third-party aggregator offers a
// clean market-data view of it: GeckoTerminal doesn't index the chain, RWA.xyz
// is enterprise-paid, CoinGecko has no equity semantics. This module is the
// missing layer.
//
// Every read is real:
//   • Chainlink NAV prices           — on-chain multicall (latestRoundData + uiMultiplier)
//   • DEX price / premium / volume    — DexScreener (chainId "robinhood")
//   • holders / token stats / gas     — Blockscout Pro API
//   • chain TVL                       — DefiLlama (/chain/robinhood-chain)
//   • memecoin screener               — CoinGecko categories + DexScreener
//   • launchpad activity              — on-chain eth_getLogs (NOXA / Odyssey factories)
//
// Failover: public RPC → Alchemy (when ROBINHOOD_ALCHEMY_KEY is set). All
// upstreams are wrapped in short-TTL caches so the board never fans out 95 RPC
// calls per request (the Chainlink snapshot is one multicall behind a 20s TTL).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createPublicClient, http } from 'viem';
import { cacheWrap } from './cache.js';

// ── Chain definitions (viem 2.52 predates the official robinhood chain defs) ──
// The installed viem is 2.52.x, whose `viem/chains` does not yet export
// `robinhood`/`robinhoodTestnet` (those land in 2.55+). Until the app bumps
// viem we define the chains inline — the same plain-object shape src/vault.js
// uses for chains viem doesn't ship. Facts verified live on 2026-07-12:
// eth_chainId → 0x1237 (4663), avg block ~101ms, Multicall3 at the canonical
// deterministic address.
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

export const HOOD_MAINNET = {
	id: 4663,
	name: 'Robinhood Chain',
	nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
	rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
	blockExplorers: {
		default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
	},
	contracts: { multicall3: { address: MULTICALL3 } },
	testnet: false,
};

export const HOOD_TESTNET = {
	id: 46630,
	name: 'Robinhood Chain Testnet',
	nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
	rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
	blockExplorers: {
		default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' },
	},
	contracts: { multicall3: { address: MULTICALL3 } },
	testnet: true,
};

export const BLOCKSCOUT_BASE = 'https://robinhoodchain.blockscout.com';
export const USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const FEED_DECIMALS = 8;
export const STOCK_TOKEN_DECIMALS = 18;

// Resolve the best RPC URL: Alchemy when a key is present (recommended paid
// RPC), else the public sequencer RPC. Same env-at-module-load contract every
// other provider on the platform uses.
function rpcUrl(testnet) {
	const key = process.env.ROBINHOOD_ALCHEMY_KEY;
	if (key) {
		return testnet
			? `https://robinhood-testnet.g.alchemy.com/v2/${key}`
			: `https://robinhood-mainnet.g.alchemy.com/v2/${key}`;
	}
	return (testnet ? HOOD_TESTNET : HOOD_MAINNET).rpcUrls.default.http[0];
}

let _clients = { mainnet: null, testnet: null };

/** Cached viem public client for chain 4663 (or 46630 when testnet). */
export function publicClient(testnet = false) {
	const slot = testnet ? 'testnet' : 'mainnet';
	if (_clients[slot]) return _clients[slot];
	const chain = testnet ? HOOD_TESTNET : HOOD_MAINNET;
	_clients[slot] = createPublicClient({
		chain,
		transport: http(rpcUrl(testnet), { batch: true, timeout: 12_000 }),
		batch: { multicall: { wait: 16 } },
	});
	return _clients[slot];
}

// ── Stock Token registry ──────────────────────────────────────────────────
// The 95-token registry generated on-chain during the Wave-1 SDK build (shared
// beacon slot + per-token symbol/name/decimals/uiMultiplier multicall + feed
// latestRoundData). Loaded once at module init.
let _registry = null;
export function stockRegistry() {
	if (_registry) return _registry;
	const file = path.join(process.cwd(), 'data', 'robinhood-stock-tokens.json');
	_registry = JSON.parse(readFileSync(file, 'utf8'));
	return _registry;
}

/** Look up one Stock Token by ticker symbol (case-insensitive). */
export function findStock(symbol) {
	const want = String(symbol || '').trim().toUpperCase();
	if (!want) return null;
	return stockRegistry().tokens.find((t) => t.symbol.toUpperCase() === want) || null;
}

// ── Chainlink feed reads ───────────────────────────────────────────────────
const AGGREGATOR_ABI = [
	{
		type: 'function',
		name: 'latestRoundData',
		stateMutability: 'view',
		inputs: [],
		outputs: [
			{ name: 'roundId', type: 'uint80' },
			{ name: 'answer', type: 'int256' },
			{ name: 'startedAt', type: 'uint256' },
			{ name: 'updatedAt', type: 'uint256' },
			{ name: 'answeredInRound', type: 'uint80' },
		],
	},
];

const ERC8056_ABI = [
	{ type: 'function', name: 'uiMultiplier', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
	{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

/**
 * One multicall over every feed-backed Stock Token → { [address]: { answer,
 * updatedAt, uiMultiplier, totalSupply } }. Chainlink answers on Robinhood
 * Chain are 8-decimal and ALREADY multiplier-adjusted — never re-apply
 * uiMultiplier to a feed price (it's returned only for raw-balance math).
 * Cached 20s so the stocks board is one round-trip, not ~130 eth_calls.
 */
export async function chainlinkSnapshot() {
	return cacheWrap('rh:chainlink:snapshot:v1', 20, async () => {
		const client = publicClient(false);
		const reg = stockRegistry();
		const feedTokens = reg.tokens.filter((t) => t.feed);

		const priceCalls = feedTokens.map((t) => ({
			address: t.feed,
			abi: AGGREGATOR_ABI,
			functionName: 'latestRoundData',
		}));
		const multiplierCalls = feedTokens.map((t) => ({
			address: t.address,
			abi: ERC8056_ABI,
			functionName: 'uiMultiplier',
		}));
		const supplyCalls = feedTokens.map((t) => ({
			address: t.address,
			abi: ERC8056_ABI,
			functionName: 'totalSupply',
		}));

		const results = await client.multicall({
			contracts: [...priceCalls, ...multiplierCalls, ...supplyCalls],
			allowFailure: true,
		});

		const n = feedTokens.length;
		const out = {};
		for (let i = 0; i < n; i++) {
			const price = results[i];
			const mult = results[n + i];
			const supply = results[2 * n + i];
			const t = feedTokens[i];
			const answer = price?.status === 'success' ? price.result[1] : null;
			const updatedAt = price?.status === 'success' ? price.result[3] : null;
			out[t.address.toLowerCase()] = {
				symbol: t.symbol,
				priceUsd: answer != null ? Number(answer) / 10 ** FEED_DECIMALS : null,
				updatedAt: updatedAt != null ? Number(updatedAt) : null,
				uiMultiplier: mult?.status === 'success' ? mult.result.toString() : null,
				totalSupply: supply?.status === 'success' ? supply.result.toString() : null,
			};
		}
		return out;
	});
}

const GET_ROUND_DATA_ABI = [
	{
		type: 'function',
		name: 'getRoundData',
		stateMutability: 'view',
		inputs: [{ name: '_roundId', type: 'uint80' }],
		outputs: [
			{ name: 'roundId', type: 'uint80' },
			{ name: 'answer', type: 'int256' },
			{ name: 'startedAt', type: 'uint256' },
			{ name: 'updatedAt', type: 'uint256' },
			{ name: 'answeredInRound', type: 'uint80' },
		],
	},
];

/**
 * Recent Chainlink NAV history for one feed — the last `count` rounds ending at
 * the current latestRound, read in ONE multicall. Chainlink packs round IDs as
 * (phaseId << 64) | aggregatorRound, so decrementing stays inside the current
 * phase for a short window. Returns [{ roundId, priceUsd, updatedAt }] oldest
 * first; failed/empty rounds are dropped. Cached 60s.
 */
export async function feedRoundHistory(feed, count = 24) {
	const addr = String(feed || '').toLowerCase();
	if (!/^0x[0-9a-f]{40}$/.test(addr)) return [];
	return cacheWrap(`rh:feed:hist:${addr}:${count}`, 60, async () => {
		const client = publicClient(false);
		let latest;
		try {
			latest = await client.readContract({ address: feed, abi: AGGREGATOR_ABI, functionName: 'latestRoundData' });
		} catch {
			return [];
		}
		const latestId = latest[0];
		const ids = [];
		for (let i = BigInt(count) - 1n; i >= 0n; i--) {
			const id = latestId - i;
			if (id <= 0n) continue;
			ids.push(id);
		}
		const results = await client.multicall({
			contracts: ids.map((id) => ({ address: feed, abi: GET_ROUND_DATA_ABI, functionName: 'getRoundData', args: [id] })),
			allowFailure: true,
		});
		const out = [];
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			if (r?.status !== 'success') continue;
			const answer = r.result[1];
			const updatedAt = Number(r.result[3]);
			if (answer == null || !updatedAt) continue;
			out.push({ roundId: ids[i].toString(), priceUsd: Number(answer) / 10 ** FEED_DECIMALS, updatedAt });
		}
		return out;
	});
}

// ── DexScreener (chainId "robinhood") ──────────────────────────────────────
async function fetchJson(url, ttl, key, { headers } = {}) {
	return cacheWrap(key, ttl, async () => {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 12_000);
		try {
			const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json', ...headers } });
			if (!res.ok) return { __error: `upstream ${res.status}` };
			return await res.json();
		} catch (err) {
			return { __error: err?.name === 'AbortError' ? 'upstream timeout' : String(err?.message || err) };
		} finally {
			clearTimeout(timer);
		}
	});
}

/** DexScreener pairs for a token address, robinhood-chain only, deepest first. */
export async function dexPairsForToken(address) {
	const addr = String(address || '').toLowerCase();
	if (!/^0x[0-9a-f]{40}$/.test(addr)) return [];
	const data = await fetchJson(
		`https://api.dexscreener.com/latest/dex/tokens/${addr}`,
		30,
		`rh:dex:token:${addr}`,
	);
	const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
	return pairs
		.filter((p) => p.chainId === 'robinhood')
		.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
}

/** Deepest-liquidity DEX pair for a token (the reference DEX mid price). */
export async function bestDexPair(address) {
	const pairs = await dexPairsForToken(address);
	return pairs[0] || null;
}

/**
 * Batched DEX snapshot for many token addresses at once → { [lower-addr]:
 * bestRobinhoodPair }. DexScreener's /tokens/ endpoint accepts up to 30
 * addresses per call, so the whole 95-token board is 4 calls, not 95 — the
 * anti-fan-out requirement. Cached 30s per address-chunk.
 */
export async function dexSnapshot(addresses) {
	const list = (Array.isArray(addresses) ? addresses : [])
		.map((a) => String(a || '').toLowerCase())
		.filter((a) => /^0x[0-9a-f]{40}$/.test(a));
	const out = {};
	const CHUNK = 30;
	for (let i = 0; i < list.length; i += CHUNK) {
		const chunk = list.slice(i, i + CHUNK);
		const key = `rh:dex:multi:${chunk[0]}:${chunk.length}`;
		const data = await fetchJson(
			`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
			30,
			key,
		);
		const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
		for (const p of pairs) {
			if (p.chainId !== 'robinhood') continue;
			const base = String(p.baseToken?.address || '').toLowerCase();
			if (!chunk.includes(base)) continue;
			const cur = out[base];
			if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) out[base] = p;
		}
	}
	return out;
}

/** DexScreener search restricted to robinhood-chain pairs. */
export async function dexSearch(query) {
	const q = String(query || '').trim();
	if (!q) return [];
	const data = await fetchJson(
		`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
		30,
		`rh:dex:search:${q.toLowerCase()}`,
	);
	const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
	return pairs.filter((p) => p.chainId === 'robinhood');
}

// ── Blockscout Pro API ─────────────────────────────────────────────────────
export async function blockscoutStats() {
	return fetchJson(`${BLOCKSCOUT_BASE}/api/v2/stats`, 15, 'rh:bs:stats');
}

export async function blockscoutToken(address) {
	const addr = String(address || '').toLowerCase();
	if (!/^0x[0-9a-f]{40}$/.test(addr)) return null;
	const data = await fetchJson(`${BLOCKSCOUT_BASE}/api/v2/tokens/${addr}`, 30, `rh:bs:token:${addr}`);
	return data && !data.__error ? data : null;
}

export async function blockscoutHolders(address, limit = 25) {
	const addr = String(address || '').toLowerCase();
	if (!/^0x[0-9a-f]{40}$/.test(addr)) return [];
	const data = await fetchJson(
		`${BLOCKSCOUT_BASE}/api/v2/tokens/${addr}/holders`,
		30,
		`rh:bs:holders:${addr}`,
	);
	const items = Array.isArray(data?.items) ? data.items : [];
	return items.slice(0, limit).map((h) => ({
		address: h.address?.hash || null,
		isContract: Boolean(h.address?.is_contract),
		name: h.address?.name || null,
		value: h.value || null,
	}));
}

export async function blockscoutTransfers(address, limit = 25) {
	const addr = String(address || '').toLowerCase();
	if (!/^0x[0-9a-f]{40}$/.test(addr)) return [];
	const data = await fetchJson(
		`${BLOCKSCOUT_BASE}/api/v2/tokens/${addr}/transfers`,
		20,
		`rh:bs:transfers:${addr}`,
	);
	const items = Array.isArray(data?.items) ? data.items : [];
	return items.slice(0, limit).map((t) => ({
		hash: t.transaction_hash || t.tx_hash || null,
		from: t.from?.hash || null,
		to: t.to?.hash || null,
		value: t.total?.value || t.value || null,
		decimals: t.total?.decimals || null,
		timestamp: t.timestamp || null,
	}));
}

// ── DefiLlama chain TVL ────────────────────────────────────────────────────
export async function chainTvlHistory() {
	const data = await fetchJson(
		'https://api.llama.fi/v2/historicalChainTvl/robinhood-chain',
		120,
		'rh:llama:tvl:hist',
	);
	if (!Array.isArray(data)) return [];
	return data.slice(-90).map((p) => ({ date: p.date, tvl: p.tvl }));
}

export async function chainTvlCurrent() {
	const data = await fetchJson('https://api.llama.fi/v2/chains', 120, 'rh:llama:chains');
	if (!Array.isArray(data)) return null;
	const row = data.find((c) => /robinhood/i.test(c.name || '') || c.chainId === 4663);
	return row ? row.tvl : null;
}

// ── CoinGecko memecoin categories ──────────────────────────────────────────
const CG_BASE = 'https://api.coingecko.com/api/v3';
function cgHeaders() {
	const key = process.env.COINGECKO_API_KEY;
	return key ? { 'x-cg-pro-api-key': key } : {};
}

/** Ranked memecoins in a Robinhood-chain CoinGecko category. */
export async function coingeckoCategory(category, { order = 'market_cap_desc', perPage = 100 } = {}) {
	const cat = /^[a-z0-9-]+$/.test(category) ? category : 'robinhood-chain-meme';
	const url = `${CG_BASE}/coins/markets?vs_currency=usd&category=${cat}&order=${order}&per_page=${Math.min(250, perPage)}&page=1&sparkline=true&price_change_percentage=24h,7d`;
	const data = await fetchJson(url, 60, `rh:cg:cat:${cat}:${order}:${perPage}`, { headers: cgHeaders() });
	if (!Array.isArray(data)) return [];
	return data;
}

// ── Launchpad activity (on-chain eth_getLogs) ──────────────────────────────
// Addresses + event ABIs extracted and confirmed against live logs during the
// Wave-1 SDK build (neither launchpad verifies source on Blockscout).
export const NOXA_FACTORY = '0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB';
export const ODYSSEY_FACTORIES = [
	'0xEb3FeeD2716cF0eEAda05B22e67424794e1f5a80', // bonding-curve
	'0x6Ce85c4b7cE12903E5867652C265bCcce57f935F', // reflection
	'0xD7601cEe401306fdea5833c6898181D9c770F800', // instant
];

// Event topic0 selectors (keccak256 of the canonical signature). The public RPC
// caps eth_getLogs at 10k matched logs and a bounded block range, so newest
// launches are read from Blockscout's decoded-log API filtered by topic instead
// — no range guessing, always newest-first. Indexed params live in `topics`:
// topics[1] = token, topics[2] = deployer/creator (both 32-byte left-padded).
const NOXA_TOKEN_LAUNCHED_TOPIC =
	'0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';
const ODYSSEY_TOKEN_CREATED_TOPIC =
	'0xa52263eeb2ea349365a35c006fc978b0b85eb109fe50959959c829b329bebf9e';

function topicToAddress(topic) {
	if (typeof topic !== 'string' || topic.length < 42) return null;
	return `0x${topic.slice(-40)}`;
}

async function launchesFromFactory(addr, topic, launchpad, type) {
	const data = await fetchJson(
		`${BLOCKSCOUT_BASE}/api/v2/addresses/${addr}/logs?topic=${topic}`,
		45,
		`rh:launches:${addr}:${topic.slice(0, 10)}`,
	);
	const items = Array.isArray(data?.items) ? data.items : [];
	return items
		.map((l) => {
			const topics = Array.isArray(l.topics) ? l.topics : [];
			const token = topicToAddress(topics[1]);
			if (!token) return null;
			return {
				launchpad,
				type,
				token,
				deployer: topicToAddress(topics[2]),
				block: Number(l.block_number || 0),
				txHash: l.transaction_hash || l.tx_hash || null,
				timestamp: l.block_timestamp || null,
			};
		})
		.filter(Boolean);
}

/**
 * Recent launchpad launches from NOXA + The Odyssey factories, newest first.
 * Read from Blockscout's decoded-log API (reliable + unbounded) rather than the
 * range-capped public-RPC eth_getLogs. Cached 45s per factory.
 */
export async function recentLaunches({ limit = 40 } = {}) {
	const jobs = [
		launchesFromFactory(NOXA_FACTORY, NOXA_TOKEN_LAUNCHED_TOPIC, 'NOXA', 'instant'),
		...ODYSSEY_FACTORIES.map((addr) =>
			launchesFromFactory(addr, ODYSSEY_TOKEN_CREATED_TOPIC, 'The Odyssey', 'bonding-curve'),
		),
	];
	const all = (await Promise.all(jobs)).flat();
	all.sort((a, b) => b.block - a.block);
	return all.slice(0, limit);
}

const ERC20_BALANCE_ABI = [
	{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];

/**
 * Multiplier-correct full Stock Token portfolio for a wallet: one multicall
 * for balanceOf across every registry token, joined against the Chainlink NAV
 * snapshot. `raw balance × uiMultiplier / 1e18 = true position` (ERC-8056) —
 * corporate actions (splits/dividends) are already folded into uiMultiplier,
 * so this is the one place a caller should read "how many shares do I hold",
 * never the raw ERC-20 balance. USD valuation uses the Chainlink NAV, which is
 * already multiplier-adjusted (never re-apply uiMultiplier to a feed price).
 */
export async function walletStockPortfolio(owner) {
	const client = publicClient(false);
	const reg = stockRegistry();
	const snap = await chainlinkSnapshot();

	const balances = await client.multicall({
		contracts: reg.tokens.map((t) => ({ address: t.address, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [owner] })),
		allowFailure: true,
	});

	const positions = [];
	for (let i = 0; i < reg.tokens.length; i++) {
		const t = reg.tokens[i];
		const b = balances[i];
		if (b?.status !== 'success' || b.result === 0n) continue;
		const feed = snap[t.address.toLowerCase()] || null;
		const multiplier = feed?.uiMultiplier ? BigInt(feed.uiMultiplier) : BigInt(t.uiMultiplierAtGeneration || '1000000000000000000');
		const rawBalance = b.result;
		const adjustedUnits = Number(rawBalance) * (Number(multiplier) / 1e18) / 10 ** t.decimals;
		const navPrice = feed?.priceUsd ?? null;
		positions.push({
			symbol: t.symbol,
			name: t.name,
			address: t.address,
			rawBalance: rawBalance.toString(),
			uiMultiplier: multiplier.toString(),
			shares: adjustedUnits,
			navPriceUsd: navPrice,
			valueUsd: navPrice != null ? adjustedUnits * navPrice : null,
		});
	}
	positions.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
	const totalValueUsd = positions.reduce((sum, p) => sum + (p.valueUsd || 0), 0);
	return { owner, positions, totalValueUsd, positionCount: positions.length };
}

// ── Shared derivations ─────────────────────────────────────────────────────
/**
 * Premium/discount of a DEX mid price vs the Chainlink NAV, as a signed
 * percentage (positive = DEX trades above NAV). Both inputs already USD.
 */
export function premiumPct(dexUsd, navUsd) {
	const d = Number(dexUsd);
	const n = Number(navUsd);
	if (!Number.isFinite(d) || !Number.isFinite(n) || n <= 0) return null;
	return ((d - n) / n) * 100;
}

/** ISO timestamp for the `asOf` field every response carries. */
export function asOf() {
	return new Date().toISOString();
}
