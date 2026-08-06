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

import { Contract, getAddress } from 'ethers';
import { evmFallbackProvider } from './evm/rpc.js';
import { cacheGet, cacheSet, cacheDel } from './cache.js';
import {
	CHAIN_BY_ID,
	VALIDATION_REGISTRY_ABI,
	validationRegistryFor,
} from './erc8004-chains.js';
import { KIND_GLB_SCHEMA, responsePassed } from '../../src/erc8004/validation-report.js';
import { fetchSafePublicUrlPinned } from './ssrf-guard.js';

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
		// dRPC (not llamarpc — its Cloudflare bot-wall 403s server-side POSTs, which
		// wasted the first failover attempt on every call). evmFallbackProvider adds
		// the rest of the chain from erc8004-chains.js behind this primary.
		rpc: 'https://eth.drpc.org',
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
		rpc: 'https://sepolia.drpc.org',
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
		provider = await evmFallbackProvider(chainId, { primaryUrl: meta.rpc });
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
			// tokenURI is fully attacker-controlled (any NFT owner sets it), so the
			// manifest fetch must go through the SSRF guard: a tokenURI of
			// http://169.254.169.254/... or an internal host would otherwise let an
			// unauthenticated caller read internal services and exfiltrate the body
			// (it is returned to the caller as `card`). Pinned variant closes the DNS
			// rebinding window since the response is forwarded out.
			const res = await _withTimeout(
				fetchSafePublicUrlPinned(base.tokenURIResolved, {}, { allowHttp: true }),
				timeoutMs,
			);
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

// ---------------------------------------------------------------------------
// Validation attestations (ERC-8004 ValidationRegistry)
// ---------------------------------------------------------------------------

const VALIDATION_CACHE_TTL_S = 60;

// How many of an agent's most recent request hashes to inspect. Requests are
// appended, so the tail is the newest; an agent with a long re-validation history
// never turns one badge into an unbounded fan-out of RPC reads.
const VALIDATION_SCAN_LIMIT = 12;

/**
 * Read the latest on-chain validation attestation for an agent — no wallet
 * required, so any surface can render the "Validated" badge straight from the
 * server. Authoritative source is the on-chain ValidationRegistry; this layers a
 * 60s cache on top (validation is re-runnable, so the badge stays fresh).
 *
 * The registry indexes validations by request hash, and stores the validator's
 * `tag` only once the request has been answered, so an unanswered request is
 * distinguishable from a verdict: we read the agent's recent request hashes, keep
 * the ones answered with our kind, and take the most recently updated. The pinned
 * report URL is NOT in registry storage (the contract only emits it), so callers
 * that want the proof link merge it from the index cache and check it against
 * `proofHash`.
 *
 * Always resolves (never throws) so a badge fetch can't break a page:
 *   - { available: false }          registry not deployed on this chain
 *   - { available: true, exists:false, openRequests }  deployed, no verdict yet
 *   - { available: true, exists:true, passed, score, proofHash, requestHash, … }
 *
 * @param {{ chainId: number, agentId: string|number, kind?: string }} p
 */
export async function resolveLatestValidation({ chainId, agentId, kind = KIND_GLB_SCHEMA }) {
	const meta = CHAIN_BY_ID[chainId];
	const registryAddr = validationRegistryFor(chainId);
	const explorer = meta?.explorer || '';

	const base = {
		chainId,
		agentId: String(agentId),
		kind,
		registry: registryAddr || null,
		available: !!registryAddr,
		exists: false,
	};

	if (!registryAddr) {
		base.reason = 'validation_registry_not_deployed';
		return base;
	}

	const cacheKey = `onchain-validation:${chainId}:${agentId}:${kind}`;
	const cached = await cacheGet(cacheKey);
	if (cached) return cached;

	let provider;
	try {
		provider = await evmFallbackProvider(chainId, { primaryUrl: meta?.rpcUrls?.[0] });
	} catch (err) {
		return { ...base, error: `rpc_init: ${err.message}` };
	}

	const registry = new Contract(registryAddr, VALIDATION_REGISTRY_ABI, provider);
	let hashes;
	try {
		hashes = await _withTimeout(registry.getAgentValidations(BigInt(agentId)), 4000);
	} catch (err) {
		// An agent nobody has ever requested validation for reads as empty, and a
		// chain whose registry predates this agent reverts: both are "no verdict",
		// not an error worth surfacing on a badge.
		const msg = String(err?.shortMessage || err?.reason || err?.message || '');
		if (err?.code === 'CALL_EXCEPTION' || err?.code === 'BAD_DATA') {
			await cacheSet(cacheKey, base, VALIDATION_CACHE_TTL_S);
			return base;
		}
		return { ...base, error: `chain_read: ${msg}` };
	}

	const recent = Array.from(hashes || []).slice(-VALIDATION_SCAN_LIMIT).reverse();
	if (!recent.length) {
		const empty = { ...base, openRequests: 0 };
		await cacheSet(cacheKey, empty, VALIDATION_CACHE_TTL_S);
		return empty;
	}

	const statuses = await Promise.all(
		recent.map((hash) =>
			_withTimeout(registry.getValidationStatus(hash), 4000)
				.then((s) => ({
					requestHash: hash,
					validator: s[0],
					response: Number(s[2]),
					responseHash: s[3],
					tag: s[4],
					lastUpdate: Number(s[5]),
				}))
				.catch(() => null),
		),
	);

	const answered = statuses.filter((s) => s && s.tag === kind);
	if (!answered.length) {
		// Requests exist but none is answered for this kind: an attestation is
		// outstanding, which the badge shows as pending rather than "not validated".
		const openRequests = statuses.filter((s) => s && !s.tag).length;
		const empty = { ...base, openRequests };
		await cacheSet(cacheKey, empty, VALIDATION_CACHE_TTL_S);
		return empty;
	}

	const latest = answered.reduce((a, b) => (b.lastUpdate > a.lastUpdate ? b : a));
	const result = {
		...base,
		exists: true,
		passed: responsePassed(latest.response),
		score: latest.response,
		requestHash: latest.requestHash,
		proofHash: latest.responseHash,
		// The registry emits responseURI but never stores it, so the pinned report
		// link is merged from the index cache (guarded by proofHash) by the caller.
		proofURI: null,
		proofUrlResolved: null,
		validator: _safeAddress(latest.validator),
		validatorExplorer: explorer && latest.validator ? `${explorer}/address/${latest.validator}` : null,
		timestamp: latest.lastUpdate,
		validatedAt: latest.lastUpdate ? new Date(latest.lastUpdate * 1000).toISOString() : null,
	};
	await cacheSet(cacheKey, result, VALIDATION_CACHE_TTL_S);
	return result;
}

/** Invalidate the cached validation badge for an agent (call after a fresh attestation). */
export async function invalidateValidationCache({ chainId, agentId, kind = KIND_GLB_SCHEMA }) {
	await cacheDel(`onchain-validation:${chainId}:${agentId}:${kind}`);
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
