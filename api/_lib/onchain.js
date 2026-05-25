/**
 * Server-side on-chain agent resolver.
 *
 * Mirrors the client-side resolver in src/erc8004/resolve-avatar.js but keeps
 * its own lightweight chain-meta table so serverless cold-starts stay cheap.
 * Only identity-registry `tokenURI` + `ownerOf` reads happen here; manifest
 * bodies (GLB, images) are pointed to, never fetched.
 *
 * Canonical deployment addresses are the CREATE2-deterministic ones from
 * src/erc8004/abi.js — kept in sync by hand.
 */

import { JsonRpcProvider, Contract, getAddress } from 'ethers';
import { cacheGet, cacheSet } from './cache.js';

const IDENTITY_ABI = [
	'function tokenURI(uint256 tokenId) external view returns (string)',
	'function ownerOf(uint256 tokenId) external view returns (address)',
	'function getAgentWallet(uint256 agentId) external view returns (address)',
];

const MAINNET = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const TESTNET = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

// Tight table — only what the server needs. Public RPCs with low-latency
// global edges; no API keys required.
export const SERVER_CHAIN_META = {
	// Mainnets
	1: {
		name: 'Ethereum',
		short: 'ETH',
		rpc: 'https://eth.llamarpc.com',
		explorer: 'https://etherscan.io',
		registry: MAINNET,
		testnet: false,
	},
	10: {
		name: 'Optimism',
		short: 'OP',
		rpc: 'https://mainnet.optimism.io',
		explorer: 'https://optimistic.etherscan.io',
		registry: MAINNET,
		testnet: false,
	},
	56: {
		name: 'BNB Chain',
		short: 'BSC',
		rpc: 'https://bsc-dataseed.bnbchain.org',
		explorer: 'https://bscscan.com',
		registry: MAINNET,
		testnet: false,
	},
	100: {
		name: 'Gnosis',
		short: 'GNO',
		rpc: 'https://rpc.gnosischain.com',
		explorer: 'https://gnosisscan.io',
		registry: MAINNET,
		testnet: false,
	},
	137: {
		name: 'Polygon',
		short: 'MATIC',
		rpc: 'https://polygon-rpc.com',
		explorer: 'https://polygonscan.com',
		registry: MAINNET,
		testnet: false,
	},
	250: {
		name: 'Fantom',
		short: 'FTM',
		rpc: 'https://rpc.ftm.tools',
		explorer: 'https://ftmscan.com',
		registry: MAINNET,
		testnet: false,
	},
	324: {
		name: 'zkSync Era',
		short: 'zkSync',
		rpc: 'https://mainnet.era.zksync.io',
		explorer: 'https://explorer.zksync.io',
		registry: MAINNET,
		testnet: false,
	},
	1284: {
		name: 'Moonbeam',
		short: 'GLMR',
		rpc: 'https://rpc.api.moonbeam.network',
		explorer: 'https://moonscan.io',
		registry: MAINNET,
		testnet: false,
	},
	5000: {
		name: 'Mantle',
		short: 'MNT',
		rpc: 'https://rpc.mantle.xyz',
		explorer: 'https://explorer.mantle.xyz',
		registry: MAINNET,
		testnet: false,
	},
	8453: {
		name: 'Base',
		short: 'BASE',
		rpc: 'https://mainnet.base.org',
		explorer: 'https://basescan.org',
		registry: MAINNET,
		testnet: false,
	},
	42161: {
		name: 'Arbitrum One',
		short: 'ARB',
		rpc: 'https://arb1.arbitrum.io/rpc',
		explorer: 'https://arbiscan.io',
		registry: MAINNET,
		testnet: false,
	},
	42220: {
		name: 'Celo',
		short: 'CELO',
		rpc: 'https://forno.celo.org',
		explorer: 'https://celoscan.io',
		registry: MAINNET,
		testnet: false,
	},
	43114: {
		name: 'Avalanche',
		short: 'AVAX',
		rpc: 'https://api.avax.network/ext/bc/C/rpc',
		explorer: 'https://snowtrace.io',
		registry: MAINNET,
		testnet: false,
	},
	59144: {
		name: 'Linea',
		short: 'LINEA',
		rpc: 'https://rpc.linea.build',
		explorer: 'https://lineascan.build',
		registry: MAINNET,
		testnet: false,
	},
	534352: {
		name: 'Scroll',
		short: 'SCR',
		rpc: 'https://rpc.scroll.io',
		explorer: 'https://scrollscan.com',
		registry: MAINNET,
		testnet: false,
	},

	// Testnets
	97: {
		name: 'BSC Testnet',
		short: 'tBSC',
		rpc: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
		explorer: 'https://testnet.bscscan.com',
		registry: TESTNET,
		testnet: true,
	},
	11155111: {
		name: 'Ethereum Sepolia',
		short: 'SEP',
		rpc: 'https://rpc.sepolia.org',
		explorer: 'https://sepolia.etherscan.io',
		registry: TESTNET,
		testnet: true,
	},
	84532: {
		name: 'Base Sepolia',
		short: 'baseSep',
		rpc: 'https://sepolia.base.org',
		explorer: 'https://sepolia.basescan.org',
		registry: TESTNET,
		testnet: true,
	},
	421614: {
		name: 'Arbitrum Sepolia',
		short: 'arbSep',
		rpc: 'https://sepolia-rollup.arbitrum.io/rpc',
		explorer: 'https://sepolia.arbiscan.io',
		registry: TESTNET,
		testnet: true,
	},
	11155420: {
		name: 'Optimism Sepolia',
		short: 'opSep',
		rpc: 'https://sepolia.optimism.io',
		explorer: 'https://sepolia-optimism.etherscan.io',
		registry: TESTNET,
		testnet: true,
	},
	80002: {
		name: 'Polygon Amoy',
		short: 'Amoy',
		rpc: 'https://rpc-amoy.polygon.technology',
		explorer: 'https://amoy.polygonscan.com',
		registry: TESTNET,
		testnet: true,
	},
	43113: {
		name: 'Avalanche Fuji',
		short: 'Fuji',
		rpc: 'https://api.avax-test.network/ext/bc/C/rpc',
		explorer: 'https://testnet.snowtrace.io',
		registry: TESTNET,
		testnet: true,
	},
};

const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const AR_GATEWAY = 'https://arweave.net/';

// Shared via Upstash when configured — see api/_lib/cache.js. Falls back to
// an in-process Map for local/dev. Either way, TTL is 10 minutes.
const CACHE_TTL_S = 10 * 60;

/** @param {string} uri */
export function resolveURI(uri) {
	if (!uri) return '';
	if (uri.startsWith('ipfs://')) return IPFS_GATEWAY + uri.slice(7);
	if (uri.startsWith('ar://')) return AR_GATEWAY + uri.slice(5);
	return uri;
}

/**
 * Resolve an on-chain agent.
 * @param {{ chainId: number, agentId: string|number, fetchManifest?: boolean, timeoutMs?: number }} p
 * @returns {Promise<{
 *   chainId: number,
 *   chainName: string,
 *   chainShort: string,
 *   testnet: boolean,
 *   explorer: string,
 *   registry: string,
 *   agentId: string,
 *   owner: string|null,
 *   wallet: string|null,
 *   tokenURI: string|null,
 *   tokenURIResolved: string|null,
 *   manifest: object|null,
 *   name: string|null,
 *   description: string|null,
 *   image: string|null,
 *   bodyURI: string|null,
 *   error?: string,
 * }>}
 */
export async function resolveOnChainAgent({
	chainId,
	agentId,
	fetchManifest = true,
	timeoutMs = 4000,
}) {
	const meta = SERVER_CHAIN_META[chainId];
	if (!meta) {
		return _emptyResult(chainId, agentId, 'unsupported_chain');
	}

	const cacheKey = `onchain-agent:${chainId}:${agentId}:${fetchManifest ? '1' : '0'}`;
	const cached = await cacheGet(cacheKey);
	if (cached) return cached;

	const base = {
		chainId,
		chainName: meta.name,
		chainShort: meta.short,
		testnet: meta.testnet,
		explorer: meta.explorer,
		registry: meta.registry,
		agentId: String(agentId),
		owner: null,
		wallet: null,
		tokenURI: null,
		tokenURIResolved: null,
		manifest: null,
		name: null,
		description: null,
		image: null,
		bodyURI: null,
	};

	let provider;
	try {
		provider = new JsonRpcProvider(meta.rpc, chainId, { staticNetwork: true });
	} catch (err) {
		return { ...base, error: `rpc_init: ${err.message}` };
	}

	const registry = new Contract(meta.registry, IDENTITY_ABI, provider);
	const idBig = BigInt(agentId);

	try {
		const [uri, owner] = await Promise.all([
			_withTimeout(registry.tokenURI(idBig), timeoutMs),
			_withTimeout(
				registry.ownerOf(idBig).catch(() => null),
				timeoutMs,
			),
		]);
		base.tokenURI = uri || null;
		base.tokenURIResolved = uri ? resolveURI(uri) : null;
		base.owner = owner ? _safeAddress(owner) : null;
	} catch (err) {
		return { ...base, error: `chain_read: ${err.message}` };
	}

	if (fetchManifest && base.tokenURIResolved) {
		try {
			const res = await _withTimeout(fetch(base.tokenURIResolved), timeoutMs);
			if (res.ok) {
				const json = await res.json();
				base.manifest = json;
				base.name = _pickName(json, agentId);
				base.description = _pickDescription(json);
				base.image = _pickImage(json);
				base.bodyURI = _pickBody(json);
			}
		} catch (err) {
			base.error = `manifest_fetch: ${err.message}`;
		}
	}

	if (!base.error) {
		await cacheSet(cacheKey, base, CACHE_TTL_S);
	}
	return base;
}

function _emptyResult(chainId, agentId, error) {
	return {
		chainId,
		chainName: `Chain ${chainId}`,
		chainShort: String(chainId),
		testnet: false,
		explorer: '',
		registry: '',
		agentId: String(agentId),
		owner: null,
		wallet: null,
		tokenURI: null,
		tokenURIResolved: null,
		manifest: null,
		name: null,
		description: null,
		image: null,
		bodyURI: null,
		error,
	};
}

function _safeAddress(addr) {
	try {
		return getAddress(addr);
	} catch {
		return null;
	}
}

function _pickName(json, agentId) {
	if (json?.name) return String(json.name);
	const reg = json?.registrations?.[0];
	if (reg?.agentId) return `Agent #${reg.agentId}`;
	return `Agent #${agentId}`;
}

function _pickDescription(json) {
	if (typeof json?.description === 'string') return json.description;
	if (typeof json?.summary === 'string') return json.summary;
	return null;
}

function _isAbsoluteURI(uri) {
	return /^(https?|ipfs|ar|data):/.test(uri);
}

function _pickImage(json) {
	const candidates = [json?.image, json?.thumbnail, json?.body?.thumbnail, json?.avatar];
	for (const c of candidates) {
		if (typeof c === 'string' && c && _isAbsoluteURI(c)) return resolveURI(c);
	}
	return null;
}

function _pickBody(json) {
	const candidates = [
		json?.body?.uri,
		json?.body?.url,
		json?.body,
		json?.avatar,
		json?.model,
		json?.image,
	];
	for (const c of candidates) {
		if (typeof c === 'string' && c && _isAbsoluteURI(c)) return resolveURI(c);
	}
	return null;
}

function _withTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
		Promise.resolve(promise).then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

/** Short address form 0xabc…def */
export function shortenAddr(addr) {
	if (!addr || typeof addr !== 'string') return '';
	if (addr.length <= 10) return addr;
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Build explorer deep link. */
export function explorerLink(chainId, kind, value) {
	const meta = SERVER_CHAIN_META[chainId];
	if (!meta?.explorer || !value) return '';
	switch (kind) {
		case 'tx':
			return `${meta.explorer}/tx/${value}`;
		case 'address':
			return `${meta.explorer}/address/${value}`;
		case 'token':
			return `${meta.explorer}/token/${value}`;
		default:
			return meta.explorer;
	}
}
