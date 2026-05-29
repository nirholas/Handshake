# Solana Agents

Register an agent on Solana as a Metaplex Core NFT. The flow mirrors the [ERC-8004](erc8004.md) path on EVM chains: a user's wallet signs a transaction that mints an on-chain identity token, and the platform stores the link between the agent record and the mint address.

This document covers what is supported today, the end-to-end registration flow, and what is intentionally **not** on Solana yet.

---

## What's supported today

| Surface | Status | Where |
|---|---|---|
| Sign-In with Solana (SIWS) | Live | [api/auth/siws/\[action\].js](../api/auth/siws/%5Baction%5D.js) (handles `nonce` + `verify`) |
| Linking a Solana wallet to a user | Live | `user_wallets` table, `chain_type = 'solana'` |
| Solana payments (checkout + confirm) | Live | [api/payments/solana/\[action\].js](../api/payments/solana/%5Baction%5D.js) (handles `checkout` + `confirm`) |
| Agent identity NFT (Metaplex Core) | Live | [api/agents/register/\[action\].js](../api/agents/register/%5Baction%5D.js) (handles `solana-prep` + `solana-confirm`) |
| Agent record persisted in DB | Live | `agent_identities`, `meta.chain_type='solana'`, `meta.sol_mint_address` |
| On-chain reputation registry | **Not on Solana** | EVM only |
| On-chain validation registry | **Not on Solana** | EVM only (testnet) |
| Discovery file lists Solana agents | **Not yet** | [public/.well-known/agent-registration.json](../public/.well-known/agent-registration.json) is EVM-only |

---

## How identity works on Solana

EVM agents are minted as ERC-721 NFTs in the IdentityRegistry contract at a fixed CREATE2 address. Solana has no CREATE2 and no shared registry — instead each agent is a standalone **Metaplex Core asset** (a single-account NFT standard with name + URI metadata baked in).

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

Public RPCs are rate-limited. For production, set `SOLANA_RPC_URL` to a Helius, QuickNode, or Triton endpoint.

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
    network: 'devnet',                // or 'mainnet'
    avatar_id: avatarUuid,            // optional — must be owned by user
    metadata_uri: 'https://...',      // optional — else server synthesizes one
  }),
}).then(r => r.json());

// → { prep_id, asset_pubkey, tx_base64, network, metadata_uri, expires_at }
```

The server:
- Verifies the wallet is linked to the session user.
- If `avatar_id` is given, verifies the user owns the avatar.
- Builds an unsigned Metaplex Core `createV1` transaction with the user's pubkey as a `NoopSigner`. The asset (mint) keypair is generated server-side and pre-signs the transaction.
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

// → {
//     ok: true,
//     agent: { id, name, description, wallet_address, meta, home_url, ... },
//     sol_mint_address,
//     tx_signature,
//     network,
//   }
```

The server re-fetches the parsed transaction from the cluster, asserts:
- the tx exists and did not error,
- `asset_pubkey` appears in the transaction's account keys,
- no agent has already been registered for this mint,

then inserts the `agent_identities` row and clears the pending record.

---

## Error codes

Returned as `{ error, error_description }` from the prep / confirm endpoints.

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | No session |
| 403 | `forbidden` | Wallet is not linked to the session user |
| 404 | `not_found` | `avatar_id` doesn't exist or isn't owned by user |
| 422 | `tx_not_found` | RPC has not seen the signature yet — retry after a few seconds |
| 422 | `tx_failed` | Transaction landed on-chain but reverted |
| 422 | `asset_not_in_tx` | `asset_pubkey` is not among the transaction's account keys |
| 409 | `conflict` | An agent is already registered for this mint |
| 429 | `rate_limited` | Per-IP auth limiter tripped |

---

## Environment variables

| Var | Purpose |
|---|---|
| `SOLANA_RPC_URL` | Mainnet RPC. Defaults to public mainnet-beta. **Set this in production.** |
| `SOLANA_RPC_URL_DEVNET` | Devnet RPC. Defaults to public devnet. |
| `APP_ORIGIN` | Used to synthesize a default `metadata_uri` if the caller didn't provide one. |

SIWS-related env vars live in [api/_lib/env.js](../api/_lib/env.js) and [api/_lib/siws.js](../api/_lib/siws.js).

---

## Resolving a Solana agent

Given an `agent_identities` row with `meta.chain_type === 'solana'`:

- The asset can be fetched from any Solana RPC via Metaplex Core's `fetchAsset(umi, mint)`.
- The metadata JSON lives at `meta.metadata_uri` (or, if synthesized, at `${APP_ORIGIN}/api/agents/solana-metadata?...`).
- The mint transaction is at `https://solscan.io/tx/<tx_signature>` (or `?cluster=devnet`).

There is no global Solana registry to query — discovery happens via the platform's own indexes (`agent_identities`) until [public/.well-known/agent-registration.json](../public/.well-known/agent-registration.json) is extended to publish Solana entries.

---

## What's intentionally not on Solana yet

- **Reputation**: ERC-8004's `ReputationRegistry` is EVM-only. Solana agents have no on-chain feedback aggregation today. Reviews live in the platform DB. Off-chain pump.fun behavior signals are crawled into `pumpfun_signals` and surfaced through `solana-reputation` — see [solana-pumpfun.md](solana-pumpfun.md).
- **Validation**: Same. The `ValidationRegistry` is EVM testnet only; there is no Solana analog.
- **Delegated wallet (EIP-712)**: There is no equivalent for Solana agents. Owner = the wallet that signed the mint.
- **Cross-chain identifier**: EVM agents use `eip155:<chainId>:<registry>:<agentId>` (CAIP-10). Solana agents use the asset pubkey directly; a CAIP-10 form (`solana:<cluster-genesis>:<asset-pubkey>`) is not currently emitted by the platform.
- **Discovery**: `agent-registration.json` is EVM-shaped. Adding Solana entries means defining a JSON schema for Metaplex Core assets — not done.

A full ERC-8004-equivalent on Solana would mean writing three Anchor programs (Identity / Reputation / Validation) and a parallel JS client. That is a separate, larger piece of work; this document covers only what ships today.
