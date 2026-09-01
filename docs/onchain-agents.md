# Deploying Agents On-Chain (Bulk)

Give every three.ws agent a real on-chain identity: a **Metaplex Core NFT** minted into the **three.ws Agents collection** on Solana. This page is for platform admins and self-hosters; regular users register a single agent through the wallet-signed flow instead. It is the bulk/admin counterpart to the single-agent, user-signed flow in [Solana agents](solana.md): it deploys many agents server-side through a CLI runner that reports every mint as it lands.

> Not pump.fun. These are NFTs (on-chain identity), not tokens. The only coin three.ws ever references is `$THREE`; it appears in each asset's metadata as a link, nothing more.

---

## What you get

For every agent, one **Metaplex Core asset** that is:

- **minted into the three.ws Agents collection** — authority-managed, so three.ws can curate on-chain metadata on the owner's behalf;
- **owned by the agent** (its own custodial Solana wallet) or held in **authority custody** until claimed — see [Custody model](#custody-model);
- carrying an on-chain **Attributes plugin** (platform, links, `$THREE`, schema — real bytes in the asset account) and an enforced **5% Royalties plugin**;
- pointing at a pinned **manifest** (Metaplex token-metadata + `agent-manifest/0.1`) on IPFS, so Phantom / Solscan / Magic Eden render it;
- **enrolled in the Metaplex Agent Registry** right after the mint: an Agent Identity PDA, authority-signed, whose URI points at the agent's live `/api/agents/:id/registration` document (see [What gets recorded](#what-gets-recorded)).

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
                                       │
                                       ▼
                       scripts/deploy-agents-onchain.mjs
                       (CLI runner: canary + full run)
                                       │
                                       ▼
                       node --env-file=.env … --confirm
```

Files:

| File | Role |
|---|---|
| [api/_lib/onchain-deploy.js](../api/_lib/onchain-deploy.js) | Shared mint logic — collection resolution, manifest pin, Core mint, DB persist. |
| [scripts/deploy-agents-onchain.mjs](../scripts/deploy-agents-onchain.mjs) | CLI runner — dry-run preview, canary, full fleet. |
| [scripts/register-agents-onchain.mjs](../scripts/register-agents-onchain.mjs) | CLI back-fill: enrols already-minted agents that have a Core asset but no Agent Identity PDA (same `--network` / `--limit` / `--dry-run` / `--confirm` flags). |
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
| Register its Agent Identity PDA | ~0.003 SOL (rent + fee) |

So ~0.05 SOL canaries a handful; **~0.007 × N** covers a fleet of N (≈ 13 SOL for ~1,850 agents). The runner checks the balance before each mint and pauses cleanly if it runs low: top up and re-run.

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
    "onchain_id": "<asset pubkey>",
    "sol_asset": "<asset pubkey>",
    "contract_or_mint": "<asset pubkey>",
    "metadata_uri": "https://ipfs.io/ipfs/<cid>",
    "owner": "<owner pubkey>",
    "custody": true,
    "tx_hash": "<signature>",
    "confirmed_at": "<iso>"
  }
}
```

`sol_mint_address` is the canonical key every read path uses (explore, discover, profiles). It also makes re-runs **idempotent**: an agent that already has it is skipped. (Devnet runs are isolated under `meta.devnet` so they never block a real mainnet mint.) An `agent_actions` row (`type: solana.deploy`) is logged, and on mainnet a truthful `agent-onchain` feed event fires.

Right after the mint, `registerAgentOnce()` enrols the asset in the Metaplex Agent Registry. The collection authority signs (the owner still never signs and needs no SOL), the Agent Identity PDA's URI is set to the agent's live `/api/agents/:id/registration` document rather than a pinned snapshot (the registry program has no instruction to change a URI later, so a mutable endpoint keeps `active`, services, and the model current), and an `agent_registry` block is merged into the same `meta` (`standard: metaplex-agent-registry`, `program`, `identity_pda`, `asset`, `collection`, `authority`, `registration_uri`, `network`, `tx_hash`, `registered_at`; under `meta.devnet` for devnet runs). A second `agent_actions` row (`type: solana.register`) is logged. A registry failure never undoes the mint: the asset and `sol_mint_address` are already persisted, the runner prints `registry skipped: <error> (back-fill later)`, and `scripts/register-agents-onchain.mjs` picks up every agent that has `sol_mint_address` but no `agent_registry.identity_pda`.

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

## Batch runs

The in-app bulk-launch dashboard was removed with the admin panel; batch
registration runs through the CLI runner only
(`scripts/deploy-agents-onchain.mjs`, Tutorial 2 above). It calls the same
`api/_lib/onchain-deploy.js` functions the dashboard did, so assets minted
before and after the removal are identical.

## Tutorial 3: The full fleet

Once the canary checks out and the funder holds enough SOL (~0.007 × N):

```bash
# CLI, in batches:
node --env-file=.env scripts/deploy-agents-onchain.mjs --limit 500 --confirm
# …re-run until "Found 0 agent(s)". Re-runs are safe.
```

`--limit` is clamped to 500 per run, so a larger fleet is several runs of the
same command; already-deployed agents are skipped, so re-running is safe and
costs nothing extra. Run on **production** if you want per-agent ownership for
wallet-less agents (see [Custody model](#custody-model)).

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
| `↳ registry skipped: …` under a ✓ mint | The Core asset minted and persisted, but the Agent Registry enrolment failed (usually the RPC). Re-run `node --env-file=.env scripts/register-agents-onchain.mjs --confirm`; it only targets agents with `sol_mint_address` and no `agent_registry.identity_pda`, and already-registered assets short-circuit without a transaction. |

---

## See also

- [Solana agents](solana.md) — the single-agent, user-signed registration flow.
- [ERC-8004](erc8004.md) — the EVM on-chain identity path.
- [Agent manifest](agent-manifest.md) — the metadata schema.
- [Mint mark ("3ws")](mint-mark.md) — vanity marking for three.ws launches.
