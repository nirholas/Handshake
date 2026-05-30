/**
 * Agent enumeration & metadata fetching.
 *
 * Strategy, in priority order:
 *  1. ERC-721 Enumerable: balanceOf + tokenOfOwnerByIndex (fast, one call per id)
 *  2. Event scan: query Transfer(to = owner) filter on the registry (slow on
 *     chains with many blocks; keep a bounded `fromBlock` when provided)
 *
 * Metadata resolution fetches `tokenURI(id)` and follows ipfs://, ar://, https://.
 */

import { getIdentityRegistry } from './agent-registry.js';

const IPFS_GATEWAYS = [
	(cid) => `https://ipfs.io/ipfs/${cid}`,
	(cid) => `https://flk-ipfs.xyz/ipfs/${cid}`,
	(cid) => `https://dweb.link/ipfs/${cid}`,
];

/**
 * Resolve an ipfs://, ar://, or https:// URI to an HTTP URL.
 * Returns the first gateway for ipfs — caller may retry others via `ipfsFallbackUrls`.
 * @param {string} uri
 * @returns {string}
 */
export function uriToHttp(uri) {
	if (!uri) return '';
	if (uri.startsWith('ipfs://')) return IPFS_GATEWAYS[0](uri.slice(7));
	if (uri.startsWith('ar://')) return `https://arweave.net/${uri.slice(5)}`;
	return uri;
}

/**
 * Full list of fallback HTTP URLs for an IPFS URI (for retries).
 * @param {string} uri
 * @returns {string[]}
 */
export function ipfsFallbackUrls(uri) {
	if (!uri?.startsWith('ipfs://')) return [uri];
	const cid = uri.slice(7);
	return IPFS_GATEWAYS.map((fn) => fn(cid));
}

/**
 * Enumerate token IDs owned by `address` on the given registry.
 *
 * @param {import('ethers').Contract} registry
 * @param {string} address
 * @param {{ fromBlock?: number, onStatus?: (msg: string) => void }} [opts]
 * @returns {Promise<{tokenIds: number[], balance: number, strategy: 'enumerable'|'event-scan'|'empty'}>}
 */
export async function getAgentsByOwner(registry, address, opts = {}) {
	const log = opts.onStatus || (() => {});

	log('Reading balance…');
	const balance = Number(await registry.balanceOf(address));
	if (balance === 0) return { tokenIds: [], balance: 0, strategy: 'empty' };

	// Try ERC-721 Enumerable first.
	try {
		const tokenIds = [];
		for (let i = 0; i < balance; i++) {
			tokenIds.push(Number(await registry.tokenOfOwnerByIndex(address, i)));
		}
		return { tokenIds, balance, strategy: 'enumerable' };
	} catch {
		// Fall through to event scan.
	}

	log('Scanning Transfer events…');
	const filter = registry.filters.Transfer(null, address);
	const events = opts.fromBlock
		? await registry.queryFilter(filter, opts.fromBlock)
		: await registry.queryFilter(filter);

	const seen = new Set();
	const tokenIds = [];
	for (const e of events) {
		const id = Number(e.args.tokenId);
		if (seen.has(id)) continue;
		seen.add(id);
		try {
			const currentOwner = await registry.ownerOf(id);
			if (currentOwner.toLowerCase() === address.toLowerCase()) tokenIds.push(id);
		} catch {
			/* burned — skip */
		}
	}
	return { tokenIds, balance, strategy: 'event-scan' };
}

/**
 * Fetch `tokenURI(id)` and its resolved JSON (if reachable).
 *
 * @param {import('ethers').Contract} registry
 * @param {number} tokenId
 * @returns {Promise<{id: number, uri: string, meta: object|null, owner: string|null}>}
 */
export async function fetchTokenMeta(registry, tokenId) {
	let uri = '';
	let meta = null;
	let owner = null;

	try {
		uri = await registry.tokenURI(tokenId);
	} catch {
		/* no URI set */
	}
	try {
		owner = await registry.ownerOf(tokenId);
	} catch {
		/* burned */
	}

	if (uri) {
		const urls = ipfsFallbackUrls(uri);
		for (const u of urls) {
			try {
				const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
				const ct = r.headers.get('content-type') || '';
				if (r.ok && ct.includes('json')) {
					meta = await r.json();
					break;
				}
			} catch {
				/* try next gateway */
			}
		}
	}
	return { id: tokenId, uri, meta, owner };
}

/**
 * Scan past `Registered` events for a given owner — powers the History tab.
 *
 * @param {import('ethers').Contract} registry
 * @param {string} ownerAddress
 * @param {{ fromBlock?: number, limit?: number }} [opts]
 * @returns {Promise<Array<{agentId: number, agentURI: string, txHash: string, blockNumber: number, blockHash: string}>>}
 */
export async function getRegistrationHistory(registry, ownerAddress, opts = {}) {
	const limit = opts.limit ?? 50;
	const filter = registry.filters.Registered(null, null, ownerAddress);
	const events = opts.fromBlock
		? await registry.queryFilter(filter, opts.fromBlock)
		: await registry.queryFilter(filter);

	return events
		.map((e) => ({
			agentId: Number(e.args.agentId),
			agentURI: String(e.args.agentURI || ''),
			txHash: e.transactionHash,
			blockNumber: Number(e.blockNumber),
			blockHash: e.blockHash,
		}))
		.sort((a, b) => b.blockNumber - a.blockNumber)
		.slice(0, limit);
}

/**
 * Read-only registry connect — uses a public RPC when no signer is available.
 * Used by the Search tab when a user hasn't connected a wallet yet.
 *
 * @param {number} chainId
 * @param {string} rpcUrl
 * @returns {Promise<import('ethers').Contract>}
 */
export async function getReadOnlyRegistry(chainId, rpcUrl) {
	const { JsonRpcProvider, Contract } = await import('ethers');
	const { REGISTRY_DEPLOYMENTS, IDENTITY_REGISTRY_ABI } = await import('./abi.js');
	const deployment = REGISTRY_DEPLOYMENTS[chainId];
	if (!deployment?.identityRegistry) {
		throw new Error(`No registry for chain ${chainId}`);
	}
	const provider = new JsonRpcProvider(rpcUrl);
	return new Contract(deployment.identityRegistry, IDENTITY_REGISTRY_ABI, provider);
}

export { getIdentityRegistry };
