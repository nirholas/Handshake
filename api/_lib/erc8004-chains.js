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

// ValidationRegistry: the canonical ERC-8004 reference deployment
// (`ValidationRegistryUpgradeable` behind an ERC-1967 proxy), the same family of
// 0x8004-vanity addresses as the Identity Registry above, one address per
// network class. Live on the testnet class (bytecode probed 2026-08-06 on Base
// Sepolia, Sepolia, Arbitrum Sepolia and OP Sepolia). No mainnet deployment
// exists yet, so mainnet stays '' and the badge renders nothing there.
//
// This is NOT contracts/src/ValidationRegistry.sol. That contract is ours and is
// deployed nowhere; the address below answers a different, standard interface
// (request/response, no validator allow-list), which is what the ABI below and
// api/_lib/validation-attest.js target. Never point these constants at an
// address without first probing its bytecode for the selectors we call.
export const VALIDATION_REGISTRY_MAINNET = '';
export const VALIDATION_REGISTRY_TESTNET = '0x8004Cb1BF31DAf7788923b405b754f57acEB4272';

/**
 * Minimal human-readable ValidationRegistry ABI for server reads + attestations.
 * Mirrors the deployed `ValidationRegistryUpgradeable`.
 *
 * The model is two-legged and deliberate: the agent's ERC-721 owner (or an
 * approved operator) opens a request naming a validator, and only that validator
 * can answer it. `response` is a 0..100 score, and `responseURI` is emitted in
 * the event but NOT stored, so the pinned report URL cannot be read back from
 * storage. `tag` is stored and is where our validation kind lives.
 */
export const VALIDATION_REGISTRY_ABI = [
	'function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash) external',
	'function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag) external',
	'function getValidationStatus(bytes32 requestHash) external view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)',
	'function getAgentValidations(uint256 agentId) external view returns (bytes32[])',
	'function getValidatorRequests(address validatorAddress) external view returns (bytes32[])',
	'function getSummary(uint256 agentId, address[] validatorAddresses, string tag) external view returns (uint64 count, uint8 avgResponse)',
	'function getIdentityRegistry() external view returns (address)',
	'event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)',
	'event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)',
];

/**
 * Chains where the ERC-8004 Identity Registry is deployed. Ordered so the most
 * active chains are crawled first when the cron has a time budget.
 *
 * `rpcUrls` is the KEYLESS tail of the failover chain built in
 * api/_lib/evm/rpc.js (`evmRpcEndpoints`): an explicit RPC_URL_<chainId>
 * override and Alchemy are tried first, and these back them up. Because they
 * are the fallback of last resort, a dead entry here is not harmless — it is
 * tried on every call that got that far, and a host that accepts the connection
 * then stalls burns the caller's whole timeout budget.
 *
 * **Ankr's keyless public RPCs are gone.** Probed live 2026-07-29: every
 * `rpc.ankr.com/*` endpoint we listed now answers `-32000 Unauthorized: You
 * must authenticate` (or a malformed error body) for both `eth_blockNumber` and
 * `eth_call`-class reads. All 14 dead entries were removed; where that would
 * have left a chain with a single rung, a live-probed dRPC/publicnode endpoint
 * replaced it, because no external dependency may be a single point of failure.
 * `rpc.ankr.com/celo` still answers and is kept — verify before re-adding any
 * other Ankr host.
 *
 * When adding an endpoint here, probe it with a HEAVY method (`eth_call` or
 * `eth_getBalance`), not just `eth_blockNumber`. Several free tiers serve the
 * cheap call and time out on the real one; eth.drpc.org does exactly that, which
 * is why it is no longer first for mainnet.
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
			'https://base.drpc.org',
			'https://1rpc.io/base',
			'https://base-rpc.publicnode.com',
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
			'https://arbitrum.drpc.org',
			'https://1rpc.io/arb',
			'https://arbitrum-rpc.publicnode.com',
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
			'https://bsc.drpc.org',
			'https://bsc-rpc.publicnode.com',
		],
	},
	{
		id: 1,
		name: 'Ethereum',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://etherscan.io',
		// Mainnet public RPCs are the most restrictive/latent on eth_getLogs; use a
		// smaller scan window than the global default so a single call stays fast.
		// Keyless set probed live from a datacenter IP. Dropped: eth.llamarpc.com
		// (Cloudflare bot-wall 403s server-side POSTs), cloudflare-eth.com
		// (endpoint sunset, -32046) and rpc.ankr.com/eth (see the Ankr note on CHAINS above).
		// Re-probed 2026-07-29 across BOTH eth_blockNumber and an eth_call-class
		// read: eth.drpc.org answers the cheap call but returns "Request timeout on
		// the free plan" (-32030) on the heavier one, so it is no longer first — it
		// was, and it cost every ENS resolve most of its budget. publicnode 403'd
		// from the old Vercel IPs so it stays last as best-effort.
		blockChunk: 500,
		rpcUrls: [
			'https://1rpc.io/eth',
			'https://rpc.mevblocker.io',
			'https://eth.drpc.org',
			'https://ethereum-rpc.publicnode.com',
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
			'https://optimism.drpc.org',
			'https://1rpc.io/op',
			'https://optimism-rpc.publicnode.com',
		],
	},
	{
		id: 137,
		name: 'Polygon',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://polygonscan.com',
		// High block rate + busy public RPCs; cap eth_getLogs ranges below default.
		blockChunk: 500,
		rpcUrls: [
			'https://polygon-rpc.com',
			'https://polygon.drpc.org',
			'https://1rpc.io/matic',
			'https://polygon-bor-rpc.publicnode.com',
		],
	},
	{
		id: 43114,
		name: 'Avalanche',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://snowtrace.io',
		rpcUrls: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche.drpc.org', 'https://avalanche-c-chain-rpc.publicnode.com'],
	},
	{
		id: 100,
		name: 'Gnosis',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://gnosisscan.io',
		rpcUrls: ['https://rpc.gnosischain.com', 'https://gnosis.drpc.org', 'https://gnosis-rpc.publicnode.com'],
	},
	{
		id: 250,
		name: 'Fantom',
		testnet: false,
		registry: IDENTITY_REGISTRY_MAINNET,
		explorer: 'https://ftmscan.com',
		rpcUrls: ['https://rpcapi.fantom.network', 'https://fantom.drpc.org'],
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
		rpcUrls: ['https://rpc.scroll.io', 'https://scroll.drpc.org', 'https://scroll-rpc.publicnode.com'],
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
		rpcUrls: ['https://rpc.api.moonbeam.network', 'https://moonbeam.drpc.org', 'https://moonbeam-rpc.publicnode.com'],
	},
	{
		id: 97,
		name: 'BSC Testnet',
		testnet: true,
		registry: IDENTITY_REGISTRY_TESTNET,
		explorer: 'https://testnet.bscscan.com',
		// PublicNode leads because the bnbchain data-seed nodes answer
		// eth_blockNumber fine but refuse EVERY eth_getLogs with `-32005 limit
		// exceeded`, down to a single-block range. That is a plan limit on the
		// method, not a range the crawl can shrink into, so with only data-seed
		// lanes configured this chain could never index a single log. Verified
		// 2026-08-14: publicnode serves 2,000-block getLogs here.
		rpcUrls: [
			'https://bsc-testnet-rpc.publicnode.com',
			'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
			'https://data-seed-prebsc-2-s1.bnbchain.org:8545',
		],
	},
	{
		id: 84532,
		name: 'Base Sepolia',
		testnet: true,
		registry: IDENTITY_REGISTRY_TESTNET,
		explorer: 'https://sepolia.basescan.org',
		rpcUrls: [
			'https://sepolia.base.org',
			'https://base-sepolia.drpc.org',
			'https://base-sepolia.gateway.tenderly.co',
			'https://base-sepolia-rpc.publicnode.com',
		],
	},
	{
		id: 421614,
		name: 'Arbitrum Sepolia',
		testnet: true,
		registry: IDENTITY_REGISTRY_TESTNET,
		explorer: 'https://sepolia.arbiscan.io',
		// `arbitrum-sepolia.publicnode.com` (bare host) has no RPC service — it 403s
		// every call. PublicNode serves testnets at the `<chain>-rpc` subdomain.
		rpcUrls: [
			'https://sepolia-rollup.arbitrum.io/rpc',
			'https://arbitrum-sepolia.drpc.org',
			'https://arbitrum-sepolia.gateway.tenderly.co',
			'https://arbitrum-sepolia-rpc.publicnode.com',
		],
	},
	{
		id: 11155111,
		name: 'Ethereum Sepolia',
		testnet: true,
		registry: IDENTITY_REGISTRY_TESTNET,
		explorer: 'https://sepolia.etherscan.io',
		// rpc2.sepolia.org is dead (no route). Lead with dRPC + ethPandaOps + Tenderly,
		// all verified serving eth_getLogs keyless; publicnode last (Vercel-IP 403s).
		rpcUrls: [
			'https://sepolia.drpc.org',
			'https://1rpc.io/sepolia',
			'https://rpc.sepolia.ethpandaops.io',
			'https://sepolia.gateway.tenderly.co',
			'https://ethereum-sepolia-rpc.publicnode.com',
		],
	},
	{
		id: 11155420,
		name: 'Optimism Sepolia',
		testnet: true,
		registry: IDENTITY_REGISTRY_TESTNET,
		explorer: 'https://sepolia-optimism.etherscan.io',
		rpcUrls: [
			'https://sepolia.optimism.io',
			'https://optimism-sepolia.drpc.org',
			'https://optimism-sepolia.gateway.tenderly.co',
			'https://optimism-sepolia-rpc.publicnode.com',
		],
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
		rpcUrls: ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com', 'https://avalanche-fuji.drpc.org'],
	},
];

// Decorate each chain with its ValidationRegistry address (deterministic by
// network class). Mainnet entries carry '' until a mainnet deployment exists.
for (const c of CHAINS) {
	c.validationRegistry = c.testnet ? VALIDATION_REGISTRY_TESTNET : VALIDATION_REGISTRY_MAINNET;
}

export const CHAIN_BY_ID = Object.fromEntries(CHAINS.map((c) => [c.id, c]));

/**
 * ValidationRegistry address for a chain, or '' when not yet deployed there.
 * @param {number} chainId
 * @returns {string}
 */
export function validationRegistryFor(chainId) {
	return CHAIN_BY_ID[chainId]?.validationRegistry || '';
}

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
