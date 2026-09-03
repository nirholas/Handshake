# Solana Agents

Give your three.ws agent a real on-chain identity on Solana. When you register, your wallet signs one transaction that mints an NFT (a Metaplex Core asset) representing the agent, and three.ws links that mint to your agent record. You do this from the agent creation and edit pages after connecting a Solana wallet (Phantom, Solflare, or Backpack).

Technically, the flow mirrors the [ERC-8004](erc8004.md) path on EVM chains: a user's wallet signs a transaction that mints an on-chain identity token, and the platform stores the link between the agent record and the mint address.

This document covers what is supported today, the end-to-end registration flow, and what is intentionally **not** on Solana yet.

> Deploying many agents at once (server-side, into the three.ws Agents collection, with a live dashboard)? See [Deploy agents on-chain (bulk)](onchain-agents.md).

---

## What's supported today

| Surface | Status | Where |
|---|---|---|
| Sign-In with Solana (SIWS) | Live | [api/auth/siws/\[action\].js](../api/auth/siws/%5Baction%5D.js) (handles `nonce` + `verify`) |
| Linking a Solana wallet to a user | Live | `user_wallets` table, `chain_type = 'solana'` |
| Solana payments (checkout + confirm) | Live | [api/payments/solana/\[action\].js](../api/payments/solana/%5Baction%5D.js) (handles `checkout` + `confirm`) |
| Agent identity NFT (Metaplex Core) | Live | [api/agents/solana/\[action\].js](../api/agents/solana/%5Baction%5D.js) (handles `register-prep` + `register-confirm`) |
| Agent record persisted in DB | Live | `agent_identities`, `meta.chain_type='solana'`, `meta.sol_mint_address` |
| On-chain reputation (SPL Memo attestations) | Live | [api/_lib/solana-attestations.js](../api/_lib/solana-attestations.js), aggregated by `/api/agents/solana-reputation` (see [Solana reputation](solana-reputation.md)) |
| On-chain validation (glTF/schema attestation) | Live | [api/_lib/solana-validation-attest.js](../api/_lib/solana-validation-attest.js), auto-run at register-confirm |
| Credentialed attestations (SAS) | Live | [api/agents/sas/\[action\].js](../api/agents/sas/%5Baction%5D.js) (see [SAS attestations](sas-attestations.md)) |
| Discovery file lists Solana agents | **Not yet** | [public/.well-known/agent-registration.json](../public/.well-known/agent-registration.json) publishes the platform card and x402 catalog, but its `registrations` array carries no per-agent Solana entries |

---

## How identity works on Solana

EVM agents are minted as ERC-721 NFTs in the IdentityRegistry contract at a fixed CREATE2 address. Solana has no CREATE2 and no shared registry contract. Instead each agent is a **Metaplex Core asset** (a single-account NFT standard with name + URI metadata baked in). When a three.ws Agents collection is configured for the network (`SOLANA_AGENT_COLLECTION_MAINNET` / `_DEVNET`), the asset is minted into that collection with the collection authority co-signing, so three.ws can curate on-chain metadata on the owner's behalf; with no collection configured, the mint falls back to a standalone asset. See [Deploy agents on-chain (bulk)](onchain-agents.md) for the collection model.

The agent's canonical identifier on Solana is its **asset pubkey** (base58, 32-byte). The platform stores it alongside the mint transaction signature so the on-chain record can always be re-verified.

Agent record shape (`agent_identities.meta`):

```json
{
  "chain_type": "solana",
  "network": "mainnet",
  "sol_mint_address": "<base58 asset pubkey>",
  "tx_signature": "<base58 tx signature>"
}
```

---

## Networks

| Network | Cluster | Default RPC |
|---|---|---|
| `mainnet` | mainnet-beta | `SOLANA_RPC_URL` env, falls back to `https://api.mainnet-beta.solana.com` |
| `devnet` | devnet | `SOLANA_RPC_URL_DEVNET` env, falls back to `https://api.devnet.solana.com` |

Public RPCs are rate-limited. For production, set `SOLANA_RPC_URL` to a Helius, Quicknode, or Triton endpoint. Server-side calls do not depend on a single endpoint: [api/_lib/solana/connection.js](../api/_lib/solana/connection.js) builds a failover chain (explicit `SOLANA_RPC_URL`, then keyed providers such as Helius and Alchemy when their keys are set, then operator-supplied `SOLANA_RPC_FALLBACK_URLS`, then keyless public endpoints, with `SOLANA_RPC_LAST_RESORT_URLS` as a paid reserve tried last) and rotates past endpoints that are rate-limited or cooling down.

**Never name the same endpoint as both the primary and the last-resort reserve.** The chain dedupes by URL and keeps the FIRST occurrence, so an endpoint listed in `SOLANA_RPC_URL` (or `QUICKNODE_RPC_URL`) *and* in `SOLANA_RPC_LAST_RESORT_URLS` is simply the primary: it absorbs 100% of traffic and its reserve status is a no-op. Production ran this exact misconfiguration until 2026-07-28, pointing `SOLANA_RPC_URL` at the metered QuickNode endpoint that was also the reserve; it burned through its daily request cap (`-32003 daily request limit reached`) while the free chain sat idle. The reserve must appear in `SOLANA_RPC_LAST_RESORT_URLS` and **nowhere else**.

Two safeguards back this up. A bare public-cluster URL passed as the caller's explicit endpoint no longer wins priority 1: roughly 35 call sites spell their default as ``process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'``, so an unset `SOLANA_RPC_URL` used to pin the most-throttled endpoint in the chain ahead of every paid lane. It is still tried, just at its natural position. And the cooldown breaker is fleet-wide, mirrored through the shared cache: when one instance parks a provider for an exhausted quota, siblings inherit that verdict on their first call instead of each re-burning a doomed request against a cap that is already full.

### How long a failing endpoint is parked

Failing over is only half the contract. The other half is *how long* a lane stays benched, and getting that wrong is expensive in both directions: park a healthy lane too long and you throw away capacity you are paying for, park a dead one too briefly and every caller keeps rediscovering it the hard way. `cooldownMsFor()` sizes the window to the failure class.

| Failure | Window | Why |
|---|---|---|
| Quota exhausted (`max usage reached`, `daily request limit reached`, `Monthly capacity limit exceeded`) | 6 h | The plan is dead for the billing window. Re-probing cannot revive it. |
| Plain rate limit (429, no quota wording) | 10 min | Transient burst throttling; the lane recovers on its own. |
| Bad or expired key (401, 403) | 30 min | An endpoint-wide credential problem. |
| Dead or misrouted URL (404, 410) | 30 min | Persistent misconfiguration, not a blip. |
| One refused *call shape* (403 + `Request blocked`) | none for the lane | The lane is healthy; only this request is unwelcome, so the *method* is demoted on that endpoint (`markMethodDemotion`) and every other call shape keeps flowing. A caller that reaches `markEndpointCooldown` directly still gets the cheapest window, 30 s. |
| Provider 5xx | 2 min | Server-side wobble. |
| Fetch threw (DNS, connection) | 30 s | Network blip. |

The second-to-last row is the subtle one, and it cost us a primary. Each provider draws its own line between "you may not do this" and "your key is bad", and they answer both with the same status code. PublicNode returns **HTTP 403** for `getTokenAccountsByOwner` filtered by `programId` while serving every other method perfectly:

```jsonc
// HTTP 403, but the key is fine and getBalance still works
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": -32602,
             "message": "Request blocked. Details: blocked parameter: params.1.programId" } }
```

Read as a credential failure that benched the node for 30 minutes, and since token and USDC balance readers make that exact call constantly, a healthy primary evicted itself on its own routine traffic and the rotation cascaded onto whatever came next. So a 403 whose body names a blocked call shape now fails over for that one request and demotes only that method on that endpoint, leaving the lane serving everything else with no cooldown at all. A 403 that does *not* say so is still treated as a bad key and benched for the full 30 minutes. Both directions are covered by `tests/solana-rpc-priority-and-breaker.test.js`.

The same distinction applies one layer up, to HTTP 200 responses carrying a JSON-RPC error. A provider refusing a call shape (PublicNode's `excluded from account secondary indexes`, Tatum's `available for paid plans only`) must rotate to the next lane, while a genuinely deterministic error (`invalid params`) must *not*, because every lane would fail it identically and rotating just multiplies one failure by the length of the chain.

---

## Registration flow

Four steps. Steps 1–2 are server-side; steps 3–4 happen in the browser with the user's wallet.

```
┌─────────┐  1. SIWS link        ┌─────────┐
│ Browser │ ───────────────────► │  Server │
│ +Wallet │                      └────┬────┘
│         │                           │ user_wallets row inserted
│         │  2. POST prep             │
│         │ ───────────────────────► ┌▼───────────────────┐
│         │                          │ build unsigned tx  │
│         │ ◄─────────────────────── │ (Metaplex createV1)│
│         │   { tx_base64, ... }     └────────────────────┘
│         │
│         │  3. wallet signs + sendRawTransaction → cluster
│         │
│         │  4. POST confirm
│         │ ────────────────────────►┌───────────────────┐
│         │                          │ verify tx on RPC  │
│         │                          │ insert agent row  │
│         │ ◄────────────────────────└───────────────────┘
└─────────┘   { agent, sol_mint_address, ... }
```

### 1. Link a Solana wallet (one-time)

The user clicks the Solana wallet button (Phantom / Solflare / Backpack) in [public/wallet/connect-button-solana.js](../public/wallet/connect-button-solana.js), then signs the SIWS challenge from `/api/auth/siws/nonce` and posts the signature to `/api/auth/siws/verify`. On success the wallet is linked to the user with `chain_type = 'solana'` in `user_wallets`.

### 2. Prep the mint transaction

```js
const prep = await fetch('/api/agents/solana-register-prep', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'My Agent',                 // 1–60 chars
    description: 'short bio',         // ≤ 280 chars
    wallet_address: walletPubkey,     // base58, must be linked to user
    network: 'devnet',                // or 'mainnet' (the default)
    avatar_id: avatarUuid,            // optional — must be owned by user
    metadata_uri: 'https://...',      // optional — else server synthesizes one
    asset_pubkey: vanityPubkey,       // optional: client-supplied asset keypair pubkey
    vanity_prefix: '3ws',             // optional: asserts asset_pubkey starts with it
  }),
}).then(r => r.json());

// → { prep_id, asset_pubkey, tx_base64, network, metadata_uri, expires_at }
```

The server:
- Verifies the wallet is linked to the session user.
- If `avatar_id` is given, verifies the user owns the avatar.
- Builds an unsigned Metaplex Core `create` transaction with the user's pubkey as a `NoopSigner`. The asset keypair is generated server-side and pre-signs the transaction; alternatively the client supplies its own `asset_pubkey` (with an optional `vanity_prefix`, which returns `402 payment_required` for prefixes of 5+ characters on the free plan).
- Writes an on-chain Attributes plugin (the three.ws brand block) and an enforced Royalties plugin into the asset, and mints into the three.ws Agents collection when one is configured for the network.
- Stores a 30-minute pending record so step 4 can resolve `name` / `description` / `avatar_id` from the prep payload.

The returned `tx_base64` is a fully built transaction missing only the user's signature.

### 3. Sign and submit with the wallet

```js
import * as solanaWeb3 from '@solana/web3.js';

const txBytes = Uint8Array.from(atob(prep.tx_base64), c => c.charCodeAt(0));
const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);

// User signs with their connected Solana wallet.
const signed = await window.solana.signTransaction(tx);

const conn = new solanaWeb3.Connection(
  prep.network === 'devnet'
    ? 'https://api.devnet.solana.com'
    : 'https://api.mainnet-beta.solana.com',
  'confirmed',
);

const sig = await conn.sendRawTransaction(signed.serialize());
await conn.confirmTransaction(sig, 'confirmed');
```

### 4. Confirm to the server

```js
const result = await fetch('/api/agents/solana-register-confirm', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    tx_signature: sig,
    asset_pubkey: prep.asset_pubkey,
    wallet_address: walletPubkey,
    network: prep.network,
  }),
}).then(r => r.json());

// → 201 {
//     ok: true,
//     agent: { id, name, description, wallet_address, meta, home_url, ... },
//     sol_mint_address,
//     tx_signature,
//     network,
//     validation?: { passed, signature, proof_hash, deduped },
//   }
```

The server re-fetches the parsed transaction from the cluster, asserts:
- the tx exists and did not error,
- `asset_pubkey` appears in the transaction's account keys,
- no agent has already been registered for this mint,

then inserts the `agent_identities` row and clears the pending record. If the agent has an avatar GLB, the server also records a best-effort on-chain glTF/schema validation attestation (`threews.validation.v1`, signed by the platform validator; see [api/_lib/solana-validation-attest.js](../api/_lib/solana-validation-attest.js)); a failure there never fails the registration.

---

## Error codes

Returned as `{ error, error_description }` from the prep / confirm endpoints.

| Status | `error` | When |
|---|---|---|
| 400 | `validation_error` | Malformed body, non-base58 `asset_pubkey`, or `vanity_prefix` without `asset_pubkey` |
| 401 | `unauthorized` | No session |
| 402 | `payment_required` | `vanity_prefix` of 5+ characters on a free plan |
| 403 | `forbidden` | Wallet is not linked to the session user |
| 404 | `not_found` | `avatar_id` doesn't exist or isn't owned by user |
| 422 | `tx_not_found` | RPC has not seen the signature yet — retry after a few seconds |
| 422 | `tx_failed` | Transaction landed on-chain but reverted |
| 422 | `asset_not_in_tx` | `asset_pubkey` is not among the transaction's account keys |
| 409 | `conflict` | An agent is already registered for this mint |
| 429 | `rate_limited` | Per-IP auth limiter tripped |
| 503 | `rpc_unavailable` | Every RPC endpoint in the failover chain failed while building the tx |

---

## Environment variables

| Var | Purpose |
|---|---|
| `SOLANA_RPC_URL` | Primary mainnet RPC. Defaults to public mainnet-beta. **Set this in production.** |
| `SOLANA_RPC_URL_DEVNET` | Devnet RPC. Defaults to public devnet. |
| `SOLANA_RPC_FALLBACK_URLS` | Comma-separated extra mainnet endpoints rotated into the failover chain after the primary. |
| `SOLANA_RPC_LAST_RESORT_URLS` | Comma-separated paid/metered endpoints tried only after every free endpoint fails. Must not repeat a URL already named as the primary, or it is the primary and the reserve is a no-op. |
| `SOLANA_AGENT_COLLECTION_MAINNET` / `_DEVNET` | Address of the three.ws Agents collection; when set, registrations mint into it. |
| `PUBLIC_APP_ORIGIN` | Canonical origin (exposed to code as `env.APP_ORIGIN`); used to synthesize a default `metadata_uri` if the caller didn't provide one. |

SIWS-related env vars live in [api/_lib/env.js](../api/_lib/env.js) and [api/_lib/siws.js](../api/_lib/siws.js).

---

## Resolving a Solana agent

Given an `agent_identities` row with `meta.chain_type === 'solana'`:

- The asset can be fetched from any Solana RPC via Metaplex Core's `fetchAsset(umi, mint)`.
- The metadata JSON lives at `meta.metadata_uri` (or, if synthesized, at `${APP_ORIGIN}/api/agents/solana-metadata?...`).
- The mint transaction is at `https://solscan.io/tx/<tx_signature>` (or `?cluster=devnet`).

There is no global Solana registry to query — discovery happens via the platform's own indexes (`agent_identities`) until [public/.well-known/agent-registration.json](../public/.well-known/agent-registration.json) is extended to publish Solana entries.

---

## What's on Solana instead of a registry contract

- **Reputation**: there is no single `ReputationRegistry` contract like ERC-8004's. Instead, permissionless SPL Memo attestations (feedback, stakes, tasks, disputes) are written on-chain against the agent's asset pubkey, crawled into `solana_attestations`, and aggregated by `/api/agents/solana-reputation`. Off-chain pump.fun behavior signals land in `pumpfun_signals` and feed the same score. See [Solana reputation](solana-reputation.md) and [solana-pumpfun.md](solana-pumpfun.md).
- **Validation**: no registry contract either; validations are `threews.validation.v1` SPL Memo attestations (including the automatic glb-schema attestation at register-confirm), plus SAS credentialed validations signed by the platform authority ([SAS attestations](sas-attestations.md)).

## What's intentionally not on Solana yet

- **Delegated wallet (EIP-712)**: There is no equivalent for Solana agents. Owner = the wallet that signed the mint.
- **Cross-chain identifier**: EVM agents use `eip155:<chainId>:<registry>:<agentId>` (CAIP-10). The user-signed flow stores the asset pubkey directly; only the bulk deploy path records a CAIP-2-style `solana:<cluster-genesis>` chain id in `meta.onchain.chain` (see [onchain-agents.md](onchain-agents.md)).
- **Discovery**: `agent-registration.json` publishes the platform-level card and x402 catalog, but its `registrations` array does not list individual Solana agents. Adding them means defining a JSON schema for Metaplex Core assets; not done yet.

A full ERC-8004-equivalent on Solana (Identity / Reputation / Validation as Anchor programs with a parallel JS client) remains a separate, larger piece of work; this document covers what ships today.

---

## Related

- [Deploy agents on-chain (bulk)](/docs/onchain-agents): the server-side, collection-minting counterpart to this flow
- [Agent Reputation on Solana](/docs/solana-reputation): how attestations become a trust grade
- [SAS Credentialed Attestations](/docs/sas-attestations): authority-signed credentials
- [ERC-8004](/docs/erc8004): the EVM identity path this flow mirrors

---

## Runnable example

[`solana-agent-sdk/`](https://github.com/nirholas/three.ws/tree/main/solana-agent-sdk) The `@three-ws/solana-agent` package: Solana-native agent actions, wallet providers, and x402 exact payments, with its quickstart in the README.

It is part of the curated set `npm run export:satellites` publishes as the public
three.ws examples repo, so it is installed, run, and link-checked before every release.
