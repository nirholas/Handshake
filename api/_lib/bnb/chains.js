/**
 * BNB Chain constants + resilient RPC client + block-time probe.
 *
 * The single source of truth for every `api/_lib/bnb/*` module and the BNB
 * product surfaces (latency proof, hub, vault, on-chain world). No secrets live
 * here — every RPC URL is a public read endpoint. Mainnet Greenfield hub
 * addresses are copied verbatim from `prompts/bnb-chain/00-CONTEXT.md` (bytecode
 * verified 2026-07-07); never invent an address.
 *
 * Verified facts this module encodes (do not overstate elsewhere): BSC mainnet
 * runs ~0.45s blocks (Fermi hardfork, live 2026-07-07); testnet block time is
 * not a marketing claim, so `probeBlockTime` returns `target: null` there.
 */

import { createPublicClient, fallback, http, getAddress, isAddress } from 'viem';

/**
 * Typed error thrown when every RPC URL for a network is unreachable. Carries
 * the list of URLs tried so a caller can surface a precise 503.
 */
export class BnbRpcError extends Error {
	/** @param {string} message @param {{ network?: string, tried?: string[], cause?: unknown }} [info] */
	constructor(message, info = {}) {
		super(message);
		this.name = 'BnbRpcError';
		this.network = info.network;
		this.tried = info.tried || [];
		if (info.cause) this.cause = info.cause;
	}
}

/**
 * Chain metadata. Two public RPCs minimum per network for failover. Greenfield
 * cross-chain hub addresses are BSC-mainnet-only (verbatim from 00-CONTEXT).
 */
export const BNB_CHAINS = {
	bscMainnet: {
		id: 56,
		name: 'BNB Smart Chain',
		testnet: false,
		nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
		explorer: 'https://bscscan.com',
		rpcs: [
			'https://bsc-dataseed.bnbchain.org',
			'https://bsc-dataseed1.binance.org',
			'https://bsc.drpc.org',
			'https://bsc-rpc.publicnode.com',
			'https://rpc.ankr.com/bsc',
		],
		// Greenfield cross-chain hubs on BSC(56) — bytecode-verified 2026-07-07.
		greenfieldHubs: {
			crossChain: '0x77e719b714be09F70D484AB81F70D02B0E182f7d',
			tokenHub: '0xeA97dF87E6c7F68C9f95A69dA79E19B834823F25',
			bucketHub: '0xE909754263572F71bc6aFAc837646A93f5818573',
			objectHub: '0x634eB9c438b8378bbdd8D0e10970Ec88db0b4d0f',
			groupHub: '0xDd9af4573D64324125fCa5Ce13407be79331B7F7',
			multiMessage: '0x26204702935e2D617EE75B795152B9623a7d9809',
		},
	},
	bscTestnet: {
		id: 97,
		name: 'BNB Smart Chain Testnet',
		testnet: true,
		nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
		explorer: 'https://testnet.bscscan.com',
		rpcs: [
			'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
			'https://data-seed-prebsc-2-s1.bnbchain.org:8545',
			'https://bsc-testnet.drpc.org',
			'https://bsc-testnet.bnbchain.org',
		],
	},
};

const DEFAULT_TIMEOUT_MS = 5000;

/** @returns {'bscMainnet'|'bscTestnet'} normalized network key. Accepts id 56/97 or aliases. */
function normalizeNetwork(network) {
	if (network === 56 || network === '56' || network === 'bsc' || network === 'mainnet') return 'bscMainnet';
	if (network === 97 || network === '97' || network === 'testnet') return 'bscTestnet';
	if (network === 'bscMainnet' || network === 'bscTestnet') return network;
	if (network == null) return 'bscTestnet';
	throw new BnbRpcError(`Unknown BNB network: ${network}`, { tried: [] });
}

/** Build a viem `chain` object from our metadata (no dependency on viem/chains). */
function toViemChain(meta) {
	return {
		id: meta.id,
		name: meta.name,
		nativeCurrency: meta.nativeCurrency,
		rpcUrls: { default: { http: meta.rpcs }, public: { http: meta.rpcs } },
		blockExplorers: { default: { name: 'Explorer', url: meta.explorer } },
		testnet: meta.testnet,
	};
}

const clientCache = new Map();

/**
 * viem public client with ordered RPC failover: requests hit the first healthy
 * URL and only advance on error (viem `fallback`, `rank:false` → deterministic
 * order). Clients are cached per network. Default network `bscTestnet`.
 *
 * @param {'bscMainnet'|'bscTestnet'|56|97} [network]
 * @param {{ rpcs?: string[], transports?: any[], timeoutMs?: number, cache?: boolean }} [opts]
 *   `transports` injects custom viem transports (tests); `rpcs` overrides URLs.
 * @returns {import('viem').PublicClient}
 */
export function getPublicClient(network = 'bscTestnet', opts = {}) {
	const key = normalizeNetwork(network);
	const meta = BNB_CHAINS[key];
	const useCache = opts.cache !== false && !opts.transports && !opts.rpcs;
	if (useCache && clientCache.has(key)) return clientCache.get(key);

	const rpcs = opts.rpcs || meta.rpcs;
	const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
	const transports = opts.transports || rpcs.map((url) => http(url, { timeout, retryCount: 0 }));

	const client = createPublicClient({
		chain: toViemChain(meta),
		transport: fallback(transports, { rank: false, retryCount: 0 }),
	});
	client.bnbNetwork = key;
	client.bnbRpcs = rpcs;
	if (useCache) clientCache.set(key, client);
	return client;
}

/**
 * Measure the observed block time by sampling two blocks `sampleBlocks` apart.
 * Iterates the RPC list manually so total RPC failure raises a typed
 * `BnbRpcError` with every URL tried. `target` is the marketing reference for
 * the network (mainnet 450ms; testnet has no published target → null).
 *
 * @param {'bscMainnet'|'bscTestnet'|56|97} [network]
 * @param {number} [sampleBlocks]
 * @param {{ rpcs?: string[], client?: import('viem').PublicClient, timeoutMs?: number }} [opts]
 * @returns {Promise<{ network:string, avgBlockTimeMs:number, latestBlock:number, sampleBlocks:number, target:number|null, measuredAt:string }>}
 */
export async function probeBlockTime(network = 'bscTestnet', sampleBlocks = 200, opts = {}) {
	const key = normalizeNetwork(network);
	const meta = BNB_CHAINS[key];
	const span = Math.max(1, Math.floor(sampleBlocks));
	const rpcs = opts.rpcs || meta.rpcs;
	const tried = [];
	let lastErr;

	// A caller-provided client (or the injected list) is tried first; otherwise
	// walk each RPC in its own single-transport client so a dead URL is isolated.
	const candidates = opts.client
		? [{ url: opts.client.bnbRpcs?.[0] || 'injected', client: opts.client }]
		: rpcs.map((url) => ({ url, client: getPublicClient(key, { rpcs: [url], timeoutMs: opts.timeoutMs, cache: false }) }));

	for (const { url, client } of candidates) {
		tried.push(url);
		try {
			const latest = await client.getBlock({ blockTag: 'latest' });
			const latestNumber = Number(latest.number);
			const olderNumber = BigInt(Math.max(0, latestNumber - span));
			const older = await client.getBlock({ blockNumber: olderNumber });
			const blocks = latestNumber - Number(older.number);
			const deltaMs = (Number(latest.timestamp) - Number(older.timestamp)) * 1000;
			const avgBlockTimeMs = blocks > 0 ? Math.round((deltaMs / blocks) * 100) / 100 : 0;
			return {
				network: key,
				avgBlockTimeMs,
				latestBlock: latestNumber,
				sampleBlocks: blocks,
				target: key === 'bscMainnet' ? 450 : null,
				measuredAt: new Date().toISOString(),
			};
		} catch (err) {
			lastErr = err;
		}
	}
	throw new BnbRpcError(`All BNB RPCs failed for ${key}`, { network: key, tried, cause: lastErr });
}

/** True for a syntactically valid 0x-prefixed 20-byte EVM address (checksum-agnostic). */
export function isEvmAddress(s) {
	return typeof s === 'string' && isAddress(s, { strict: false });
}

/**
 * Assert `s` is a valid EVM address and return it checksummed. Throws a typed
 * `BnbRpcError`-adjacent TypeError on junk / Solana base58 input.
 * @returns {`0x${string}`}
 */
export function assertBscAddress(s) {
	if (!isEvmAddress(s)) {
		throw new TypeError(`Not a valid BSC/EVM address: ${String(s).slice(0, 64)}`);
	}
	return getAddress(s);
}
