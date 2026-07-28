// Canonical EVM RPC endpoint resolution + failover transports/providers.
//
// EVM mirrors the Solana failover layer: a priority-ordered endpoint list per
// chain, plus ready-made viem and ethers constructs that try each endpoint in
// turn. Priority: an explicit RPC_URL_<chainId> override → Alchemy (where the
// chain is supported and ALCHEMY_API_KEY is set) → the chain's public rpcUrls
// (already curated in erc8004-chains.js). The keyless public endpoints are
// always last, never the sole dependency.
//
// Scope: GENERIC JSON-RPC (eth_call, eth_getBalance, eth_getTransactionReceipt,
// ENS, contract reads). It is NOT for Alchemy-proprietary methods like
// alchemy_getTokenBalances — those only exist on Alchemy, so a public fallback
// would 4xx. Keep those on a single Alchemy URL.

import { fallback, http } from 'viem';
import { CHAIN_BY_ID } from '../erc8004-chains.js';
import { env } from '../env.js';

// Alchemy network subdomains, keyed by chainId. Only chains Alchemy actually
// serves are listed; everything else relies on the public rpcUrls list.
const ALCHEMY_SUBDOMAIN = {
	1: 'eth-mainnet',
	8453: 'base-mainnet',
	42161: 'arb-mainnet',
	10: 'opt-mainnet',
	137: 'polygon-mainnet',
	56: 'bnb-mainnet',
	43114: 'avax-mainnet',
	59144: 'linea-mainnet',
	534352: 'scroll-mainnet',
	324: 'zksync-mainnet',
	// testnets
	84532: 'base-sepolia',
	421614: 'arb-sepolia',
	11155111: 'eth-sepolia',
	11155420: 'opt-sepolia',
	80002: 'polygon-amoy',
	43113: 'avax-fuji',
};

// Per-chain Alchemy key overrides — operators provision separate keys per app
// (ALCHEMY_ETH_KEY, ALCHEMY_BASE_KEY, …); the shared ALCHEMY_API_KEY remains
// the fallback for every chain.
const ALCHEMY_CHAIN_KEY = {
	1: 'ALCHEMY_ETH_KEY',
	10: 'ALCHEMY_OPT_KEY',
	137: 'ALCHEMY_POLYGON_KEY',
	8453: 'ALCHEMY_BASE_KEY',
	42161: 'ALCHEMY_ARB_KEY',
};

function alchemyUrl(chainId) {
	const sub = ALCHEMY_SUBDOMAIN[chainId];
	const chainKeyName = ALCHEMY_CHAIN_KEY[chainId];
	const key = (chainKeyName && process.env[chainKeyName]) || process.env.ALCHEMY_API_KEY;
	return sub && key ? `https://${sub}.g.alchemy.com/v2/${key}` : null;
}

/**
 * Priority-ordered, de-duplicated RPC URL list for a chain. `primaryUrl` (a url a
 * call site already resolved, e.g. a per-row `meta.rpc` or MAINNET_RPC_URL) is
 * pinned first so its choice is honored, with the keyed/public endpoints as
 * fallbacks behind it.
 */
export function evmRpcEndpoints(chainId, primaryUrl = null) {
	const chain = CHAIN_BY_ID[chainId];
	const urls = [
		primaryUrl,
		env.getRpcUrl(chainId), // explicit RPC_URL_<id> / BASE_SEPOLIA_RPC_URL / SEPOLIA_RPC_URL
		alchemyUrl(chainId),
		...((chain && chain.rpcUrls) || []),
	];
	return urls.filter((u, i, a) => u && a.indexOf(u) === i);
}

/**
 * viem Transport with sequential failover across the chain's endpoints. Drop-in
 * for `http(url)`:  `createPublicClient({ chain, transport: evmTransport(id) })`.
 * `rank: false` keeps strict priority order (override → Alchemy → public) rather
 * than latency-ranking, so we lead with the most reliable endpoint.
 */
export function evmTransport(chainId, { retryCount = 1, timeout, primaryUrl = null } = {}) {
	const httpOpts = { retryCount, ...(timeout != null ? { timeout } : {}) };
	const urls = evmRpcEndpoints(chainId, primaryUrl);
	if (urls.length === 0) return http(undefined, httpOpts); // viem default for the chain
	if (urls.length === 1) return http(urls[0], httpOpts);
	return fallback(
		urls.map((u) => http(u, httpOpts)),
		{ rank: false },
	);
}

/**
 * ethers v6 FallbackProvider with quorum 1 — the first endpoint to answer wins,
 * tried in priority order. Returns a single-provider JsonRpcProvider when only
 * one endpoint exists (FallbackProvider requires ≥2 and quorum ≤ count).
 */
export async function evmFallbackProvider(chainId, { primaryUrl = null, stallTimeout = 2000 } = {}) {
	const { JsonRpcProvider, FallbackProvider, Network } = await import('ethers');
	const urls = evmRpcEndpoints(chainId, primaryUrl);
	if (urls.length === 0) throw new Error(`no RPC endpoint for chain ${chainId}`);
	const network = chainId ? Network.from(chainId) : undefined;
	// staticNetwork avoids a per-call eth_chainId round-trip on every provider.
	const mk = (u) => new JsonRpcProvider(u, network, { staticNetwork: network });
	if (urls.length === 1) return mk(urls[0]);
	const configs = urls.map((u, i) => ({
		provider: mk(u),
		priority: i + 1, // lower = tried first
		weight: 1,
		stallTimeout,
	}));
	return new FallbackProvider(configs, network, { quorum: 1 });
}
