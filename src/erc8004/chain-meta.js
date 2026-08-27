/**
 * Human-readable metadata for every chain in REGISTRY_DEPLOYMENTS.
 *
 * Used by:
 *  - Chain switcher (wallet_switchEthereumChain + wallet_addEthereumChain fallback)
 *  - Agent card "View on explorer" links
 *  - Chain dropdown labels
 *
 * Public RPCs below are safe defaults. They work out-of-the-box for
 * wallet_addEthereumChain but may rate-limit on heavy reads — use user-supplied
 * wallet provider for production reads.
 */

import { FallbackProvider, JsonRpcProvider, Network } from 'ethers';

import { REGISTRY_DEPLOYMENTS } from './abi.js';

// `rpcUrl` is the primary public node (also what wallet_addEthereumChain is
// handed); `rpcUrls` lists keyless alternates that readProvider() below fails
// over to. One node rate-limiting a visitor's IP used to blank the agent page,
// the reputation panel and registration with no way to recover.
/** @type {Record<number, { name: string, shortName: string, currency: { name: string, symbol: string, decimals: number }, rpcUrl: string, rpcUrls?: string[], explorer: string, testnet: boolean }>} */
export const CHAIN_META = {
	// ── Mainnets ──────────────────────────────────────────────────────────
	1: {
		name: 'Ethereum',
		shortName: 'ETH',
		currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrl: 'https://ethereum-rpc.publicnode.com',
		rpcUrls: ['https://eth.drpc.org', 'https://1rpc.io/eth', 'https://rpc.ankr.com/eth'],
		explorer: 'https://etherscan.io',
		testnet: false,
	},
	10: {
		name: 'Optimism',
		shortName: 'OP',
		currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrl: 'https://mainnet.optimism.io',
		rpcUrls: ['https://optimism.drpc.org', 'https://1rpc.io/op'],
		explorer: 'https://optimistic.etherscan.io',
		testnet: false,
	},
	56: {
		name: 'BNB Chain',
		shortName: 'BSC',
		currency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
		rpcUrl: 'https://bsc-dataseed.bnbchain.org',
		rpcUrls: ['https://bsc.drpc.org', 'https://1rpc.io/bnb', 'https://bsc-rpc.publicnode.com'],
		explorer: 'https://bscscan.com',
		testnet: false,
	},
	100: {
		name: 'Gnosis',
		shortName: 'GNO',
		currency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
		rpcUrl: 'https://rpc.gnosischain.com',
		rpcUrls: ['https://gnosis.drpc.org'],
		explorer: 'https://gnosisscan.io',
		testnet: false,
	},
	137: {
		name: 'Polygon',
		shortName: 'POL',
		currency: { name: 'POL', symbol: 'POL', decimals: 18 },
		rpcUrl: 'https://polygon-rpc.com',
		rpcUrls: ['https://polygon.drpc.org', 'https://1rpc.io/matic', 'https://polygon-bor-rpc.publicnode.com'],
		explorer: 'https://polygonscan.com',
		testnet: false,
	},
	250: {
		name: 'Fantom',
		shortName: 'FTM',
		currency: { name: 'Fantom', symbol: 'FTM', decimals: 18 },
		rpcUrl: 'https://rpc.ftm.tools',
		rpcUrls: ['https://fantom.drpc.org'],
		explorer: 'https://ftmscan.com',
		testnet: false,
	},
	324: {
		name: 'zkSync Era',
		shortName: 'zkSync',
		currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrl: 'https://mainnet.era.zksync.io',
		rpcUrls: ['https://zksync.drpc.org'],
		explorer: 'https://explorer.zksync.io',
		testnet: false,
	},
	1284: {
		name: 'Moonbeam',
		shortName: 'GLMR',
		currency: { name: 'Glimmer', symbol: 'GLMR', decimals: 18 },
		rpcUrl: 'https://rpc.api.moonbeam.network',
		rpcUrls: ['https://moonbeam.drpc.org'],
		explorer: 'https://moonbeam.moonscan.io',
		testnet: false,
	},
	5000: {
		name: 'Mantle',
		shortName: 'MNT',
		currency: { name: 'Mantle', symbol: 'MNT', decimals: 18 },
		rpcUrl: 'https://rpc.mantle.xyz',
		rpcUrls: ['https://mantle.drpc.org'],
		explorer: 'https://explorer.mantle.xyz',
		testnet: false,
	},
	8453: {
		name: 'Base',
		shortName: 'Base',
		currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrl: 'https://mainnet.base.org',
		rpcUrls: ['https://base.drpc.org', 'https://1rpc.io/base', 'https://base-rpc.publicnode.com'],
		explorer: 'https://basescan.org',
		testnet: false,
	},
	42161: {
		name: 'Arbitrum One',
		shortName: 'ARB',
		currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrl: 'https://arb1.arbitrum.io/rpc',
		rpcUrls: ['https://arbitrum.drpc.org', 'https://1rpc.io/arb', 'https://arbitrum-one-rpc.publicnode.com'],
		explorer: 'https://arbiscan.io',
		testnet: false,
	},
	42220: {
		name: 'Celo',
		shortName: 'CELO',
		currency: { name: 'Celo', symbol: 'CELO', decimals: 18 },
		rpcUrl: 'https://forno.celo.org',
		rpcUrls: ['https://celo.drpc.org'],
		explorer: 'https://celoscan.io',
		testnet: false,
	},
	43114: {
		name: 'Avalanche',
		shortName: 'AVAX',
		currency: { name: 'Avax', symbol: 'AVAX', decimals: 18 },
		rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
		rpcUrls: ['https://avalanche.drpc.org', 'https://1rpc.io/avax/c', 'https://avalanche-c-chain-rpc.publicnode.com'],
		explorer: 'https://snowtrace.io',
		testnet: false,
	},
	59144: {
		name: 'Linea',
		shortName: 'Linea',
		currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrl: 'https://rpc.linea.build',
		rpcUrls: ['https://linea.drpc.org'],
		explorer: 'https://lineascan.build',
		testnet: false,
	},
	534352: {
		name: 'Scroll',
		shortName: 'Scroll',
		currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrl: 'https://rpc.scroll.io',
		rpcUrls: ['https://scroll.drpc.org'],
		explorer: 'https://scrollscan.com',
		testnet: false,
	},

	// ── Testnets ──────────────────────────────────────────────────────────
	97: {
		name: 'BSC Testnet',
		shortName: 'BSCt',
		currency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
		rpcUrl: 'https://bsc-testnet-rpc.publicnode.com',
		rpcUrls: ['https://bsc-testnet.drpc.org'],
		explorer: 'https://testnet.bscscan.com',
		testnet: true,
	},
	11155111: {
		name: 'Ethereum Sepolia',
		shortName: 'Sep',
		currency: { name: 'SepETH', symbol: 'ETH', decimals: 18 },
		rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
		rpcUrls: ['https://sepolia.drpc.org', 'https://1rpc.io/sepolia'],
		explorer: 'https://sepolia.etherscan.io',
		testnet: true,
	},
	84532: {
		name: 'Base Sepolia',
		shortName: 'BaseSep',
		currency: { name: 'SepETH', symbol: 'ETH', decimals: 18 },
		rpcUrl: 'https://sepolia.base.org',
		rpcUrls: ['https://base-sepolia.drpc.org', 'https://base-sepolia-rpc.publicnode.com'],
		explorer: 'https://sepolia.basescan.org',
		testnet: true,
	},
	421614: {
		name: 'Arbitrum Sepolia',
		shortName: 'ArbSep',
		currency: { name: 'SepETH', symbol: 'ETH', decimals: 18 },
		rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
		rpcUrls: ['https://arbitrum-sepolia.drpc.org', 'https://arbitrum-sepolia-rpc.publicnode.com'],
		explorer: 'https://sepolia.arbiscan.io',
		testnet: true,
	},
	11155420: {
		name: 'Optimism Sepolia',
		shortName: 'OpSep',
		currency: { name: 'SepETH', symbol: 'ETH', decimals: 18 },
		rpcUrl: 'https://sepolia.optimism.io',
		rpcUrls: ['https://optimism-sepolia.drpc.org', 'https://optimism-sepolia-rpc.publicnode.com'],
		explorer: 'https://sepolia-optimism.etherscan.io',
		testnet: true,
	},
	80002: {
		name: 'Polygon Amoy',
		shortName: 'Amoy',
		currency: { name: 'POL', symbol: 'POL', decimals: 18 },
		rpcUrl: 'https://rpc-amoy.polygon.technology',
		rpcUrls: ['https://polygon-amoy.drpc.org', 'https://polygon-amoy-bor-rpc.publicnode.com'],
		explorer: 'https://amoy.polygonscan.com',
		testnet: true,
	},
	43113: {
		name: 'Avalanche Fuji',
		shortName: 'Fuji',
		currency: { name: 'Avax', symbol: 'AVAX', decimals: 18 },
		rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
		rpcUrls: ['https://avalanche-fuji.drpc.org', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'],
		explorer: 'https://testnet.snowtrace.io',
		testnet: true,
	},
};

export const DEFAULT_CHAIN_ID = 8453; // Base mainnet

/** @returns {number[]} All chain IDs where both CHAIN_META and REGISTRY_DEPLOYMENTS exist. */
export function supportedChainIds() {
	return Object.keys(CHAIN_META)
		.map(Number)
		.filter((id) => REGISTRY_DEPLOYMENTS[id]);
}

/**
 * Same set as supportedChainIds() but split into mainnets and testnets.
 * @returns {{ mainnets: number[], testnets: number[] }}
 */
export function supportedChainIdsGrouped() {
	const mainnets = [];
	const testnets = [];
	for (const id of supportedChainIds()) {
		(CHAIN_META[id]?.testnet ? testnets : mainnets).push(id);
	}
	return { mainnets, testnets };
}

/** @param {number} chainId */
export function chainIdHex(chainId) {
	return '0x' + chainId.toString(16);
}

/**
 * Switch the injected wallet to `chainId`. If the chain isn't known to the
 * wallet (error 4902), add it via wallet_addEthereumChain then retry switch.
 *
 * @param {number} chainId
 * @param {any} [provider]  Optional EIP-1193 provider (defaults to window.ethereum)
 */
export async function switchChain(chainId, provider) {
	const eth = provider || window.ethereum;
	if (!eth) throw new Error('No wallet provider available');

	const meta = CHAIN_META[chainId];
	if (!meta) throw new Error(`Unknown chainId ${chainId}`);
	const hex = chainIdHex(chainId);

	try {
		await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
	} catch (err) {
		if (
			err &&
			(err.code === 4902 ||
				/Unrecognized chain|not added|add.*chain/i.test(err.message || ''))
		) {
			await eth.request({
				method: 'wallet_addEthereumChain',
				params: [
					{
						chainId: hex,
						chainName: meta.name,
						nativeCurrency: meta.currency,
						rpcUrls: [meta.rpcUrl],
						blockExplorerUrls: [meta.explorer],
					},
				],
			});
			// wallet_addEthereumChain usually auto-switches, but force it to be safe.
			await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
		} else {
			throw err;
		}
	}
}

/** @param {number} chainId @param {string} txHash */
export function txExplorerUrl(chainId, txHash) {
	const m = CHAIN_META[chainId];
	return m ? `${m.explorer}/tx/${txHash}` : '';
}

/** @param {number} chainId @param {string} address */
export function addressExplorerUrl(chainId, address) {
	const m = CHAIN_META[chainId];
	return m ? `${m.explorer}/address/${address}` : '';
}

/** @param {number} chainId @param {string} contract @param {string|number} tokenId */
export function tokenExplorerUrl(chainId, contract, tokenId) {
	const m = CHAIN_META[chainId];
	return m ? `${m.explorer}/token/${contract}?a=${tokenId}` : '';
}

/**
 * Read-only provider for a chain that survives one public node being down,
 * rate-limiting the visitor's IP, or stalling. Every node in `rpcUrl` +
 * `rpcUrls` becomes a JsonRpcProvider pinned to the chain (`staticNetwork`, so
 * no eth_chainId probe per call) and they are combined in a FallbackProvider
 * with quorum 1: the first healthy node answers and a stalled one is passed
 * over after `stallTimeout`.
 *
 * @param {number} chainId
 * @returns {import('ethers').AbstractProvider}
 */
export function readProvider(chainId) {
	const meta = CHAIN_META[chainId];
	if (!meta?.rpcUrl) throw new Error(`No RPC configured for chainId ${chainId}`);
	const urls = [...new Set([meta.rpcUrl, ...(meta.rpcUrls || [])])];
	const network = Network.from(chainId);
	const providers = urls.map((url, i) => ({
		provider: new JsonRpcProvider(url, network, { staticNetwork: network, batchMaxCount: 1 }),
		priority: i + 1,
		stallTimeout: 4_000,
		weight: 1,
	}));
	if (providers.length === 1) return providers[0].provider;
	return new FallbackProvider(providers, network, { quorum: 1 });
}
