# x402 Studio: the Stripe of x402

x402 Studio is the merchant console for running a paid x402 business on three.ws. In one page you define products and pricing, point them at a payout wallet, add named agent wallets with spend caps, send and receive real USDC (addressed by `.sol` name or `@username`, not just raw base58), drag-and-drop a hosted storefront, generate an embeddable pay button for any site, add charity or round-up giving, and lock down CORS and security. Everything settles on-chain in USDC, Solana first.

Page: [/x402/studio](https://three.ws/x402/studio)

APIs: `/api/x402-merchant` (settings), `/api/x402-skus` (products), `/api/sns` (name resolution), `/api/x402/pay-by-name` (USDC send). See [x402: paid agent skills](./x402.md) for the underlying payment protocol.

## Why it exists

x402 turns any HTTP endpoint into a paid one: the server answers `402 Payment Required` with a manifest, the caller pays in USDC, and the call retries and settles. That primitive is powerful but low-level. Studio is the console on top of it, the difference between "you can hand-write a 402 challenge" and "you can run a storefront." A merchant configures once and gets hosted checkout links, a shareable storefront, a copy-paste pay button, revenue stats, and payouts to a wallet they control, without writing payment code. It is the seller-facing companion to the [x402 buyer client](./x402-buyer.md) and the [paid endpoint catalog](./x402-endpoints.md).

## How it works

The page (`public/x402/studio.js`) is a dependency-free vanilla-JS single-page app with seven hash-routed tabs: Overview, Products, Wallets, Storefront, Embed builder, Giving, and Security and API. Every request goes through a helper that sends the session cookie (`credentials: 'include'`). All USDC amounts use 6 decimals.

**Merchant settings** (`/api/x402-merchant`) is one row per user in `x402_merchant_settings`. A `GET` lazily creates it and returns your payout and agent wallets, default settlement network (`solana` by default, with `base` also allowed), branding, CORS allow-list, security caps, giving config, and storefront layout. It never returns the API key hash. A `PUT` validates against a Zod schema and upserts. `POST ?action=rotate-key` mints an `x402_live_...` key, stores only its SHA-256 hash and an 18-character prefix, and shows the secret once. A public `GET ?store=<handle>` returns a published storefront and its active products for `/store/<handle>`.

**Products** (`/api/x402-skus`) are hosted checkout links in `x402_skus`. A product carries a permanent slug, a paid target endpoint (which must itself return 402), a method, an optional request body, branding, and an optional display price. Creating one yields a shareable link at `/pay/c/<slug>` that opens the drop-in payment modal pre-wired to the target. Owner reads compute `paid_calls` and `gross_atomics` from settled calls; `GET ?id=<id>&stats=1` returns full revenue stats and the last 25 payments; `GET ?slug=<slug>` is the public checkout read.

**Payout and agent wallets.** The payout wallet (Solana, with an EVM/Base option) is where settled USDC lands. Agent wallets are named on-chain identities with a role of `payer` (auto-pays for services) or `payout` (receives), a chain, and independent per-call and daily caps stored as atomics. Up to 50 agent wallets are allowed.

**SNS name resolution** (`/api/sns`) resolves a `.sol` name (including subdomains like `nich.threews.sol`) to an address, and reverse-resolves an address to its primary `.sol`, via Bonfida's `@bonfida/spl-name-service` `resolve()` on Solana mainnet. It always answers 200 (`resolved: false` on a miss, not a 404) and caches results in-process (5 minutes positive, 60 seconds negative).

**Real USDC send** (`/api/x402/pay-by-name`) routes a payment by name across three namespaces in order: a raw base58 address, a `<name>.sol` resolved on-chain, or an `@username` mapped to that user's default agent's Solana address. Studio uses `mode: 'prep'`, which builds an unsigned SPL USDC transfer (mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) with your Phantom wallet as fee payer and source, returns the base64 transaction for signing, and caps the amount at 10,000 USDC per call. The blockhash in that transaction comes from the shared Solana read guard, which serves a cached hash still inside its validity window when the RPC is briefly unreadable. This send path is Solana-only (Phantom plus SPL USDC); Base is supported as a payout, agent, or charity destination, not in the send tool. The `@solana/web3.js` signing component is fetched on demand through `/load-module.js`, which tries esm.sh, then jsdelivr and unpkg for the same pinned version, each under a deadline; if all three are unreachable or blocked, the status line names the hosts, states that nothing was sent, and re-enables the button.

**Storefront builder.** A palette of eight blocks (hero, product grid, single product, text, image, button, divider, footer) drops onto a canvas with HTML5 drag-and-drop and reorder. Save keeps it a draft; Publish sets `store_published` and serves it at `/store/<handle>`. Layout is capped at 60 blocks.

**Embed builder.** Pick a product, a label, a size, a shape, and a theme, and it generates a working pay button. The generated snippet loads the x402 runtime and a `data-x402-*` attributed button:

```html
<!-- x402 pay button, powered by three.ws -->
<script type="module" src="https://three.ws/x402.js"></script>
<button
  data-x402-endpoint="https://your-api.example.com/paid"
  data-x402-method="GET"
  data-x402-merchant="Your merchant name"
  data-x402-action="Summarize article"
  style="...">Pay · Summarize article</button>
```

The `type="module"` on the script is load-bearing: `/x402.js` uses `import.meta.url`, which throws in a classic script.

**Giving.** A charity split donates a fixed share of every settled payment to a cause wallet, stored as `charity_bps` (percent times 100, 0 to 10000). Round-up rounds the buyer's total up to the nearest unit (1, 0.5, 0.25, 0.1, or 5 USDC) and sends the difference to the same cause wallet. Round-up requires a charity address first, and the server enforces that the charity address matches its declared chain.

**Security and CORS.** Max per-call and per-day USDC caps, an optional Sign-In-With-X requirement, settlement-network selection, and a CORS allow-list (one origin per line, `https://host[:port]`, up to 50; empty means three.ws-hosted pages only). The developer section holds an optional facilitator URL, a settlement webhook, and the rotatable API key.

## Walkthrough

1. Open [/x402/studio](https://three.ws/x402/studio). Signed out, it shows a sign-in card linking `/login?next=/x402/studio`.
2. On **Wallets**, set your Solana payout address (use the Resolve `.sol` button to paste a name instead of an address). This is where settled USDC lands.
3. On **Products**, create a product: name it, give it a slug, point it at your paid endpoint that returns 402, and save. Copy its `/pay/c/<slug>` link.
4. On **Embed builder**, pick that product, style the button, and copy the snippet into any site.
5. Optionally publish a **Storefront** at `/store/<handle>`, add **Giving**, and tighten **Security and API** (caps, CORS, an API key).
6. To pay someone, use the send tool: enter a `.sol` name or address and an amount, and approve the transfer in Phantom.

## Examples

```bash
# Resolve a .sol name (or @username) to a Solana address (public, no auth)
curl 'https://three.ws/api/sns?name=nich.threews.sol'

# Read a public storefront and its active products
curl 'https://three.ws/api/x402-merchant?store=<handle>'

# Read a public checkout SKU (what /pay/c/<slug> loads)
curl 'https://three.ws/api/x402-skus?slug=<slug>'
```

```javascript
// Build an unsigned USDC transfer addressed by name (mode: 'prep')
const res = await fetch('https://three.ws/api/x402/pay-by-name', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    name: 'nich.threews.sol',
    amount_usdc: 5,
    mode: 'prep',
    payer_wallet: '<YOUR_SOLANA_ADDRESS>',
  }),
});
const { tx_base64, blockhash } = await res.json();
// Deserialize tx_base64, sign with Phantom, and send. Amount is capped at 10,000 USDC per call.
```

## States and limits

- **Auth.** The console requires a session; every mutating endpoint is owner-scoped (401 unauthenticated, 403 for another user's resource) and rate-limited. Public reads (storefront, checkout SKU, SNS resolve) need no auth.
- **Spend confirmation.** A USDC send always requires explicit Phantom approval, is capped at 10,000 USDC per call server-side, and rejects a self-pay. Agent-signed sends additionally enforce the agent's per-transaction and daily caps and re-check the recipient against fresh resolution (409 `recipient_changed`) to defend against name-poisoning. Archiving a product, removing an agent wallet, and rotating the API key each require an explicit confirm.
- **Validation.** Solana addresses base58 32-44, EVM `0x` plus 40 hex, slugs lowercase and hyphenated 3-64, publishing requires a globally unique handle (409 `handle_taken`), and CORS origins must be `https?://` origins.
- **Empty states.** Dedicated empties for no products, no agent wallets, nothing to embed, and an empty storefront canvas, plus a retry card on a fatal boot error.
- **Networks.** SNS and the send tool are Solana mainnet only. Settlement supports Solana and Base; the default is Solana.

## Related

- [x402: paid agent skills](./x402.md): the payment protocol Studio sits on top of
- [Financial controls](./financial-controls.md): where settled payments are recorded
- [x402 paid endpoints](./x402-endpoints.md): the platform's own catalog of paid endpoints
- [x402 buyer client](./x402-buyer.md): the caller side of a 402 challenge
- [x402 developer tools](./x402-dev-tools.md) and [x402 distribution](./x402-distribution.md)
- Pages: [/x402/studio](https://three.ws/x402/studio) · [/x402](https://three.ws/x402)
