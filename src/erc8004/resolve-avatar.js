/**
 * Avatar resolver — the "paste anything, see their 3D avatar" primitive.
 *
 * Given free-form input (address, ENS name, tx hash, agent ID, agent:// URI)
 * this module fans out across configured chains, discovers matching ERC-8004
 * agent registrations, hydrates their metadata, and returns a flat list of
 * results ready to render as a gallery.
 *
 * Used by:
 *   - src/erc8004/register-ui.js  ("Find Avatar" tab for creators)
 *
 * Chain reads happen through public RPCs (CHAIN_META) so no wallet required.
 */

import { Contract, Interface, isAddress, getAddress } from 'ethers';
import { IDENTITY_REGISTRY_ABI, REGISTRY_DEPLOYMENTS } from './abi.js';
import { CHAIN_META, supportedChainIds, readProvider } from './chain-meta.js';
import {
	getReadProvider,
	getReadRegistry,
	getAgentOnchain,
	fetchAgentMetadata,
	findAvatar3D,
	listAgentsByOwner,
} from './queries.js';

// ───────────────────────────────────────────────────────────────────────────
// Input detection
// ───────────────────────────────────────────────────────────────────────────

export const INPUT_TYPES = {
	AGENT_ID: 'agentId',
	ADDRESS: 'address',
	TX_HASH: 'txHash',
	ENS: 'ens',
	AGENT_URI: 'agentURI',
	UNKNOWN: 'unknown',
};

/** @param {string} input */
export function detectInputType(input) {
	const v = String(input ?? '').trim();
	if (!v) return INPUT_TYPES.UNKNOWN;
	if (/^agent:\/\/[^/]+\/\d+$/i.test(v)) return INPUT_TYPES.AGENT_URI;
	if (/^0x[a-fA-F0-9]{64}$/.test(v)) return INPUT_TYPES.TX_HASH;
	if (/^0x[a-fA-F0-9]{40}$/.test(v)) return INPUT_TYPES.ADDRESS;
	if (/^\d{1,10}$/.test(v)) return INPUT_TYPES.AGENT_ID;
	// ENS-style: any string with at least one dot and an alpha TLD-ish tail
	if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/i.test(v)) return INPUT_TYPES.ENS;
	return INPUT_TYPES.UNKNOWN;
}

/** Default fan-out set — active ERC-8004 chains. Small enough that 9 parallel reads is cheap. */
export const DEFAULT_FAN_OUT_CHAINS = [
	8453, // Base
	1, // Ethereum
	10, // Optimism
	42161, // Arbitrum One
	137, // Polygon
	56, // BNB Chain
	84532, // Base Sepolia
	11155111, // Ethereum Sepolia
	97, // BSC Testnet
];

// ───────────────────────────────────────────────────────────────────────────
// Shared result shape
// ───────────────────────────────────────────────────────────────────────────

/**
 * A single resolved on-chain agent.
 *
 * @typedef {object} AvatarResult
 * @property {number}  chainId
 * @property {string}  chainName
 * @property {boolean} testnet
 * @property {string}  agentId      Stringified (bigint-safe)
 * @property {string}  owner        Checksummed
 * @property {string}  [uri]        Raw tokenURI (ipfs://, ar://, data:, https://)
 * @property {any}     [meta]       Parsed registration JSON (when available)
 * @property {string|null} avatarUri  Raw GLB/GLTF URI (ipfs://, ar://, https://) or null
 * @property {string}  [image]      Poster image URL
 * @property {string}  [name]
 * @property {string}  [description]
 * @property {boolean} [x402]
 * @property {string[]} [serviceTypes]  Uppercased service.type/name list for filtering
 * @property {string}  viewerUrl     Canonical `/a/<chainId>/<agentId>` link
 * @property {string}  tokenExplorerUrl
 * @property {string}  ownerExplorerUrl
 * @property {string}  registry
 * @property {string}  [error]       Per-agent non-fatal error message
 */

// ───────────────────────────────────────────────────────────────────────────
// Single-agent resolution helpers
// ───────────────────────────────────────────────────────────────────────────

function _extractX402(meta) {
	if (!meta || typeof meta !== 'object') return false;
	if (meta.x402Support || meta.x402) return true;
	const services = Array.isArray(meta.services) ? meta.services : [];
	return services.some((s) => {
		const t = String(s?.type || s?.name || '').toUpperCase();
		return t === 'X402' || t.includes('X402');
	});
}

function _extractServiceTypes(meta) {
	if (!meta || typeof meta !== 'object') return [];
	const services = Array.isArray(meta.services) ? meta.services : [];
	return services.map((s) => String(s?.type || s?.name || '').toUpperCase()).filter(Boolean);
}

function _chainName(chainId) {
	return CHAIN_META[chainId]?.name || `Chain ${chainId}`;
}

/**
 * Hydrate a single (chainId, agentId) pair into a full AvatarResult.
 * Uses the read-only public RPC — no wallet required.
 *
 * @param {object} opts
 * @param {number} opts.chainId
 * @param {bigint|string|number} opts.agentId
 * @param {any} [opts.ethProvider]
 * @returns {Promise<AvatarResult>}
 */
export async function hydrateAgent({ chainId, agentId, ethProvider }) {
	const meta = CHAIN_META[chainId];
	const deployment = REGISTRY_DEPLOYMENTS[chainId];
	const registry = deployment?.identityRegistry || '';

	const base = {
		chainId,
		chainName: meta?.name || `Chain ${chainId}`,
		testnet: !!meta?.testnet,
		agentId: String(agentId),
		owner: '',
		uri: '',
		meta: null,
		avatarUri: null,
		image: '',
		name: '',
		description: '',
		x402: false,
		serviceTypes: [],
		viewerUrl: `/a/${chainId}/${String(agentId)}`,
		tokenExplorerUrl:
			registry && meta ? `${meta.explorer}/token/${registry}?a=${String(agentId)}` : '',
		ownerExplorerUrl: '',
		registry,
	};

	try {
		const { owner, uri } = await getAgentOnchain({ chainId, agentId, ethProvider });
		base.owner = owner ? getAddress(owner) : '';
		base.uri = uri || '';
		base.ownerExplorerUrl = base.owner && meta ? `${meta.explorer}/address/${base.owner}` : '';

		if (!uri) {
			base.error = 'no agentURI';
			return base;
		}

		const fetched = await fetchAgentMetadata(uri);
		if (!fetched.ok) {
			base.error = fetched.error || 'metadata fetch failed';
			return base;
		}
		const data = fetched.data || {};
		base.meta = data;
		base.name = String(data.name || '').trim();
		base.description = String(data.description || '').trim();
		base.image = String(data.image || '').trim();
		base.avatarUri = findAvatar3D(data);
		base.x402 = _extractX402(data);
		base.serviceTypes = _extractServiceTypes(data);
	} catch (err) {
		base.error = err?.message || String(err);
	}
	return base;
}

// ───────────────────────────────────────────────────────────────────────────
// Resolvers — each takes shape-preserving opts and returns AvatarResult[]
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {{ chainId: number, agentId: string|number|bigint, ethProvider?: any }} opts
 * @returns {Promise<AvatarResult[]>}
 */
export async function resolveByAgentId(opts) {
	const result = await hydrateAgent(opts);
	return [result];
}

/**
 * Fan-out: given (chainIds, agentId) try the same id on every chain and return
 * every hit. Useful when the user pastes "6443" and we don't know the chain.
 *
 * @param {object} opts
 * @param {string|number|bigint} opts.agentId
 * @param {number[]} [opts.chainIds]
 * @param {any} [opts.ethProvider]
 * @param {(chainId: number, stage: 'start'|'done'|'error', payload?: any) => void} [opts.onProgress]
 * @returns {Promise<AvatarResult[]>}
 */
export async function resolveByAgentIdFanOut({
	agentId,
	chainIds = DEFAULT_FAN_OUT_CHAINS,
	ethProvider,
	onProgress = () => {},
}) {
	const jobs = chainIds.map(async (chainId) => {
		onProgress(chainId, 'start');
		try {
			const r = await hydrateAgent({ chainId, agentId, ethProvider });
			// Filter out "doesn't exist" (no owner AND no uri). Those are empty slots, not agents.
			if (!r.owner && !r.uri) {
				onProgress(chainId, 'done', 0);
				return null;
			}
			onProgress(chainId, 'done', 1);
			return r;
		} catch (err) {
			onProgress(chainId, 'error', err);
			return null;
		}
	});
	const out = (await Promise.all(jobs)).filter(Boolean);
	return out;
}

/**
 * Resolve every agent owned by `address` across `chainIds`.
 *
 * @param {object} opts
 * @param {string} opts.address
 * @param {number[]} [opts.chainIds]
 * @param {any} [opts.ethProvider]
 * @param {(chainId: number, stage: 'start'|'done'|'error', payload?: any) => void} [opts.onProgress]
 * @returns {Promise<AvatarResult[]>}
 */
export async function resolveByAddress({
	address,
	chainIds = DEFAULT_FAN_OUT_CHAINS,
	ethProvider,
	onProgress = () => {},
}) {
	if (!isAddress(address)) throw new Error('Not a valid EVM address');
	const checksummed = getAddress(address);

	const chainJobs = chainIds.map(async (chainId) => {
		onProgress(chainId, 'start');
		try {
			const { ids } = await listAgentsByOwner({
				chainId,
				owner: checksummed,
				ethProvider,
			});
			if (!ids || ids.length === 0) {
				onProgress(chainId, 'done', 0);
				return [];
			}
			// Hydrate each in parallel, but cap concurrency on chains with big balances.
			const hydrated = await Promise.all(
				ids.map((id) => hydrateAgent({ chainId, agentId: id, ethProvider })),
			);
			onProgress(chainId, 'done', hydrated.length);
			return hydrated;
		} catch (err) {
			onProgress(chainId, 'error', err);
			return [];
		}
	});

	const nested = await Promise.all(chainJobs);
	return nested.flat();
}

/**
 * Resolve every `Registered` event in a given tx hash — yields one result per
 * agent minted in that transaction.
 *
 * @param {object} opts
 * @param {string} opts.txHash
 * @param {number} [opts.chainId]     If omitted, we fan-out across chainIds.
 * @param {number[]} [opts.chainIds]
 * @param {any} [opts.ethProvider]
 * @param {(chainId: number, stage: 'start'|'done'|'error', payload?: any) => void} [opts.onProgress]
 * @returns {Promise<AvatarResult[]>}
 */
export async function resolveByTxHash({
	txHash,
	chainId,
	chainIds = DEFAULT_FAN_OUT_CHAINS,
	ethProvider,
	onProgress = () => {},
}) {
	if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error('Not a valid tx hash');
	const candidates = chainId ? [chainId] : chainIds;

	const iface = new Interface(IDENTITY_REGISTRY_ABI);
	const registeredTopic = iface.getEvent('Registered').topicHash;

	const chainJobs = candidates.map(async (cid) => {
		onProgress(cid, 'start');
		try {
			const deployment = REGISTRY_DEPLOYMENTS[cid];
			if (!deployment?.identityRegistry) {
				onProgress(cid, 'done', 0);
				return [];
			}
			const provider = getReadProvider(cid, ethProvider);
			const receipt = await provider.getTransactionReceipt(txHash);
			if (!receipt) {
				onProgress(cid, 'done', 0);
				return [];
			}
			const registryAddr = deployment.identityRegistry.toLowerCase();
			const hits = [];
			for (const log of receipt.logs) {
				if (!log.address || log.address.toLowerCase() !== registryAddr) continue;
				if (!log.topics || log.topics[0] !== registeredTopic) continue;
				try {
					const parsed = iface.parseLog(log);
					const agentId = parsed.args.agentId;
					hits.push(await hydrateAgent({ chainId: cid, agentId, ethProvider }));
				} catch {
					// malformed log — skip
				}
			}
			onProgress(cid, 'done', hits.length);
			return hits;
		} catch (err) {
			onProgress(cid, 'error', err);
			return [];
		}
	});

	const nested = await Promise.all(chainJobs);
	return nested.flat();
}

/**
 * Resolve an agent://<chain>/<id> URI.
 *
 * @param {string} uri
 * @param {any} [ethProvider]
 * @returns {Promise<AvatarResult[]>}
 */
export async function resolveByAgentURI(uri, ethProvider) {
	const m = String(uri).match(/^agent:\/\/([^/]+)\/(\d+)$/i);
	if (!m) throw new Error('Malformed agent URI');
	const [, chainToken, idStr] = m;
	const CHAIN_ALIASES = {
		base: 8453,
		'base-mainnet': 8453,
		'base-sepolia': 84532,
		ethereum: 1,
		mainnet: 1,
		optimism: 10,
		arbitrum: 42161,
		polygon: 137,
		bsc: 56,
	};
	const chainId = CHAIN_ALIASES[chainToken.toLowerCase()] || Number(chainToken);
	if (!chainId || !REGISTRY_DEPLOYMENTS[chainId]) {
		throw new Error(`Unknown chain in URI: ${chainToken}`);
	}
	const r = await hydrateAgent({ chainId, agentId: idStr, ethProvider });
	return [r];
}

/**
 * Resolve an ENS name to an address using Ethereum mainnet public RPC, then
 * delegate to resolveByAddress. Names that don't resolve throw.
 *
 * @param {string} name
 */
export async function resolveENSAddress(name) {
	const provider = readProvider(1);
	const addr = await provider.resolveName(name);
	if (!addr) throw new Error(`ENS name does not resolve: ${name}`);
	return getAddress(addr);
}

// ───────────────────────────────────────────────────────────────────────────
// Auto-resolve — single entry point
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.input
 * @param {number[]} [opts.chainIds]    Fan-out set
 * @param {any} [opts.ethProvider]
 * @param {(chainId: number, stage: 'start'|'done'|'error', payload?: any) => void} [opts.onProgress]
 * @returns {Promise<{ type: string, resolvedAddress?: string, results: AvatarResult[] }>}
 */
export async function autoResolve({
	input,
	chainIds = DEFAULT_FAN_OUT_CHAINS,
	ethProvider,
	onProgress = () => {},
}) {
	const type = detectInputType(input);
	const trimmed = String(input).trim();

	switch (type) {
		case INPUT_TYPES.AGENT_URI: {
			const results = await resolveByAgentURI(trimmed, ethProvider);
			return { type, results };
		}
		case INPUT_TYPES.TX_HASH: {
			const results = await resolveByTxHash({
				txHash: trimmed,
				chainIds,
				ethProvider,
				onProgress,
			});
			return { type, results };
		}
		case INPUT_TYPES.ADDRESS: {
			const results = await resolveByAddress({
				address: trimmed,
				chainIds,
				ethProvider,
				onProgress,
			});
			return { type, resolvedAddress: getAddress(trimmed), results };
		}
		case INPUT_TYPES.AGENT_ID: {
			const results = await resolveByAgentIdFanOut({
				agentId: trimmed,
				chainIds,
				ethProvider,
				onProgress,
			});
			return { type, results };
		}
		case INPUT_TYPES.ENS: {
			const address = await resolveENSAddress(trimmed);
			const results = await resolveByAddress({ address, chainIds, ethProvider, onProgress });
			return { type, resolvedAddress: address, results };
		}
		default:
			throw new Error(
				`Unrecognized input: "${trimmed}". Paste an address, ENS name, tx hash, or agent ID.`,
			);
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Convenience: all chains with a deployed registry (for UI toggle row)
// ───────────────────────────────────────────────────────────────────────────

export function allSupportedChains() {
	return supportedChainIds();
}

/** Split supported chains into mainnets vs testnets for UI grouping. */
export function splitChainsByNet() {
	const all = allSupportedChains();
	const mainnet = all.filter((id) => !CHAIN_META[id]?.testnet);
	const testnet = all.filter((id) => CHAIN_META[id]?.testnet);
	return { mainnet, testnet };
}
