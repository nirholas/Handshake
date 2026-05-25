/**
 * ERC-8004 Registry ABIs.
 *
 * Only the functions needed for agent registration, reputation, and validation.
 * Full spec: https://eips.ethereum.org/EIPS/eip-8004
 */

export const IDENTITY_REGISTRY_ABI = [
	// --- Registration ---
	'function register(string agentURI) external returns (uint256 agentId)',
	'function register(string agentURI, tuple(string metadataKey, bytes metadataValue)[] metadata) external returns (uint256 agentId)',
	'function register() external returns (uint256 agentId)',

	// --- URI ---
	'function setAgentURI(uint256 agentId, string newURI) external',
	'function tokenURI(uint256 agentId) external view returns (string)',

	// --- Wallet ---
	'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature) external',
	'function getAgentWallet(uint256 agentId) external view returns (address)',
	'function unsetAgentWallet(uint256 agentId) external',
	'function nonces(address owner) external view returns (uint256)',
	'function DOMAIN_SEPARATOR() external view returns (bytes32)',

	// --- Metadata ---
	'function getMetadata(uint256 agentId, string metadataKey) external view returns (bytes)',
	'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue) external',

	// --- ERC-721 basics ---
	'function ownerOf(uint256 tokenId) external view returns (address)',
	'function balanceOf(address owner) external view returns (uint256)',
	'function totalSupply() external view returns (uint256)',
	'function isAgent(uint256 agentId) external view returns (bool)',

	// --- Events ---
	'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
	'event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)',
	'event WalletSet(uint256 indexed agentId, address indexed wallet)',
	'event WalletUnset(uint256 indexed agentId)',
	'event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)',
	'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

export const REPUTATION_REGISTRY_ABI = [
	// --- Submit ---
	'function submitFeedback(uint256 agentId, int8 score, string uri) external',

	// --- Query ---
	'function getReputation(uint256 agentId) external view returns (int256 avgX100, uint256 count)',
	'function getFeedbackCount(uint256 agentId) external view returns (uint256)',
	'function getFeedback(uint256 agentId, uint256 index) external view returns (tuple(address from, int8 score, uint64 timestamp, string uri))',
	'function getFeedbackRange(uint256 agentId, uint256 offset, uint256 limit) external view returns (tuple(address from, int8 score, uint64 timestamp, string uri)[])',
	'function hasReviewed(uint256 agentId, address reviewer) external view returns (bool)',

	// --- Events ---
	'event FeedbackSubmitted(uint256 indexed agentId, address indexed from, int8 score, string uri)',
];

export const VALIDATION_REGISTRY_ABI = [
	// --- Admin ---
	'function addValidator(address v) external',
	'function removeValidator(address v) external',
	'function isValidator(address v) external view returns (bool)',
	'function owner() external view returns (address)',
	'function transferOwnership(address newOwner) external',

	// --- Record ---
	'function recordValidation(uint256 agentId, bool passed, bytes32 proofHash, string proofURI, string kind) external',

	// --- Query ---
	'function getValidationCount(uint256 agentId) external view returns (uint256)',
	'function getValidation(uint256 agentId, uint256 index) external view returns (tuple(address validator, bool passed, bytes32 proofHash, string proofURI, uint64 timestamp, string kind))',
	'function getLatestByKind(uint256 agentId, string kind) external view returns (tuple(address validator, bool passed, bytes32 proofHash, string proofURI, uint64 timestamp, string kind))',
	'function getValidationRange(uint256 agentId, uint256 offset, uint256 limit) external view returns (tuple(address validator, bool passed, bytes32 proofHash, string proofURI, uint64 timestamp, string kind)[])',

	// --- Events ---
	'event ValidatorAdded(address indexed validator)',
	'event ValidatorRemoved(address indexed validator)',
	'event ValidationRecorded(uint256 indexed agentId, address indexed validator, bool passed, bytes32 proofHash, string kind)',
];

// Canonical ERC-8004 reference deployments — same address on every chain via
// CREATE2. Source: https://github.com/nirholas/erc8004-agents
//
// `null` for a registry means it has not yet been deployed on this network
// tier. Callers should resolve via `getRegistry(chainId, kind)` below, which
// reads `THREE_WS_REGISTRY_<KIND>_<CHAIN_ID>` env overrides first and throws
// a clear error rather than returning empty/zero, preventing accidental
// "send to nothing" txs.

const TESTNET = {
	identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
	reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
	validationRegistry: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
};

const MAINNET = {
	identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
	reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
	validationRegistry: null,
};

/**
 * Known deployments keyed by chainId.
 * Format follows agentRegistry spec: eip155:{chainId}:{address}
 */
export const REGISTRY_DEPLOYMENTS = {
	// Mainnets
	1: MAINNET, // Ethereum
	10: MAINNET, // Optimism
	56: MAINNET, // BSC
	100: MAINNET, // Gnosis
	137: MAINNET, // Polygon
	250: MAINNET, // Fantom
	324: MAINNET, // zkSync Era
	1284: MAINNET, // Moonbeam
	5000: MAINNET, // Mantle
	8453: MAINNET, // Base
	42161: MAINNET, // Arbitrum One
	42220: MAINNET, // Celo
	43114: MAINNET, // Avalanche
	59144: MAINNET, // Linea
	534352: MAINNET, // Scroll

	// Testnets
	97: TESTNET, // BSC Testnet
	11155111: TESTNET, // Ethereum Sepolia
	84532: TESTNET, // Base Sepolia
	421614: TESTNET, // Arbitrum Sepolia
	11155420: TESTNET, // Optimism Sepolia
	80002: TESTNET, // Polygon Amoy
	43113: TESTNET, // Avalanche Fuji
};

/**
 * Build the agentRegistry string per spec.
 * @param {number} chainId
 * @param {string} registryAddress
 * @returns {string}  e.g. "eip155:8453:0x742..."
 */
export function agentRegistryId(chainId, registryAddress) {
	return `eip155:${chainId}:${registryAddress}`;
}

/**
 * Resolve a registry address for a chain with an env override path. Throws
 * if no real address is available rather than returning an empty/falsy
 * value that would silently land at the zero address.
 *
 * Env: `THREE_WS_REGISTRY_<KIND>_<chainId>=0x…` where KIND is one of
 * IDENTITY / REPUTATION / VALIDATION.
 *
 * @param {number} chainId
 * @param {'identityRegistry'|'reputationRegistry'|'validationRegistry'} kind
 * @returns {string} 0x EVM address
 */
export function getRegistry(chainId, kind) {
	const slug = {
		identityRegistry: 'IDENTITY',
		reputationRegistry: 'REPUTATION',
		validationRegistry: 'VALIDATION',
	}[kind];
	if (!slug) throw new Error(`unknown_registry_kind: ${kind}`);
	if (typeof process !== 'undefined' && process.env) {
		const env = process.env[`THREE_WS_REGISTRY_${slug}_${chainId}`];
		if (env && /^0x[0-9a-fA-F]{40}$/.test(env.trim())) return env.trim();
	}
	const deployments = REGISTRY_DEPLOYMENTS[chainId];
	const addr = deployments?.[kind];
	if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
		throw new Error(
			`erc8004_not_deployed: ${kind} is not available on chain ${chainId}. ` +
				`Set THREE_WS_REGISTRY_${slug}_${chainId}=0x… to opt in.`,
		);
	}
	return addr;
}
