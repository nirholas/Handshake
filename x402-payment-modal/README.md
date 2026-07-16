# @three-ws/x402-payment-modal

**A drop-in payment modal for any [x402](https://x402.org) paid endpoint.** One ES
module, zero runtime dependencies. It turns an HTTP `402 Payment Required`
challenge into a polished checkout: wallet connect (Phantom on Solana, MetaMask /
any EVM wallet on Base via EIP-3009), the `402 → sign → settle` flow, optional
SIWX re-entry, client-side spending caps, and a receipt — vanilla JS, no bundler
required.

```html
<script type="module" src="https://unpkg.com/@three-ws/x402-payment-modal"></script>

<button
  data-x402-endpoint="https://api.example.com/paid/summarize"
  data-x402-method="POST"
  data-x402-body='{"text":"hello"}'
  data-x402-merchant="Acme"
  data-x402-action="Summarize">
  Pay &amp; Run
</button>
```

That's the whole integration. Clicking the button opens the modal, runs the
payment, calls your endpoint with the signed `X-PAYMENT` header, and fires an
`x402:result` event with the response.

---

## Why

x402 lets any HTTP endpoint charge a micropayment per call: the server answers an
unpaid request with `402` and a list of accepted payments; the client pays and
retries with an `X-PAYMENT` header. The protocol is simple — the *wallet UX* is
not. This package is the missing front end: a single, framework-agnostic modal
that handles wallet detection, chain switching, signing, settlement, errors,
throttle retries, and the receipt, so you ship a paid endpoint in minutes.

- **Zero dependencies, zero build.** Plain ES module. Drop in a `<script>` tag or
  `import` it. The Solana/EVM crypto helpers are loaded lazily from a CDN *only*
  when a payment is actually attempted.
- **Solana + EVM.** Phantom (Solana) and any injected EVM wallet (Base USDC
  via EIP-3009 `transferWithAuthorization`). The modal picks the right path from
  the 402 challenge.
- **Pay in USDC _or_ THREE on Solana.** Offer both and the buyer gets a token
  picker — pay in USDC, or in [$THREE](https://three.ws/three-token), the three.ws
  utility token, recognized on sight (symbol, decimals, branding). See
  [Accepting multiple Solana tokens](#accepting-multiple-solana-tokens-usdc--three).
- **SIWX re-entry.** If a wallet already paid for a resource, it can sign back in
  instead of paying again. See [docs/siwx.md](docs/siwx.md).
- **Spending caps.** Optional per-call / hourly / daily caps enforced in the
  browser. See [docs/spending-caps.md](docs/spending-caps.md).
- **Themeable.** Light + automatic dark mode, all classes overridable. See
  [docs/theming.md](docs/theming.md).
- **Accessible.** Focus management, `aria-modal`, keyboard `Esc` to close.

---

## Install

**Via CDN (no build step):**

```html
<script type="module" src="https://unpkg.com/@three-ws/x402-payment-modal"></script>
```

**Via npm (bundler / framework):**

```bash
npm install @three-ws/x402-payment-modal
```

```js
import { pay, configure } from '@three-ws/x402-payment-modal';
```

For Solana payments you also run a tiny server endpoint — install the optional
peer deps there:

```bash
npm install @solana/web3.js @solana/spl-token
```

> EVM-only sites need **nothing** server-side: the wallet signs EIP-3009
> typed-data entirely in the browser.

---

## Quick start

### 1. Declarative (HTML attributes)

Any element with `data-x402-endpoint` is auto-bound on load and re-scanned as the
DOM changes:

```html
<button
  data-x402-endpoint="/api/paid/translate"
  data-x402-method="POST"
  data-x402-body='{"text":"bonjour","to":"en"}'
  data-x402-merchant="Acme Translate"
  data-x402-action="Translate">
  Translate ($0.01)
</button>

<script type="module" src="https://unpkg.com/@three-ws/x402-payment-modal"></script>

<script>
  document.querySelector('button').addEventListener('x402:result', (e) => {
    console.log('paid + result:', e.detail.result);
  });
</script>
```

### 2. Programmatic

```js
import { pay } from '@three-ws/x402-payment-modal';

try {
  const { result, payment } = await pay({
    endpoint: '/api/paid/translate',
    method: 'POST',
    body: { text: 'bonjour', to: 'en' },
    merchant: 'Acme Translate',
    action: 'Translate',
  });
  console.log(result, 'tx:', payment?.transaction);
} catch (err) {
  if (err.code !== 'cancelled') console.error(err);
}
```

See the runnable [examples/](examples/) — plain HTML, React, and an Express
server.

---

## How it works

```
 click ──▶ GET/POST endpoint
            │
            ▼  HTTP 402  { accepts: [ {network, amount, asset, payTo, ...} ] }
       ┌─────────────┐
       │   discover  │  modal shows price + network
       └─────────────┘
            │
            ▼
       ┌─────────────┐
       │   connect   │  Phantom (Solana)  or  EVM wallet (Base)
       └─────────────┘
            │
       ┌────┴───────────────────────────────────────┐
       ▼ Solana                                       ▼ EVM
  POST /api/x402-checkout?action=prepare          sign EIP-3009
  Phantom signTransaction                         transferWithAuthorization
  POST /api/x402-checkout?action=encode           (browser only — no server)
       └────┬───────────────────────────────────────┘
            ▼
       ┌─────────────┐
       │   verify    │  retry endpoint with `X-PAYMENT: <base64>`
       └─────────────┘   (auto-retries once on a 429 throttle)
            │
            ▼  200 + `X-PAYMENT-RESPONSE` settlement header
        receipt + result
```

Full walkthrough in [docs/architecture.md](docs/architecture.md).

---

## Client API

| Export | Signature | Purpose |
| --- | --- | --- |
| `pay` | `pay(opts) => Promise<PayResult>` | Open the modal and run a payment. |
| `configure` | `configure(opts) => Config` | Set checkout origin, branding, builder-code, CDN URLs. |
| `init` | `init() => void` | Bind `[data-x402-endpoint]` elements (auto-called). |
| `version` | `string` | Library version. |

Also exposed as `window.X402.{ pay, init, configure, version }` for inline
scripts.

**`pay(opts)`** — `opts`:

| Field | Type | Notes |
| --- | --- | --- |
| `endpoint` | `string` | **Required.** The paid (x402) URL. |
| `method` | `string` | Default `GET`, or `POST` when `body` is set. |
| `body` | `object \| string` | Objects are JSON-stringified. |
| `headers` | `object` | Extra headers merged into the paid call. |
| `merchant` | `string` | Shown in the modal header. |
| `action` | `string` | Shown in the modal header. |
| `autoConnect` | `boolean` | Skip the picker when exactly one wallet is detected. |
| `caps` | `SpendingCaps` | `{ maxPerCall, maxPerHour, maxPerDay }` in atomic micro-USD. |

Resolves to `PayResult`: `{ ok: true, result, payment?: { network, transaction,
payer }, siwx?: { address, network }, response: { status, headers } }`. Rejects
with an `Error` whose `.code === 'cancelled'` when the user closes the modal.

**DOM events** (bubbling `CustomEvent`s on the clicked element):
`x402:result` (`detail` = `PayResult`), `x402:error` (`detail` = `{ error }`),
`x402:siwx-signed` (`detail` = `{ address, network }`).

Full reference: [docs/api-reference.md](docs/api-reference.md).

---

## Configuration

Defaults work out of the box. Override host-specific bits with `configure()`:

```js
import { configure } from '@three-ws/x402-payment-modal';

configure({
  checkoutOrigin: 'https://pay.acme.com', // where your Solana checkout endpoint lives
  brand: { name: 'Acme', url: 'https://acme.com' },
  footerNote: 'Acme Pay',
});
```

…or with `data-*` attributes on the script tag (no inline module needed):

```html
<script type="module"
  src="https://unpkg.com/@three-ws/x402-payment-modal"
  data-x402-checkout-origin="https://pay.acme.com"
  data-x402-brand-name="Acme"
  data-x402-brand-url="https://acme.com"></script>
```

| Option | `data-*` attribute | Default |
| --- | --- | --- |
| `checkoutOrigin` | `data-x402-checkout-origin` | the script's own origin |
| `checkoutPath` | `data-x402-checkout-path` | `/api/x402-checkout` |
| `footerNote` | `data-x402-footer-note` | `x402 · onchain settled` |
| `brand.name` / `brand.url` | `data-x402-brand-name` / `-brand-url` | `three.ws` |
| `builderCode.wallet` / `.service` | `data-x402-builder-wallet` / `-builder-service` | three.ws codes |
| `esm.solanaWeb3` / `esm.nobleHashesSha3` | — | pinned esm.sh URLs |

Repoint `esm.*` at a self-hosted mirror if a strict Content-Security-Policy
blocks `esm.sh`. (The EVM/Base path needs no third-party code at all.)

---

## Server (Solana only)

Phantom signs serialized transactions but doesn't build instructions, so the
Solana path needs a tiny endpoint to build the SPL transfer and wrap the signed
tx into the `X-PAYMENT` envelope. The package ships it.

**Express:**

```js
import express from 'express';
import { x402CheckoutRouter } from '@three-ws/x402-payment-modal/server/express';

const app = express();
app.use(express.json());
app.use('/api/x402-checkout', x402CheckoutRouter({ rpcUrl: process.env.SOLANA_RPC_URL }));
app.listen(3000);
```

**Vercel / Next.js** — `api/x402-checkout.js`:

```js
export { default } from '@three-ws/x402-payment-modal/server/vercel';
```

Lower-level helpers (`prepareSolanaCheckout`, `encodeX402Payment`,
`handleCheckout`, `CheckoutError`) are exported from
`@three-ws/x402-payment-modal/server`. Full guide:
[docs/server-setup.md](docs/server-setup.md).

---

## Accepting multiple Solana tokens (USDC + THREE)

An x402 challenge can list more than one accepted payment. List a USDC accept
**and** a [$THREE](https://three.ws/three-token) accept on Solana, and the modal
renders a token picker: the buyer chooses which to pay in, the headline price and
the transaction follow the choice. No client wiring — the checkout endpoint
already builds an SPL transfer for whatever mint the chosen accept names.

Build the accepts with the `solanaAccept` helper (no hardcoded mints):

```js
import { solanaAccept } from '@three-ws/x402-payment-modal/server';

// feePayer is your facilitator's sponsor account (pays the SOL network fee).
const accepts = [
  solanaAccept({ token: 'usdc',  uiAmount: 0.25, payTo, feePayer }), // $0.25 in USDC
  solanaAccept({ token: 'three', uiAmount: 1000, payTo, feePayer }), // or 1,000 THREE
];

// Return them in your 402 body / PAYMENT-REQUIRED envelope:
//   { x402Version: 2, accepts }
```

`solanaAccept` takes `token: 'usdc' | 'three'` (or an explicit `mint` for any
SPL token), the price as `uiAmount` (human units) or `amount` (atomic string),
and emits a spec-shaped `accept`. The constants `THREE_MINT`, `USDC_MINT_SOLANA`,
and `WELL_KNOWN_SOLANA_TOKENS` are exported too. On the client, the same mints
are exposed at `window.X402.tokens` for inline merchants.

> **THREE is a utility token, not a stablecoin.** Its price floats, so the modal
> can't dollar-denominate it for browser-side spending caps — enforce caps for
> THREE server-side. USDC caps work in the browser as usual.

---

## Documentation

- [Architecture](docs/architecture.md) — the full payment lifecycle.
- [Client API reference](docs/api-reference.md)
- [Server setup](docs/server-setup.md)
- [Theming](docs/theming.md)
- [SIWX re-entry](docs/siwx.md)
- [Spending caps](docs/spending-caps.md)
- [Tutorial](TUTORIAL.md) — build a paid endpoint end-to-end.

---

## Browser support

Modern evergreen browsers (ES2020, `BigInt`, dynamic `import()`, `fetch`,
`crypto.getRandomValues`). The Solana wallet path requires
[Phantom](https://phantom.app); the EVM path requires an injected wallet
(`window.ethereum`).

## Security

- Payments are signed in the user's wallet — this package never sees a private
  key. The Solana checkout server only builds an unsigned transaction and base64-
  wraps the user-signed one; it cannot move funds.
- Spending caps are a **client-side guardrail**, not a security boundary — a user
  can clear `localStorage`. Enforce real limits server-side.
- Pin the script to a version or self-host it for production.

## License

All rights reserved. See [LICENSE](./LICENSE).

> Maintained inside the [three.ws](https://three.ws) monorepo and published as a
> standalone package. Issues and PRs:
> <https://github.com/nirholas/three.ws/issues>.
