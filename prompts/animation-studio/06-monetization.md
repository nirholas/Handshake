# Task 6 — Monetize animations: sell for USDC via x402, list in marketplace + bazaar

> Read `prompts/animation-studio/00-README.md` first (x402 patterns, `paid_assets` +
> `asset-download.js`, payout overrides, bazaar schema). Follow `CLAUDE.md`. No mocks, real
> payments rails, wire 100%, design every state, verify in a real browser.
>
> **Depends on Task 3** (`animation_clips` rows with `price_amount`/`price_currency`) and **Task 4**
> (clips saved to accounts + the "Sell" hook in the library). Benefits from Task 5 (playback for
> previews/post-purchase). Read their handoff notes first.

You are letting creators **sell** the animations they make. The platform already sells downloadable
assets for USDC — **reuse that machinery**, don't build a parallel one.

Read these before writing:
- [api/x402/asset-download.js](../../api/x402/asset-download.js) — the "pay once → presigned R2
  download" endpoint, with per-creator payout overrides + SIWX re-download. This is your template.
- [api/_lib/x402-paid-endpoint.js](../../api/_lib/x402-paid-endpoint.js) — `paidEndpoint()` helper.
- [api/_lib/x402-spec.js](../../api/_lib/x402-spec.js) — `buildBazaarSchema()`, `bazaarExtension()`,
  payment requirement structs (prices are **USDC atomics**, 6 decimals: `1_000_000` = $1.00).
- [api/x402-skus.js](../../api/x402-skus.js) — hosted checkout SKUs → `/pay/c/<slug>`.
- The marketplace page + bazaar UI and their data APIs (search `pages/marketplace*.html`,
  `public/bazaar.js`, `api/bazaar/*`).
- Payout config + per-asset overrides in [api/_lib/env.js](../../api/_lib/env.js)
  (`X402_PAY_TO_*`, `creator_payto_base/solana/bsc`).

## What to build

### 1. Pricing an animation (creator side)
- In the "My animations" library (Task 4), wire the **"Sell"** affordance into a real flow: set a
  **price** (USDC) and the **payout wallet(s)** (Base / Solana), then publish for sale.
- Publishing for sale must:
  - Set `price_amount` / `price_currency` on the `animation_clips` row (Task 3 added these), and
    set visibility appropriately (a priced clip should be discoverable — `public`/`unlisted` as the
    UI specifies; gate the actual file behind payment, not behind listing visibility).
  - Make the clip's downloadable artifact available to the paid endpoint. Decide the artifact:
    the **GLB with embedded animation** (preferred for broad compatibility) and/or the clip JSON.
    Store it in R2 the way `paid_assets` stores files, and capture the per-creator payout addresses.
    If reusing the `paid_assets` table is the cleanest fit, create the `paid_assets` row from the
    animation (link it back to the `animation_clips.id`); otherwise add the needed columns to
    `animation_clips` and serve from there. Choose the approach that **minimizes divergence** from
    `asset-download.js` and document it.
- Let the creator set/rotate price, unpublish, and see basic **earnings/stats** (mirror the stats
  pattern in [api/x402-skus.js](../../api/x402-skus.js) — paid calls, revenue, recent txs).

### 2. Paid download endpoint
- Add `api/x402/animation-download.js` modeled directly on `asset-download.js`:
  - `GET /api/x402/animation-download?id=<id>` (or `?slug=`). Look up the priced animation; if not
    priced/published, 404.
  - Wrap with `paidEndpoint()`: price from the row's atomics, networks Base + Solana, payout via the
    per-creator override (`buildPayToOverride`-style), bazaar extension via `buildBazaarSchema()`.
  - On payment: presign the R2 artifact (GLB/JSON) and return `{ ok, title, mimeType, sizeBytes,
    downloadUrl, expiresAt }` exactly like `asset-download.js`. Wire **SIWX re-download** so buyers
    re-download without re-paying (reuse the `siwx_payments` flow).
  - Increment a purchase counter / record the checkout call for stats.

### 3. Buyer experience
- On the public gallery / animation detail (Task 5) and in the marketplace, a priced animation shows
  its price and a **Buy** button that runs the existing x402 payment flow (reuse the drop-in
  payment modal / SKU checkout used elsewhere — search for the existing client payment widget;
  do not hand-roll wallet signing). After payment, the buyer can **download** the GLB/JSON and
  **play** it (link into Task 5's playback / "use on my avatar").
- Optionally create a hosted SKU (`/pay/c/<slug>`) per the `x402-skus.js` pattern so creators get a
  shareable checkout link. If you add it, wire it fully (creation + the `/pay/c/<slug>` page render).
- States: price display, buy in-flight, payment success (download + play CTA), payment
  error/cancel (recoverable), already-purchased (SIWX → free re-download).

### 4. Listing in marketplace + bazaar
- Make priced animations appear in the **marketplace** (whatever data source the marketplace page
  reads — add animations to it with title, price, seller, thumbnail, category "Animation") and
  discoverable in the **bazaar** via the `bazaarExtension()`/`buildBazaarSchema()` declaration on
  the paid endpoint so x402 discovery validation passes.
- Cross-link: marketplace card → animation detail/preview (Task 5) → Buy. No dead links.

## Definition of done
- A creator can price + publish an animation; the row carries `price_amount`/`price_currency` and a
  per-creator payout address; the artifact is in R2.
- `GET /api/x402/animation-download?id=...` returns a real 402 challenge with the correct price and
  payout, and — after a real payment on a test network/wallet — returns a working presigned
  download. SIWX re-download works without re-paying. **Verify the 402 challenge and the post-
  payment response with real requests and paste them.** (If a live settlement can't be performed in
  the environment, demonstrate the 402 envelope + verify path and document exactly what a real
  payment would complete — but do not fake a settlement.)
- The animation appears in the marketplace and validates in the bazaar discovery schema.
- Buyer flow works end-to-end in the browser: see price → Buy → pay → download + play. All states
  designed; no console errors.
- Creator earnings/stats reflect real checkout records.
- `npm test` green. Run `completionist`; fix all findings.
- Handoff note: anything Task 7 should cross-link (marketplace entry points, gallery, studio).

Reuse the existing x402 facilitator/settlement rails and payout config — never mock a payment, a
settlement, or an on-chain tx. Do not push unless the user explicitly approves (then both remotes
per CLAUDE.md).
