# ERC-8004 Smart Contracts

Three Solidity contracts make up the ERC-8004 registry system for three.ws identities. This document covers the contract interfaces, deployed addresses, how to read from and write to each registry using ethers.js v6, and how to deploy your own instance.

| Contract | Source | Purpose |
|---|---|---|
| `IdentityRegistry` | `contracts/src/IdentityRegistry.sol` | ERC-721 token registry, register and resolve three.ws identities on-chain |
| `ReputationRegistry` | `contracts/src/ReputationRegistry.sol` | Submit and aggregate signed feedback scores for agents |
| `ValidationRegistry` | `contracts/src/ValidationRegistry.sol` | Record immutable attestations of off-chain validation results (glTF schema, behavioral tests, etc.) |

All contracts are Solidity `^0.8.24`, compiled with the optimizer at 200 runs, and built on OpenZeppelin. Source is in [`contracts/src/`](../contracts/src/). ABIs and deployed addresses are in [`src/erc8004/abi.js`](../src/erc8004/abi.js).

---

## Deployed Addresses

Contracts are deployed at the same address on every supported EVM chain, using CREATE2 deterministic deployment. There are two address sets: mainnet and testnet.

> **The addresses below do not run this repository's source.** All three canonical registries are ERC-1967 proxies in front of the ERC-8004 **reference upgradeable** implementations. `contracts/src/*.sol` in this repo is a superset design that is deployed nowhere, so several members documented in the interface sections further down exist only if you deploy the repo contracts yourself. An `eth_call` sweep on 2026-08-15 against Base (8453) and Base Sepolia (84532) confirmed:
>
> | Member | Deployed registry | Repo source |
> |---|---|---|
> | `name`, `symbol`, `ownerOf`, `balanceOf`, `tokenURI`, `register`, `setAgentURI`, `setMetadata`, `setAgentWallet` | yes | yes |
> | `getMetadata`, `getAgentWallet`, `supportsInterface` | Base Sepolia only (the mainnet implementation is older) | yes |
> | `totalSupply`, `tokenOfOwnerByIndex` (ERC-721 Enumerable) | **no**, reverts | yes |
> | `isAgent`, `DOMAIN_SEPARATOR` | **no**, reverts | yes |
> | `deposit`, `withdraw`, `agentBalance`, `setSpendAllowance`, `spend` (ETH escrow) | **no**, reverts | yes |
> | every `ReputationRegistry` member documented below (`submitFeedback`, `getReputation`, `hasReviewed`, `getFeedbackCount`, `getFeedback`, `getFeedbackRange`, `stakeReputation`, `withdrawStake`) | **no**, reverts; the deployed reputation registry exposes the reference `readFeedback` / `getClients` interface instead | yes |
>
> Re-run the sweep before relying on any row: implementations sit behind upgradeable proxies and can change without the address changing. `contracts/DEPLOYMENTS.md` carries the per-chain liveness record.

### Mainnet

Chains with confirmed bytecode: Ethereum (1), Optimism (10), BSC (56), Gnosis (100), Polygon (137), Mantle (5000), Base (8453), Arbitrum One (42161), Celo (42220), Avalanche (43114), Linea (59144), Scroll (534352).

Fantom (250), zkSync Era (324), and Moonbeam (1284) are listed in `REGISTRY_DEPLOYMENTS` for address parity but have **no contract code yet** (an `eth_getCode` sweep on 2026-06-19 returned empty on all three; zkSync Era additionally derives CREATE2 addresses differently, so the canonical address is unreachable there without a chain-specific deploy). Writes on those chains revert until the registries are deployed. See [`contracts/DEPLOYMENTS.md`](../contracts/DEPLOYMENTS.md) for the authoritative per-chain status.

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
import { REGISTRY_DEPLOYMENTS } from '@three-ws/sdk';

const { identityRegistry, reputationRegistry, validationRegistry } =
  REGISTRY_DEPLOYMENTS[chainId];
```

### CREATE2 Factory: ThreeWSFactory

Vanity-prefixed CREATE2 deployer used to obtain matching addresses across chains.

| Chain | Address | Deployer EOA |
|---|---|---|
| BSC (56) | `0x00000000D49195AE81759cd247cFeDD9D0B479df` | `0x4022de2D...C0564f402` |
| Base (8453) | `0x00000000D49195AE81759cd247cFeDD9D0B479df` | `0x4022de2D...C0564f402` |
| Arbitrum One (42161) | `0x00000000D49195AE81759cd247cFeDD9D0B479df` | `0x4022de2D...C0564f402` |

The 8-byte zero prefix (`0x00000000…`) saves calldata gas on every call. Source is [`contracts/ThreeWSFactory.sol`](../contracts/ThreeWSFactory.sol) (solc 0.8.35, optimizer 200 runs, MIT, verified on BscScan), with its test at `contracts/test/ThreeWSFactory.t.sol`.

```solidity
function deploy(bytes32 salt, bytes initCode) external returns (address);
function predict(bytes32 salt, bytes32 initCodeHash) external view returns (address);
event Deployed(address indexed addr, bytes32 indexed salt);
```

`deploy` wraps `CREATE2(0, initCode, salt)` and reverts `"create2 failed"` if the resulting address is zero. To replicate the factory's address on another chain, send the same creation tx from the same EOA at the same nonce.

---

## IdentityRegistry

`IdentityRegistry` is the canonical on-chain registry for three.ws identities. Each agent is minted as an ERC-721 token; the token URI points to an ERC-8004 registration JSON (typically hosted on IPFS).

This section describes `contracts/src/IdentityRegistry.sol`. It extends `ERC721Enumerable`, so on an instance you deploy yourself all standard ERC-721 enumeration methods work. The canonical deployed addresses run the reference implementation instead and expose no enumeration: see the deployment note above for exactly which members answer and which revert.

### Registration

Three overloads of `register()` are available depending on how much you want to set at mint time:

```solidity
// Mint with no URI: set it later with setAgentURI
function register() external returns (uint256 agentId)

// Mint and set the agent URI in one transaction
function register(string calldata agentURI) external returns (uint256 agentId)

// Mint, set URI, and write key/value metadata atomically
function register(
    string calldata agentURI,
    MetadataEntry[] calldata metadata
) external returns (uint256 agentId)
```

`agentURI` should be a URL pointing to the ERC-8004 registration JSON, typically `ipfs://Qm...` or an HTTPS URL. The `MetadataEntry` array lets you attach arbitrary bytes under named keys:

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

Key/value metadata store per agent. Values are raw bytes, ABI-encode complex types before writing.

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

### ETH escrow and spend delegation

Repo source only. An agent can hold ETH inside the registry, attributed per `agentId`, and its owner can authorize a spender (typically a delegated server key) to draw on that balance up to a cap. Bare transfers are rejected (`receive`/`fallback` revert with `DirectTransferRejected`) so ETH is always attributed to one agent rather than pooled.

```solidity
// Anyone may fund an agent; the balance is spendable only against that agent.
function deposit(uint256 agentId) external payable

// The NFT owner reclaims unspent deposits.
function withdraw(uint256 agentId, address payable recipient, uint256 amountWei) external

// The NFT owner caps what a spender may draw.
function setSpendAllowance(uint256 agentId, address spender, uint256 maxWei) external

// The spender pays out, bounded by both the allowance and the agent's own balance.
function spend(uint256 agentId, address payable recipient, uint256 amountWei, string calldata memo) external

// Public storage getters
function agentBalance(uint256 agentId) external view returns (uint256)
function spendAllowance(uint256 agentId, address spender) external view returns (uint256)
```

Emits `AgentDeposit`, `AgentWithdrawal`, `SpendAllowanceSet`, and `AgentPayment(agentId, spender, recipient, amountWei, memo)`. Additional errors: `ZeroDeposit`, `InsufficientAgentBalance`, `DirectTransferRejected`, `EthTransferFailed`, `ZeroRecipient`.

### Helpers

```solidity
// Standard ERC-721, present on every deployment
function balanceOf(address owner) external view returns (uint256)
function ownerOf(uint256 tokenId) external view returns (address)

// Repo source only: these revert on the canonical deployed addresses
function isAgent(uint256 agentId) external view returns (bool)
function DOMAIN_SEPARATOR() external view returns (bytes32)
function totalSupply() external view returns (uint256)
function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)
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

// How many agents an address holds
const balance = await registry.balanceOf('0xYourAddress');

// Whether a given agentId is registered. ownerOf reverts for an unminted id,
// which is the portable existence check: isAgent() and totalSupply() are
// ERC721Enumerable/repo-source members and revert on the deployed registries.
const exists = await registry.ownerOf(42).then(() => true, () => false);
```

To list the ids an address owns, index the `Transfer` event rather than calling `tokenOfOwnerByIndex`. Public RPCs cap `eth_getLogs` at a 10,000-block range, so page it:

```js
const latest = await provider.getBlockNumber();
const STEP = 10_000;
const ids = new Set();
for (let to = latest; to > latest - 40_000; to -= STEP) {
  const events = await registry.queryFilter(
    registry.filters.Transfer(null, '0xYourAddress'),
    to - STEP + 1,
    to,
  );
  for (const e of events) ids.add(String(e.args.tokenId));
}
```

Widen the window (or use an indexed provider) to cover the registry's full history rather than a recent slice.

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

**This section describes `contracts/src/ReputationRegistry.sol`, which is deployed nowhere.** The canonical `reputationRegistry` addresses run the ERC-8004 reference implementation, whose interface (`readFeedback`, `getClients`) shares no function with the one below: every call in this section reverts against them. Use it when you deploy the repo contracts yourself, and read the deployment note above before pointing it at a canonical address.

`ReputationRegistry` stores signed feedback about registered agents. Scores are integers in the range `[-100, 100]`: negative scores indicate poor experiences, positive scores indicate good ones. Each `(reviewer, agentId)` pair can only submit once; there is no update path. Agent owners cannot review their own agents. Alongside plain feedback, the contract also exposes an ETH-staked variant (`stakeReputation(uint256 agentId, uint8 score, string comment)` payable, refundable via `withdrawStake(uint256 agentId)`); `submitFeedback` is the path documented here.

The registry holds a reference to `IdentityRegistry`, submitting feedback for an unregistered agentId reverts with `UnknownAgent`.

### Submitting Feedback

```solidity
function submitFeedback(
    uint256 agentId,
    int8 score,         // -100 to +100
    string calldata uri // optional ipfs:// or https:// pointer to review details
) external
```

Reverts with:
- `ScoreOutOfRange`: if `score < -100 || score > 100`
- `UnknownAgent`: if `agentId` is not registered in IdentityRegistry
- `SelfReviewForbidden`: if caller is the agent's NFT owner
- `AlreadyReviewed`: if caller has already reviewed this agent

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
// Returns (average * 100, count): divide avgX100 by 100 to get the real average.
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

`ValidationRegistry` records attestations of off-chain validation results against registered agents. Typical use cases are glTF schema checks, behavioral test results, or any third-party quality signal.

The deployed registry (`REGISTRY_DEPLOYMENTS[chainId].validationRegistry`, testnet only for now) is the ERC-8004 reference `ValidationRegistryUpgradeable`. It is **not** the `contracts/src/ValidationRegistry.sol` in this repo, which is an alternative design that is deployed nowhere; if you read that source expecting the deployed behavior you will write calls that revert. Verify any address before trusting it:

```
npm run verify:erc8004-validation
```

### The two-legged model

There is no validator allowlist. Authority comes from the request instead:

| Call | Who may send it |
| ---- | --------------- |
| `validationRequest(address validator, uint256 agentId, string requestURI, bytes32 requestHash)` | the agent's ERC-721 owner, its per-token approved operator, or an operator approved for all |
| `validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)` | only the validator named in that request |

`requestHash` is an id the requester picks. three.ws derives it so the flow is idempotent: `keccak256(abi.encode(chainId, agentId, kind, subjectHash))`, which means re-validating the same subject answers the same request instead of piling up duplicates.

`response` is a 0..100 score, not a boolean. A binary suite writes 100 for a pass and 0 for a fail, and readers treat 50 and above as a pass (`responsePassed()` in `src/erc8004/validation-report.js`). `tag` carries the validation kind, e.g. `"glb-schema"`.

`validationRequest` reverts with `Not authorized` when the caller has no authority over the agent, and `exists` when that `requestHash` was already used. `validationResponse` reverts with `unknown` for an id the registry has never seen, `not validator` when the sender is not the named validator, and `resp>100` for an out-of-range score.

### Reading validations

```solidity
// Every request id ever opened for an agent, oldest first
function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory)

// Every request id addressed to a validator
function getValidatorRequests(address validator) external view returns (bytes32[] memory)

// One request's state; reverts ("unknown") if the id was never opened.
// An unanswered request returns response 0 with an EMPTY tag: that is pending,
// not a failing verdict.
function getValidationStatus(bytes32 requestHash)
    external view
    returns (
        address validatorAddress,
        uint256 agentId,
        uint8 response,
        bytes32 responseHash,
        string memory tag,
        uint256 lastUpdate
    )

// Aggregate over chosen validators for one tag
function getSummary(uint256 agentId, address[] calldata validators, string calldata tag)
    external view
    returns (uint64 count, uint8 avgResponse)
```

Note what is missing: `responseURI` is emitted in the `ValidationResponse` event but never stored. To link a verdict to its pinned report, read the event or keep your own index, and verify whatever URL you recover against the stored `responseHash`.

Events:

```solidity
event ValidationRequest(
    address indexed validatorAddress,
    uint256 indexed agentId,
    string requestURI,
    bytes32 indexed requestHash
);

event ValidationResponse(
    address indexed validatorAddress,
    uint256 indexed agentId,
    bytes32 indexed requestHash,
    uint8 response,
    string responseURI,
    bytes32 responseHash,
    string tag
);
```

### Recording from ethers.js

```js
import { ethers, keccak256, toUtf8Bytes } from 'ethers';
import { VALIDATION_REGISTRY_ABI, REGISTRY_DEPLOYMENTS } from './src/erc8004/abi.js';
import { validationRequestHash, responseForPassed } from './src/erc8004/validation-report.js';

const chainId = 84532; // Base Sepolia
const valRegistry = new ethers.Contract(
  REGISTRY_DEPLOYMENTS[chainId].validationRegistry,
  VALIDATION_REGISTRY_ABI,
  signer, // the agent's owner or operator for leg 1; the named validator for leg 2
);

const proofHash = keccak256(toUtf8Bytes(JSON.stringify(validationReport)));
const passed = validationReport.issues.numErrors === 0;
const proofURI = 'ipfs://QmYourPinnedReport'; // or '' to omit
const requestHash = validationRequestHash({ chainId, agentId: 42, seed: proofHash });

// Leg 1: the owner opens the request (skip when it already exists).
await (await valRegistry.validationRequest(validatorAddress, 42, proofURI, requestHash)).wait();

// Leg 2: the named validator answers it.
await (await valRegistry.validationResponse(
  requestHash,
  responseForPassed(passed), // 100 or 0
  proofURI,
  proofHash,
  'glb-schema',
)).wait();
```

`recordValidation()` in `src/erc8004/validation-recorder.js` wraps both legs for the common case where one wallet owns the agent and validates it.

### Verifying a Validation

```js
import { responsePassed } from './src/erc8004/validation-report.js';

// The latest answered glb-schema attestation for agent 42
const hashes = await valRegistry.getAgentValidations(42);
const statuses = await Promise.all(hashes.map((h) => valRegistry.getValidationStatus(h)));
const answered = statuses.filter((s) => s[4] === 'glb-schema');
const record = answered.sort((a, b) => Number(b[5]) - Number(a[5]))[0];

// Re-run the validator on the current GLB, then re-hash the output
const freshReport = await runGlbValidator(glbUrl);
const recomputedHash = keccak256(toUtf8Bytes(JSON.stringify(freshReport)));

console.log('Passes:', responsePassed(record[2]), '| Attestation still valid:', recomputedHash === record[3]);
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
forge script script/Deploy.s.sol --rpc-url base_sepolia --private-key "$DEPLOYER_PK"

# Deploy to Base Sepolia and verify on Basescan
forge script script/Deploy.s.sol \
  --rpc-url base_sepolia \
  --private-key "$DEPLOYER_PK" \
  --broadcast \
  --verify

# Deploy to Base mainnet
forge script script/Deploy.s.sol \
  --rpc-url base \
  --private-key "$DEPLOYER_PK" \
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
| `validationRequest` | ~120k | Writes the request plus two index arrays |
| `validationResponse` | ~60k | Updates the request in place |
| All `view` functions | 0 | Free off-chain reads |

On Base at typical gas prices (~0.001 gwei base fee), an agent registration runs to roughly $0.10-$0.25. The same transaction costs 20-50x more on Ethereum mainnet, use Base or another L2 for cost-sensitive flows.

---

## Related

- [ERC-8004 guide](/docs/erc8004) - the higher-level walkthrough of registering three.ws identities on-chain.
- [Reputation system](/docs/reputation) - how feedback scores surface in the product.
- [Validation attestations](/docs/validation) - the off-chain validation flow that writes to `ValidationRegistry`.
- [Register on-chain tutorial](/docs/tutorials/register-onchain) - step-by-step registration from the UI and SDK.
