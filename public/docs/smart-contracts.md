# ERC-8004 Smart Contracts

Three Solidity contracts make up the ERC-8004 registry system for three.ws identities. This document covers the contract interfaces, deployed addresses, how to read from and write to each registry using ethers.js v6, and how to deploy your own instance.

| Contract | Source | Purpose |
|---|---|---|
| `IdentityRegistry` | `contracts/src/IdentityRegistry.sol` | ERC-721 token registry — register and resolve three.ws identities on-chain |
| `ReputationRegistry` | `contracts/src/ReputationRegistry.sol` | Submit and aggregate signed feedback scores for agents |
| `ValidationRegistry` | `contracts/src/ValidationRegistry.sol` | Record immutable attestations of off-chain validation results (glTF schema, behavioral tests, etc.) |

All contracts are Solidity `^0.8.24`, compiled with the optimizer at 200 runs, and built on OpenZeppelin. Source is in [`contracts/src/`](../../contracts/src/). ABIs and deployed addresses are in [`src/erc8004/abi.js`](../../src/erc8004/abi.js).

---

## Deployed Addresses

Contracts are deployed at the same address on every supported EVM chain, using CREATE2 deterministic deployment. There are two address sets: mainnet and testnet.

### Mainnet

Chains: Ethereum (1), Optimism (10), BSC (56), Gnosis (100), Polygon (137), Fantom (250), zkSync Era (324), Moonbeam (1284), Mantle (5000), Base (8453), Arbitrum One (42161), Celo (42220), Avalanche (43114), Linea (59144), Scroll (534352).

| Contract | Address |
|---|---|
| IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| ValidationRegistry | *(not yet deployed)* |

### Testnet

Chains: BSC Testnet (97), Ethereum Sepolia (11155111), Base Sepolia (84532), Arbitrum Sepolia (421614), Optimism Sepolia (11155420), Polygon Amoy (80002), Avalanche Fuji (43113).

| Contract | Address |
|---|---|
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |

Always read addresses from the SDK rather than hardcoding them:

```js
import { REGISTRY_DEPLOYMENTS } from '@three-ws/sdk/erc8004';

const { identityRegistry, reputationRegistry, validationRegistry } =
  REGISTRY_DEPLOYMENTS[chainId];
```

### CREATE2 Factory — ThreeWSFactory

Vanity-prefixed CREATE2 deployer used to obtain matching addresses across chains.

| Chain | Address | Deployer EOA |
|---|---|---|
| BSC (56) | `0x00000000D49195AE81759cd247cFeDD9D0B479df` | `0x4022de2D...C0564f402` |
| Base (8453) | `0x00000000D49195AE81759cd247cFeDD9D0B479df` | `0x4022de2D...C0564f402` |
| Arbitrum One (42161) | `0x00000000D49195AE81759cd247cFeDD9D0B479df` | `0x4022de2D...C0564f402` |

The 8-byte zero prefix (`0x00000000…`) saves calldata gas on every call. Source is `ThreeWSFactory.sol` (solc 0.8.35, optimizer 200 runs, MIT, verified on BscScan).

```solidity
function deploy(bytes32 salt, bytes initCode) external returns (address);
function predict(bytes32 salt, bytes32 initCodeHash) external view returns (address);
event Deployed(address indexed addr, bytes32 indexed salt);
```

`deploy` wraps `CREATE2(0, initCode, salt)` and reverts `"create2 failed"` if the resulting address is zero. To replicate the factory's address on another chain, send the same creation tx from the same EOA at the same nonce.

---

## IdentityRegistry

`IdentityRegistry` is the canonical on-chain registry for three.ws identities. Each agent is minted as an ERC-721 token; the token URI points to an ERC-8004 registration JSON (typically hosted on IPFS). The contract extends `ERC721Enumerable`, so all standard ERC-721 enumeration methods work.

### Registration

Three overloads of `register()` are available depending on how much you want to set at mint time:

```solidity
// Mint with no URI — set it later with setAgentURI
function register() external returns (uint256 agentId)

// Mint and set the agent URI in one transaction
function register(string calldata agentURI) external returns (uint256 agentId)

// Mint, set URI, and write key/value metadata atomically
function register(
    string calldata agentURI,
    MetadataEntry[] calldata metadata
) external returns (uint256 agentId)
```

`agentURI` should be a URL pointing to the ERC-8004 registration JSON — typically `ipfs://Qm...` or an HTTPS URL. The `MetadataEntry` array lets you attach arbitrary bytes under named keys:

```solidity
struct MetadataEntry {
    string metadataKey;
    bytes metadataValue;
}
```

All three overloads emit:

```solidity
event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
```

### URI Management

```solidity
// Update the registration JSON pointer (owner only)
function setAgentURI(uint256 agentId, string calldata newURI) external

// Read the current URI (standard ERC-721 tokenURI)
function tokenURI(uint256 tokenId) external view returns (string memory)
```

`setAgentURI` emits:

```solidity
event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
```

### Arbitrary Metadata

Key/value metadata store per agent. Values are raw bytes — ABI-encode complex types before writing.

```solidity
// Set a metadata value (owner only)
function setMetadata(
    uint256 agentId,
    string calldata metadataKey,
    bytes calldata metadataValue
) external

// Read a metadata value
function getMetadata(
    uint256 agentId,
    string calldata metadataKey
) external view returns (bytes memory)
```

Emits:

```solidity
event MetadataSet(
    uint256 indexed agentId,
    string indexed indexedMetadataKey,
    string metadataKey,
    bytes metadataValue
);
```

### Wallet Delegation (EIP-712)

An agent NFT owner can bind a separate "hot wallet" address to an agent. The bound wallet can act on behalf of the agent in other contracts. The binding requires an EIP-712 signature from the NFT owner:

```solidity
// Bind a delegated wallet. Requires a valid EIP-712 signature from the token owner.
function setAgentWallet(
    uint256 agentId,
    address newWallet,
    uint256 deadline,
    bytes calldata signature
) external

// Returns the bound wallet, or the owner address if none is set.
function getAgentWallet(uint256 agentId) external view returns (address)

// Remove the bound wallet (owner only)
function unsetAgentWallet(uint256 agentId) external
```

The EIP-712 typehash is:

```
SetAgentWallet(uint256 agentId, address newWallet, uint256 nonce, uint256 deadline)
```

Domain: `name = "ERC8004-IdentityRegistry"`, `version = "1"`.

### Helpers

```solidity
// Check whether an agentId exists
function isAgent(uint256 agentId) external view returns (bool)

// EIP-712 domain separator (useful for off-chain signature construction)
function DOMAIN_SEPARATOR() external view returns (bytes32)

// Standard ERC-721 Enumerable
function totalSupply() external view returns (uint256)
function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)
function balanceOf(address owner) external view returns (uint256)
function ownerOf(uint256 tokenId) external view returns (address)
```

### Errors

```solidity
error NotAgentOwner();     // caller is not the NFT owner
error SignatureExpired();  // deadline < block.timestamp in setAgentWallet
error InvalidSignature();  // signature verification failed in setAgentWallet
error UnknownAgent();      // agentId does not exist
```

### Reading from ethers.js

```js
import { ethers } from 'ethers';
import { IDENTITY_REGISTRY_ABI, REGISTRY_DEPLOYMENTS } from './src/erc8004/abi.js';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const registry = new ethers.Contract(
  REGISTRY_DEPLOYMENTS[8453].identityRegistry,
  IDENTITY_REGISTRY_ABI,
  provider
);

// Resolve a single agent
const owner = await registry.ownerOf(42);
const uri   = await registry.tokenURI(42);

// List all agents owned by an address
const balance = await registry.balanceOf('0xYourAddress');
const ids = [];
for (let i = 0; i < Number(balance); i++) {
  ids.push(await registry.tokenOfOwnerByIndex('0xYourAddress', i));
}

// Check total registered agents
const total = await registry.totalSupply();

// Check whether a given agentId is registered
const exists = await registry.isAgent(42);
```

### Registering from ethers.js

```js
const signer = await provider.getSigner();
const registryWithSigner = registry.connect(signer);

// Option 1: register with a URI in one call
const tx = await registryWithSigner['register(string)'](
  'ipfs://QmYourManifestCid'
);
const receipt = await tx.wait();

// Parse the agentId from the Registered event
const iface = new ethers.Interface(IDENTITY_REGISTRY_ABI);
const log = receipt.logs
  .map(l => { try { return iface.parseLog(l); } catch { return null; } })
  .find(e => e?.name === 'Registered');
const agentId = Number(log.args.agentId);

// Option 2: register + write metadata atomically
const metadata = [
  {
    metadataKey: 'name',
    metadataValue: ethers.toUtf8Bytes('Aria'),
  },
  {
    metadataKey: 'description',
    metadataValue: ethers.toUtf8Bytes('Product guide agent'),
  },
];

const tx2 = await registryWithSigner['register(string,(string,bytes)[])'](
  'ipfs://QmYourManifestCid',
  metadata
);
await tx2.wait();
```

---

## ReputationRegistry

`ReputationRegistry` stores signed feedback about registered agents. Scores are integers in the range `[-100, 100]` — negative scores indicate poor experiences, positive scores indicate good ones. Each `(reviewer, agentId)` pair can only submit once; there is no update path. Agent owners cannot review their own agents.

The registry holds a reference to `IdentityRegistry` — submitting feedback for an unregistered agentId reverts with `UnknownAgent`.

### Submitting Feedback

```solidity
function submitFeedback(
    uint256 agentId,
    int8 score,         // -100 to +100
    string calldata uri // optional ipfs:// or https:// pointer to review details
) external
```

Reverts with:
- `ScoreOutOfRange` — if `score < -100 || score > 100`
- `UnknownAgent` — if `agentId` is not registered in IdentityRegistry
- `SelfReviewForbidden` — if caller is the agent's NFT owner
- `AlreadyReviewed` — if caller has already reviewed this agent

Emits:

```solidity
event FeedbackSubmitted(
    uint256 indexed agentId,
    address indexed from,
    int8 score,
    string uri
);
```

### Reading Reputation

```solidity
// Returns (average * 100, count) — divide avgX100 by 100 to get the real average.
// Returns (0, 0) for agents with no reviews.
function getReputation(uint256 agentId)
    external view
    returns (int256 avgX100, uint256 count)

// Check whether an address has already reviewed an agent
function hasReviewed(uint256 agentId, address reviewer)
    external view
    returns (bool)

// Total number of reviews for an agent
function getFeedbackCount(uint256 agentId) external view returns (uint256)

// Fetch a single review by index
function getFeedback(uint256 agentId, uint256 index)
    external view
    returns (Feedback memory)

// Fetch a slice of reviews
function getFeedbackRange(uint256 agentId, uint256 offset, uint256 limit)
    external view
    returns (Feedback[] memory)
```

### Feedback Struct

```solidity
struct Feedback {
    address from;
    int8 score;        // -100 to +100
    uint64 timestamp;
    string uri;        // optional ipfs:// pointer to review details
}
```

### Reading from ethers.js

```js
import { ethers } from 'ethers';
import { REPUTATION_REGISTRY_ABI, REGISTRY_DEPLOYMENTS } from './src/erc8004/abi.js';

const repRegistry = new ethers.Contract(
  REGISTRY_DEPLOYMENTS[8453].reputationRegistry,
  REPUTATION_REGISTRY_ABI,
  provider
);

// Get the aggregate reputation
const [avgX100, count] = await repRegistry.getReputation(42);
const displayScore = Number(avgX100) / 100;   // e.g. 73.5
console.log(`Score: ${displayScore} (${count} reviews)`);

// Fetch the 10 most recent reviews (newest first by index)
const total = await repRegistry.getFeedbackCount(42);
const offset = total > 10n ? total - 10n : 0n;
const reviews = await repRegistry.getFeedbackRange(42, offset, 10);
reviews.forEach(r => {
  console.log(r.from, r.score, r.uri, new Date(Number(r.timestamp) * 1000));
});

// Check if an address has already reviewed
const reviewed = await repRegistry.hasReviewed(42, '0xReviewerAddress');
```

### Submitting from ethers.js

```js
const repWithSigner = repRegistry.connect(signer);

const tx = await repWithSigner.submitFeedback(
  42,           // agentId
  85,           // score: -100 to +100
  'ipfs://QmReviewDetails'  // uri: optional, pass '' to omit
);
await tx.wait();
```

---

## ValidationRegistry

`ValidationRegistry` records immutable attestations of off-chain validation results against registered agents. Typical use cases are glTF schema checks, behavioral test results, or any third-party quality signal.

Unlike the other two registries, `ValidationRegistry` is **permissioned**: only addresses added to the validator allowlist by the contract owner can call `recordValidation`. If you are building a third-party validator service, you need to be added to the allowlist or deploy your own instance.

The `ValidationRegistry` is deployed on testnets only; mainnet deployment is pending.

### Structs and Storage

```solidity
struct Validation {
    address validator;  // who ran the validation
    bool passed;        // true = zero errors
    bytes32 proofHash;  // keccak256 of the off-chain report JSON
    string proofURI;    // optional ipfs:// or https:// pointer to the full report
    uint64 timestamp;
    string kind;        // free-form tag, e.g. "glb-schema", "a2a-card"
}
```

The `kind` field lets multiple independent validator types coexist for the same agent. The registry tracks the latest record per `(agentId, kind)` for O(1) lookup via `getLatestByKind`.

### Recording a Validation

```solidity
// Caller must be in the isValidator allowlist
function recordValidation(
    uint256 agentId,
    bool passed,
    bytes32 proofHash,
    string calldata proofURI,
    string calldata kind
) external
```

Reverts with:
- `NotValidator` — caller is not in the allowlist
- `UnknownAgent` — agentId is not registered

Emits:

```solidity
event ValidationRecorded(
    uint256 indexed agentId,
    address indexed validator,
    bool passed,
    bytes32 proofHash,
    string kind
);
```

### Reading Validations

```solidity
// Total number of validation records for an agent
function getValidationCount(uint256 agentId) external view returns (uint256)

// Fetch a single record by index
function getValidation(uint256 agentId, uint256 index)
    external view
    returns (Validation memory)

// Fetch the most recent record for a given kind (reverts if none exists)
function getLatestByKind(uint256 agentId, string calldata kind)
    external view
    returns (Validation memory)

// Fetch a slice of records (pagination)
function getValidationRange(uint256 agentId, uint256 offset, uint256 limit)
    external view
    returns (Validation[] memory)
```

### Allowlist Management (owner only)

```solidity
function addValidator(address v) external        // emits ValidatorAdded
function removeValidator(address v) external     // emits ValidatorRemoved
function transferOwnership(address newOwner) external

mapping(address => bool) public isValidator;
address public owner;
```

### Recording from ethers.js

```js
import { ethers } from 'ethers';
import { VALIDATION_REGISTRY_ABI, REGISTRY_DEPLOYMENTS } from './src/erc8004/abi.js';
import { keccak256, toUtf8Bytes } from 'ethers';

const valRegistry = new ethers.Contract(
  REGISTRY_DEPLOYMENTS[84532].validationRegistry,  // testnet: Base Sepolia
  VALIDATION_REGISTRY_ABI,
  signer  // must be allow-listed
);

// Hash the report JSON deterministically
const reportJson = JSON.stringify(validationReport);
const proofHash = keccak256(toUtf8Bytes(reportJson));
const passed = validationReport.issues.numErrors === 0;

// Optionally pin the full report to IPFS first, so verifiers can fetch details
const proofURI = 'ipfs://QmYourPinnedReport';  // or '' to omit

const tx = await valRegistry.recordValidation(
  agentId,
  passed,
  proofHash,
  proofURI,
  'glb-schema'  // kind
);
await tx.wait();
```

### Verifying a Validation

```js
// Fetch the latest glb-schema attestation for agent 42
const record = await valRegistry.getLatestByKind(42, 'glb-schema');

// Re-run the validator on the current GLB, then re-hash the output
const freshReport = await runGlbValidator(glbUrl);
const recomputedHash = keccak256(toUtf8Bytes(JSON.stringify(freshReport)));

const attestationMatches = recomputedHash === record.proofHash;
console.log('Passes:', record.passed, '| Attestation still valid:', attestationMatches);
```

---

## Deploying Your Own Registry

The contracts use Foundry. To deploy a fresh set to a new chain or to run a fork of the registry under your own addresses:

```bash
cd contracts

# Build and run tests
forge build
forge test

# Set environment variables
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
export BASE_RPC_URL=https://mainnet.base.org
export BASESCAN_API_KEY=your_key
export DEPLOYER_PK=0xYourPrivateKey

# Dry run first (no --broadcast)
forge script script/Deploy.s.sol --rpc-url base_sepolia

# Deploy to Base Sepolia and verify on Basescan
forge script script/Deploy.s.sol \
  --rpc-url base_sepolia \
  --broadcast \
  --verify

# Deploy to Base mainnet
forge script script/Deploy.s.sol \
  --rpc-url base \
  --broadcast \
  --verify
```

RPC aliases `base_sepolia` and `base` are pre-configured in `contracts/foundry.toml`. After deploying, update `REGISTRY_DEPLOYMENTS` in `src/erc8004/abi.js` with the new addresses.

Verify the deployed addresses with:

```bash
node scripts/check-erc7710-addresses.js
```

**Note:** The constructor for `ReputationRegistry` takes the `IdentityRegistry` address as a parameter. `ValidationRegistry` takes both the `IdentityRegistry` address and an initial `owner` address. The `Deploy.s.sol` script handles this ordering automatically.

---

## Gas Reference

These are approximate costs at optimizer 200 runs. Actual cost depends on chain base fee and priority fee.

| Operation | ~Gas | Notes |
|---|---|---|
| `register()` | ~80k | Minimal mint, no URI |
| `register(string)` | ~100k | Includes URI write |
| `register(string, MetadataEntry[])` | ~120k+ | Depends on metadata size |
| `setAgentURI` | ~40k | URI update only |
| `setMetadata` | ~35k | Per key/value entry |
| `setAgentWallet` | ~50k | EIP-712 sig verification + storage |
| `submitFeedback` | ~55k | New review; first review costs slightly more |
| `recordValidation` | ~60k | Includes `getLatestByKind` index write |
| All `view` functions | 0 | Free off-chain reads |

On Base at typical gas prices (~0.001 gwei base fee), an agent registration runs to roughly $0.10–$0.25. The same transaction costs 20–50x more on Ethereum mainnet — use Base or another L2 for cost-sensitive flows.
