<div align="center">

# @three-ws/x402-modal

**A drop-in payment modal for any [x402](https://x402.org) paid endpoint.**

One script tag turns an HTTP `402 Payment Required` into a polished checkout:
wallet connect (Phantom on Solana, MetaMask/EVM via EIP-3009), the
`402 → sign → settle` flow, SIWX re-entry, spending caps, and a receipt — all
in **vanilla JS, with no bundler and no framework**.

[![npm](https://img.shields.io/npm/v/@three-ws/x402-modal?logo=npm&color=cb3837)](https://www.npmjs.com/package/@three-ws/x402-modal)
[![downloads](https://img.shields.io/npm/dm/@three-ws/x402-modal?color=cb3837)](https://www.npmjs.com/package/@three-ws/x402-modal)
![license](https://img.shields.io/npm/l/@three-ws/x402-modal?color=3b82f6)
![node](https://img.shields.io/node/v/@three-ws/x402-modal?color=339933&logo=node.js)

[Quick start](#quick-start) · [How it works](#how-it-works) · [API](#api) · [Configuration](#configuration) · [Backend](#the-backend) · [Tutorials](./TUTORIAL.md) · [FAQ](#faq)

</div>

---

## Why

[x402](https://x402.org) revives HTTP `402 Payment Required` as a real payment
rail: a server answers a request with a `402` whose body lists what it
`accepts` (asset, amount, network, pay-to), the client pays, and re-sends the
request with an `X-PAYMENT` header. It's perfect for pay-per-call APIs, agent
economies, and content paywalls — but every merchant ends up rebuilding the same
fiddly client: parse the challenge, connect a wallet, sign the right thing for
the right chain, retry, settle, show a receipt.

**This package is that client, done once and done well.** Point it at a `402`
endpoint and it renders the entire flow. The EVM/Base path is 100%
client-side. The Solana path needs one small backend helper (see
[The backend](#the-backend)).

## Quick start

### 1 — One script tag (zero JS)

```html
<script type="module" src="https://unpkg.com/@three-ws/x402-modal/global"></script>

<button
  data-x402-endpoint="https://api.example.com/paid/summarize"
  data-x402-method="POST"
  data-x402-body='{"text":"hello world"}'
  data-x402-merchant="Acme"
  data-x402-action="Summarize">
  Pay &amp; summarize
</button>
```

Clicking the button opens the modal, runs the payment, calls the endpoint, and
fires an `x402:result` event on the button with `{ ok, result, payment, response }`:

```js
document.querySelector('button').addEventListener('x402:result', (e) => {
  console.log('paid + got result:', e.detail.result);
});
```

### 2 — Programmatic (full control)

```js
import { pay } from '@three-ws/x402-modal';

const out = await pay({
  endpoint: '/api/paid/summarize',
  method: 'POST',
  body: { text: 'hello world' },
  merchant: 'Acme',
  action: 'Summarize',
});

console.log(out.result);   // the endpoint's response, after settlement
console.log(out.payment);  // { network, payer, transaction }
```

`pay()` resolves once the paid call returns `200`, or rejects with an `Error`
whose `.code === 'cancelled'` if the user closes the modal.

### 3 — Self-hosted, fully branded

```html
<script
  type="module"
  src="https://your.cdn/x402.global.js"
  data-x402-api-origin="https://pay.your-company.com"
  data-x402-brand-label="Powered by Acme"
  data-x402-brand-href="https://acme.com"></script>
```

or from JS, before the first `pay()`:

```js
import { configure } from '@three-ws/x402-modal';

configure({
  apiOrigin: 'https://pay.your-company.com',     // Solana checkout backend
  brand: { label: 'Powered by Acme', href: 'https://acme.com' },
});
```

> **No dependencies to install.** The ESM build leaves the two optional wallet
> libraries (`@solana/web3.js` for Solana, a keccak for EVM sign-in) as runtime
> CDN imports, fetched only when that wallet path actually runs. The `/global`
> build is a single self-contained file.

## How it works

```
pay({ endpoint })
   │
   ├─ 1. discover   GET/POST endpoint → 402 (or 401 + payment-required header)
   │                parse `accepts[]` (asset · amount · network · payTo)
   │
   ├─ 2. connect    pick a wallet that can satisfy an accept:
   │                  Solana → Phantom          EVM → MetaMask / window.ethereum
   │
   ├─ 3. authorize  Solana: backend builds the tx → Phantom signs it
   │                  EVM:   wallet signs an EIP-3009 transferWithAuthorization
   │                  (no on-chain tx, no gas for the payer)
   │
   └─ 4. verify     re-send the request with `X-PAYMENT` → endpoint runs the work,
                    settles on-chain, returns 200 + `x-payment-response` receipt
```

Each step renders as a live row in the modal (spinner → check → error), with a
**Try again** affordance on failure, automatic retry on a `429` upstream
throttle (the payment isn't settled until the work succeeds, so re-sending can't
double-charge), and a receipt with an explorer link on success.

### Networks

| Network | Wallet | Scheme | Needs a backend? |
|---|---|---|---|
| **Base** (`eip155:8453`) | MetaMask / any `window.ethereum` | EIP-3009 `transferWithAuthorization` | **No** — fully client-side |
| Base Sepolia, Arbitrum, Optimism | same | EIP-3009 | No |
| **Solana** (`solana:*`) | Phantom | `exact` (facilitator-settled) | Yes — `prepare`/`encode` helper |

When a `402` advertises more than one network the modal shows a wallet picker;
when it advertises exactly one, it goes straight there.

## API

### `pay(options): Promise<PayResult>`

| option        | type                          | default            | notes |
|---------------|-------------------------------|--------------------|-------|
| `endpoint`    | `string`                      | — (**required**)   | the x402-protected URL to pay for and call |
| `method`      | `string`                      | `GET` / `POST`*    | *POST when a `body` is set |
| `body`        | `object \| string`            | —                  | forwarded to the endpoint (object → JSON) |
| `headers`     | `Record<string,string>`       | —                  | merged into discovery + paid calls |
| `merchant`    | `string`                      | `Payment`          | shown in the modal header |
| `action`      | `string`                      | `Pay-per-call`     | shown in the modal header |
| `caps`        | `{ maxPerCall, maxPerHour, maxPerDay }` | —      | µUSD spending caps (see [Configuration](#configuration)) |
| `autoConnect` | `boolean`                     | `false`            | skip the picker when exactly one wallet is detected |
| `apiOrigin`   | `string`                      | global config      | per-call override of the Solana checkout backend |
| `brand`       | `{ label, href }`             | global config      | per-call footer override |

Returns `{ ok: true, result, payment?, siwx?, response }`. `payment` is present
on a fresh payment (`{ network, payer, transaction }`); `siwx` is present when
the user re-entered via sign-in instead of paying.

### `configure(config): config` · `getConfig(): config`

Set global defaults once at startup. See [Configuration](#configuration).

### `init(): void`

Scan the document and bind every `[data-x402-endpoint]` element. The `/global`
build calls this automatically (and re-scans on DOM mutation); call it yourself
only when using the ESM build with declarative buttons.

### DOM events (declarative usage)

Bound elements dispatch bubbling `CustomEvent`s:

- `x402:result` — `detail` is the full `PayResult`.
- `x402:error` — `detail` is `{ error: string }`. (Cancellation does **not** fire this.)
- `x402:siwx-signed` — `detail` is `{ address, network }`, when re-entry was via SIWX.

### `data-*` attributes (declarative usage)

`data-x402-endpoint` (required), `data-x402-method`, `data-x402-body` (JSON),
`data-x402-headers` (JSON), `data-x402-caps` (JSON), `data-x402-api-origin`,
`data-x402-merchant`, `data-x402-action`.

## Configuration

All fields are optional; the defaults reproduce the hosted three.ws modal.

```js
configure({
  // Origin serving the Solana prepare/encode checkout helpers. Only the Solana
  // path uses it; the EVM path needs no backend. null → resolve from the
  // script's own origin; '' → same-origin.
  apiOrigin: 'https://pay.example.com',

  // Footer attribution.
  brand: { label: 'Powered by Acme', href: 'https://acme.com' },

  // ERC-8021 builder-code self-attribution, echoed back only when the 402
  // challenge declares a builder code. null disables the echo.
  builderCode: { wallet: 'acme', service: 'acme_checkout' },

  // Override the on-demand CDN modules (e.g. to self-host under a strict CSP).
  solanaWeb3Url: 'https://esm.sh/@solana/web3.js@1.95.3?bundle',
  nobleHashesUrl: 'https://esm.sh/@noble/hashes@1.4.0/sha3?bundle',
});
```

### Spending caps

Caps are enforced in `localStorage`, bucketed by rolling UTC hour and day, and
survive reloads. Amounts are **micro-USD** (`1_000_000` = `$1`). A failed payment
rolls its reservation back.

```js
await pay({
  endpoint: '/api/paid/x',
  caps: {
    maxPerCall: 1_000_000,    // $1.00 per call
    maxPerHour: 10_000_000,   // $10/hour
    maxPerDay:  50_000_000,   // $50/day
  },
});
```

Stablecoins (USDC, USDT, DAI) are converted to µUSD exactly. Non-stable assets
pass through atomic in the browser (no price feed is fetched to keep the script
dependency-free) — enforce those server-side.

## The backend

**EVM / Base needs no backend.** The payer signs an EIP-3009
`transferWithAuthorization` in their wallet and the modal sends the signed
authorization straight to your merchant endpoint as `X-PAYMENT`. Your x402
server (and its facilitator) verify and settle it.

**Solana needs one tiny helper**, because building a Solana transfer transaction
requires RPC access and the facilitator's fee-payer. The modal expects two
actions at `{apiOrigin}/api/x402-checkout`:

| action | request | response |
|---|---|---|
| `?action=prepare` | `{ accept, buyer }` | `{ tx_base64 }` — an unsigned/partially-signed `VersionedTransaction` |
| `?action=encode`  | `{ accept, signed_tx_base64, resource_url, builder_code? }` | `{ x_payment }` — the base64 `X-PAYMENT` value to send to the merchant |

`apiOrigin` defaults to the origin that served the script, so when you self-host
both the script and this helper there is nothing to configure. See
[`docs/BACKEND.md`](./docs/BACKEND.md) for the full contract and a reference
implementation, and [`examples/`](./examples) for runnable code.

## Install

```sh
npm i @three-ws/x402-modal
```

```js
import { pay, configure } from '@three-ws/x402-modal';   // ESM, no side effects
```

or skip the install entirely and use the CDN `/global` build (auto-binds
`[data-x402-endpoint]`, exposes `window.X402`).

## Security notes

- The modal **never holds keys**. Signing happens in the user's wallet; the
  signed payload goes to your endpoint.
- A `429` from the merchant is retried with the *same* signed payment — safe,
  because x402 settles only after the work succeeds.
- Upstream throttle/billing text is never relayed to the buyer verbatim.
- All endpoint-supplied strings are HTML-escaped before rendering.
- For the Solana path, the dynamic CDN import can be blocked by a strict
  Content-Security-Policy; either allow it, repoint it via `solanaWeb3Url`, or
  steer users to the dependency-free Base path.

## FAQ

**Do I need a wallet adapter / WalletConnect?** No. Solana uses the injected
Phantom provider; EVM uses the injected `window.ethereum`.

**Does the payer pay gas?** On EVM, no — EIP-3009 is a gasless signed
authorization your facilitator submits. On Solana the facilitator is the
fee-payer.

**Can I theme it?** It ships a self-contained stylesheet with light/dark
(`prefers-color-scheme`) support. Override the `.x402-*` classes, or set
`brand` for the footer. The header reflects `merchant` / `action`.

**Framework support?** It's framework-agnostic. Import `pay()` and call it from
a React/Vue/Svelte handler, or drop the `/global` script and use `data-*`
buttons.

**Where does this run in production?** This is the same modal that powers
payments on [three.ws](https://three.ws); the package is its standalone,
configurable home.

## License

All rights reserved, see [LICENSE](./LICENSE). Part of the [three.ws](https://three.ws)
platform for building, animating, rigging, and monetizing 3D AI agents.
