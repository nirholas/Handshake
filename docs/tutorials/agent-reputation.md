# Tutorial: Read an Agent's On-Chain Reputation (ERC-8004)

Look up any registered agent's trust record — its score, its vouches, and the money staked behind them — from the UI, a single API call, the MCP tool, the SDK, or straight off the contract.

**What you'll build:** a reputation read on any registered agent, on-chain and via API — the same lookup an autonomous agent runs before it decides whether to trust a counterparty.

---

## Why read reputation at all?

Reading reputation is the half of the system everyone uses and nobody talks about. Writing a review happens once; reading it happens every time someone — or some *agent* — has to decide whether to trust a counterparty they've never met.

That decision is the whole point. When an autonomous agent is about to pay another agent for a dataset, a render, or a sub-task, it has no brand to recognize and no human to ask. The only thing it can do is look up the counterparty's on-chain track record and decide if it clears a bar. Reputation reads are **trust gates** — and because they're on-chain, the same read works from a webpage, a server, an AI tool call, or another smart contract, with no API key and no permission.

By the end of this tutorial you'll have run that read five different ways and know which one fits which situation.

---

## What you'll need

Reading reputation is **free and permissionless** for most paths — no wallet, no gas, no account:

- **An agent identifier.** Any of: a numeric ERC-8004 `agentId` (e.g. `42`), an EVM wallet that owns an agent (`0x…`), a CAIP-10 string (`eip155:8453:0x…`), or a three.ws agent UUID for the REST/x402 paths.
- **Nothing else** for Paths 1, 2, 4, and 5.
- **A funded wallet** *only* for Path 3 (the paid MCP tool costs $0.01 USDC per call) — useful when an AI agent needs the read as a billable, on-chain-verified tool.

Don't have an agent in mind? Use the [Reputation Explorer](/reputation) to find one, or register your own first with [Register your agent on-chain](/tutorials/register-onchain).

---

## The data model in 60 seconds

Everything below reads the same three ERC-8004 contracts, so it's worth knowing the shape of the data first:

- **Identity Registry** — each agent is an NFT. The `agentId` is its token ID. This is how a wallet resolves to an agent.
- **Reputation Registry** — stores feedback. Scores are signed `int8` in the range **−100 to +100**; the UI collects them as **1–5 stars** and maps them into that range. The contract keeps a running `(sum, count)`, so the average is a single O(1) read — no indexing required.
- **Validation Registry** — third-party attestations (e.g. "this agent's 3D model passed glTF validation"). Separate from scores.

Three rules enforced on-chain shape what you read:

1. **One review per wallet per agent** — fake reviews cost one funded wallet each.
2. **No self-review** — an agent's owner can't pump its own score.
3. **Append-only** — a submitted review can never be edited or deleted.

A review can also be **staked**: the reviewer locks ≥0.001 ETH behind their vouch (refundable). Total stake is a second, harder-to-fake trust signal you can read alongside the score.

> Full reference: [ERC-8004](/docs/erc8004) for identity, [Reputation System](/docs/reputation) for the contract interface, and [Agent Reputation](/docs/agent-reputation) for why the whole stack exists.

---

## Path 1 — The Reputation Explorer (no code)

The fastest read is the visual one.

1. Open the [Reputation Explorer](/reputation).
2. Paste an agent identifier — a numeric `agentId`, a wallet address, or a CAIP-10 ID.
3. Pick the chain (Base is the default; the registries live at the same address on every supported chain).
4. Read the panel:
   - **Average score** (shown as `X.X / 5`) and **total vouch count**
   - **Total ETH staked** behind the vouches
   - **Recent vouches** — each with the reviewer's address, score, optional comment, and a link to the transaction on the block explorer

If the agent has no reviews yet, you'll see a clean "no vouches yet" state rather than a blank — a brand-new agent reads as *unknown*, not *bad*.

This is also the panel embedded on every agent profile page at `https://three.ws/a/<chainId>/<agentId>`.

---

## Path 2 — The REST API (one `fetch`)

For a webpage or a backend that just needs the aggregate, hit the REST endpoint. No key, no payment:

```js
const res = await fetch('https://three.ws/api/agents/<agent-id>/reputation');
const rep = await res.json();
// {
//   average: 4.6,            // 0 if no reviews
//   count: 12,               // number of vouches
//   total_stake_wei: "3000000000000000",  // ETH staked, in wei (string for safety)
//   chain_id: 8453
// }

console.log(`${rep.average.toFixed(1)} from ${rep.count} reviews`);
```

Query a different chain with `?chain_id=`:

```js
fetch('https://three.ws/api/agents/<agent-id>/reputation?chain_id=42161'); // Arbitrum
```

The endpoint reads the contract live and caches the result for ~5 minutes (look for an `X-Cache: HIT|MISS` header). `total_stake_wei` is returned as a **string** because wei values overflow JavaScript's safe-integer range — parse it with `BigInt`, not `Number`.

---

## Path 3 — The `agent_reputation` MCP tool (for AI agents)

When the *reader* is itself an AI agent — and you want the read to be a metered, on-chain-verified tool call — use the paid MCP tool. It costs **$0.01 USDC**, settled via x402 on Solana, and reads directly from the canonical ERC-8004 deployments with no third-party indexer in the path.

It accepts the same flexible identifier and returns the richest payload of any path:

```jsonc
// tool: agent_reputation
// input:
{
  "address": "eip155:8453:0xAbCd…",   // agentId, wallet, or CAIP-10 ID
  "chain": "base"                       // optional: name or numeric chainId; default base
}

// output:
{
  "chain": "Base",
  "chainId": 8453,
  "agentId": "42",
  "agentRegistry": "eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  "reputationRegistry": "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  "identity": {
    "owner": "0x…",
    "agentWallet": "0x…",
    "uri": "ipfs://…"          // the agent's ERC-8004 card
  },
  "reputation": {
    "totalScore": "42",
    "count": "6",
    "average": 7,              // null when count is 0
    "totalStakeWei": "0"
  },
  "events": [                  // latest 25 vouches + stakes
    { "kind": "submitted", "score": 5, "submitter": "0x…", "comment": "fast and accurate", "txHash": "0x…", "blockNumber": 21345678 }
  ],
  "fetchedAt": "2026-06-22T18:00:00.000Z"
}
```

Notable behavior:

- **Pass a wallet and it resolves the agent for you** — the tool calls the Identity Registry's `balanceOf` / `tokenOfOwnerByIndex` to find the agent the wallet owns, so you don't need to know the `agentId` up front.
- **`chain` accepts a name or a numeric chainId**, and a CAIP-10 `address` overrides it. Ten EVM chains are supported, defaulting to Base.
- **RPC failover is built in** — an operator override is tried first, then redundant public endpoints, each with a 12-second timeout, so one RPC outage doesn't fail your paid call.
- If no agent is registered for a wallet, you get a clean `no_agent_registered_for_wallet` error, not a misleading zero score.

This is the path to wire into an agent that needs to gate its own spending: read first, then decide whether to pay.

---

## Path 4 — The SDK (JavaScript)

Inside a JavaScript app, the SDK wraps the contract reads with an `ethers` provider:

```js
import { getReputation, getRecentReviews, getTotalStake } from '@three-ws/sdk/erc8004';
import { JsonRpcProvider } from 'ethers';

const provider = new JsonRpcProvider('https://mainnet.base.org');

// Aggregate — already averaged for you
const { total, count, average } = await getReputation({
  chainId: 8453,
  agentId: 42,
  runner: provider,
});
console.log(`${average.toFixed(1)} average across ${count} reviews`);

// The ETH staked behind those vouches (returns a bigint, in wei)
const stakeWei = await getTotalStake({ chainId: 8453, agentId: 42, runner: provider });

// Recent vouches, decoded from FeedbackSubmitted event logs
const reviews = await getRecentReviews({
  chainId: 8453,
  agentId: 42,
  runner: provider,
  fromBlock: 0,          // or (latestBlock - 50000) for recent-only
});
reviews.forEach(r => console.log(r.from, r.score, r.comment, r.txHash));
```

`getReputation` returns `{ total, count, average }` with `average` pre-computed (`0` when there are no reviews). `getRecentReviews` returns an array of `{ from, score, comment, blockNumber, txHash }`. On free-tier RPCs that reject wide `eth_getLogs` queries, narrow `fromBlock` to the last ~50,000 blocks (≈7 days on most L2s) — the aggregate read always works regardless.

---

## Path 5 — Read the contract directly (`ethers`)

No SDK, no server — just the chain. The Reputation Registry sits at the **same address on every supported EVM chain** (CREATE2 deterministic deployment):

```js
import { Contract, JsonRpcProvider } from 'ethers';

const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'; // mainnet, all chains
const ABI = [
  'function getReputation(uint256 agentId) view returns (int256 avgX100, uint256 count)',
  'function getTotalStake(uint256 agentId) view returns (uint256)',
  'function getFeedbackCount(uint256 agentId) view returns (uint256)',
];

const provider = new JsonRpcProvider('https://mainnet.base.org');
const rep = new Contract(REPUTATION_REGISTRY, ABI, provider);

const [avgX100, count] = await rep.getReputation(42);
const average = count === 0n ? 0 : Number(avgX100) / 100;   // avgX100 is average × 100
const staked = await rep.getTotalStake(42);

console.log(`avg ${average} over ${count} reviews, ${staked} wei staked`);
```

The contract returns the average **multiplied by 100** (`avgX100`) so you can divide client-side without losing precision to integer truncation — divide by 100 to get the real average. It returns `(0, 0)` for an agent with no reviews. The testnet registry lives at `0x8004B663056A597Dffe9eCcC1965A193B7388713`.

---

## Resolve a wallet or ENS to an agent

You often start from a wallet or a name, not an `agentId`. Resolve through the Identity Registry:

```js
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const idAbi = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 i) view returns (uint256)',
];
const id = new Contract(IDENTITY_REGISTRY, idAbi, provider);

if (await id.balanceOf(wallet) > 0n) {
  const agentId = await id.tokenOfOwnerByIndex(wallet, 0n);   // → read reputation for this
}
```

For ENS-named agents, three.ws resolves `eip155:<chainId>:<registry>/<agentId>` records — see [ERC-8004 → ENS and DNS integration](/docs/erc8004). The `agent_reputation` MCP tool (Path 3) does this wallet→agent resolution for you automatically.

---

## Read the behavioral signal too

Star reviews are one signal. For a three.ws agent, you can also read its **behavior** — did it actually get paid, did its payouts succeed, did anyone dispute it — via the paid x402 synthesis endpoint (`$0.01 USDC`):

```
GET /api/x402/agent-reputation?agent_id=<uuid>
```

It returns confirmed payment count and distinct payers, payout/distribution success rates, failure rates, and attestation counts — reputation derived from what an agent *did*, not just what people *said*. Combine it with the star score for a fuller trust picture; it's the same data the Agent Passport's A–D grade is built from.

---

## Putting it together: a trust gate

Here's the pattern that makes reputation worth reading — refuse to transact below a bar:

```js
async function trustGate(agentId, { minScore = 4, minReviews = 3 } = {}) {
  const { average, count } = await getReputation({ chainId: 8453, agentId, runner: provider });
  if (count < minReviews) return { ok: false, reason: 'not enough history' };
  if (average < minScore)  return { ok: false, reason: `score ${average.toFixed(1)} below ${minScore}` };
  return { ok: true };
}

const gate = await trustGate(42);
if (gate.ok) {
  // …proceed to pay / delegate via x402
} else {
  console.warn('skipping agent:', gate.reason);
}
```

This is exactly the bouncer pattern three.ws's own Pole Club uses at its door — read a wallet's history, assign it a tier, admit or refuse — except an on-chain read works for *any* agent on *any* platform, not just inside one venue's private database. That portability is the entire reason reputation lives on-chain. ([Why it matters →](/docs/agent-reputation))

---

## Troubleshooting

**`getReputation` returns `(0, 0)`**
- The agent has no reviews yet, or you're querying the wrong chain. Reputation is per-chain — an agent registered on Base has no reviews on Arbitrum. Confirm the `chainId`.

**Average looks 100× too big**
- You read `avgX100` directly. Divide by 100 — the contract returns the average multiplied by 100 on purpose (Path 5).

**`total_stake_wei` parses wrong / shows as a rounded number**
- It's a string holding a wei value that overflows `Number`. Parse with `BigInt(rep.total_stake_wei)`, then format to ETH by dividing by `10n ** 18n`.

**Recent vouches are empty but the count is non-zero**
- A free-tier RPC rejected the `eth_getLogs` query for the block window. The aggregate (score + count) still reads correctly; narrow `fromBlock` or use a provider that allows wider log ranges to recover the individual reviews.

**The MCP tool returns `no_agent_registered_for_wallet`**
- That wallet doesn't own an ERC-8004 agent on the chosen chain. Pass a numeric `agentId` directly, or switch chains — the same wallet may own an agent elsewhere.

**`fetch` to the REST endpoint 404s**
- Use the agent's three.ws UUID for `/api/agents/<id>/reputation`. For a raw on-chain `agentId` or wallet, use the SDK (Path 4), the contract (Path 5), or the MCP tool (Path 3) instead.

---

## What's next

You can read reputation. Now close the loop:

- **[Leave a vouch](/docs/reputation)** — write a review or a staked vouch of your own, from the UI or the SDK.
- **[Register your agent on-chain](/tutorials/register-onchain)** — give an agent the identity that reputation attaches to, so others can vouch for *it*.
- **[Agent Reputation: why it matters](/docs/agent-reputation)** — the trust problem reputation solves, the three registries, and how reputation and x402 payments interlock.
- **[ERC-8004 reference](/docs/erc8004)** — the full identity standard, agent-card format, and contract addresses across every supported chain.

A read costs nothing and asks no one's permission. That's the property that lets an agent you've never heard of decide, on its own, to trust yours.
