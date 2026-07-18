<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/x402-server</h1>

<p align="center"><strong>The merchant side of <a href="https://x402.org">x402</a> — turn any HTTP endpoint into a paid one in a few lines. Issue the 402, price the work, verify and settle the payment, take your fee.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/x402-server"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/x402-server?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/x402-server"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/x402-server?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/x402-server?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/x402-server?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#payment">Payment</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/x402-server` is the **seller** half of x402: the middleware and
> primitives that make an endpoint demand payment. Wrap a route with `paid()`
> and it answers an unpaid request with a `402 Payment Required` challenge —
> listing what it `accepts` (asset · amount · network · pay-to) — then, on the
> retry that carries an `X-PAYMENT` header, it verifies the payment, runs your
> handler, settles on-chain, and returns the result with an `X-PAYMENT-RESPONSE`
> receipt. It speaks the two lanes the three.ws rails already run in production:
> **Solana** (facilitator-settled SPL `transferChecked`) and **EVM / Base**
> (gasless [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009)
> `transferWithAuthorization`). It is the server twin of the buyer-side
> [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch)
> and [`@three-ws/x402-modal`](https://www.npmjs.com/package/@three-ws/x402-modal) —
> they pay; this charges.

## Why

x402 revives HTTP `402 Payment Required` as a real payment rail: a server
answers a request with a `402` whose body lists its `accepts[]`, the client
pays, and re-sends the request with an `X-PAYMENT` header. The buyer side is a
solved problem — drop in a fetch wrapper or the modal and it pays. **The seller
side is where everyone reinvents the same machinery:** build the challenge
envelope in the exact v2 shape, advertise the right asset/fee-payer per chain,
parse the `X-PAYMENT` header, call a facilitator's `/verify`, run the work
*only after* verification, settle *only after* the work succeeds, emit the
receipt, and skim a platform fee out of the price without double-charging the
buyer.

This package is that machinery, done once, the way the three.ws merchant rails
do it:

- **One wrapper, a paid route.** `paid({ price, asset, payTo })` emits the 402
  and gates your handler behind a verified payment.
- **Two lanes, one API.** Solana and Base/EVM accepts come from the same config;
  the challenge advertises both and the buyer picks.
- **Settle after the work, never before.** Verification gates the handler;
  settlement runs after it returns `200`. A failed call moves no funds, so a
  retry can't double-charge.
- **Fee without surprise-billing.** A platform fee is split out of the listed
  price — the buyer's total is never marked up, and the fee ships inert (rate
  `0`, no treasury) until you turn it on.

This is the same flow that powers paid MCP tools and hosted checkout SKUs on
[three.ws](https://three.ws); the package is its standalone, embeddable home.

## Install

```bash
npm install @three-ws/x402-server
```

Node 18+ (uses the global `fetch` and Web Crypto). Framework-agnostic: works as
Express/Connect middleware, a Fastify hook, or a bare `(req, res)` handler on
Vercel / Node `http`. For the buyer side of a test, pair with
[`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch).

## Quick start

### The one-liner — `paid()`

Wrap a handler. Unpaid requests get a `402`; paid ones run the handler:

```js
import { paid } from '@three-ws/x402-server';

export default paid(
  { price: '10000', asset: 'usdc', payTo: { solana: 'THREEsynthetic1111…' } },
  async (req, res) => {
    res.json({ summary: await summarize(req.body.text) });
  },
);
```

`price` is in **atomic units** of the asset — `'10000'` is `$0.01` of 6-decimal
USDC. The first unpaid `GET`/`POST` returns the challenge; the buyer pays and
re-sends with `X-PAYMENT`; your handler runs once, settlement lands, and the
response carries the on-chain receipt.

### A fuller route — both lanes, a fee, a receipt

```js
import { paid } from '@three-ws/x402-server';

export default paid(
  {
    price: '50000',                 // $0.05 USDC (6-decimal atomics)
    asset: 'usdc',
    payTo: {
      solana: 'THREEsynthetic1111…',          // SPL pay-to
      base:   '0xPlatformPayoutAddress…',      // EVM pay-to
    },
    network: ['solana', 'base'],    // advertise both accepts; buyer chooses
    feeBps: 250,                    // 2.5% platform fee, split out of the price
    feeTo:  'TREASURYsynthetic1111…',
    description: 'Document summarization',
    serviceName: 'Acme Summarize',
  },
  async (req, res, payment) => {
    // `payment` is the verified payer + accept — present only on a paid call.
    const out = await summarize(req.body.text);
    res.json({ summary: out, billedTo: payment.payer });
  },
);
```

### Under the hood — the raw 402 → sign → settle flow

`paid()` wraps four primitives you can drive directly when you don't want the
middleware:

```js
import {
  buildChallenge,   // → the 402 envelope (x402Version, resource, accepts[], extensions)
  verifyPayment,    // X-PAYMENT header → { ok, payer, accept } (calls the facilitator /verify)
  settlePayment,    // verified payment → on-chain settlement + receipt
  feeSplit,         // (price, bps) → { net, fee, recipient }
} from '@three-ws/x402-server';

export default async function handler(req, res) {
  const accepts = [
    { scheme: 'exact', network: 'solana:5eykt…', asset: 'EPjF…USDC', payTo, amount: '50000',
      maxTimeoutSeconds: 60, extra: { name: 'USDC', decimals: 6, feePayer } },
  ];

  const header = req.headers['x-payment'];
  if (!header) {
    // 1 — challenge. Body + base64 PAYMENT-REQUIRED header (Bazaar reads both).
    const body = buildChallenge({ resourceUrl: req.url, accepts });
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(body)).toString('base64'));
    return res.end(JSON.stringify(body));
  }

  // 2 — verify the X-PAYMENT against the same accepts. No work runs if this fails.
  const v = await verifyPayment({ paymentHeader: header, requirements: accepts });
  if (!v.ok) { res.statusCode = 402; return res.end(JSON.stringify(v.body)); }

  // 3 — run the work, THEN settle (never before — a failed call moves no funds).
  const result = await summarize(req.body.text);
  const settled = await settlePayment({ verified: v });

  res.setHeader('X-PAYMENT-RESPONSE',
    Buffer.from(JSON.stringify(settled)).toString('base64'));
  res.json({ result, payer: v.payer, tx: settled.transaction });
}
```

This is exactly the order the three.ws rails enforce: **verify → dispatch →
settle**. Settlement is the last step, so a handler that throws never charges.

## API

### `paid(options, handler) → (req, res) => void`

Wrap a request handler so it requires payment. Returns a standard `(req, res)`
function — mount it as Express/Connect middleware, a Vercel function, or a Node
`http` handler.

**Options**

| Option | Type | Default | Notes |
|---|---|---|---|
| `price` | `string` | — (**required**) | Amount in **atomic units** of the asset (`'10000'` = `$0.01` of 6-decimal USDC). |
| `asset` | `'usdc' \| { solana?, base? }` | `'usdc'` | Settlement asset. A string resolves the canonical USDC mint/contract per chain; an object pins explicit addresses. |
| `payTo` | `{ solana?, base? }` | — (**required**) | Pay-to address per lane. At least one chain is required. |
| `network` | `('solana' \| 'base')[]` | from `payTo` | Which accepts to advertise. Solana leads when both are present. |
| `feeBps` | `number` | `0` | Platform fee in basis points, **split out of `price`** (≤ `1000` / 10%). `0` = no fee. |
| `feeTo` | `string` | — | Fee recipient. Required when `feeBps > 0` — no recipient, no fee. |
| `facilitator` | `string` | platform default | Override the x402 facilitator base URL used for `/verify` + `/settle`. |
| `maxTimeoutSeconds` | `number` | `60` | How long the buyer has to land the signed payment. |
| `description` | `string` | — | Human label for the `resource` in the challenge (shown in wallets/the modal). |
| `serviceName` / `tags` / `iconUrl` | `string` / `string[]` / `string` | — | Bazaar discovery metadata echoed into the challenge. |
| `streaming` | `boolean` | `false` | Response ordering. `false` = deliver-then-settle (buffer the response, settle, flush with the receipt header). `true` = settle-then-stream, for self-flushing handlers (binary download, SSE, `res.pipe`). Node adapter only. |
| `onSettled` | `(receipt) => void` | — | Fired after a successful settlement — record the call, fire a webhook. |

**Handler** — `(req, res, payment) => unknown`. `payment` is present only on a
paid call: `{ payer, network, accept, amount }`. Write your response
(`res.json(...)`) **or** just `return` a value — either way the wrapper holds
the bytes until settlement lands (see [Response modes](#response-modes)).
Throwing from the handler **skips settlement** (no funds move) and returns a
`500` the buyer can retry with the same payment.

### Response modes

`paid()` guarantees the buyer never receives the good before settlement, two ways:

- **Deliver-then-settle (default).** The handler's response is **buffered**, the
  payment settles, then the `200` is flushed with the `X-PAYMENT-RESPONSE`
  receipt header attached. Handlers may `res.json(...)`/`res.end(...)` or return
  a value. Best for JSON APIs.
- **Settle-then-stream (`streaming: true`).** For responses you can't buffer
  (large files, SSE, `res.pipe`): settlement runs first, the receipt header is
  set up-front, then the handler writes its own body — paid by construction.

This mirrors `api/_lib/x402-paid-endpoint.js` on the platform. Runnable examples
for both modes are in [`examples/`](./examples).

### `buildChallenge(options) → Body`

Build the v2 `402` envelope. Returns `{ x402Version, error, resource, accepts,
extensions }`; the same object is what you base64 into the `PAYMENT-REQUIRED`
header. Accepts the canonical accept shape:

```ts
{ scheme: 'exact', network, asset, payTo, amount, maxTimeoutSeconds,
  extra: { name, decimals, feePayer? } }   // feePayer required on Solana
```

### `verifyPayment({ paymentHeader, requirements }) → Promise<Verified>`

Decode the base64 `X-PAYMENT` header and verify it against `requirements` (your
`accepts[]`) via the facilitator's `/verify`. Returns `{ ok, payer, accept }` on
success, or `{ ok: false, body }` (a fresh `402` body) on a rejected/under-paid
payment. **Call your handler only when `ok`.**

### `settlePayment({ verified }) → Promise<Receipt>`

Broadcast/settle the verified payment and return the receipt
`{ network, payer, transaction }`. Run this **after** the work succeeds. The
returned object is what you base64 into the `X-PAYMENT-RESPONSE` header.

### `feeSplit(priceAtomics, bps, recipient) → { net, fee, recipient } | null`

Split a platform fee out of the listed price: `fee = floor(price × bps /
10_000)`, `net = price − fee`. Returns `null` when no fee applies (rate `0`, no
recipient, or a sub-atomic fee) so the buyer is charged the full price and the
creator receives all of it. `bps` is clamped to `[0, 1000]`.

## How it works

```
buyer request (no X-PAYMENT)
        │
        ▼
   ┌──────────────┐  402  ┌──────────────────────────────────────────────┐
   │ buildChallenge├──────▶ accepts[]:  Solana (exact, feePayer)          │
   │              │       │             Base/EVM (EIP-3009 transferWith…) │
   └──────────────┘       └──────────────────────────────────────────────┘
        │ buyer signs (wallet) and retries with X-PAYMENT
        ▼
   verifyPayment ──▶ facilitator /verify ──▶ { ok, payer, accept }
        │ ok
        ▼
   your handler runs the work  ◀── settlement has NOT happened yet
        │ returns 200
        ▼
   settlePayment ──▶ on-chain settle ──▶ X-PAYMENT-RESPONSE receipt
```

The buyer never signs an instruction your server can't verify. On **Solana** the
accept advertises a `feePayer` (the facilitator's sponsor account); the buyer's
wallet signs an SPL `transferChecked` of the named mint to `payTo`, the
facilitator co-signs as fee payer and lands it — the buyer pays no SOL gas. On
**Base/EVM** the buyer signs an EIP-3009 `transferWithAuthorization` typed-data
message locally (no on-chain tx, no gas) and the facilitator submits it;
settlement is verified by scanning the mined tx for a USDC `Transfer` to `payTo`
of at least the expected amount, with a confirmation floor against reorgs.

### Lanes

| Lane | Network id | Scheme | Buyer signs | Gas |
|---|---|---|---|---|
| **Solana** | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `exact` | SPL `transferChecked` (facilitator co-signs) | facilitator pays |
| **Base** | `eip155:8453` | `exact` (EIP-3009) | `transferWithAuthorization` typed data | facilitator pays |
| Base Sepolia | `eip155:84532` | `exact` (EIP-3009) | same | facilitator pays |

Solana leads the `accepts[]` so first-accept clients settle there; advertise
`network: ['base']` (or both) to lead with EVM. The challenge also carries a
`bazaar` discovery extension so the endpoint is findable in the x402 bazaar.

## Payment

Prices are quoted and charged in **atomic units** of the settlement asset — USDC
is 6-decimal, so `1_000_000` = `$1.00`. The buyer's total is exactly `price`;
the platform fee is carved *out* of it:

| `feeBps` | On a `$1.00` (`1000000`) call | Creator nets | Fee |
|---|---|---|---|
| `0` (default) | buyer pays `$1.00` | `$1.00` | — |
| `250` (2.5%) | buyer pays `$1.00` | `$0.975` | `$0.025` |
| `1000` (10%, max) | buyer pays `$1.00` | `$0.90` | `$0.10` |

The fee applies **only** when both `feeBps > 0` **and** `feeTo` is set, so an
unconfigured server charges nothing — the fee feature ships inert and never
surprise-bills on deploy. On Solana the fee is an extra `transferChecked` in the
*same* transaction the buyer signs (one signature, no custody, atomic); the
buyer sees and signs it. The only coin this platform promotes is
[$THREE](https://three.ws) — settlement runs in USDC, and any mint your server
names is supplied by you at config time.

## Errors & edge cases

`verifyPayment` returns a structured result rather than throwing on a bad
payment, and `paid()` maps every state to the right HTTP status:

| Code | HTTP | Meaning | What the buyer sees / does |
|---|---|---|---|
| `payment_required` | 402 | No `X-PAYMENT`, or the header failed `/verify`. | A fresh challenge — pay and retry. |
| `invalid_payment` | 402 | The signed tx doesn't pay the declared amount/asset/recipient. | Re-sign against the advertised accept. |
| `missing_fee_payer` | 422 | A Solana accept omitted `extra.feePayer`. | Server misconfig — set `X402_FEE_PAYER_SOLANA`. |
| `unsupported_network` | 400 | Buyer paid a network the route doesn't advertise. | Pick an advertised accept. |
| `facilitator_unreachable` | 502 | The facilitator `/verify` or `/settle` is down. | **No funds moved** — safe to retry. |
| `settle_uncertain` | 502 | Verified + work ran, but settlement status is unknown. | Check on-chain before retrying to avoid double-pay. |
| `pending` | — | EVM tx not yet mined / below the confirmation floor. | Confirm again shortly. |

Two invariants make these safe: verification runs **before** your handler (a bad
payment never triggers the work), and settlement runs **after** it (a failed
handler never charges). A `429` from your upstream can be retried with the
*same* signed payment, because settlement only happens once the work succeeds.

## Examples

Runnable versions of everything below live in [`examples/`](./examples) — start
with [`examples/loopback-demo.mjs`](./examples/loopback-demo.mjs), which runs the
whole buyer↔seller loop offline against a local stub facilitator
(`node examples/loopback-demo.mjs`). A step-by-step walkthrough is in the
[x402-server SDK tutorial](https://three.ws/tutorials/x402-server-sdk).

**Express — meter an existing API**

```js
import express from 'express';
import { paid } from '@three-ws/x402-server';

const app = express();
app.use(express.json());

app.post('/v1/embed', paid(
  { price: '2000', asset: 'usdc', payTo: { solana: 'THREEsynthetic1111…' } },
  async (req, res) => res.json({ vector: await embed(req.body.text) }),
));

app.listen(3000);
```

**Vercel / Node `http` — a paid serverless function**

```js
import { paid } from '@three-ws/x402-server';

export default paid(
  { price: '100000', asset: 'usdc', payTo: { base: '0xPayout…' }, network: ['base'] },
  async (req, res, payment) => {
    res.json({ report: await generate(req.body.topic), billedTo: payment.payer });
  },
);
```

**Agent economy — sell a tool, record every call**

```js
export default paid(
  {
    price: '5000', asset: 'usdc',
    payTo: { solana: 'THREEsynthetic1111…' },
    serviceName: 'Pose seeds', tags: ['3d', 'animation'],
    onSettled: (receipt) => recordCall(receipt),   // feed your dashboard / webhook
  },
  async (req, res) => res.json({ seed: await poseSeed(req.body.prompt) }),
);
```

A buyer running [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch)
calls any of these with a plain `fetch` — the `402` is paid automatically and the
result comes back as if the endpoint were free.

## Related

- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) — **buyer side.** A `fetch` wrapper that auto-pays the `402` your server here emits.
- [`@three-ws/x402-modal`](https://www.npmjs.com/package/@three-ws/x402-modal) — **buyer side.** A drop-in browser checkout modal for the same `402`.
- [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge) — a real paid endpoint built on these rails (text/image → 3D GLB).
- [three.ws merchant console](https://three.ws) — hosted SKUs, storefronts, and settlement dashboards over the same primitives.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
