<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/skill-license</h1>

<p align="center"><strong>On-chain skill licenses — every purchased agent skill is a 1/1 SPL NFT and a deterministic <code>SkillLicense</code> PDA. Mint, verify, and read trustless access in one import.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/skill-license"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/skill-license?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/skill-license"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/skill-license?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/skill-license?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/skill-license?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/skill-license` is the official client for the three.ws
> **`skill_license`** Solana program — a trustless way to prove that a wallet
> owns a purchased agent skill. Each license is a real 1-of-1 SPL NFT held in the
> buyer's wallet, paired with a deterministic `SkillLicense` PDA that anyone can
> re-derive and read in a single RPC call. It wraps the public, auth-free verify
> endpoint ([`GET /api/skills/license-onchain`](https://three.ws)) — which derives
> the `SkillLicense` PDA and reads it back for you — so checking access is one
> function call instead of a database round-trip. It pairs with
> [`@three-ws/x402-server`](https://www.npmjs.com/package/@three-ws/x402-server)
> — gate a paid endpoint on a license the holder actually owns on-chain.

## Why

The usual way to answer "can this wallet use skill X on agent Y?" is a database
lookup you have to trust, run, and keep online. That's a single point of failure
and a closed door to anyone who isn't you.

The `skill_license` program makes the answer **public chain state**:

- **A license is an asset, not a row.** A 1/1 SPL NFT lands in the buyer's
  wallet — visible, ownable, transferable. Real ownership, not an entry you can
  silently flip.
- **Verification is deterministic.** The `SkillLicense` PDA is derived from
  `(owner, agent_mint, sha256(skill_name))`. Anyone re-derives the same address
  and reads it back: a PDA that exists with `revoked_at == 0` means the wallet
  owns the skill. No auth, no API key, no database.
- **One `getAccountInfo`, no enumeration.** The PDA is the strongly-typed record
  you check — you never have to walk a wallet's token accounts to find the NFT.
- **Refundable.** The minter retains freeze authority, so a refund can freeze
  the NFT and stamp `revoked_at` while leaving the record readable, so verifiers
  see the revoked state.

This SDK is the one-call front door to that chain state: `verifyLicense(...)`
→ `true | false`, resolved through the platform's public read endpoint, which
does the PDA derivation and RPC read for you.

## Install

```bash
npm install @three-ws/skill-license
```

Zero runtime dependencies. Works in Node 18+ and the browser (uses `fetch`).
Verification only reads public chain state through the platform endpoint, so no
wallet, signer, or RPC of your own is needed to check a license.

## Quick start

The one call that sells it — does this wallet own this skill, right now, on
chain?

```js
import { verifyLicense } from '@three-ws/skill-license';

const owns = await verifyLicense({
  holder: 'HoLDeRwa11et1111111111111111111111111111111',
  agent: 'THREEsynthetic1111111111111111111111111111', // agent skill-collection mint
  skill: 'web-search',
});

console.log(owns); // → true | false
```

Need the full record, not just a boolean — purchase date, NFT mint, explorer
link, revoked state:

```js
import { getLicense } from '@three-ws/skill-license';

const license = await getLicense({
  holder: 'HoLDeRwa11et1111111111111111111111111111111',
  agent: 'THREEsynthetic1111111111111111111111111111',
  skill: 'web-search',
});
if (license?.owned) {
  console.log(license.nftMint);      // the 1/1 SPL NFT in the holder's wallet
  console.log(license.purchaseDate); // unix seconds
  console.log(license.explorer);     // solscan/explorer link
}
```

Mint a license after a confirmed purchase (server-side, minter-signed):

```js
import { mintLicense } from '@three-ws/skill-license';

// Runs on your backend, authenticated as the buyer. Verifies the payment was
// confirmed on-chain, then mints the 1/1 NFT + SkillLicense PDA to the wallet.
const { nftMint, signature } = await mintLicense({
  agentId: '3b1f…-uuid',
  skill: 'web-search',
  buyer: 'HoLDeRwa11et1111111111111111111111111111111',
  txSignature: '4xKp…purchaseSig',
  apiKey: process.env.THREE_WS_API_KEY, // your three.ws bearer token
});
```

## API

The SDK is a thin wrapper over the live three.ws endpoints: the platform does the
Solana work (PDA derivation, RPC reads, minting) server-side, so every call is one
`fetch` and the client stays zero-dependency.

### `verifyLicense({ holder, agent, skill, network? }) → Promise<boolean>`

The headline check. Resolves to `true` when `holder` owns an active (non-revoked)
license for `skill` on `agent`. Wraps
`GET /api/skills/license-onchain?wallet=…&agent_mint=…&skill=…` and returns its
`data.owned` field.

| Param | Type | Default | Notes |
|---|---|---|---|
| `holder` | `string` | — | Base58 Solana pubkey of the wallet to check. |
| `agent` | `string` | — | The agent's on-chain grouping mint (its skill-collection mint). |
| `agentId` | `string` | — | Alternatively, a three.ws agent UUID — resolved to `skill_collection_mint` server-side. Pass `agent` **or** `agentId`. |
| `skill` | `string` | — | Skill name/slug (≤100 chars). Hashed with SHA-256 to form the PDA seed. |
| `network` | `'mainnet' \| 'devnet'` | `'mainnet'` | Which cluster to read. |

### `getLicense(input, { network? }) → Promise<LicenseRecord \| null>`

Read the full license record. `input` is `{ holder, agent, skill }` (or
`{ holder, agentId, skill }`), the same shape `verifyLicense` takes. Wraps
`GET /api/skills/license-onchain` and returns `null` when no license exists
on-chain.

**`LicenseRecord`**

| Field | Type | Notes |
|---|---|---|
| `owned` | `boolean` | Exists **and** not revoked **and** authority matches the holder. |
| `exists` | `boolean` | The PDA is present on-chain. |
| `revoked` | `boolean` | `true` once `revokedAt !== 0` (refunded / frozen). |
| `authority` | `string` | The wallet that owns the license. |
| `agentMint` | `string` | The agent grouping mint recorded on the license. |
| `nftMint` | `string` | The 1/1 SPL NFT mint backing the license. |
| `ownerTokenAccount` | `string` | The holder's ATA for the NFT. |
| `skillName` | `string` | Human-readable skill identifier (≤64 bytes). |
| `skillHash` | `string` | Hex SHA-256 of `skillName` (the third PDA seed). |
| `purchaseDate` | `number` | Unix seconds the license was minted. |
| `revokedAt` | `number` | Unix seconds when revoked, or `0` while active. |
| `license` | `string` | The `SkillLicense` PDA address. |
| `explorer` | `string` | Explorer link to the license account. |

### `skillSeed(skillName) → Promise<string>`

`sha256(skillName)` as a 32-byte hex string — the fixed-length third PDA seed.
Async (Web Crypto's `crypto.subtle.digest`, so it runs zero-dep in Node 18+ and
the browser). Matches the program's `skill_seed()` (Solana `hash::hash` is
SHA-256), so it reproduces the exact hash the on-chain seed uses.

### `mintLicense({ agentId, skill, buyer, txSignature?, apiKey }) → Promise<MintResult>`

**Server-side.** Mints the on-chain license to `buyer` after their purchase is
confirmed. Wraps `POST /api/skills/mint`, which verifies the payment reached the
agent's payout wallet before minting — a caller can never mint a free license.
Idempotent: a second call returns the existing mint.

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | three.ws agent UUID. |
| `skill` | `string` | Skill name/slug (≤100 chars). |
| `buyer` | `string` | Recipient wallet — must be a Solana wallet linked to the caller's account. |
| `txSignature` | `string` | The purchase transaction signature (optional; the most recent attempt is used otherwise). |
| `apiKey` | `string` | Bearer token for the authenticated three.ws account (overrides the client's `apiKey`). |

To point the client at a different origin, construct one with
`createSkillLicense({ baseUrl })` instead of passing `baseUrl` per call.

**Returns `MintResult`**: `{ nftMint, signature, collection, network, explorer, skill, agentId, purchaseId, alreadyMinted }`.

`PROGRAM_ID` is exported as a constant
(`EdngSwxmDktyrr4phwGEZnCXEoQ27vgnBtowjhKa7Wr8`) — the same id on every cluster.

## How it works

The license is two linked artifacts derived from one triple
`(owner, agent_mint, sha256(skill_name))`:

```
buy skill ──▶ payment confirmed on-chain ──▶ mint_skill_license (minter-signed)
                                                │
                                                ├─ SkillLicense PDA   ← the queryable record
                                                │     seeds = ["skill_license", owner, agent, sha256(skill)]
                                                │     { authority, agent_mint, nft_mint, skill_hash,
                                                │       purchase_date, revoked_at, skill_name }
                                                │
                                                └─ 1/1 SPL NFT ──▶ owner's ATA
                                                      mint PDA = ["skill_mint", owner, agent, sha256(skill)]
                                                      decimals 0, supply locked at 1 (mint authority removed)

verify ─▶ derive SkillLicense PDA ─▶ getAccountInfo ─▶ exists && revoked_at == 0  ⇒  owned
```

- **The NFT** is the transferable, wallet-visible proof of ownership.
- **The PDA** is the cheap, strongly-typed record the platform reads to answer
  access questions in one `getAccountInfo` — no token-account enumeration.
- `skill_name` can be up to 64 bytes (longer than the 32-byte per-seed limit),
  so it's hashed to a fixed 32 bytes. The client (`skillSeed`) computes the
  identical hash, so both sides derive the same addresses.
- Minting is **idempotent**: a second mint for the same triple fails because the
  PDAs already exist. The purchase can only ever produce one license.

The program is **Anchor**, id `EdngSwxmDktyrr4phwGEZnCXEoQ27vgnBtowjhKa7Wr8`
(identical on localnet/devnet/mainnet). Its instructions:

| Instruction | Signer | Effect |
|---|---|---|
| `initialize_marketplace(minter)` | admin | One-time singleton config; sets the authorized minter wallet. |
| `set_minter(new_minter)` | admin | Rotate the minter (key rotation). |
| `mint_skill_license(skill_name)` | minter | Create the `SkillLicense` PDA, mint the 1/1 NFT to the owner's ATA, lock supply at 1. Owner doesn't sign. |
| `burn_skill_license()` | owner | Burn the NFT, close the token account + PDA, reclaim rent. |
| `revoke_skill_license()` | minter | Refund path: freeze the holder's token account and stamp `revoked_at`; the PDA stays readable. |

## Errors & edge cases

`verifyLicense` and `getLicense` only read public state, so they never need
credentials. The shapes they surface, straight from the endpoint:

| State | Meaning | What you get |
|---|---|---|
| Program not deployed | The `skill_license` program isn't live on this cluster. | `getLicense` → `{ exists: false, owned: false, deployed: false }`; `verifyLicense` → `false`. |
| No license | The PDA doesn't exist — never purchased. | `getLicense` → `null`; `verifyLicense` → `false`. |
| Revoked | Refunded — frozen with `revoked_at` set. | `{ exists: true, revoked: true, owned: false }`. |
| `rpc_error` (502) | The Solana RPC read failed. | Rejects; retry or fall back. |
| `no_collection` (409) | Resolved by `agentId` but the agent has no on-chain skill collection yet. | Rejects — nothing can be licensed on-chain for that agent. |

`mintLicense` surfaces the mint endpoint's authenticated states:

| `code` | HTTP | Meaning | Recovery |
|---|---|---|---|
| `unauthorized` | 401 | Missing/invalid bearer. | Pass a valid `apiKey`. |
| `wallet_not_linked` | 403 | `buyer` isn't a Solana wallet linked to your account. | Link the wallet first. |
| `no_purchase` | 404 | No purchase row for this skill. | Buy the skill before minting. |
| `payment_pending` | 402 | The purchase payment isn't confirmed yet. | Wait for confirmation, then retry. |
| `signature_mismatch` | 400 | `txSignature` contradicts the recorded purchase. | Send the correct signature, or omit it. |
| `already minted` | 200 | A license already exists. | Returned with `alreadyMinted: true` — treat as success. |

Every state is designed: a missing license reads as `false`, never a crash; an
unconfirmed payment returns `402`, never a free mint.

## Examples

**Gate a paid x402 endpoint on real ownership** — pair with
[`@three-ws/x402-server`](https://www.npmjs.com/package/@three-ws/x402-server):

```js
import { verifyLicense } from '@three-ws/skill-license';

async function handler(req, res) {
  const owns = await verifyLicense({
    holder: req.wallet,
    agent: AGENT_SKILL_COLLECTION_MINT,
    skill: 'web-search',
  });
  if (!owns) return res.status(402).json({ error: 'license required' });
  // …serve the skill
}
```

**Render a "You own this" badge in the browser** — verification is read-only, so
it runs client-side with no signer:

```js
import { verifyLicense } from '@three-ws/skill-license';

const owned = await verifyLicense({ holder: wallet, agentId: AGENT_UUID, skill });
badge.textContent = owned ? 'Licensed on-chain ✓' : 'Buy this skill';
```

**Under the hood** — the raw HTTP the verify path wraps, so the docs hold even
before the wrapper ships:

```js
const u = new URL('https://three.ws/api/skills/license-onchain');
u.searchParams.set('wallet', holder);
u.searchParams.set('agent_mint', agent); // or agent_id=<uuid>
u.searchParams.set('skill', skill);

const { data } = await fetch(u).then((r) => r.json());
// data → { owned, exists, revoked, deployed, license, nft_mint,
//          owner_token_account, program_id, explorer, record }
console.log(data.owned);
```

## Related

- [`@three-ws/x402-server`](https://www.npmjs.com/package/@three-ws/x402-server) — gate a paid endpoint on a verified license.
- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) — pay for the skill that mints the license.
- [`@three-ws/agent-memory`](https://www.npmjs.com/package/@three-ws/agent-memory) — durable state for the agents these skills extend.
- [`@three-ws/reputation`](https://www.npmjs.com/package/@three-ws/reputation) — on-chain agent reputation, the same trustless-state pattern.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
