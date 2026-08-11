# Configuration reference

Three ways to configure, in increasing specificity (later wins):

1. **`data-x402-*` on the `/global` script tag** — declarative, no JS.
2. **`configure({ … })`** — global defaults, set once at startup.
3. **`pay({ … })` options** — per-call overrides.

All defaults reproduce the hosted three.ws modal, so an un-configured drop-in
behaves exactly like `https://three.ws/x402.js`.

---

## `configure(config)` / `getConfig()`

```js
import { configure, getConfig } from '@three-ws/x402-modal';
configure({ apiOrigin: 'https://pay.example.com' });
getConfig(); // → fully-resolved snapshot
```

| field | type | default | purpose |
|---|---|---|---|
| `apiOrigin` | `string \| null` | `null` → script origin | Origin of the Solana `prepare`/`encode` helper. `''` = same-origin. Ignored by the EVM path. |
| `brand` | `{ label?, href? }` | `Powered by three.ws` → `https://three.ws` | Footer attribution. Merge-updated (set only `label` and `href` survives). |
| `builderCode` | `{ wallet?, service? } \| null` | `{ wallet: '3d_agent', service: '3d_agent_modal' }` | ERC-8021 self-attribution echoed when the `402` declares a builder code. `null` disables the echo. Codes must match `^[a-z0-9_]{1,32}$`. |
| `solanaWeb3Url` | `string` | `esm.sh/@solana/web3.js@1.95.3` | CDN module dynamic-imported on the Solana path. Repoint to self-host under a strict CSP. |
| `nobleHashesUrl` | `string` | `esm.sh/@noble/hashes@1.4.0/sha3` | CDN keccak module, used only for EVM SIWX sign-in. |

`configure()` merges: `configure({ brand: { label: 'X' } })` keeps the existing
`href`. Pass `apiOrigin: null` to reset to script-origin resolution; pass
`builderCode: null` to switch the echo off.

---

## `pay(options)`

| option | type | default | notes |
|---|---|---|---|
| `endpoint` | `string` | — (**required**) | the x402-protected URL |
| `method` | `string` | `GET`, or `POST` if `body` set | HTTP method |
| `body` | `object \| string` | — | object is JSON-encoded; string sent as-is |
| `headers` | `Record<string,string>` | — | merged into discovery + paid requests |
| `merchant` | `string` | `Payment` | modal header line 1 |
| `action` | `string` | `Pay-per-call` | modal header line 2 |
| `caps` | `SpendingCaps` | — | per-wallet µUSD caps (below) |
| `autoConnect` | `boolean` | `false` | skip the picker when exactly one wallet is detected |
| `apiOrigin` | `string` | global config | per-call Solana backend override |
| `brand` | `{ label?, href? }` | global config | per-call footer override |

### `SpendingCaps`

```ts
{ maxPerCall?: number|string, maxPerHour?: number|string, maxPerDay?: number|string }
```

Micro-USD (`1_000_000` = `$1`). Tracked per wallet address in `localStorage`,
bucketed by rolling UTC hour and day. Stablecoins convert exactly; non-stable
assets pass through atomic (cap those server-side). A breach is rejected before
the wallet prompt; a downstream failure rolls the reservation back.

---

## `data-x402-*` attributes

### On the `/global` `<script>` tag (global config)

| attribute | maps to |
|---|---|
| `data-x402-api-origin` | `apiOrigin` |
| `data-x402-brand-label` | `brand.label` |
| `data-x402-brand-href` | `brand.href` |
| `data-x402-builder-wallet` | `builderCode.wallet` |
| `data-x402-builder-service` | `builderCode.service` |
| `data-x402-builder-disable` | `builderCode = null` (presence or `"true"`) |
| `data-x402-solana-web3-url` | `solanaWeb3Url` |
| `data-x402-noble-hashes-url` | `nobleHashesUrl` |

These are read off whichever `<script>` tag carries them, so every URL shape
works: the CDN's extensionless `unpkg.com/@three-ws/x402-modal/global` subpath,
a self-hosted `x402.global.js`, or any filename you rename it to.

### On a clickable element (per-button `pay()` options)

| attribute | maps to |
|---|---|
| `data-x402-endpoint` | `endpoint` (**required** to bind) |
| `data-x402-method` | `method` |
| `data-x402-body` | `body` (JSON parsed; falls back to raw string) |
| `data-x402-headers` | `headers` (JSON) |
| `data-x402-caps` | `caps` (JSON) |
| `data-x402-api-origin` | `apiOrigin` |
| `data-x402-merchant` | `merchant` |
| `data-x402-action` | `action` (defaults to the element's text) |

---

## Theming

The modal injects one stylesheet (`#x402-styles`) scoped to `.x402-*` classes,
with full `prefers-color-scheme` light/dark support and a `prefers-reduced-motion`
-friendly animation. To restyle, override those classes after the script loads:

```css
.x402-modal { border-radius: 8px; }
.x402-pay-btn { background: #6d28d9; }
```

The footer text/link is set by `brand`; the two header lines by
`merchant` / `action`.
