/**
 * IPFS / Arweave URI resolver.
 *
 * Translates decentralised storage URIs into HTTPS gateway URLs
 * so the Three.js loader can fetch them normally.
 *
 *   ipfs://QmXyz...        → https://dweb.link/ipfs/QmXyz...
 *   ipfs://bafkreiXyz...   → https://dweb.link/ipfs/bafkreiXyz...
 *   ar://txId               → https://arweave.net/txId
 */

// Cloudflare retired both cf-ipfs.com and cloudflare-ipfs.com (Aug 2024);
// requests to either now fail DNS (ERR_NAME_NOT_RESOLVED). pump.fun metadata
// still hands out cf-ipfs.com image URLs, so we keep this list dead-host-free
// and rewrite any lingering dead-gateway URL via normalizeGatewayURL().
const IPFS_GATEWAYS = [
	'https://ipfs.io/ipfs/',
	'https://dweb.link/ipfs/',
	'https://flk-ipfs.xyz/ipfs/',
];

const AR_GATEWAY = 'https://arweave.net/';

// Hosts that no longer resolve. Any HTTPS gateway URL using one of these is
// rewritten onto the primary working gateway (preserving the /ipfs/<cid>/path).
const DEAD_GATEWAY_HOST_RE = /^https?:\/\/(?:cf-ipfs\.com|cloudflare-ipfs\.com)\/ipfs\/(.+)$/i;

/**
 * Returns true when the URL uses a decentralised storage scheme.
 * @param {string} url
 * @returns {boolean}
 */
export function isDecentralizedURI(url) {
	return /^(ipfs|ar):\/\//i.test(url);
}

/**
 * Repair full HTTPS gateway URLs that point at a retired gateway host.
 * Leaves every other URL (including live gateways) untouched.
 *
 * @param {string} url
 * @param {number} [gatewayIndex=0]  Which working gateway to route to.
 * @returns {string}
 */
export function normalizeGatewayURL(url, gatewayIndex = 0) {
	if (!url) return url;
	const dead = url.match(DEAD_GATEWAY_HOST_RE);
	if (dead) {
		const gw = IPFS_GATEWAYS[gatewayIndex % IPFS_GATEWAYS.length];
		return gw + dead[1];
	}
	return url;
}

/**
 * Resolve an ipfs:// or ar:// URI to an HTTPS gateway URL.
 * For regular URLs the input is returned unchanged, except that URLs pointing
 * at a retired gateway host are rewritten onto a working gateway.
 *
 * @param {string} uri
 * @param {number} [gatewayIndex=0]  Which IPFS gateway to use (for fallback).
 * @returns {string}
 */
export function resolveURI(uri, gatewayIndex = 0) {
	if (!uri) return uri;

	// ipfs://CID  or  ipfs://CID/path
	const ipfsMatch = uri.match(/^ipfs:\/\/(.+)$/i);
	if (ipfsMatch) {
		const gw = IPFS_GATEWAYS[gatewayIndex % IPFS_GATEWAYS.length];
		return gw + ipfsMatch[1];
	}

	// ar://txId
	const arMatch = uri.match(/^ar:\/\/(.+)$/i);
	if (arMatch) {
		return AR_GATEWAY + arMatch[1];
	}

	return normalizeGatewayURL(uri, gatewayIndex);
}

/**
 * Try to fetch from the primary gateway; on failure, cycle through fallbacks.
 *
 * @param {string} ipfsURI  An ipfs:// URI.
 * @returns {Promise<Response>}
 */
export async function fetchWithFallback(ipfsURI) {
	let lastError;
	for (let i = 0; i < IPFS_GATEWAYS.length; i++) {
		const url = resolveURI(ipfsURI, i);
		try {
			const res = await fetch(url);
			if (res.ok) return res;
		} catch (err) {
			lastError = err;
		}
	}
	throw lastError || new Error('All IPFS gateways failed for ' + ipfsURI);
}
