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

MIT © 2026 nirholas

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
