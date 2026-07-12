// Robinhood Chain — viem chain definitions + read-only public clients.
//
// Robinhood Chain is a permissionless Arbitrum Orbit L2 that settles to
// Ethereum (ETH gas, ~100ms blocks). The three.ws app pins viem ^2.52, which
// predates viem's official `robinhood` / `robinhoodTestnet` chain exports
// (added in 2.55), so we define the chains here with `defineChain` from the
// SAME verified constants the Wave-1 SDK uses (RPC / explorer / multicall3).
// When the app's viem is bumped to ≥2.55 these can be swapped for the official
// exports without touching any handler.
//
// RPC: the public sequencer RPC works for reads out of the box. Set
// ROBINHOOD_RPC_URL (e.g. an Alchemy `robinhood-mainnet.g.alchemy.com/v2/…`
// endpoint) to route through a reliable paid node; ROBINHOOD_TESTNET_RPC_URL
// overrides the testnet RPC. Both fall back to the public endpoints.

import { createPublicClient, defineChain, http, fallback } from 'viem';

// ── verified endpoints (prompts/robinhood-chain/_shared.md, cross-checked
// against the SDK's addresses.ts and live on 2026-07-12) ─────────────────────
export const MAINNET_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const TESTNET_RPC = 'https://rpc.testnet.chain.robinhood.com';
export const MAINNET_EXPLORER = 'https://robinhoodchain.blockscout.com';
export const TESTNET_EXPLORER = 'https://explorer.testnet.chain.robinhood.com';
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

const MAINNET_RPC_URL = process.env.ROBINHOOD_RPC_URL || MAINNET_RPC;
const TESTNET_RPC_URL = process.env.ROBINHOOD_TESTNET_RPC_URL || TESTNET_RPC;

export const robinhood = defineChain({
	id: 4663,
	name: 'Robinhood Chain',
	nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
	rpcUrls: {
		default: { http: [MAINNET_RPC_URL], webSocket: ['wss://feed.mainnet.chain.robinhood.com'] },
	},
	blockExplorers: {
		default: { name: 'Blockscout', url: MAINNET_EXPLORER, apiUrl: `${MAINNET_EXPLORER}/api` },
	},
	contracts: { multicall3: { address: MULTICALL3 } },
});

export const robinhoodTestnet = defineChain({
	id: 46630,
	name: 'Robinhood Chain Testnet',
	testnet: true,
	nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
	rpcUrls: { default: { http: [TESTNET_RPC_URL] } },
	blockExplorers: {
		default: { name: 'Blockscout', url: TESTNET_EXPLORER, apiUrl: `${TESTNET_EXPLORER}/api` },
	},
	contracts: { multicall3: { address: MULTICALL3 } },
});

// One public client per network, created lazily and memoised. Multicall
// batching is on so a 95-token fan-out collapses to one eth_call. When a
// custom RPC is configured we still keep the public sequencer RPC as a
// fallback transport so a paid-node blip degrades to public reads rather than
// erroring the whole handler.
const clients = new Map();

function transportFor(network) {
	const primary = network === 'testnet' ? TESTNET_RPC_URL : MAINNET_RPC_URL;
	const publicRpc = network === 'testnet' ? TESTNET_RPC : MAINNET_RPC;
	const opts = { timeout: 12_000, retryCount: 2 };
	if (primary === publicRpc) return http(primary, opts);
	// Configured node first, public sequencer RPC as the failover leg.
	return fallback([http(primary, opts), http(publicRpc, opts)]);
}

export function hoodClient(network = 'mainnet') {
	const key = network === 'testnet' ? 'testnet' : 'mainnet';
	if (clients.has(key)) return clients.get(key);
	const client = createPublicClient({
		chain: key === 'testnet' ? robinhoodTestnet : robinhood,
		transport: transportFor(key),
		batch: { multicall: { wait: 16, batchSize: 1024 } },
	});
	clients.set(key, client);
	return client;
}

export function explorerFor(network = 'mainnet') {
	return network === 'testnet' ? TESTNET_EXPLORER : MAINNET_EXPLORER;
}

/** Blockscout links for an address / tx on the given network. */
export function explorerLinks(network = 'mainnet') {
	const base = explorerFor(network);
	return {
		address: (a) => `${base}/address/${a}`,
		token: (a) => `${base}/token/${a}`,
		tx: (h) => `${base}/tx/${h}`,
	};
}
