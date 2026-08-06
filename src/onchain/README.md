# src/onchain

Unified, family-agnostic on-chain deploy stack. This superseded the legacy
`src/erc8004/deploy-button.js` (deleted 2026-08-06); `src/erc8004/solana-deploy.js`
remains as the RegisterUI wizard's Solana driver (vanity grinding included).

## Why this exists

The legacy stack branches on chain family (`if isSolana ...`) at every layer:
deploy button, register-prep payload, agent_identities `meta` shape. Every new
chain family doubles the branching surface. This module collapses all of that
behind two abstractions:

- **`ChainRef`** — a CAIP-2-shaped value: `{ family, chainId | cluster }`. Every
  helper takes a `ChainRef`. Family-specific knowledge does not leak into the
  UI.
- **`WalletAdapter`** — `{ connect, switchTo, signAndSend }`. EVM and Solana
  adapters implement the same interface; the deploy orchestrator never sees
  `window.ethereum` or `window.phantom` directly.

## Layout

```
src/onchain/
├── chain-ref.js          ChainRef + CAIP-2 + chain registry (pure)
├── adapters/
│   ├── base.js           WalletAdapter abstract class + isUserRejection()
│   ├── evm.js            ethers + window.ethereum
│   ├── solana.js         @solana/web3.js + Phantom/Backpack/Solflare + inline SIWS
│   └── index.js          getAdapter(family) factory with cache
├── deploy.js             Unified prep → sign → confirm orchestrator
└── deploy-button.js      Mountable UI component (drop-in for legacy)
```

## API surface (frontend)

```js
import { OnchainDeployButton } from 'src/onchain/deploy-button.js';

const btn = new OnchainDeployButton({
  agent,                          // { id, name, description?, avatarId?, onchain? }
  container: document.querySelector('#deploy'),
  preferredChain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',  // CAIP-2; default Solana mainnet (Metaplex Core)
});
btn.mount();
```

Or, headless:

```js
import { deployAgent } from 'src/onchain/deploy.js';
import { evm, solana } from 'src/onchain/chain-ref.js';

const result = await deployAgent({
  agent,
  ref: solana('devnet'),
  onProgress: (step) => console.log(step), // 'connect'|'prep'|'sign'|'confirm'|'save'
});
// → { ref, txHash, onchainId, contractOrMint, agent }
```

## API surface (server)

Two endpoints — replace the four legacy ones:

| Endpoint                          | Purpose                                                 |
| --------------------------------- | ------------------------------------------------------- |
| `POST /api/agents/onchain/prep`   | Pin manifest, build family-specific tx prep, return prepId |
| `POST /api/agents/onchain/confirm`| Verify tx on-chain, link wallet, write `meta.onchain`   |

Request shape (prep):

```json
{
  "agent_id": "uuid",
  "chain": "eip155:8453",
  "wallet_address": "0x...",
  "name": "...",
  "description": "...",
  "avatar_id": "uuid|null",
  "skills": ["..."]
}
```

Response (prep): `{ prepId, chain, metadataUri, cid, contractAddress | { assetPubkey, txBase64, cluster } }`

Request shape (confirm):

```json
{
  "prep_id": "...",
  "tx_hash": "0x... | <base58 sig>",
  "onchain_id": "<EVM agentId> | null",
  "wallet_address": "..."
}
```

Confirm writes a single canonical block to `agent_identities.meta.onchain`:

```json
{
  "onchain": {
    "chain":            "eip155:8453",
    "family":           "evm",
    "tx_hash":          "0x...",
    "onchain_id":       "42",
    "contract_or_mint": "0x8004...",
    "wallet":           "0x...",
    "metadata_uri":     "ipfs://...",
    "confirmed_at":     "2026-..."
  }
}
```

Frontend reads `agent.onchain` only — no family-specific fields.

## Migration

`api/_lib/migrations/2026-04-29-onchain-unified.sql` backfills legacy rows
(both EVM and Solana shapes) into `meta.onchain`. Idempotent. Apply via:

```bash
psql $DATABASE_URL -f api/_lib/migrations/2026-04-29-onchain-unified.sql
```

The legacy endpoints (`register-prep`, `register-confirm`,
`solana-register-prep`, `solana-register-confirm`) are left intact. Deprecate
once all callers move to `/api/agents/onchain/*`.

## Adding a new chain family

1. Add a `ChainRef` constructor + CAIP-2 namespace handling in `chain-ref.js`.
2. Add an entry helper to `buildRegistry()` so it appears in the dropdown.
3. Implement `WalletAdapter` for the family in `adapters/<name>.js`.
4. Wire the adapter into `getAdapter()` in `adapters/index.js`.
5. Add a `prep<Family>()` branch in `api/agents/onchain/prep.js` and a
   `verify<Family>()` branch in `api/agents/onchain/confirm.js`.

No UI changes required.

## Tests

`tests/src/onchain.test.js` — pure-logic coverage of `chain-ref` + adapter
factory dispatch. Wallet I/O is integration-tested via Playwright (not yet
written for this module — TODO).

## Token launches (Pump.fun, …)

Layered on top of the deploy stack. Same pattern: a `TokenAdapter` interface
under `src/onchain/tokens/` with one impl today (`PumpfunTokenAdapter`) and
two endpoints (`/api/agents/tokens/launch-prep` + `launch-confirm`) writing a
canonical `meta.token` block on the agent record:

```json
{
  "token": {
    "provider":     "pumpfun",
    "mint":         "<base58>",
    "symbol":       "AGT",
    "name":         "Agent",
    "metadata_uri": "ipfs://...",
    "cluster":      "mainnet" | "devnet",
    "creator":      "<base58>",
    "tx_signature": "<base58>",
    "launched_at":  "2026-...",
    "pumpfun_url":  "https://pump.fun/<mint>"
  }
}
```

Mounting:

```js
import { LaunchTokenButton } from 'src/onchain/launch-token-button.js';
new LaunchTokenButton({ agent, container }).mount();
```

The button auto-hides itself unless the agent is deployed on Solana. After a
launch, it rehydrates as a chip linking to the Pump.fun page (mainnet) or
Solana Explorer (devnet).

Schema migration: `api/_lib/migrations/2026-04-29-token-launches.sql`.

Pump.fun specifics:
- The mint Keypair is generated server-side and partial-signs the launch tx.
  Its secret key never touches the client and is dropped after partial-signing.
- Optional `initial_buy_sol` (0–50) buys the first slot on the bonding curve
  in the same transaction as the create.
- Compute budget is bumped to 350k units — coin creation routinely overflows
  the 200k default and reverts otherwise.
- Mainnet only after deploy. Devnet works for QA via Pump.fun's devnet-tagged
  SDK builds (`@pump-fun/pump-sdk@*-devnet.*`).

### Cost preview

`GET /api/agents/tokens/launch-quote?initial_buy_sol=0.5&cluster=mainnet` →
`{ fixed_total_sol, initial_buy: { tokens_out, protocol_fee_sol }, total_sol }`.
Returns conservative upper-bound rent costs + a live curve quote when an
initial buy is requested. Surface in any UI that asks the user to launch.

### Migrations

Apply migrations with the bundled runner:

```bash
DATABASE_URL=postgres://… node scripts/apply-migrations.mjs           # dry-run
DATABASE_URL=postgres://… node scripts/apply-migrations.mjs --apply   # execute
```

Tracks state in `schema_migrations` (filename + sha256). Refuses to proceed
if a previously-applied file has been edited after the fact (drift) — roll
forward with a new migration instead.

## Agent payments (Pump.fun agent-payments-sdk)

Layered on top of token launches. Same prep/sign/submit/confirm pattern.

Two flows:

- **Owner enables payments** — once the agent has a launched token, the owner
  signs a one-time `create` tx that registers the agent's TokenAgentPayments
  PDA. Persists `meta.payments` on the agent record.
- **Anyone pays the agent** — signed-in user picks a currency mint + amount,
  signs an `agent_accept_payment` tx, server verifies via the SDK's
  `validateInvoicePayment` and writes `agent_payment_intents.status='paid'`.

```js
import {
  EnablePaymentsButton,
  PayAgentButton,
} from 'src/onchain/payments-buttons.js';

new EnablePaymentsButton({ agent, container }).mount(); // owner-only
new PayAgentButton({ agent, container }).mount();       // any signed-in user
```

Endpoints: `/api/agents/payments/{create-prep,create-confirm,pay-prep,pay-confirm}`.
Schema: `payment_configs_pending` + `agent_payment_intents` (see migration
`2026-04-29-agent-payments.sql`).

`meta.payments` shape (returned at top level on `/api/agents/:id` as
`agent.payments` when configured):

```json
{
  "payments": {
    "configured":      true,
    "provider":        "pumpfun",
    "mint":            "<token mint base58>",
    "token_agent_pda": "<TokenAgentPayments PDA base58>",
    "receiver":        "<owner wallet base58>",
    "cluster":         "mainnet" | "devnet",
    "tx_signature":    "<base58>",
    "configured_at":   "2026-...",
    "accepted_tokens": []
  }
}
```

## Vanity wallets (custodial agent identities)

Agents can be provisioned with a custodial Solana wallet whose address starts
with a chosen base58 prefix. The secret key is encrypted server-side
(AES-GCM, HKDF-derived from `JWT_SECRET`) and never leaves the server after
provisioning.

```js
import { VanityWalletButton } from 'src/onchain/vanity-wallet-button.js';
new VanityWalletButton({ agent, container }).mount();
```

Headless usage:

```js
import { provisionVanityForAgent } from 'src/onchain/vanity/index.js';
await provisionVanityForAgent({
  agentId,
  prefix: 'AGNT',
  ignoreCase: false,
  onProgress: ({ rate, eta }) => console.log(rate, eta),
});
```

Grinding happens client-side via Web Workers (one per logical core, capped
at 8). Long prefixes take time — pass an `AbortSignal` to support a Cancel
UX. Server-side grinding for 5+ char prefixes already exists in
`api/_lib/pump-vanity.js` and is wired into the legacy `pumpfun/launch`
flow.

The provisioning endpoint (`POST /api/agents/:id/solana`) verifies that the
submitted secret derives the claimed pubkey and that the prefix matches
before storing the encrypted secret.

## x402 (HTTP 402 Payment Required for paid skills)

Wires the agent payments layer to per-call paywalls. Any agent endpoint can
return `402 Payment Required` with a canonical manifest; clients pay via the
Pump.fun agent-payments flow and retry with `x-payment-intent`.

Server middleware:

```js
import { emit402, verifyPaid, consumeIntent } from 'api/_lib/x402.js';

const paid = await verifyPaid(req, {
  agentId, skill: 'summarize',
  expectedAmount: '10000',
  expectedCurrency: USDC_MINT,
});
if (!paid) return emit402(res, { agent, skill, amount, currency });
await consumeIntent(paid.intentId);  // single-shot
return doTheThing();
```

Reference impl: `api/agents/x402/invoke.js` (paid-skill router with `echo`
demo skill). Manifest discovery at `GET /api/agents/x402/manifest`.

Client wrapper that follows 402 automatically:

```js
import { x402Fetch } from 'src/onchain/x402/client.js';
const res = await x402Fetch('/api/agents/x402/invoke', {
  method: 'POST',
  body: JSON.stringify({ agent_id, skill: 'echo', args: {} }),
  onPaymentRequired: () => 'auto',
});
```

Full spec at [docs/x402.md](../../docs/x402.md).

Note: the agent-payments-sdk is published as a restricted npm package. If
`npm install` fails with 403, contact Pump.fun for access. The pump-sdk used
for token launches is public and unaffected.

Adding another launchpad:
1. Implement `TokenAdapter` in `src/onchain/tokens/<provider>.js`.
2. Add to `getTokenAdapter()` in `src/onchain/tokens/index.js`.
3. Branch on `provider` in `api/agents/tokens/launch-prep.js`.
4. UI auto-extends if you make the dropdown provider-aware (single provider
   today, no dropdown).
