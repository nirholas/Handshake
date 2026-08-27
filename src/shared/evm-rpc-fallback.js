// Browser-side EVM RPC failover, the client half of api/_lib/evm/rpc.js.
//
// Browser code used to pin one keyless public host per chain (often
// eth.llamarpc.com, which the server chain demotes as a known-bad host), so a
// single dead endpoint read as "chain unsupported". Every consumer now gets an
// ordered list instead:
//   1. the same-origin proxy `/api/evm-rpc?chainId=N`, which inherits the
//      server failover (RPC_URL override, Alchemy where keyed, curated public
//      tail). Only when the page is served from a three.ws origin (or a local
//      dev server): a widget embedded on a third-party site has no proxy.
//   2. the chain's keyless public hosts from src/erc8004/chains.js.
// The two helpers below turn that list into an ethers v6 FallbackProvider or a
// viem fallback transport, so a consumer makes one call. Both libraries are
// imported lazily so a consumer only pays for the one it already uses.

import { CHAIN_INFO } from '../erc8004/chains.js';

const PROXY_HOSTS = /(^|\.)three\.ws$|^localhost$|^127\.0\.0\.1$|^\[::1\]$/i;

/** True when the page is served from an origin that hosts /api/evm-rpc. */
export function hasEvmProxy() {
	if (typeof window === 'undefined' || !window.location?.origin) return false;
	return PROXY_HOSTS.test(window.location.hostname || '');
}

/** Same-origin proxy URL for a chain, or null off a three.ws origin. */
export function evmProxyUrl(chainId) {
	return hasEvmProxy() ? `${window.location.origin}/api/evm-rpc?chainId=${chainId}` : null;
}

/**
 * Ordered RPC URL list for a chain: proxy first (when available), then a
 * caller-pinned URL, then the public hosts. De-duplicated, empty when the chain
 * is unknown and nothing was pinned.
 *
 * @param {number} chainId
 * @param {{ primaryUrl?: string|null, proxy?: boolean }} [opts]
 * @returns {string[]}
 */
export function evmRpcUrls(chainId, { primaryUrl = null, proxy = true } = {}) {
	const info = CHAIN_INFO[chainId];
	const urls = [
		proxy ? evmProxyUrl(chainId) : null,
		primaryUrl,
		...(info?.rpcUrls || (info?.rpc ? [info.rpc] : [])),
	];
	return urls.filter((u, i, a) => u && a.indexOf(u) === i);
}

/**
 * ethers v6 read provider with quorum-1 failover across evmRpcUrls(). The first
 * endpoint to answer wins, tried in priority order; a single-URL chain gets a
 * plain JsonRpcProvider. Throws when the chain has no endpoint at all.
 *
 * @param {number} chainId
 * @param {{ primaryUrl?: string|null, stallTimeout?: number, proxy?: boolean }} [opts]
 * @returns {Promise<import('ethers').AbstractProvider>}
 */
export async function getEvmProvider(chainId, { primaryUrl = null, stallTimeout = 2000, proxy = true } = {}) {
	const { JsonRpcProvider, FallbackProvider, Network } = await import('ethers');
	const urls = evmRpcUrls(chainId, { primaryUrl, proxy });
	if (urls.length === 0) throw new Error(`No RPC configured for chainId ${chainId}`);
	const network = Number.isInteger(chainId) && chainId > 0 ? Network.from(chainId) : undefined;
	// staticNetwork skips the per-call eth_chainId round trip on every endpoint.
	const mk = (u) => new JsonRpcProvider(u, network, network ? { staticNetwork: network } : undefined);
	if (urls.length === 1) return mk(urls[0]);
	const configs = urls.map((u, i) => ({ provider: mk(u), priority: i + 1, weight: 1, stallTimeout }));
	return new FallbackProvider(configs, network, { quorum: 1 });
}

/**
 * viem transport with sequential failover across evmRpcUrls(), strict priority
 * order (`rank: false`). Drop-in for `http(url)` in createPublicClient.
 *
 * @param {number} chainId
 * @param {{ primaryUrl?: string|null, timeout?: number, retryCount?: number, proxy?: boolean }} [opts]
 */
export async function getEvmTransport(chainId, { primaryUrl = null, timeout = 10_000, retryCount = 2, proxy = true } = {}) {
	const { fallback, http } = await import('viem');
	const httpOpts = { timeout, retryCount };
	const urls = evmRpcUrls(chainId, { primaryUrl, proxy });
	if (urls.length === 0) return http(undefined, httpOpts);
	if (urls.length === 1) return http(urls[0], httpOpts);
	return fallback(urls.map((u) => http(u, httpOpts)), { rank: false });
}

/**
 * Classify a provider failure: true when the error is a transport problem
 * (network, timeout, HTTP status, every endpoint down) rather than an on-chain
 * answer such as a revert. Lets a caller report "rpc unavailable" instead of
 * presenting an outage as a negative result.
 */
export function isRpcTransportError(err) {
	const code = err?.code;
	if (code === 'NETWORK_ERROR' || code === 'TIMEOUT' || code === 'SERVER_ERROR') return true;
	if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
	const msg = String(err?.message || err || '').toLowerCase();
	return /network|timeout|timed out|failed to fetch|fetch failed|econnre|enotfound|http request failed|quorum|all .* endpoints? failed|rate limit|429|5\d\d/.test(msg);
}
