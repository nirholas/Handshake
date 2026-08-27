/**
 * Chain metadata for the ERC-8004 creator UI.
 *
 * Only chains that appear in REGISTRY_DEPLOYMENTS should be listed here.
 * Default: BSC Testnet (chainId 97) — cheapest to experiment on.
 */

import { REGISTRY_DEPLOYMENTS } from './abi.js';

/**
 * @typedef {Object} ChainInfo
 * @property {number} chainId
 * @property {string} name        Display name shown in the selector.
 * @property {string} short       Short label (e.g. "BSC", "Base").
 * @property {string} symbol      Native token symbol.
 * @property {string} explorer    Block explorer base URL (no trailing slash).
 * @property {string} rpc         First public RPC URL (wallet_addEthereumChain and legacy single-URL callers).
 * @property {string[]} rpcUrls   Ordered keyless public RPC hosts; the same-origin
 *                                /api/evm-rpc proxy is prepended at runtime by
 *                                src/shared/evm-rpc-fallback.js. Never a host the
 *                                server chain demotes (eth.llamarpc.com).
 * @property {'mainnet'|'testnet'} kind
 */

/** @type {Record<number, ChainInfo>} */
export const CHAIN_INFO = {
	// ── Mainnets ──────────────────────────────────────────────────────────
	1: {
		chainId: 1,
		name: 'Ethereum',
		short: 'ETH',
		symbol: 'ETH',
		explorer: 'https://etherscan.io',
		rpc: 'https://ethereum-rpc.publicnode.com',
		rpcUrls: [
			'https://ethereum-rpc.publicnode.com',
			'https://eth.drpc.org',
			'https://1rpc.io/eth',
		],
		kind: 'mainnet',
	},
	10: {
		chainId: 10,
		name: 'Optimism',
		short: 'OP',
		symbol: 'ETH',
		explorer: 'https://optimistic.etherscan.io',
		rpc: 'https://optimism-rpc.publicnode.com',
		rpcUrls: [
			'https://optimism-rpc.publicnode.com',
			'https://mainnet.optimism.io',
			'https://optimism.drpc.org',
		],
		kind: 'mainnet',
	},
	56: {
		chainId: 56,
		name: 'BNB Chain',
		short: 'BSC',
		symbol: 'BNB',
		explorer: 'https://bscscan.com',
		rpc: 'https://bsc-rpc.publicnode.com',
		rpcUrls: [
			'https://bsc-rpc.publicnode.com',
			'https://bsc-dataseed.bnbchain.org',
			'https://bsc.drpc.org',
		],
		kind: 'mainnet',
	},
	100: {
		chainId: 100,
		name: 'Gnosis',
		short: 'GNO',
		symbol: 'xDAI',
		explorer: 'https://gnosisscan.io',
		rpc: 'https://gnosis-rpc.publicnode.com',
		rpcUrls: [
			'https://gnosis-rpc.publicnode.com',
			'https://rpc.gnosischain.com',
			'https://gnosis.drpc.org',
		],
		kind: 'mainnet',
	},
	137: {
		chainId: 137,
		name: 'Polygon',
		short: 'MATIC',
		symbol: 'POL',
		explorer: 'https://polygonscan.com',
		rpc: 'https://polygon-bor-rpc.publicnode.com',
		rpcUrls: [
			'https://polygon-bor-rpc.publicnode.com',
			'https://polygon-rpc.com',
			'https://polygon.drpc.org',
		],
		kind: 'mainnet',
	},
	250: {
		chainId: 250,
		name: 'Fantom',
		short: 'FTM',
		symbol: 'FTM',
		explorer: 'https://ftmscan.com',
		rpc: 'https://fantom-rpc.publicnode.com',
		rpcUrls: [
			'https://fantom-rpc.publicnode.com',
			'https://rpc.ftm.tools',
			'https://fantom.drpc.org',
		],
		kind: 'mainnet',
	},
	324: {
		chainId: 324,
		name: 'zkSync Era',
		short: 'zkSync',
		symbol: 'ETH',
		explorer: 'https://explorer.zksync.io',
		rpc: 'https://mainnet.era.zksync.io',
		rpcUrls: [
			'https://mainnet.era.zksync.io',
			'https://zksync.drpc.org',
			'https://1rpc.io/zksync2-era',
		],
		kind: 'mainnet',
	},
	1284: {
		chainId: 1284,
		name: 'Moonbeam',
		short: 'GLMR',
		symbol: 'GLMR',
		explorer: 'https://moonscan.io',
		rpc: 'https://rpc.api.moonbeam.network',
		rpcUrls: [
			'https://rpc.api.moonbeam.network',
			'https://moonbeam-rpc.publicnode.com',
			'https://moonbeam.drpc.org',
		],
		kind: 'mainnet',
	},
	5000: {
		chainId: 5000,
		name: 'Mantle',
		short: 'MNT',
		symbol: 'MNT',
		explorer: 'https://explorer.mantle.xyz',
		rpc: 'https://rpc.mantle.xyz',
		rpcUrls: [
			'https://rpc.mantle.xyz',
			'https://mantle-rpc.publicnode.com',
			'https://mantle.drpc.org',
		],
		kind: 'mainnet',
	},
	8453: {
		chainId: 8453,
		name: 'Base',
		short: 'BASE',
		symbol: 'ETH',
		explorer: 'https://basescan.org',
		rpc: 'https://base-rpc.publicnode.com',
		rpcUrls: [
			'https://base-rpc.publicnode.com',
			'https://mainnet.base.org',
			'https://base.drpc.org',
		],
		kind: 'mainnet',
	},
	42161: {
		chainId: 42161,
		name: 'Arbitrum One',
		short: 'ARB',
		symbol: 'ETH',
		explorer: 'https://arbiscan.io',
		rpc: 'https://arbitrum-one-rpc.publicnode.com',
		rpcUrls: [
			'https://arbitrum-one-rpc.publicnode.com',
			'https://arb1.arbitrum.io/rpc',
			'https://arbitrum.drpc.org',
		],
		kind: 'mainnet',
	},
	42220: {
		chainId: 42220,
		name: 'Celo',
		short: 'CELO',
		symbol: 'CELO',
		explorer: 'https://celoscan.io',
		rpc: 'https://forno.celo.org',
		rpcUrls: [
			'https://forno.celo.org',
			'https://celo.drpc.org',
			'https://1rpc.io/celo',
		],
		kind: 'mainnet',
	},
	43114: {
		chainId: 43114,
		name: 'Avalanche',
		short: 'AVAX',
		symbol: 'AVAX',
		explorer: 'https://snowtrace.io',
		rpc: 'https://avalanche-c-chain-rpc.publicnode.com',
		rpcUrls: [
			'https://avalanche-c-chain-rpc.publicnode.com',
			'https://api.avax.network/ext/bc/C/rpc',
			'https://avalanche.drpc.org',
		],
		kind: 'mainnet',
	},
	59144: {
		chainId: 59144,
		name: 'Linea',
		short: 'LINEA',
		symbol: 'ETH',
		explorer: 'https://lineascan.build',
		rpc: 'https://rpc.linea.build',
		rpcUrls: [
			'https://rpc.linea.build',
			'https://linea-rpc.publicnode.com',
			'https://linea.drpc.org',
		],
		kind: 'mainnet',
	},
	534352: {
		chainId: 534352,
		name: 'Scroll',
		short: 'SCR',
		symbol: 'ETH',
		explorer: 'https://scrollscan.com',
		rpc: 'https://rpc.scroll.io',
		rpcUrls: [
			'https://rpc.scroll.io',
			'https://scroll-rpc.publicnode.com',
			'https://scroll.drpc.org',
		],
		kind: 'mainnet',
	},

	// ── Testnets ──────────────────────────────────────────────────────────
	97: {
		chainId: 97,
		name: 'BSC Testnet',
		short: 'tBSC',
		symbol: 'tBNB',
		explorer: 'https://testnet.bscscan.com',
		rpc: 'https://bsc-testnet-rpc.publicnode.com',
		rpcUrls: [
			'https://bsc-testnet-rpc.publicnode.com',
			'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
			'https://bsc-testnet.drpc.org',
		],
		kind: 'testnet',
	},
	11155111: {
		chainId: 11155111,
		name: 'Ethereum Sepolia',
		short: 'SEP',
		symbol: 'ETH',
		explorer: 'https://sepolia.etherscan.io',
		rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
		rpcUrls: [
			'https://ethereum-sepolia-rpc.publicnode.com',
			'https://rpc.sepolia.org',
			'https://sepolia.drpc.org',
		],
		kind: 'testnet',
	},
	84532: {
		chainId: 84532,
		name: 'Base Sepolia',
		short: 'baseSep',
		symbol: 'ETH',
		explorer: 'https://sepolia.basescan.org',
		rpc: 'https://base-sepolia-rpc.publicnode.com',
		rpcUrls: [
			'https://base-sepolia-rpc.publicnode.com',
			'https://sepolia.base.org',
			'https://base-sepolia.drpc.org',
		],
		kind: 'testnet',
	},
	421614: {
		chainId: 421614,
		name: 'Arbitrum Sepolia',
		short: 'arbSep',
		symbol: 'ETH',
		explorer: 'https://sepolia.arbiscan.io',
		rpc: 'https://arbitrum-sepolia-rpc.publicnode.com',
		rpcUrls: [
			'https://arbitrum-sepolia-rpc.publicnode.com',
			'https://sepolia-rollup.arbitrum.io/rpc',
			'https://arbitrum-sepolia.drpc.org',
		],
		kind: 'testnet',
	},
	11155420: {
		chainId: 11155420,
		name: 'Optimism Sepolia',
		short: 'opSep',
		symbol: 'ETH',
		explorer: 'https://sepolia-optimism.etherscan.io',
		rpc: 'https://optimism-sepolia-rpc.publicnode.com',
		rpcUrls: [
			'https://optimism-sepolia-rpc.publicnode.com',
			'https://sepolia.optimism.io',
			'https://optimism-sepolia.drpc.org',
		],
		kind: 'testnet',
	},
	80002: {
		chainId: 80002,
		name: 'Polygon Amoy',
		short: 'Amoy',
		symbol: 'POL',
		explorer: 'https://amoy.polygonscan.com',
		rpc: 'https://polygon-amoy-bor-rpc.publicnode.com',
		rpcUrls: [
			'https://polygon-amoy-bor-rpc.publicnode.com',
			'https://rpc-amoy.polygon.technology',
			'https://polygon-amoy.drpc.org',
		],
		kind: 'testnet',
	},
	43113: {
		chainId: 43113,
		name: 'Avalanche Fuji',
		short: 'Fuji',
		symbol: 'AVAX',
		explorer: 'https://testnet.snowtrace.io',
		rpc: 'https://avalanche-fuji-c-chain-rpc.publicnode.com',
		rpcUrls: [
			'https://avalanche-fuji-c-chain-rpc.publicnode.com',
			'https://api.avax-test.network/ext/bc/C/rpc',
			'https://avalanche-fuji.drpc.org',
		],
		kind: 'testnet',
	},
};

/** Default chain presented to new users. */
export const DEFAULT_CHAIN_ID = 97; // BSC Testnet

/**
 * @param {number} chainId
 * @returns {ChainInfo|null}
 */
export function getChainInfo(chainId) {
	return CHAIN_INFO[chainId] || null;
}

/**
 * Chains grouped as [mainnets, testnets], in the order users see them in the
 * selector. Only chains with an ERC-8004 deployment are returned.
 * @returns {{mainnets: ChainInfo[], testnets: ChainInfo[]}}
 */
export function supportedChainsGrouped() {
	const mainnets = [];
	const testnets = [];
	for (const [id, info] of Object.entries(CHAIN_INFO)) {
		const chainId = Number(id);
		if (!REGISTRY_DEPLOYMENTS[chainId]?.identityRegistry) continue;
		(info.kind === 'mainnet' ? mainnets : testnets).push(info);
	}
	mainnets.sort((a, b) => a.name.localeCompare(b.name));
	testnets.sort((a, b) => a.name.localeCompare(b.name));
	return { mainnets, testnets };
}

/**
 * Convert a chainId to the 0x-prefixed hex form required by
 * wallet_switchEthereumChain / wallet_addEthereumChain.
 * @param {number} chainId
 * @returns {string}
 */
export function toHexChainId(chainId) {
	return '0x' + Number(chainId).toString(16);
}

/**
 * Ask the connected wallet to switch chains, adding the chain definition if
 * the wallet hasn't seen it before.
 *
 * Throws if the user rejects or no wallet is present.
 * @param {number} chainId
 */
export async function requestSwitchChain(chainId) {
	if (!window.ethereum?.request) {
		throw new Error('No wallet available to switch chains.');
	}
	const info = getChainInfo(chainId);
	if (!info) throw new Error(`Unknown chain: ${chainId}`);

	const hex = toHexChainId(chainId);
	try {
		await window.ethereum.request({
			method: 'wallet_switchEthereumChain',
			params: [{ chainId: hex }],
		});
	} catch (err) {
		// 4902 = chain not added to the wallet yet.
		if (err?.code === 4902 || /unrecognized chain/i.test(err?.message || '')) {
			await window.ethereum.request({
				method: 'wallet_addEthereumChain',
				params: [
					{
						chainId: hex,
						chainName: info.name,
						nativeCurrency: { name: info.symbol, symbol: info.symbol, decimals: 18 },
						rpcUrls: [info.rpc],
						blockExplorerUrls: [info.explorer],
					},
				],
			});
		} else {
			throw err;
		}
	}
}

/**
 * Build an explorer URL for a tx / address / token given a chainId.
 * @param {number} chainId
 * @param {'tx'|'address'|'token'} kind
 * @param {string|number} value
 * @returns {string}
 */
export function explorerUrl(chainId, kind, value) {
	const info = getChainInfo(chainId);
	if (!info) return '';
	switch (kind) {
		case 'tx':
			return `${info.explorer}/tx/${value}`;
		case 'address':
			return `${info.explorer}/address/${value}`;
		case 'token':
			return `${info.explorer}/token/${value}`;
		default:
			return info.explorer;
	}
}
