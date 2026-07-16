# Deploying Agents On-Chain (Bulk)

Give every three.ws agent a real on-chain identity: a **Metaplex Core NFT** minted into the **three.ws Agents collection** on Solana. This is the bulk/admin counterpart to the single-agent, user-signed flow in [Solana agents](solana.md) — it deploys many agents server-side, with a live recording dashboard and a CLI runner.

> Not pump.fun. These are NFTs (on-chain identity), not tokens. The only coin three.ws ever references is `$THREE`; it appears in each asset's metadata as a link, nothing more.

---

## What you get

For every agent, one **Metaplex Core asset** that is:

- **minted into the three.ws Agents collection** — authority-managed, so three.ws can curate on-chain metadata on the owner's behalf;
- **owned by the agent** (its own custodial Solana wallet) or held in **authority custody** until claimed — see [Custody model](#custody-model);
- carrying an on-chain **Attributes plugin** (platform, links, `$THREE`, schema — real bytes in the asset account) and an enforced **5% Royalties plugin**;
- pointing at a pinned **manifest** (Metaplex token-metadata + `agent-manifest/0.1`) on IPFS, so Phantom / Solscan / Magic Eden render it.

The live mainnet collection: [`56Gnsb7Jjg1N9c8V7EAnDC4HmQbQjsEueSUA3EK5272H`](https://solscan.io/account/56Gnsb7Jjg1N9c8V7EAnDC4HmQbQjsEueSUA3EK5272H).

---

## Architecture

One module holds the mint logic; two surfaces drive it.

```
                       ┌───────────────────────────────────────────┐
                       │  api/_lib/onchain-deploy.js                 │
                       │  (single source of truth)                   │
                       │   • buildAuthorityUmi()                     │
                       │   • resolveAgentCollection()  ← env|db|deploy│
                       │   • loadCollectionAsset()                   │
                       │   • fetchUndeployedAgents()                 │
                       │   • deployAgentOnce()  ← pin + mint + persist│
                       └───────────────┬───────────────┬────────────┘
                                       │               │
          ┌────────────────────────────┘               └───────────────────────────┐
          ▼                                                                          ▼
  api/admin/bulk-launch.js                                          scripts/deploy-agents-onchain.mjs
  (SSE dashboard endpoint)                                          (CLI runner — canary + full run)
          ▼                                                                          ▼
  pages/bulk-launch.html  →  /admin/bulk-launch                     node --env-file=.env … --confirm
```

Both surfaces call the same functions, so they mint **identical** assets. Files:

| File | Role |
|---|---|
| [api/_lib/onchain-deploy.js](../api/_lib/onchain-deploy.js) | Shared mint logic — collection resolution, manifest pin, Core mint, DB persist. |
| [api/admin/bulk-launch.js](../api/admin/bulk-launch.js) | Admin SSE endpoint (`GET /api/admin/bulk-launch`) streaming live progress. |
| [pages/bulk-launch.html](../pages/bulk-launch.html) | Live dashboard at `/admin/bulk-launch` — funder balance, stats, animated cards. |
| [scripts/deploy-agents-onchain.mjs](../scripts/deploy-agents-onchain.mjs) | CLI runner — dry-run preview, canary, full fleet. |
| [api/_lib/solana-collection.js](../api/_lib/solana-collection.js) | Collection authority + address helpers. |
| [api/_lib/three-brand.js](../api/_lib/three-brand.js) | Manifest + on-chain attributes builders. |

---

## The collection

Every agent is minted **into** a single Metaplex Core *collection* account, "three.ws Agents". The collection's update authority is a three.ws-held keypair, which makes every member asset **authority-managed**: the owner holds (and can transfer/sell) the asset, while three.ws can edit its on-chain metadata on request.

`resolveAgentCollection()` finds the collection in this order, and only deploys once:

1. **Env** — `SOLANA_AGENT_COLLECTION_MAINNET` / `_DEVNET` (keeps the interactive deploy + edit paths aligned).
2. **DB** — the `app_settings` table, key `solana_agent_collection_<network>`.
3. **Deploy** — first run with neither set deploys the collection (funded + signed by the authority), then persists its address to `app_settings`.

> After the first run, set `SOLANA_AGENT_COLLECTION_MAINNET=<address>` in your environment so the single-agent flow in [Solana agents](solana.md) mints into the *same* collection.

---

## Custody model

`deployAgentOnce()` resolves the asset **owner** like this:

1. **Agent already has a wallet** (`meta.solana_address`) → mint to it. The agent owns its identity directly.
2. **No wallet + `JWT_SECRET` present** (i.e. on production) → generate a per-agent custodial Solana wallet, encrypt the secret with the platform key, store it, and mint to it. The agent owns its identity; three.ws can recover the key.
3. **No wallet + no `JWT_SECRET`** (e.g. a local CLI run) → mint to the **collection authority** as custodian (`custody: true`). Transferable to the agent/user later via a claim flow.

The owner of a Core asset does **not** sign the mint, so **agent wallets never need SOL**. Only the authority/funder wallet spends.

> Run the full fleet where `JWT_SECRET` lives (production) if you want per-agent ownership for agents that don't yet have a wallet. A local run will custody those under the authority instead.

---

## Cost & the funder wallet

One funded wallet does everything — it is the **collection authority**, the **mint fee payer**, and the **collection deployer**. Resolved from `SOLANA_AGENT_COLLECTION_AUTHORITY_KEY` (falls back to `LAUNCH_FUNDER_SECRET`).

| Action | Approx cost |
|---|---|
| Deploy the collection (once) | ~0.003 SOL |
| Mint one agent asset | ~0.004 SOL (rent + fee) |

So ~0.05 SOL canaries a handful; **~0.004 × N** covers a fleet of N (≈ 7.5 SOL for ~1,850 agents). The runner checks the balance before each mint and pauses cleanly if it runs low — top up and re-run.

---

## Metadata

Two layers, both real:

- **Off-chain manifest** (`buildAgentManifest`) — a superset of the Metaplex token-metadata standard and `agent-manifest/0.1`: name, image (avatar thumbnail), `animation_url` (the GLB body), `external_url` (the agent's three.ws page), attributes, the platform brand block, and the `$THREE` link. Pinned to **IPFS via Pinata** (`PINATA_JWT`) → falls back to web3.storage → falls back to R2 with a real CIDv1. Never a stub.
- **On-chain Attributes plugin** (`buildAgentOnchainAttributes`) — a curated ~11-pair subset written into the asset account itself: `platform`, `url`, `agent`, `agent_url`, `x`, `github`, `$THREE`, `$THREE_url`, `standard`, `schema`, `created`. Byte-clamped to keep the whole transaction under Solana's 1232-byte limit.

---

## What gets recorded

On a confirmed mint, `deployAgentOnce()` writes to `agent_identities.meta`:

```json
{
  "chain_type": "solana",
  "network": "mainnet",
  "sol_mint_address": "<asset pubkey>",
  "collection": "56Gnsb7Jjg1N9c8V7EAnDC4HmQbQjsEueSUA3EK5272H",
  "update_authority": "threews",
  "onchain": {
    "chain": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "family": "solana",
    "cluster": "mainnet",
    "sol_asset": "<asset pubkey>",
    "metadata_uri": "https://ipfs.io/ipfs/<cid>",
    "owner": "<owner pubkey>",
    "custody": true,
    "tx_hash": "<signature>",
    "confirmed_at": "<iso>"
  }
}
```

`sol_mint_address` is the canonical key every read path uses (explore, discover, profiles). It also makes re-runs **idempotent**: an agent that already has it is skipped. (Devnet runs are isolated under `meta.devnet` so they never block a real mainnet mint.) An `agent_actions` row (`type: solana.deploy`) is logged, and on mainnet a truthful `agent-onchain` feed event fires.

---

## Setup

Add to `.env` (the wallet that signs + pays must hold SOL on the target network):

```bash
# Authority = mint fee payer = collection deployer (one funded wallet)
SOLANA_AGENT_COLLECTION_AUTHORITY_KEY=<bs58 secret>

# IPFS pinning for manifests (preferred; see below)
PINATA_JWT=<jwt>

# Database (production agents)
DATABASE_URL=postgresql://…

# Optional but recommended for the full run — a keyed RPC beats the
# rate-limited public endpoint for hundreds of sends.
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=…
```

**Getting a `PINATA_JWT`:** [app.pinata.cloud](https://app.pinata.cloud) → API Keys → New Key → **Admin** → copy the JWT (the code pins via the legacy `pinFileToIPFS` endpoint, which an Admin JWT authorizes). The dashboard on production already has these env vars.

---

## Tutorial 1 — Dry run (no SOL, no writes)

Preview exactly which agents would deploy:

```bash
node --env-file=.env scripts/deploy-agents-onchain.mjs --limit 3 --dry-run
```

```
three.ws — on-chain agent deploy (Metaplex Core)
  network: mainnet   limit: 3   DRY RUN
  funder:  p8STS4g7KCp77fYxXsEADNRUWHQUbq4T5xBs3RiMPnX  (0.0754 SOL)

Found 3 agent(s) without an on-chain identity on mainnet:
  • Chain Watcher 2  (660444ae)
  • Event Scanner 5  (9f0ede49)
  • Governance Bot 13  (4a46e416)

Dry run — no SOL spent, no writes. Re-run with --confirm to deploy.
```

---

## Tutorial 2 — The canary (3 agents, CLI)

Always deploy a few first and verify before the fleet. A live run requires `--confirm` (it spends real SOL):

```bash
node --env-file=.env scripts/deploy-agents-onchain.mjs --limit 3 --confirm
```

```
Collection [deployed]: 56Gnsb7Jjg1N9c8V7EAnDC4HmQbQjsEueSUA3EK5272H  (deploy sig 3iRcPUVd…)
[1/3] Chain Watcher 2 … ✓ A1Enk7aPqLdJjhQ3xtN5sDpnVacYDLGChR7YnusJMGGS
        https://solscan.io/account/A1Enk7aPqLdJjhQ3xtN5sDpnVacYDLGChR7YnusJMGGS
[2/3] Event Scanner 5 … ✓ 2sBBq8TE8LRMGGLJwKwnwMotEoXUBxvoehvorkbCqAo7
[3/3] Governance Bot 13 … ✓ 8XKAXv7MxGD6mW2xE33EPc9YVexteaMKDNmVbJqmRRjw
Done — deployed: 3, errors: 0.
```

The first run also deploys the collection. Re-runs reuse it and skip already-deployed agents.

**Flags:**

| Flag | Default | Meaning |
|---|---|---|
| `--network` | `mainnet` | `mainnet` or `devnet`. |
| `--limit N` | `3` | Max agents this run. |
| `--dry-run` | off | Preview only — no SOL, no writes. |
| `--confirm` | off | Required for a live run. |

---

## Tutorial 3 — The live dashboard

For the visual recording, use the admin dashboard (production has all the env vars):

1. Open **`/admin/bulk-launch`** (admin-gated via `requireAdmin`).
2. The sidebar shows the funder address (click to copy) and live SOL balance.
3. Set **Network**, **Agents per run** (start at 3), and optionally tick **Dry run**.
4. Click **Deploy On-Chain**. The collection deploys on the first run, then each agent's card animates in the moment its asset confirms — with avatar, owner, asset address, and a Solscan link.

Under the hood it's an [SSE](https://developer.mozilla.org/docs/Web/API/Server-sent_events) stream from `GET /api/admin/bulk-launch?network=&limit=&dry_run=`:

| Event | Payload |
|---|---|
| `init` | `{ total, network, funder, funder_balance_sol, dry_run }` |
| `collection` | `{ address, source: env\|db\|deployed, authority, signature? }` |
| `wallet` | `{ agent_id, name, owner }` (a custodial wallet was created) |
| `deployed` | `{ agent_id, name, asset, owner, metadata_uri, signature, explorer_url, avatar_thumb }` |
| `paused` | `{ funder_balance_sol, deployed, reason }` (funder low on SOL) |
| `error` | `{ agent_id, name, error }` |
| `done` | `{ deployed, errors, skipped }` |

---

## Tutorial 4 — The full fleet

Once the canary checks out and the funder holds enough SOL (~0.004 × N):

```bash
# CLI, in batches:
node --env-file=.env scripts/deploy-agents-onchain.mjs --limit 500 --confirm
# …re-run until "Found 0 agent(s)". Re-runs are safe.
```

…or set **Agents per run = 500** on the dashboard and click Deploy, repeating until none remain. Run on **production** if you want per-agent ownership for wallet-less agents (see [Custody model](#custody-model)).

---

## Verifying on-chain

```js
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, fetchAsset, fetchCollection } from '@metaplex-foundation/mpl-core';
import { publicKey } from '@metaplex-foundation/umi';

const umi = createUmi(process.env.SOLANA_RPC_URL).use(mplCore());
const asset = await fetchAsset(umi, publicKey('<asset pubkey>'));

asset.updateAuthority.type;            // 'Collection'  ← in the collection
asset.updateAuthority.address;         // the collection pubkey
asset.royalties.basisPoints;           // 500
asset.attributes.attributeList.length; // 11
await (await fetch(asset.uri)).json(); // resolvable manifest
```

A confirmed canary asset shows `inCollection=true`, `royalty=500bps`, `attrs=11`, and a resolvable IPFS URI; the matching DB row has `meta.sol_mint_address` and `meta.collection` set.

---

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Assets mint but `updateAuthority.type !== 'Collection'` | mpl-core's `create` wants the collection as an **object** (`{publicKey, oracles, lifecycleHooks}`), not a bare pubkey — passing an address silently mints standalone. The shared module fetches the real collection via `loadCollectionAsset()`; never pass a bare pubkey to `create({ collection })`. |
| `Missing required env var: JWT_SECRET` | A wallet-less agent tried to generate a custodial wallet. Either run on production (where `JWT_SECRET` lives) for per-agent wallets, or accept authority custody — the module falls back to custody automatically when the key is absent. |
| `funder needs ~0.005 SOL to deploy the collection` | First-run collection deploy needs SOL. Top up the authority wallet. |
| Run pauses: `funder wallet is low on SOL` | Top up and re-run; already-deployed agents are skipped. |
| `solana rpc 429` / send timeouts | The public endpoint is rate-limited. Set `SOLANA_RPC_URL` to a Helius/Quicknode/Triton endpoint for the full run. |
| Manifest URI doesn't resolve | `PINATA_JWT` missing/invalid and no R2 configured. Set a valid `PINATA_JWT` (or `WEB3_STORAGE_TOKEN`, or the `S3_*` set). |
| An agent re-deploys unexpectedly | It shouldn't — `meta.sol_mint_address IS NULL` is the skip guard. If you intentionally re-mint, clear `sol_mint_address`/`onchain` from its `meta` first. |

---

## See also

- [Solana agents](solana.md) — the single-agent, user-signed registration flow.
- [ERC-8004](erc8004.md) — the EVM on-chain identity path.
- [Agent manifest](agent-manifest.md) — the metadata schema.
- [Mint mark ("3ws")](mint-mark.md) — vanity marking for three.ws launches.
