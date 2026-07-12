# hood402

**The x402 payment rail for USDG on [Robinhood Chain](https://docs.robinhood.com/chain/) (chain ID 4663).**

Spec-conformant `exact`/EIP-3009 server middleware, a paying client, and a self-hostable
facilitator. Gasless USDG micropayments over plain HTTP 402 — no accounts, no API keys, no
subscriptions. hood402 follows the standard [x402 protocol](https://github.com/coinbase/x402)
wire format exactly, so it interoperates with the wider x402 client ecosystem, not just its
own client.

Docs: **https://nirholas.github.io/hood402/**

## Why EIP-3009, and how we know

USDG (Paxos Global Dollar) is a facet/diamond-router stablecoin. Its base implementation
doesn't expose EIP-3009 directly, but `getFacet(bytes4)` proves the facet is registered —
verified live against both networks:

```bash
npm run verify:usdg
```

```
robinhood (chain 4663) — USDG 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
  getFacet(transferWithAuthorization) -> 0x780d30b6a89BC9Eef953a543aA288c3B05b01309 [OK]
  getFacet(receiveWithAuthorization)  -> 0x780d30b6a89BC9Eef953a543aA288c3B05b01309 [OK]
  getFacet(authorizationState)        -> 0x780d30b6a89BC9Eef953a543aA288c3B05b01309 [OK]
  DOMAIN_SEPARATOR() -> 0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036
  Expected domain: name="Global Dollar", version="1"

robinhood-testnet (chain 46630) — USDG 0x7E955252E15c84f5768B83c41a71F9eba181802F
  getFacet(transferWithAuthorization) -> 0x08f560a85db40a7d4ac49b4F44f1D38e5B8aB811 [OK]
  ...

PASS: USDG EIP-3009 facet registration confirmed on both networks.
```

The EIP-712 domain separator was reconstructed offline (`name="Global Dollar"`,
`version="1"`) and matches the live `DOMAIN_SEPARATOR()` on both chains exactly. This is
the load-bearing decision behind hood402: settlement is the standard, gasless
`transferWithAuthorization` path — the same mechanism USDC uses, and the one x402's `exact`
scheme is designed around. No custom scheme, no proxy contract, no Permit2 fallback needed.

See [Blockscout — mainnet USDG](https://robinhoodchain.blockscout.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168)
and [`docs/index.html`](./docs/index.html#conformance) for the full write-up.

## Install

```bash
npm install hood402 viem
```

Node ≥ 20. Until the package is on npm, install from a checkout: `npm i ../hood402`.

## Packages in this repo

| Path | What it is |
|---|---|
| `hood402` (this package) | Protocol types, the `exact`/EIP-3009 scheme, `verifyPayment`/`settlePayment`, and the `hood402/server` + `hood402/client` subpath exports |
| [`facilitator/`](./facilitator) | A standalone, self-hostable facilitator service — `/verify`, `/settle`, `/supported`, `/metrics`, an idempotent SQLite ledger, and a Dockerfile |

## Quickstart — server

```ts
import express from 'express'
import { paywall } from 'hood402/server'

const app = express()

app.get('/premium', paywall({
  price: '0.01',                              // USDG
  payTo: '0xYourReceivingAddress',
  network: 'robinhood',                        // or 'robinhood-testnet'
  facilitator: 'https://your-facilitator.example.com',
}), (req, res) => {
  res.json({ data: 'unlocked after a settled USDG payment' })
})
```

No facilitator? Pass `wallet` (a viem `WalletClient` holding a gas key), `account`, and
`reader` (a viem `PublicClient`) instead — the server verifies and settles locally:

```ts
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { robinhood } from 'viem/chains'
import { paywall } from 'hood402/server'

const account = privateKeyToAccount(process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`)
const transport = http('https://rpc.mainnet.chain.robinhood.com')

app.get('/premium', paywall({
  price: '0.01',
  payTo: '0xYourReceivingAddress',
  network: 'robinhood',
  wallet: createWalletClient({ account, chain: robinhood, transport }),
  account: account.address,
  reader: createPublicClient({ chain: robinhood, transport }),
}), (req, res) => res.json({ data: 'unlocked' }))
```

Hono works too — use `honoPaywall` from `hood402/server` with the same options.

## Quickstart — client

```ts
import { Hood402Client, fromAccount } from 'hood402/client'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(process.env.ROBINHOOD_CHAIN_PRIVATE_KEY as `0x${string}`)
const client = new Hood402Client({
  signer: fromAccount(account),
  maxSpendPerOrigin: '1.00',   // hard cap in USDG — refuses to sign above it
})

const res = await client.fetch('https://api.example.com/premium')
console.log(await res.json())  // the 402 was paid automatically
```

`client.fetchWithReceipt(url)` returns the response *and* the decoded
`X-PAYMENT-RESPONSE` settlement receipt (transaction hash, network, payer). In the
browser, build a `Signer` from an injected wallet with `fromWalletClient` instead of
`fromAccount`.

## Quickstart — facilitator

See [`facilitator/README.md`](./facilitator/README.md).

## Supported networks

| Network id | Chain ID | USDG address | Explorer |
|---|---|---|---|
| `robinhood` (mainnet) | 4663 | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | [Blockscout](https://robinhoodchain.blockscout.com) |
| `robinhood-testnet` | 46630 | `0x7E955252E15c84f5768B83c41a71F9eba181802F` | [Blockscout](https://explorer.testnet.chain.robinhood.com) |

Both are 6-decimal USDG with EIP-712 domain `name="Global Dollar", version="1"`. Aliases like
`"robinhood-chain"`, `"robinhood-mainnet"`, `"robinhood-sepolia"`, `eip155:4663`/`eip155:46630`,
and the bare chain ids `4663`/`46630` all resolve to the same two networks via
`resolveNetwork()`/`requireNetwork()`.

## API reference

### Root — `hood402`

Protocol primitives shared by both the server and client. Re-exported by `hood402/server` and
`hood402/client` where relevant.

| Export | What it does |
|---|---|
| `X402_VERSION`, `SCHEME` | Wire-protocol constants (`1`, `"exact"`). |
| `PaymentRequirements`, `PaymentRequiredResponse`, `ExactEvmAuthorization`, `ExactEvmPayload`, `PaymentPayload`, `VerifyResult`, `SettleResult`, `SettlementResponseHeader`, `SupportedResponse` | Wire-format TypeScript types. |
| `InvalidReason`, `REASON_TEXT` | The canonical failure-reason union and its human-readable text (e.g. `authorization_already_used` → *"The authorization nonce has already been settled (replay)."*). |
| `Hood402ConfigError`, `SpendCapExceededError` | Errors thrown on misconfiguration / an over-cap client payment. |
| `ROBINHOOD_MAINNET`, `ROBINHOOD_TESTNET`, `NETWORKS`, `HoodNetwork` | The network registry — chain id, RPC URL, explorer, USDG address/decimals/domain. |
| `resolveNetwork(idOrChainId)` | Resolve a network by id/alias/chain id; returns `undefined` if unknown. |
| `requireNetwork(idOrChainId)` | Same, but throws a descriptive error on an unknown network. |
| `PAYMENT_HEADER`, `PAYMENT_RESPONSE_HEADER` | The literal header names `"X-PAYMENT"` / `"X-PAYMENT-RESPONSE"`. |
| `Price` | `string \| { atomic: string } \| { usdg: string }` — how a resource's price can be expressed. |
| `toAtomic(price, decimals)` | Convert a `Price` to an atomic-unit decimal string. |
| `buildRequirements(input)` | Build a spec-compliant `PaymentRequirements` for a resource (price, `payTo`, network, description, …). |
| `buildPaymentRequired(accepts, error?)` | Wrap one or more `PaymentRequirements` into a 402 response body. |
| `TRANSFER_WITH_AUTHORIZATION_TYPES` | The EIP-712 `TransferWithAuthorization` type definition. |
| `usdgDomain(net)` | Build the EIP-712 domain for a network's USDG contract. |
| `randomNonce()` | Generate a fresh random 32-byte EIP-3009 nonce (browser + Node safe). |
| `authorizationMessage(auth)` | Convert an `ExactEvmAuthorization` (decimal-string fields) into its EIP-712 message form (bigint fields). |
| `verifyAuthorizationSignature(net, auth, signature)` | Verify an EIP-3009 signature recovers to `auth.from` (EOA + ERC-1271). |
| `isWellFormedPayload(p)` | Type-guard: does `p` have every required `PaymentPayload` field, correctly typed? |
| `validateStructural(payload, requirements, now?)` | The pure, RPC-free half of verification — scheme/network/asset/recipient/amount/expiry checks. |
| `verifyPayment(opts)` | Full verification state machine: structural → signature → (with a `reader`) replay → balance. Returns `VerifyResult`. |
| `settlePayment(opts)` | Re-verify, then broadcast `transferWithAuthorization` and await the receipt. Returns `SettleResult`. |
| `encodeBase64Json`, `decodeBase64Json`, `encodePaymentHeader`, `decodePaymentHeader`, `encodeSettlementHeader`, `decodeSettlementHeader` | Base64/JSON codecs for the `X-PAYMENT` and `X-PAYMENT-RESPONSE` header values. |
| `FacilitatorClient` | HTTP client for a remote facilitator — `supported()`, `verify(payload, requirements)`, `settle(payload, requirements)`. |
| `eip3009Abi`, `erc20Abi` | The minimal viem ABI fragments used for `transferWithAuthorization`, `authorizationState`, `balanceOf`, `decimals`. |

### `hood402/server`

| Export | What it does |
|---|---|
| `paywall(opts: PaywallOptions)` | Express middleware. Verifies `X-PAYMENT`, settles, sets `X-PAYMENT-RESPONSE`, then calls `next()`. |
| `honoPaywall(opts: PaywallOptions)` | Same semantics as `paywall`, for a Hono `Context`. |
| `PaywallEngine` | The framework-agnostic engine both adapters wrap — `requirements(resource)`, `authorize(headerValue, resource)`, `settle(payload, requirements)`, `settlementHeader(result)`. Use it directly to build an adapter for another framework. |
| `PaywallOptions` | `{ price, payTo, network?, description?, mimeType?, maxTimeoutSeconds?, resource?, facilitator? }` (facilitator mode) or the same plus `{ wallet, account, reader }` (self-settle mode) — one of the two settlement modes is required. |
| `getAddress` | Re-exported from viem for convenience. |

### `hood402/client`

| Export | What it does |
|---|---|
| `Hood402Client` | The paying client. `fetch(url, init?)`, `fetchWithReceipt(url, init?)`, `sign(requirements)`, `spent(origin)`. |
| `Hood402ClientOptions` | `{ signer, maxSpendPerOrigin?, allowedNetworks?, fetch?, validitySeconds?, now? }`. |
| `fromAccount(account)` | Build a `Signer` from a viem `LocalAccount` (private key). |
| `fromWalletClient(client, address)` | Build a `Signer` from a viem `WalletClient` (e.g. an injected browser wallet). |
| `wrapFetch(opts)` | Convenience: returns a plain `fetch`-compatible function that transparently pays every 402 it hits. |
| `Signer` | The minimal typed-data-signing interface `Hood402Client` needs — `{ address, signTypedData }`. |
| `PaidResponse` | `{ response, paid, settlement? }` — the return type of `fetchWithReceipt`. |
| `AuthorizationMessage` | The EIP-712 message shape (`ExactEvmAuthorization` with bigint numeric fields) passed to `signTypedData`. |

## Environment variables

hood402 itself is a library and reads no env vars — these are the ones the **examples**,
**facilitator**, and **`scripts/verify-usdg.mjs`** in this repo use (see
[`.env.example`](./.env.example)). Wire them into your own app's config however you like.

| Variable | Used by | Meaning |
|---|---|---|
| `FACILITATOR_PRIVATE_KEY` | `facilitator/` | The gas wallet that broadcasts settlement transactions. Needs ETH on every network it settles. Never holds user funds — only relays signed EIP-3009 authorizations. |
| `FACILITATOR_NETWORKS` | `facilitator/` | Comma-separated networks to settle on (default `robinhood,robinhood-testnet`). |
| `ROBINHOOD_RPC_URL` | `facilitator/` | Optional mainnet RPC override (defaults to the public Robinhood Chain RPC). |
| `ROBINHOOD_TESTNET_RPC_URL` | `facilitator/` | Optional testnet RPC override. |
| `PORT` | `facilitator/` | HTTP port for the facilitator service (default `4021`). |
| `LEDGER_PATH` | `facilitator/` | Path to the SQLite settlement ledger (default `./data/hood402-ledger.sqlite`). |
| `ROBINHOOD_CHAIN_PRIVATE_KEY` | client examples | The wallet that signs USDG payments. Needs USDG balance, not ETH — the payer never pays gas. |
| `HOOD402_MAX_SPEND_PER_ORIGIN` | client examples | Hard per-origin spend cap in USDG (maps to `Hood402ClientOptions.maxSpendPerOrigin`). |
| `DEMO_PORT`, `DEMO_PAY_TO`, `FACILITATOR_URL` | `examples/demo-server.ts` | Demo resource-server port, payee address, and facilitator URL. |

See [`facilitator/README.md`](./facilitator/README.md#environment-variables) for the
facilitator's own copy of this table with defaults spelled out per-field.

## Security model

- **The facilitator never holds user funds.** It relays signed EIP-3009 authorizations —
  the payer's signature fixes the amount and recipient; the facilitator can only choose
  *whether* to broadcast, not *what*.
- **Replay protection is two-layered.** Every authorization carries a random 32-byte nonce
  checked against on-chain `authorizationState` before verification passes, and the
  facilitator's SQLite ledger claims an idempotency slot on `(network, payer, nonce)`
  before broadcasting — a retried `/settle` for the same signed payment returns the
  original transaction instead of double-spending gas.
- **Validity windows are short by default** (`client.fetch`'s signer sets a 300-second
  window) — a leaked signature has a narrow blast radius.
- **The client enforces a hard spend cap per origin** (`maxSpendPerOrigin`) — it refuses to
  sign a payment that would exceed the cap, before any network call.
- **Keys are env vars only.** `FACILITATOR_PRIVATE_KEY` (the gas wallet) and
  `ROBINHOOD_CHAIN_PRIVATE_KEY` (a payer) are never hardcoded or logged. See
  [`.env.example`](./.env.example).

## Development

```bash
npm install
npm run build
npm test              # vitest — the exact/EIP-3009 state machine, 65 tests
npm run verify:usdg   # live on-chain proof of the EIP-3009 facet + domain separator
npm run e2e           # full interop proof — see examples/e2e.ts

cd facilitator && npm install && npm test   # 18 more tests: ledger idempotency + HTTP endpoints
```

`npm run e2e` proves the whole flow against live chain state: real mainnet reads, a real
HTTP 402 → sign → pay round trip over an actual socket, a real testnet RPC verify call, and
a real `eth_call` simulation of the settlement transaction. It states plainly which parts
are live broadcast vs. simulation — see the script's own header comment for the full
rationale.

## License

Apache-2.0 © 2026 nirholas

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
