<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/pumpfun-skills</h1>

<p align="center"><strong>pump.fun launch + trade as composable agent tools: create a coin, swap, and read creator fees, with a runtime-supplied mint.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/pumpfun-skills"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/pumpfun-skills?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/pumpfun-skills"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/pumpfun-skills?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/pumpfun-skills?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/pumpfun-skills?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/pumpfun-skills` is the official client for the three.ws **pump.fun
> skill set**: the same launch/trade/fee plumbing the three.ws agents use,
> exposed as plain functions instead of [Agent Skills](https://agentskills.io)
> tools. It wraps pump.fun's agent transaction API
> (`https://fun-block.pump.fun/agents/*`), which builds the unsigned or
> mint-signed Solana transaction for you, and the public coins read API
> (`frontend-api-v3.pump.fun/coins-v2`). Every function is **coin-agnostic**:
> the mint, amounts, and wallet are supplied at call time; nothing is
> hardcoded. You build, you co-sign, you broadcast. It pairs with
> [`@three-ws/agent-payments`](https://www.npmjs.com/package/@three-ws/agent-payments)
> for tokenized-agent invoices and the three.ws launch feed.

## Why

Launching and trading on pump.fun by hand means juggling two SDKs
(`@pump-fun/pump-sdk`, `@pump-fun/pump-swap-sdk`), deriving PDAs, detecting
whether a coin is still on the bonding curve or has graduated to an AMM pool,
quoting slippage, and assembling a versioned transaction, all before you ever ask
the user to sign. These skills collapse that into three calls:

- **One call, a ready transaction.** `createCoin({...})` returns a
  base64 transaction with the mint keypair already signed; you only co-sign
  with the wallet and submit.
- **State-aware swaps.** `swap({...})` auto-detects bonding curve vs. graduated
  AMM and builds the correct route, with slippage and optional Jito MEV
  protection.
- **Fees, read and collected.** `coinFees(mint)` resolves the fee destination
  (creator, cashback, or a sharing config), reports vault balances, and
  `collectFees({...})` builds the claim or distribution transaction.
- **Mint supplied at runtime.** Pass any pump.fun mint you control. There is no
  coin list, no allowlist: generic plumbing, your inputs.

This is the SDK twin of the `pumpfun_create_coin`, `pumpfun_swap`, and
`pumpfun_collect_fees` MCP/skill tools: same endpoints, plain functions.

## Install

```bash
npm install @three-ws/pumpfun-skills
```

Works in Node 18+ and the browser (uses `fetch`). To sign and broadcast the
transactions these functions return, add `@solana/web3.js`. The fee-reading
calls go through pump.fun's read API; the build calls go through pump.fun's
agent API; no key, no three.ws account required.

## Quick start

Build a launch transaction for a coin, mint keypair already signed:

```js
import { createCoin } from '@three-ws/pumpfun-skills';

const { transaction, mint } = await createCoin({
  user: 'YourWa11et1111111111111111111111111111111111',
  name: '$THREE',
  symbol: 'THREE',
  uri: 'https://ipfs.io/ipfs/Qm…/metadata.json',
  solLamports: '500000000', // 0.5 SOL initial buy, in lamports
});

// `transaction` is base64; co-sign with the wallet and submit. `mint` is the new coin's address.
```

A full launch → swap → fees loop against a runtime mint:

```js
import { createCoin, swap, coinFees, NATIVE_MINT } from '@three-ws/pumpfun-skills';

// 1. Launch
const launch = await createCoin({
  user: wallet.publicKey.toBase58(),
  name: '$THREE',
  symbol: 'THREE',
  uri: metadataUri,
  solLamports: '250000000',
});

// 2. Buy 0.1 SOL of the coin (auto-routes bonding curve vs AMM)
const buy = await swap({
  inputMint: NATIVE_MINT, // So11111111111111111111111111111111111111112
  outputMint: launch.mint,
  amount: '100000000',    // 0.1 SOL in lamports
  user: wallet.publicKey.toBase58(),
  slippagePct: 2,
});

// 3. Read the fee state for that mint
const fees = await coinFees(launch.mint);
console.log(fees.feeDestination);      // 'creator' | 'cashback' | 'sharing_config'
console.log(fees.creatorVaultLamports); // claimable lamports
```

## API

All build functions return a base64 Solana transaction the caller signs and
broadcasts. Amounts are strings in base units (lamports for SOL, token smallest
units for SPL). `NATIVE_MINT` is re-exported as a convenience for SOL.

Also exported: `createPumpfunSkills(options)` builds a configured client (custom
`fetch`, `agentBaseUrl`, `coinsV2Base`, `apiKey`, `headers`) whose methods match
the functions below; plus the `AGENT_API_BASE`, `COINS_V2_BASE`, and
`FEE_DESTINATIONS` constants and the `ThreeWsError` / `PaymentRequiredError`
error classes.

### `createCoin(input) → Promise<BuiltTx & { mint: string }>`

Build a new-coin transaction with an optional initial buy. The mint keypair is
already signed; the user wallet co-signs. Wraps `POST /agents/create-coin`.

| Field | Type | Notes |
|---|---|---|
| `user` | `string` | **Required.** Creator wallet public key. |
| `name` | `string` | **Required.** Token name. |
| `symbol` | `string` | **Required.** Token symbol. |
| `uri` | `string` | **Required.** Metadata URI (IPFS or HTTPS JSON). |
| `solLamports` | `string` | **Required.** Initial buy in lamports (`'0'` for none). |
| `mayhemMode` | `boolean` | Enable mayhem mode. Default `false`. |
| `cashback` | `boolean` | Route fees as cashback. Default `false`. |
| `tokenizedAgent` | `boolean` | Launch as a tokenized agent. Default `false`. |
| `buybackBps` | `number` | Buyback basis points when `tokenizedAgent`, e.g. `5000` = 50%. |
| `frontRunningProtection` | `boolean` | Route via Jito for MEV protection (needs `tipAmount`). |
| `tipAmount` | `number` | Jito tip in SOL, e.g. `0.0001`. |
| `feePayer` | `string` | Fee payer public key. Defaults to `user`. |
| `creator` | `string` | Creator public key. Defaults to `user`. |

### `swap(input) → Promise<BuiltTx>`

Build a buy or sell. Auto-detects bonding curve vs. graduated AMM and builds the
matching route. For a **buy**, set `inputMint` to `NATIVE_MINT`; for a **sell**,
set `outputMint` to `NATIVE_MINT`. Wraps `POST /agents/swap`.

| Field | Type | Notes |
|---|---|---|
| `inputMint` | `string` | **Required.** Mint to spend. `NATIVE_MINT` for SOL buys. |
| `outputMint` | `string` | **Required.** Mint to receive. `NATIVE_MINT` for SOL sells. |
| `amount` | `string` | **Required.** Lamports for SOL, or token smallest units (6 decimals). |
| `user` | `string` | **Required.** User wallet public key (signer). |
| `slippagePct` | `number` | Slippage tolerance, percent. Default `2`. |
| `feePayer` | `string` | Fee payer public key. Defaults to `user`. |
| `frontRunningProtection` | `boolean` | Route via Jito (needs `tipAmount`). |
| `tipAmount` | `number` | Jito tip in SOL. |

### `coinFees(mint) → Promise<FeeInfo>`

Read-only. Resolve the fee destination, vault balances, sharing config, and
graduation state for a mint. Reads the public `coins-v2` API, which carries the
bonding-curve, pool, cashback, and sharing-config state. No transaction, no RPC.

**Returns** `FeeInfo`

| Field | Type | Notes |
|---|---|---|
| `mint` | `string` | The coin mint. |
| `bondingCurve` | `string` | Bonding-curve PDA. |
| `pool` | `string \| null` | AMM pool PDA, or `null` if not graduated. |
| `isGraduated` | `boolean` | True once the coin migrated to an AMM pool. |
| `isCashbackCoin` | `boolean` | True if fees route as cashback. |
| `hasSharingConfig` | `boolean` | True if a fee-sharing config is active. |
| `creator` | `string` | Effective creator public key. |
| `creatorVaultLamports` | `string` | Claimable lamports in the creator vault (`'0'` when `coins-v2` carries no balance). |
| `sharingConfig` | `object \| null` | `{ address, admin, adminRevoked, shareholders[] }`. |
| `feeDestination` | `'creator' \| 'cashback' \| 'sharing_config'` | Where fees go. |

### `collectFees(input) → Promise<BuiltTx>`

Build a transaction to collect creator fees, or distribute them via the sharing
config, auto-detected from on-chain state. Wraps `POST /agents/collect-fees`.

| Field | Type | Notes |
|---|---|---|
| `mint` | `string` | **Required.** Token mint. |
| `user` | `string` | **Required.** Creator wallet public key. |
| `frontRunningProtection` | `boolean` | Route via Jito. |
| `tipAmount` | `number` | Jito tip in SOL. |

### `sharingConfig(input) → Promise<BuiltTx>`

Create or update a fee-sharing config (up to 10 shareholders; `bps` must total
exactly `10000`). Mode is auto-detected if omitted. Wraps
`POST /agents/sharing-config`.

| Field | Type | Notes |
|---|---|---|
| `mint` | `string` | **Required.** Token mint. |
| `user` | `string` | **Required.** Creator wallet public key. |
| `shareholders` | `{ address: string; bps: number }[]` | **Required.** `bps` sums to `10000`. |
| `mode` | `'create' \| 'update'` | Auto-detected if omitted. |
| `frontRunningProtection` | `boolean` | Route via Jito. |
| `tipAmount` | `number` | Jito tip in SOL. |

## How it works

Two surfaces, one rule (**the function builds, you sign**):

```
createCoin / swap        coinFees                 collectFees / sharingConfig
   │                        │                          │
   ▼                        ▼                          ▼
POST fun-block.pump.fun   read coins-v2 (curve,      POST fun-block.pump.fun
  /agents/create-coin     pool + fee state)            /agents/collect-fees
  /agents/swap            (no transaction)             /agents/sharing-config
   │                        │                          │
   ▼                        ▼                          ▼
base64 transaction        FeeInfo JSON               base64 transaction
(mint pre-signed for                                 │
 create-coin)                                        │
   └──────────────► you co-sign with the wallet ◄────┘
                          │
                          ▼
                  broadcast to Solana
```

- **Build calls** post your inputs (plus `encoding: 'base64'`) to the pump.fun
  agent API and get back a transaction. `create-coin` returns it with the new
  **mint keypair already signed**: you only add the wallet signature. `swap`,
  `collect-fees`, and `sharing-config` return a transaction for the wallet to
  sign outright.
- **Read calls** (`coinFees`) hit `coins-v2`, which carries the bonding-curve,
  pool, cashback, and sharing-config state, and derive the fee destination and
  balances from it. No wallet, no signing, no RPC.
- **State detection is automatic.** `swap` and `collectFees` inspect whether the
  coin is still on the bonding curve or graduated to an AMM pool and build the
  correct route; you never branch on it yourself.

Override the read backend (e.g. for devnet) with the `PUMP_COINS_V2_BASE`
environment variable; the build API base is `https://fun-block.pump.fun/agents`.

## Errors & edge cases

Every function rejects with a typed `ThreeWsError` carrying a `code`, the HTTP
`status`, and the upstream `body`; a 402 surfaces as `PaymentRequiredError`, a
`ThreeWsError` subclass carrying the x402 challenge. Every state is surfaced,
never swallowed:

| Where | Condition | Meaning | Recovery |
|---|---|---|---|
| `createCoin` / `swap` / `collectFees` | non-2xx from `/agents/*` | pump.fun rejected the build (bad mint, insufficient SOL, malformed input). | Inspect `error.status` + `error.body`; fix inputs and retry. |
| `swap` | coin not found | Mint isn't a pump.fun coin. | Verify the mint. |
| `sharingConfig` | `bps` ≠ 10000 | Shareholder splits don't total 100%. | Adjust `bps` to sum to `10000`. |
| `collectFees` | empty vault | `coinFees(mint).creatorVaultLamports === '0'`. | Read first; skip if nothing to claim. |
| `coinFees` | empty `coins-v2` body | Wrong cluster, or coin missing. | Set `PUMP_COINS_V2_BASE` for devnet. |
| any | `frontRunningProtection: true`, no `tipAmount` | Jito route needs a tip. | Pass `tipAmount` (SOL). |

A built transaction is **partially signed at most**: it is never broadcast for
you. Submitting (and paying network fees) is always the caller's step.

## Examples

**Read before you claim**: never build a no-op collection:

```js
import { coinFees, collectFees } from '@three-ws/pumpfun-skills';

const fees = await coinFees('THREEsynthetic1111111111111111111111111111');
if (fees.feeDestination === 'creator' && fees.creatorVaultLamports !== '0') {
  const { transaction } = await collectFees({ mint: fees.mint, user: creator });
  // co-sign + broadcast `transaction`
}
```

**Split creator fees across a team** (50 / 30 / 20):

```js
import { sharingConfig } from '@three-ws/pumpfun-skills';

const { transaction } = await sharingConfig({
  mint: 'THREEsynthetic1111111111111111111111111111',
  user: creator,
  shareholders: [
    { address: dev,    bps: 5000 },
    { address: design, bps: 3000 },
    { address: ops,    bps: 2000 },
  ], // sums to 10000
});
```

**Sell back to SOL with MEV protection:**

```js
import { swap, NATIVE_MINT } from '@three-ws/pumpfun-skills';

const { transaction } = await swap({
  inputMint: 'THREEsynthetic1111111111111111111111111111',
  outputMint: NATIVE_MINT,
  amount: '1000000',          // 1.0 token (6 decimals)
  user: wallet.publicKey.toBase58(),
  slippagePct: 3,
  frontRunningProtection: true,
  tipAmount: 0.0001,          // Jito tip in SOL
});
```

## Related

- [`@three-ws/agent-payments`](https://www.npmjs.com/package/@three-ws/agent-payments): tokenized-agent invoices and on-chain payment verification.
- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch): pay-per-call USDC settlement for agent services.
- [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge): generate the 3D avatar that fronts a tokenized agent.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
