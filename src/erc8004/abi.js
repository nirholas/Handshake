/**
 * ERC-8004 Registry ABIs & canonical deployments.
 *
 * Contract addresses below are the canonical ERC-8004 reference deployments
 * shared across every EVM chain (deployed via CREATE2). Source:
 * https://github.com/nirholas/erc8004-agents
 *
 * ValidationRegistry exists on the testnet class only; MAINNET.validationRegistry
 * stays empty until a reference deployment lands on mainnet. Fill it in only after
 * probing the address's bytecode for the selectors in VALIDATION_REGISTRY_ABI: a
 * 0x8004-vanity address is not by itself proof that the contract behind it is the
 * one this ABI describes.
 */

export const IDENTITY_REGISTRY_ABI = [
	// --- Registration ---
	'function register() external returns (uint256 agentId)',
	'function register(string agentURI) external returns (uint256 agentId)',
	'function register(string agentURI, tuple(string metadataKey, bytes metadataValue)[] metadata) external returns (uint256 agentId)',

	// --- URI ---
	'function setAgentURI(uint256 agentId, string newURI) external',
	'function tokenURI(uint256 tokenId) external view returns (string)',

	// --- Metadata ---
	'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue) external',
	'function getMetadata(uint256 agentId, string metadataKey) external view returns (bytes)',

	// --- Wallet ---
	'function getAgentWallet(uint256 agentId) external view returns (address)',

	// --- Agent spend delegation ---
	'function setSpendAllowance(uint256 agentId, address spender, uint256 maxWei) external',
	'function spend(uint256 agentId, address payable recipient, uint256 amountWei, string memo) external',
	'function spendAllowance(uint256 agentId, address spender) external view returns (uint256)',
	'event SpendAllowanceSet(uint256 indexed agentId, address indexed spender, uint256 maxWei)',
	'event AgentPayment(uint256 indexed agentId, address indexed spender, address indexed recipient, uint256 amountWei, string memo)',

	// --- ERC-721 basics ---
	'function ownerOf(uint256 tokenId) external view returns (address)',
	'function balanceOf(address owner) external view returns (uint256)',
	'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
	'function totalSupply() external view returns (uint256)',
	'function name() external view returns (string)',
	'function symbol() external view returns (string)',
	'function getVersion() external pure returns (string)',

	// --- ERC-721 transfer ---
	'function transferFrom(address from, address to, uint256 tokenId) external',
	'function safeTransferFrom(address from, address to, uint256 tokenId) external',
	'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data) external',
	'function approve(address to, uint256 tokenId) external',
	'function setApprovalForAll(address operator, bool approved) external',

	// --- Events ---
	'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
	'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

// Mirrors contracts/src/ReputationRegistry.sol exactly (the deployed bytecode):
//   submitFeedback(uint256, int8 score, string uri)        — score is signed, [-100,100]
//   getReputation(uint256) → (int256 avgX100, uint256 count) — pre-averaged ×100; divide for display
//   FeedbackSubmitted(agentId, from, int8 score, string uri) — `from`, not `submitter`
// The earlier `submitReputation` / `(uint256 totalScore, uint256 count)` shape
// did NOT match the contract: ethers mis-decoded a signed average as a raw total
// and the write selector reverted. Kept byte-identical with sdk/src/erc8004/abi.js.
export const REPUTATION_REGISTRY_ABI = [
	'function submitFeedback(uint256 agentId, int8 score, string uri) external',
	'function getReputation(uint256 agentId) external view returns (int256 avgX100, uint256 count)',
	'function getFeedbackCount(uint256 agentId) external view returns (uint256)',
	'function getFeedback(uint256 agentId, uint256 index) external view returns (tuple(address from, int8 score, uint64 timestamp, string uri))',
	'function getFeedbackRange(uint256 agentId, uint256 offset, uint256 limit) external view returns (tuple(address from, int8 score, uint64 timestamp, string uri)[])',
	'function hasReviewed(uint256 agentId, address reviewer) external view returns (bool)',
	'function stakeReputation(uint256 agentId, uint8 score, string comment) external payable',
	'function withdrawStake(uint256 agentId) external',
	'function getTotalStake(uint256 agentId) external view returns (uint256)',
	'function getStake(uint256 agentId, address staker) external view returns (uint256)',
	'event FeedbackSubmitted(uint256 indexed agentId, address indexed from, int8 score, string uri)',
	'event ReputationStaked(uint256 indexed agentId, address indexed staker, uint8 score, uint256 value)',
	'event StakeWithdrawn(uint256 indexed agentId, address indexed staker, uint256 value)',
];

/**
 * Validation Registry ABI: mirrors the deployed ERC-8004
 * `ValidationRegistryUpgradeable` (and the canonical SDK ABI in
 * sdk/src/erc8004/abi.js). Two-legged by design: the agent's owner (or an
 * approved operator) opens a request naming a validator, and only that validator
 * can answer it with a 0..100 score. `responseURI` is emitted, never stored, so
 * the pinned report link has to come from the event or an index. Mainnet has no
 * Validation Registry deployed yet.
 */
export const VALIDATION_REGISTRY_ABI = [
	'function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash) external',
	'function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag) external',
	'function getValidationStatus(bytes32 requestHash) external view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)',
	'function getAgentValidations(uint256 agentId) external view returns (bytes32[])',
	'function getValidatorRequests(address validatorAddress) external view returns (bytes32[])',
	'function getSummary(uint256 agentId, address[] validatorAddresses, string tag) external view returns (uint64 count, uint8 avgResponse)',
	'event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)',
	'event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)',
];

// ---------------------------------------------------------------------------
// Canonical deployments (same address on every chain)
// ---------------------------------------------------------------------------

const TESTNET = {
	identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
	reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
	validationRegistry: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
};

const MAINNET = {
	identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
	reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
	validationRegistry: '', // not yet deployed on mainnet
};

/**
 * Known deployments keyed by chainId.
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
