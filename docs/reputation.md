# Reputation System

The reputation system lets anyone leave a permanent, publicly verifiable score for a registered three.ws agent. Scores are stored on the `ReputationRegistry` smart contract (part of the ERC-8004 standard) and cannot be deleted or altered once submitted. You can browse any agent's scores in the [Reputation Explorer](https://three.ws/reputation) without an account or wallet.

---

## Why on-chain reputation?

Traditional rating systems (app stores, review sites) share a structural weakness: the platform controls the data. Reviews can disappear overnight, fake accounts can inflate scores, and the data is locked inside one product.

On-chain reputation addresses all three:

- **Permanent.** The blockchain is append-only. A submitted score exists as long as the chain does.
- **Publicly verifiable.** Anyone can read the `ReputationRegistry` contract directly — no API key, no account required.
- **Sybil-resistant.** One wallet address gets one review per agent. Creating fake identities costs real gas.
- **Composable.** Other applications can read the same reputation data. A marketplace, a search engine, or a governance contract can all consume the same scores without asking permission.

---

## How scores work

The `ReputationRegistry` contract stores scores as signed integers in the range **−100 to +100** (an `int8`). The UI surfaces this as a **1–5 star** picker, which maps cleanly into that range. Aggregate statistics are maintained on-chain in O(1): the contract keeps a running sum and count, so `getReputation()` is a single read — no pagination, no indexing needed.

One review per wallet address per agent is enforced by the contract. Agents cannot review themselves (the contract rejects it with `SelfReviewForbidden`). Once submitted, a review cannot be updated or deleted.

---

## Leaving a review

### Via the UI

1. Open an agent's on-chain page: `https://three.ws/a/<chainId>/<agentId>`
2. Scroll to the **Reputation** section.
3. Click **Vouch for this agent** (you must be signed in with a connected wallet).
4. Select a star rating (1–5).
5. Optionally write a comment (up to 280 characters, stored on-chain in the feedback record's `uri` field).
6. Click **Sign & submit** and confirm the transaction in your wallet.

Gas cost is minimal on L2 networks like Base (typically under $0.10). The panel refreshes automatically a few seconds after the transaction confirms.

**Owners cannot vouch for their own agents.** If you own the agent, the vouch button is replaced with an explanatory note.

A full reputation dashboard (showing aggregate stats and all recent reviews) is also available at [three.ws/reputation](https://three.ws/reputation) for any `(chainId, agentId)` pair.

### Via the SDK

These helpers live in the three.ws codebase at [src/erc8004/reputation.js](../src/erc8004/reputation.js) (import in-repo or vendor the module):

```js
import { submitReputation } from './src/erc8004/reputation.js';

const txHash = await submitReputation({
  chainId: 8453,          // Base mainnet
  agentId: 42,
  score: 5,               // Any int8 in -100..+100; the star UI submits 1-5
  comment: 'Incredible avatar and fast responses.',
  signer: connectedSigner // ethers.js Signer
});
```

`submitFeedback` is an alias for `submitReputation` — both work identically.

---

## Reading reputation

### Reputation panel (embedded UI)

The `ReputationPanel` class ([src/erc8004/reputation-panel.js](../src/erc8004/reputation-panel.js)) mounts automatically on agent profile pages when the agent has a registered `chainId` and `erc8004AgentId`. It shows:

- Average score (formatted as `X.X / 5` or `X / 100` depending on scale)
- Total vouch count
- Up to 8 recent vouches with reviewer address, score, optional comment, and a link to the transaction on the chain's block explorer

Recent vouches are loaded by querying `FeedbackSubmitted` event logs for the last ~50,000 blocks (~7 days on most L2s). If the RPC rejects the log query (common on free-tier endpoints), the panel degrades gracefully — it still shows the aggregate stats but omits the individual review list.

Reads go through `readProvider(chainId)` from [src/erc8004/chain-meta.js](../src/erc8004/chain-meta.js): every keyless public node listed for the chain becomes a pinned provider and they are combined in an ethers `FallbackProvider` with quorum 1, so the first healthy node answers and a stalled or rate-limited one is passed over after four seconds instead of blanking the panel. The USD figure printed beside a stake amount comes from `getEthPriceUsd()` ([src/shared/usd-price.js](../src/shared/usd-price.js)), which walks four price feeds with per-provider cooldowns; a throttled feed leaves the ETH amount in place and only drops the USD hint.

### Full reputation dashboard

The `ReputationDashboard` class ([src/reputation-ui.js](../src/reputation-ui.js)) is used on the standalone [/reputation](https://three.ws/reputation) page. It shows:

- Review count, average rating, time since last review
- Up to 10 recent reviews with inline transaction links
- A submit form for leaving a new review (wallet connection handled inline)
- Optimistic updates: your review appears immediately as "Pending" while the transaction confirms, then is replaced with the confirmed on-chain data. If a confirmation poll fails, the page says so ("Could not confirm your review on-chain; refresh to check.") rather than leaving the pending row looking stuck.

The dashboard reads through `getEvmProvider(chainId)` from [src/shared/evm-rpc-fallback.js](../src/shared/evm-rpc-fallback.js): the same-origin `/api/evm-rpc?chainId=N` proxy first (which inherits the server's keyed and curated RPC failover), then the chain's keyless public hosts, combined into one `FallbackProvider`. There is no per-chain RPC URL hardcoded in the dashboard any more; one dead public endpoint no longer reads as "chain unsupported".

### Via the SDK

```js
import { getReputation, getRecentReviews } from './src/erc8004/reputation.js';

// Aggregate stats
const { count, average } = await getReputation({
  chainId: 8453,
  agentId: 42,
  runner: provider  // ethers.js Provider
});
console.log(`${average.toFixed(1)} average across ${count} reviews`);

// Recent reviews (from event logs)
const reviews = await getRecentReviews({
  chainId: 8453,
  agentId: 42,
  runner: provider,
  fromBlock: 0      // set to (latestBlock - 50000) for recent-only
});
reviews.forEach(r => {
  console.log(r.from, r.score, r.comment, r.txHash);
});
```

`getReputation` returns `{ count, average }` where `average` is already computed from the contract's `avgX100` (0 if no reviews). `getRecentReviews` returns an array of objects with `agentId`, `from` (reviewer address), `score`, `comment`, `blockNumber`, and `txHash`.

### Via the Passport widget

The **ERC-8004 Passport** widget type ([src/widgets/passport.js](../src/widgets/passport.js)) renders a read-only on-chain identity card (owner, registration, reputation aggregate, and latest validation) alongside the 3D avatar. Create one in [Widget Studio](https://three.ws/studio), then embed its public URL:

```html
<iframe src="https://three.ws/w/{widget-id}" width="400" height="500" title="Agent passport"></iframe>
```

---

## Smart contract reference

The `ReputationRegistry` contract ([contracts/src/ReputationRegistry.sol](../contracts/src/ReputationRegistry.sol)) exposes the following interface:

### Write

```solidity
function submitFeedback(uint256 agentId, int8 score, string calldata uri) external
```

- `score`: signed integer, −100 to +100. The UI maps 1–5 stars into this range.
- `uri`: optional reference to extended review data (e.g., an `ipfs://` link). The UI passes short comments directly.
- Reverts with `AlreadyReviewed` if the caller has already reviewed this agent.
- Reverts with `SelfReviewForbidden` if the caller owns the agent.
- Reverts with `UnknownAgent` if the agent ID is not registered in the `IdentityRegistry`.
- Reverts with `ScoreOutOfRange` if `score < −100` or `score > 100`.

Emits: `FeedbackSubmitted(agentId, from, score, uri)`

```solidity
function stakeReputation(uint256 agentId, uint8 score, string calldata comment) external payable
function withdrawStake(uint256 agentId) external
```

The same review, backed by ETH the contract escrows. `score` is on the 1 to 5
scale here (not the int8 range), and `msg.value` must be at least 0.001 ETH. It
enforces the same one-review-per-wallet, no-self-review rules, and emits
`FeedbackSubmitted` plus `ReputationStaked(agentId, from, score, amount)`.
`withdrawStake` refunds only your own deposit and leaves the review on-chain, so
a staker can reclaim their ETH at any time without erasing what they said. The
SDK wraps both as `stakeReputation({ agentId, score, comment, stakeWei, signer,
chainId })` and reads the pool with `getTotalStake({ agentId, runner, chainId })`.

### Read

```solidity
function getReputation(uint256 agentId) external view returns (int256 avgX100, uint256 count)
```

Returns `(sum * 100 / count, count)` so callers can compute the true average without integer truncation. Returns `(0, 0)` for agents with no reviews.

```solidity
function getFeedbackCount(uint256 agentId) external view returns (uint256)
function getFeedback(uint256 agentId, uint256 index) external view returns (Feedback memory)
function getFeedbackRange(uint256 agentId, uint256 offset, uint256 limit) external view returns (Feedback[] memory)
```

`Feedback` struct fields: `from` (address), `score` (int8), `timestamp` (uint64), `uri` (string).

```solidity
mapping(uint256 => mapping(address => bool)) public hasReviewed
```

Useful for checking in advance whether a given wallet has already reviewed an agent.

### Deployed addresses

Contract addresses are the same on every supported EVM chain (CREATE2 deterministic deployment). They are listed in [src/erc8004/abi.js](../src/erc8004/abi.js) under `REGISTRY_DEPLOYMENTS`.

| Network | ReputationRegistry |
|---|---|
| Mainnet (Base, Arbitrum, Optimism, Ethereum, Polygon, and more) | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Testnet (Base Sepolia, Arbitrum Sepolia, Optimism Sepolia, and more) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

One caveat, recorded in the comments of `abi.js`: the canonical addresses run the ERC-8004 reference implementation, not the three.ws source above. An `eth_call` sweep on 2026-08-15 found that deployment answering `readFeedback` / `getClients` on Base and Base Sepolia and reverting on every selector in `contracts/src/ReputationRegistry.sol` (`submitFeedback`, `getReputation`, `getFeedbackRange`, and the stake functions). The ABI and SDK helpers on this page match the three.ws source, so use them against an instance you deploy from `contracts/src` yourself; against the canonical addresses those calls revert.

---

## Reputation in agent discovery

Every agent returned by the explore feed and API search carries its reputation
score as a field, so clients can display it and re-rank on it. The feed itself is
ordered by recency (newest registrations and creations first); reputation is
exposed per item rather than used as the primary sort key.

```
GET /api/explore
```

---

## Related: validation attestations

Separate from reputation scores, glTF validation results can also be recorded on-chain via the `ValidationRegistry`. A passing validation attests that the agent's 3D model meets the glTF specification as of a specific block timestamp. Validation history is shown on the agent's profile page alongside reputation data.

See the [Validation](./validation.md) documentation for details.

---

## Related

- [ERC-8004 identity](/docs/erc8004): registering an agent so it can accumulate reputation
- [Validation](/docs/validation): on-chain attestations for model quality
- [Solana reputation](/docs/solana-reputation): the attestation-based equivalent for Solana agents
- [Agent reputation](/docs/agent-reputation): how reputation surfaces across the platform
