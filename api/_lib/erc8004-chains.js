/**
 * Server-side mirror of src/erc8004/abi.js REGISTRY_DEPLOYMENTS + chain metadata.
 * Duplicated (rather than importing from src/) so the serverless bundle stays
 * lean and the crawler is insulated from client-only imports in src/erc8004/.
 *
 * Identity Registry deployment: CREATE2-deterministic, same address on every
 * chain — one address per network class (mainnet vs. testnet).
 */

export const IDENTITY_REGISTRY_MAINNET = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const IDENTITY_REGISTRY_TESTNET = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

/**
 * Chains where the ERC-8004 Identity Registry is deployed. Ordered so the most
 * active chains are crawled first when the cron has a time budget.
 */
export const CHAINS = [
	{
		id: 8453,
		name: 'Base',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://basescan.org',
		rpcUrls: [
			'https://mainnet.base.org',
			'https://base.llamarpc.com',
			'https://rpc.ankr.com/base',
			'https://base.publicnode.com',
			'https://1rpc.io/base',
		],
	},
	{
		id: 42161,
		name: 'Arbitrum One',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://arbiscan.io',
		rpcUrls: [
			'https://arb1.arbitrum.io/rpc',
			'https://arbitrum.llamarpc.com',
			'https://rpc.ankr.com/arbitrum',
			'https://arbitrum.publicnode.com',
		],
	},
	{
		id: 56,
		name: 'BNB Chain',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://bscscan.com',
		rpcUrls: [
			'https://bsc-dataseed1.binance.org',
			'https://bsc-dataseed2.binance.org',
			'https://rpc.ankr.com/bsc',
			'https://bsc.publicnode.com',
		],
	},
	{
		id: 1,
		name: 'Ethereum',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://etherscan.io',
		rpcUrls: [
			'https://eth.llamarpc.com',
			'https://cloudflare-eth.com',
			'https://rpc.ankr.com/eth',
			'https://ethereum.publicnode.com',
			'https://1rpc.io/eth',
		],
	},
	{
		id: 10,
		name: 'Optimism',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://optimistic.etherscan.io',
		rpcUrls: [
			'https://mainnet.optimism.io',
			'https://optimism.llamarpc.com',
			'https://rpc.ankr.com/optimism',
			'https://optimism.publicnode.com',
		],
	},
	{
		id: 137,
		name: 'Polygon',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://polygonscan.com',
		rpcUrls: [
			'https://polygon-rpc.com',
			'https://polygon.llamarpc.com',
			'https://rpc.ankr.com/polygon',
			'https://polygon.publicnode.com',
		],
	},
	{
		id: 43114,
		name: 'Avalanche',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://snowtrace.io',
		rpcUrls: ['https://api.avax.network/ext/bc/C/rpc', 'https://rpc.ankr.com/avalanche'],
	},
	{
		id: 100,
		name: 'Gnosis',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://gnosisscan.io',
		rpcUrls: ['https://rpc.gnosischain.com', 'https://rpc.ankr.com/gnosis'],
	},
	{
		id: 250,
		name: 'Fantom',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://ftmscan.com',
		rpcUrls: ['https://rpc.ankr.com/fantom', 'https://rpcapi.fantom.network'],
	},
	{
		id: 42220,
		name: 'Celo',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://celoscan.io',
		rpcUrls: ['https://forno.celo.org', 'https://rpc.ankr.com/celo'],
	},
	{
		id: 59144,
		name: 'Linea',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://lineascan.build',
		rpcUrls: ['https://rpc.linea.build', 'https://linea.drpc.org'],
	},
	{
		id: 534352,
		name: 'Scroll',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://scrollscan.com',
		rpcUrls: ['https://rpc.scroll.io', 'https://rpc.ankr.com/scroll'],
	},
	{
		id: 5000,
		name: 'Mantle',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://explorer.mantle.xyz',
		rpcUrls: ['https://rpc.mantle.xyz', 'https://mantle.drpc.org'],
	},
	{
		id: 324,
		name: 'zkSync Era',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://explorer.zksync.io',
		rpcUrls: ['https://mainnet.era.zksync.io', 'https://zksync.drpc.org'],
	},
	{
		id: 1284,
		name: 'Moonbeam',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://moonbeam.moonscan.io',
		rpcUrls: ['https://rpc.api.moonbeam.network', 'https://rpc.ankr.com/moonbeam'],
	},
	{
		id: 97,
		name: 'BSC Testnet',
		testnet: true,
		registry: IDENTITY_REGISTRY_TESTNET,
		explorer: 'https://testnet.bscscan.com',
		rpcUrls: ['https://data-seed-prebsc-1-s1.bnbchain.org:8545', 'https://data-seed-prebsc-2-s1.bnbchain.org:8545'],
	},
	{
		id: 84532,
		name: 'Base Sepolia',
		testnet: true,
		registry: IDENTITY_REGISTRY_TESTNET,
		explorer: 'https://sepolia.basescan.org',
		rpcUrls: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com', 'https://rpc.ankr.com/base_sepolia'],
	},
	{
		id: 421614,
		name: 'Arbitrum Sepolia',
		testnet: true,
		registry: IDENTITY_REGISTRY_TESTNET,
		explorer: 'https://sepolia.arbiscan.io',
		rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia.publicnode.com'],
	},
	{
		id: 11155111,
		name: 'Ethereum Sepolia',
		testnet: true,
		registry: IDENTITY_REGISTRY_TESTNET,
		explorer: 'https://sepolia.etherscan.io',
		rpcUrls: ['https://rpc2.sepolia.org', 'https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.ankr.com/eth_sepolia'],
	},
	{
		id: 11155420,
		name: 'Optimism Sepolia',
		testnet: true,
		registry: IDENTITY_REGISTRY_TESTNET,
		explorer: 'https://sepolia-optimism.etherscan.io',
		rpcUrls: ['https://sepolia.optimism.io', 'https://optimism-sepolia.publicnode.com'],
	},
	{
		id: 80002,
		name: 'Polygon Amoy',
		testnet: true,
		registry: IDENTITY_REGISTRY_TESTNET,
		explorer: 'https://amoy.polygonscan.com',
		rpcUrls: ['https://rpc-amoy.polygon.technology', 'https://polygon-amoy.drpc.org'],
	},
	{
		id: 43113,
		name: 'Avalanche Fuji',
		testnet: true,
		registry: IDENTITY_REGISTRY_TESTNET,
		explorer: 'https://testnet.snowtrace.io',
		rpcUrls: ['https://api.avax-test.network/ext/bc/C/rpc', 'https://rpc.ankr.com/avalanche_fuji'],
	},
];

export const CHAIN_BY_ID = Object.fromEntries(CHAINS.map((c) => [c.id, c]));

export function tokenExplorerUrl(chainId, agentId) {
	const c = CHAIN_BY_ID[chainId];
	if (!c) return null;
	return `${c.explorer}/token/${c.registry}?a=${agentId}`;
}

export function addressExplorerUrl(chainId, address) {
	const c = CHAIN_BY_ID[chainId];
	if (!c) return null;
	return `${c.explorer}/address/${address}`;
}
