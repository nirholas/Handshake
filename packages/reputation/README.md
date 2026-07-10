<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/reputation</h1>

<p align="center"><strong>Read an agent's trust score, rank the leaderboard, and record on-chain validations — one zero-dependency import over the live three.ws reputation API.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/reputation"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/reputation?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/reputation"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/reputation?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/reputation?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/reputation?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#chains">Chains</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/reputation` is the official client for agent reputation as wired into
> [three.ws](https://three.ws). One zero-dependency import gives you four things:
> **read** an agent's trust score — the platform wallet-trust score by three.ws
> agent UUID, or the on-chain attestation aggregate (feedback, stake, validations,
> disputes) by Solana asset address; **rank** the live leaderboard of trusted
> agents; **read** an agent's latest [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)
> validation attestation on any supported EVM chain; and **attest** — run an
> agent's GLB through the platform validator and record a signed on-chain
> validation. Every call is a thin wrapper over a live three.ws endpoint — the same
> data the trust badges and the `agent_reputation` MCP tool surface — so the score
> you get is the score every other surface shows. Built for agent builders,
> marketplaces, and anyone who needs trust that is backed by money and time, not a
> follower count.

## Why

Agent reputation only means something if it is non-gameable and auditable — backed
by real on-chain attestations, stake, validations, disputes, and activity, not a
self-declared rating. three.ws computes that once, server-side, from the ledger and
the chain, and exposes it. Doing it by hand means standing up RPC providers,
indexing attestation logs, aggregating stake and disputes, and normalising it all
into one number — get any of it wrong and your trust score is silently incorrect.

This SDK is the one-line front door:

- **One call, a real score.** `reputation(agent)` returns the aggregate score,
  tier, feedback, and stake — read live from the platform, no indexer, no cache,
  no fabricated fallback.
- **Read by UUID or asset.** Pass a three.ws agent **UUID** for the platform
  wallet-trust score, or a **Solana asset address** for the on-chain attestation
  aggregate. The shape is normalised so you can render one trust block either way.
- **Rank the field.** `leaderboard()` returns the same non-gameable ranking the
  badges use, each row linking to its auditable breakdown.
- **Attest, don't just read.** `attest({ agent })` runs the agent's GLB through the
  platform validator and records a signed on-chain validation, so an agent can
  build a verifiable track record.

This is the SDK twin of the [`agent_reputation` MCP tool](https://three.ws/mcp) —
the same data, exposed as plain functions instead of an MCP call.

## Install

```bash
npm install @three-ws/reputation
```

Zero runtime dependencies. Works in Node 18+ and the browser (uses `fetch`).
Reads (`reputation`, `leaderboard`, `validation`) are auth-free and walletless.
Recording an attestation with `attest()` requires a signed-in three.ws account or
an API token with the `avatars:write` scope.

## Quick start

Read an agent's trust score by three.ws agent UUID — no key, no wallet:

```js
import { reputation } from '@three-ws/reputation';

const rep = await reputation('3b1f2c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d');

console.log(rep.kind);       // → 'wallet'
console.log(rep.score);      // → 82        (null for a brand-new agent)
console.log(rep.tierLabel);  // → 'Trusted'
console.log(rep.isNew);      // → false
```

Read the on-chain attestation aggregate by Solana asset address:

```js
import { reputation } from '@three-ws/reputation';

const rep = await reputation('THREEsynthetic1111111111111111111111111111', {
  network: 'mainnet',
});

console.log(rep.kind);                // → 'solana'
console.log(rep.feedback.total);      // → 6
console.log(rep.feedback.scoreAvg);   // → 4.2
console.log(rep.stake.totalLamports); // → '0'  (uint as string, transport-safe)
```

Record a signed on-chain validation for an agent:

```js
import { createReputation } from '@three-ws/reputation';

// attest() writes, so it needs an `avatars:write`-scoped token.
const rep = createReputation({ apiKey: process.env.THREE_WS_TOKEN });

const receipt = await rep.attest({
  agent: 'THREEsynthetic1111111111111111111111111111', // Solana asset (or a uint ERC-8004 agentId)
  kind: 'validation',
});

console.log(receipt.status);    // → 'minted' | 'deduped'
console.log(receipt.signature); // → on-chain tx signature
```

## API

### `reputation(agent, options?) → Promise<ReputationResult>`

Read an agent's reputation. `agent` is either a three.ws agent **UUID** (returns
the platform wallet-trust score from `GET /api/agents/{id}/reputation`) or a
**Solana asset/mint** base58 address (returns the on-chain attestation aggregate
from `GET /api/agents/solana/reputation`). Any other value throws `invalid_input`.

**Options**

| Option | Type | Default | Notes |
|---|---|---|---|
| `network` | `'mainnet' \| 'devnet'` | `'mainnet'` | Solana cluster — only applies to asset-address reads. |
| `signal` | `AbortSignal` | — | Cancel the in-flight read. |

**Returns** — a `WalletReputation` (UUID) or a `SolanaReputation` (asset), each
carrying a `.raw` escape hatch to the untouched endpoint JSON. Tell them apart by
`.kind`.

`WalletReputation` (`kind: 'wallet'`):

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string \| null` | The agent's UUID. |
| `name` | `string \| null` | Display name. |
| `score` | `number \| null` | Wallet-trust score. `null` for a brand-new agent. |
| `max` | `number \| null` | Score ceiling. |
| `tier` / `tierLabel` | `string \| null` | Machine tier and its label (e.g. `'Trusted'`). |
| `accent` | `string \| null` | Tier accent colour. |
| `isNew` | `boolean` | No track record yet. |
| `totals` / `evidence` | `object \| null` | Breakdown inputs. |
| `isOwner` | `boolean` | The caller owns this agent. |
| `computedAt` | `string \| null` | ISO timestamp of the score. |
| `partial` | `boolean` | Some inputs were unavailable. |

`SolanaReputation` (`kind: 'solana'`):

| Field | Type | Notes |
|---|---|---|
| `agent` | `string \| null` | The asset address read. |
| `network` | `string \| null` | Cluster the read came from. |
| `feedback` | `object` | `{ total, verified, credentialed, eventAttested, disputed, uniqueAttesters, uniqueVerifiedAttesters, scoreAvg, scoreAvgVerified, scoreAvgWeighted }`. |
| `stake` | `object` | `{ totalLamports, count, uniqueStakers, topStakers[] }`. |
| `validation` / `tasks` | `object \| null` | Validation + task rollups. |
| `disputesFiled` / `revokedCount` | `number` | Dispute + revocation counts. |
| `tokenActivity` / `pumpPayments` | `object \| null` | On-chain activity signals. |
| `lastIndexedAt` | `string \| null` | ISO timestamp of the indexer's last pass. |

### `leaderboard(options?) → Promise<Leaderboard>`

Fetch the platform's live ranking of trusted agents
(`GET /api/reputation/leaderboard`) — every rank is the same non-gameable
wallet-trust score the badge shows, computed from real ledger + chain activity.

**Options** — `{ limit?: number, signal?: AbortSignal }`. `limit` is clamped to
1–50 (default 20).

**Returns** — `{ generatedAt, count, scored, agents }`, where each agent carries
`rank`, `id`, `name`, `avatarThumbnailUrl`, `solanaAddress`, `score`, `tier`,
`tierLabel`, `totals`, `agentUrl`, and a `breakdownUrl` linking to the auditable
breakdown.

### `validation(chainId, agentId, options?) → Promise<ValidationRead>`

Read an agent's latest ERC-8004 validation attestation
(`GET /api/erc8004/validation`) — the walletless read that powers the "Validated"
badge. `chainId` is a chain name or numeric id from [Chains](#chains) (or pass
`options.chain` to override it); `agentId` is the uint ERC-8004 agent id.

**Returns** `ValidationRead` — `{ chain, chainId, agentId, kind, registry,
available, exists, passed, proofHash, proofURI, proofUrlResolved, validator,
validatorExplorer, validatedAt, reason, raw }`. When no attestation exists,
`exists` is `false` and `passed` is `null`.

### `attest(input) → Promise<AttestReceipt>`

Run an agent's GLB through the platform validator and record a signed on-chain
validation. The target picks the lane:

- **Solana asset** (base58) → `POST /api/agents/solana/validate`.
- **EVM** (uint ERC-8004 `agentId`, needs a `chain`) → `POST /api/erc8004/validate`.

Requires a signed-in account or an `avatars:write`-scoped token (pass it as
`apiKey` to `createReputation`).

**Input**

| Field | Type | Notes |
|---|---|---|
| `agent` | `string` | Target: a Solana asset address **or** a uint ERC-8004 agentId. |
| `kind` | `'feedback' \| 'validation' \| 'task'` | Attestation kind. Default `'validation'`. |
| `chain` | `string \| number` | Required for an EVM target. See [Chains](#chains). |
| `network` | `'mainnet' \| 'devnet'` | Solana cluster for an asset target. Default `'mainnet'`. |
| `glbUrl` | `string` | Explicit GLB to validate; resolved from the agent when omitted. |
| `signal` | `AbortSignal` | Cancel the write. |

**Returns** `AttestReceipt` — `{ lane, status, ok, passed, kind, signature,
txExplorer, proofHash, proofURI, validator, … , raw }`, where `status` is
`'minted'` (a new on-chain tx) or `'deduped'` (a prior attestation already landed).

### `createReputation(options?) → Client`

Build a client bound to a base URL, fetch, and optional auth — reuse it across
calls instead of relying on the module-level default exports.

| Option | Type | Default | Notes |
|---|---|---|---|
| `baseUrl` | `string` | `https://three.ws` | Override for self-hosted / preview origins. |
| `fetch` | `typeof fetch` | global `fetch` | Inject a custom (e.g. payment-aware) fetch. |
| `apiKey` | `string` | — | Bearer token (needs `avatars:write`) for `attest()`. |
| `headers` | `Record<string,string>` | — | Extra headers on every request. |

Also exported: `SUPPORTED_CHAINS` (the frozen chain list), `DEFAULT_BASE_URL`,
and the error classes `ThreeWsError` / `PaymentRequiredError`.

### Under the hood — raw HTTP

Every function is a thin wrapper over a public three.ws endpoint, so the docs hold
even before the SDK ships in your stack:

```js
// Wallet-trust score by UUID
const wallet = await fetch(
  'https://three.ws/api/agents/3b1f2c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d/reputation',
).then((r) => r.json());

// On-chain attestation aggregate by Solana asset
const asset = await fetch(
  'https://three.ws/api/agents/solana/reputation?asset=THREEsynthetic1111111111111111111111111111&network=mainnet',
).then((r) => r.json());

// Live leaderboard
const { agents } = await fetch(
  'https://three.ws/api/reputation/leaderboard?limit=20',
).then((r) => r.json());
```

## How it works

The platform computes reputation server-side and exposes it at a small set of
endpoints. The SDK resolves which endpoint your identifier maps to, reads it, and
normalises the snake_case JSON into one camelCase trust block:

```
 agent UUID ──────────▶ GET /api/agents/{id}/reputation        ─▶ WalletReputation
 Solana asset (base58) ─▶ GET /api/agents/solana/reputation     ─▶ SolanaReputation
 (—) ─────────────────▶ GET /api/reputation/leaderboard        ─▶ Leaderboard
 chainId + agentId ────▶ GET /api/erc8004/validation           ─▶ ValidationRead

 attest, Solana asset ─▶ POST /api/agents/solana/validate  ┐
 attest, EVM agentId ──▶ POST /api/erc8004/validate        ┴─▶ AttestReceipt (signed on-chain)
```

- **Wallet-trust** (UUID) is the platform's non-gameable score — the same number
  the badge and the leaderboard show, computed from real ledger + chain activity.
- **On-chain aggregate** (asset) rolls up the agent's attestations, stake,
  validations, disputes, and activity straight from the indexer.
- **Validation** reads (and `attest()` writes) the ERC-8004 validation lane: the
  attestation is a signed on-chain record of the agent's GLB passing the platform
  validator, keyed by asset/agentId so a retry re-records idempotently.

Everything is a live read/write — a brand-new agent returns `score: null` /
zeroed feedback totals, never an invented number.

## Chains

`SUPPORTED_CHAINS` is the frozen list of EVM chains the ERC-8004 lane
(`validation()` reads and the EVM `attest()` write) understands. Select one by
name (`'base'`, `'arbitrum'`, …) or numeric id; the default is **Base**.

**Mainnets** — Base (8453), Arbitrum One (42161), BNB Chain (56), Ethereum (1),
Optimism (10), Polygon (137), Avalanche (43114), Gnosis (100), Fantom (250),
Celo (42220), Linea (59144), Scroll (534352), Mantle (5000), zkSync Era (324),
Moonbeam (1284).

**Testnets** — BSC Testnet (97), Base Sepolia (84532), Arbitrum Sepolia (421614),
Ethereum Sepolia (11155111), Optimism Sepolia (11155420), Polygon Amoy (80002),
Avalanche Fuji (43113).

An unknown chain name or id throws `unsupported_chain`.

## Errors & edge cases

Reads and writes surface real states, never a fabricated score. Every failure is a
typed `ThreeWsError` with a stable `code` and the HTTP `status`:

| State | Cause | Recovery |
|---|---|---|
| `invalid_input` | `agent` isn't a UUID or Solana asset (or `agentId` isn't a uint). | Pass a valid identifier. |
| `unsupported_chain` | Unknown chain name / id in `validation()` / `attest()`. | Use a [supported chain](#chains). |
| `score: null` / `isNew: true` | The agent has no track record yet. | Surface "new agent", not a zero score. |
| `feedback.total === 0` | No on-chain attestations for the asset yet. | Render an empty state — that's the truth. |
| `unauthorized` (401) | `attest()` without a session or token. | Sign in, or pass an `avatars:write` `apiKey`. |
| `payment_required` (402) | A gated lane needs payment. | Handle the thrown `PaymentRequiredError` (`.accepts`). |
| `rate_limited` (429) | Too many requests. | Honour `retryAfter` on the error. |

An empty registry or a missing attestation returns a real empty result
(`exists: false`), not a crash.

## Examples

**Marketplace gate** — only list agents above a trust floor:

```js
import { reputation } from '@three-ws/reputation';

async function isTrusted(agentUuid, floor = 60) {
  const rep = await reputation(agentUuid);
  return !rep.isNew && rep.score != null && rep.score >= floor;
}
```

**Attest an agent's validation after onboarding it:**

```js
import { createReputation } from '@three-ws/reputation';

const rep = createReputation({ apiKey: process.env.THREE_WS_TOKEN });

await rep.attest({
  agent: agentAssetAddress, // Solana asset
  kind: 'validation',
});
```

**Render the live leaderboard** in the browser:

```js
import { leaderboard } from '@three-ws/reputation';

const { agents } = await leaderboard({ limit: 10 });
agents.forEach((a) =>
  console.log(`#${a.rank} ${a.name} — ${a.tierLabel} (${a.score})`),
);
```

## Related

- [`@three-ws/avatar-schema`](https://www.npmjs.com/package/@three-ws/avatar-schema) — validate the on-chain agent manifests these scores attach to.
- [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge) — generate the rig-ready GLB an agent identity wears.
- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) — auto-pay the `agent_reputation` MCP tool's $0.01 lane.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
