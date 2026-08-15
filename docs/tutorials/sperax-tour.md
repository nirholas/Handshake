# The Sperax Tour Template — a Ready-Made 3D Guide for a DeFi Protocol

The [Tour Builder](/tour-builder) ships **templates** — ready-made tours you load into the editor as a starting point instead of picking every stop by hand. The first one is **Sperax — DeFi protocol tour**: an 8-stop guided walk of [usds.sperax.io](https://usds.sperax.io), Sperax's USDs auto-yield stablecoin site, built for three.ws's first DeFi partner deployment.

This page shows what the template covers, how to load and adjust it, and the exact snippet it exports — the same one Sperax (or anyone forking the idea for their own DeFi site) would drop onto their own pages.

---

## What the template covers

Loading the template gives you 8 stops across 3 chapters, written in plain language with no unexplained jargon:

| # | Chapter | Stop | What the guide says |
| - | --- | --- | --- |
| 1 | Sperax at a glance | What Sperax is | Sperax has been building on Arbitrum since 2019 — audited, DAO-governed. |
| 2 | How USDs works | USDs: yield with zero extra steps | USDs pays you for holding it — no staking, no claiming, the balance just grows. |
| 3 | Sperax at a glance | Why holders choose USDs | Effortless income, security-first design, instant withdrawals. |
| 4 | How USDs works | Minting & redeeming | Deposit USDC/USDT/USDC.e to mint USDs; redeem back for your collateral of choice anytime. |
| 5 | How USDs works | Where the yield comes from | Collateral works in audited protocols like Aave, Compound, and Stargate; ~70% of the yield flows back to holders. |
| 6 | SPA, farms & getting started | Stake SPA for veSPA | Lock SPA for veSPA — voting power plus a share of fees and yield. |
| 7 | SPA, farms & getting started | Farms — extra yield on LP tokens | Stake LP tokens in a Sperax Farm for up to 100% APR. |
| 8 | SPA, farms & getting started | Get started | Hit Launch App, connect a wallet, mint your first USDs. |

Every fact above was checked against a live source before it was written — see [Selector & fact provenance](#selector--fact-provenance) below.

## Loading it

1. Open the **[Tour Builder](/tour-builder)**.
2. Click **🧩 Browse templates** at the top of the editor panel.
3. Pick **Sperax — DeFi protocol tour**. The 8 stops above load straight into the editor — same title, avatar, and chapters as the table.
4. Edit like any hand-built tour: rewrite a line, star a stop into the Quick track, reorder, or re-pick a target by clicking a section of the (unrelated) demo storefront — the picker still works, it just replaces that one stop's selector chain with whatever you clicked.

A banner appears while the template is active:

> This template targets usds.sperax.io's real DOM. Preview here shows the guide walking, spotlighting, and narrating on our demo store — the mechanics are identical, but the actual sections only exist on Sperax's site. Export the snippet and drop it into usds.sperax.io to see the real thing.

**Preview** in the builder always runs against the builder's own demo storefront (a Shopify-style sandbox), so it can't show the guide standing next to Sperax's real hero or FAQ — but it proves the walking, spotlighting, narration, chapter map, and playback controls are wired correctly, because it's the identical engine. The true preview is the exported snippet running on the real site, which is why **Get the code** is the next step, not an afterthought.

## Getting the code

Click **⬇ Get the code**. Because a partner template targets a real, already-built site instead of a fresh Shopify theme, the walkthrough is two steps instead of three:

**1. Host the curriculum.** Download `curriculum.json` and put it anywhere on your own domain — a CDN bucket, your `/public` folder, your CMS's file storage — then copy its URL.

**2. Drop the tag on the page.** Paste the generated `<script>` tag right before `</body>`, swapping the placeholder URL for the one from step 1:

```html
<script src="https://unpkg.com/@three-ws/tour@0.5.1/dist/tour.global.js"
        data-tour
        data-curriculum="https://cdn.sperax.io/tour/curriculum.json"
        defer></script>
```

Add a start button anywhere on the page:

```html
<button data-tour-start class="button">✨ Sperax — DeFi protocol tour</button>
```

Both snippets above are the builder's real generated output for the unmodified template — not hand-written examples.

### The exported curriculum

This is the actual `curriculum.json` the builder produces for the unmodified template (downloaded from a live export, not retyped):

```json
{
  "title": "Sperax — DeFi protocol tour",
  "tracks": [
    { "id": "full", "title": "Full tour" },
    { "id": "quick", "title": "Quick tour" }
  ],
  "sections": [
    { "id": "overview", "title": "Sperax at a glance", "intro": "Welcome — I’m here to walk you through Sperax and USDs, its auto-yield stablecoin that’s been live on Arbitrum since 2019." },
    { "id": "usds", "title": "How USDs works", "intro": "USDs isn’t a slideshow — it’s a real yield engine. Let’s see how minting, redeeming, and the yield itself actually work." },
    { "id": "spa", "title": "SPA, farms & getting started", "intro": "Beyond USDs there’s SPA — Sperax’s governance token — plus Farms for extra yield. Let’s finish with how to get started." }
  ],
  "stops": [
    {
      "path": "/", "section": "overview", "title": "What Sperax is",
      "narration": "Sperax has been building on Arbitrum since 2019 — through every market cycle, fully audited, and governed by its own DAO. USDs, its auto-yield stablecoin, is where the story starts.",
      "highlight": true,
      "targets": ["[data-framer-name=\"Hero section\"]", "header"]
    },
    {
      "path": "/", "section": "usds", "title": "USDs: yield with zero extra steps",
      "narration": "USDs is a stablecoin that pays you just for holding it. No staking, no claiming, no dashboards — the yield shows up as a bigger wallet balance automatically, roughly once a day.",
      "highlight": true,
      "targets": ["[data-framer-name=\"Native Yield with Zero Extra Steps\"]", "[data-framer-name=\"Stablecoin with built-in Auto-Yield on Arbitrum\"]"]
    },
    {
      "path": "/", "section": "overview", "title": "Why holders choose USDs",
      "narration": "Three things holders keep coming back for: effortless income that compounds on its own, security-first engineering, and instant withdrawals — your USDs are never locked up.",
      "highlight": false,
      "targets": ["[data-framer-name=\"Why Choose USDs?\"]", "[data-framer-name=\"Discover the benefits of USDs\"]"]
    },
    {
      "path": "/", "section": "usds", "title": "Minting & redeeming",
      "narration": "Deposit USDC, USDT, or USDC.e and mint USDs against it, roughly one-for-one. Ready to exit? Redeem USDs back for the collateral of your choice — no lockups, no waiting.",
      "highlight": true,
      "targets": ["[data-framer-name=\"Deposit USDT, USDC.e & USDC collaterals to get USDs in your wallet\"]", "[data-framer-name=\"Mint USDs Using Other Tokens in Your Wallet\"]"]
    },
    {
      "path": "/", "section": "usds", "title": "Where the yield comes from",
      "narration": "Your collateral doesn’t sit idle — it’s deployed across audited lending and liquidity protocols like Aave, Compound, and Stargate. About 70% of what it earns flows back to USDs holders automatically; the rest funds SPA buybacks.",
      "highlight": false,
      "targets": ["[data-framer-name=\"Smart Yield Made Simple\"]", "[data-framer-name=\"Historical Revenue Growth\"]"]
    },
    {
      "path": "/", "section": "spa", "title": "Stake SPA for veSPA",
      "narration": "Lock SPA, Sperax’s governance token, to receive veSPA — non-transferable voting power that also earns you a cut of protocol fees and yield. Lock longer, get more veSPA and a bigger share.",
      "highlight": true,
      "targets": ["[data-framer-name=\"Launch App\"]", "a[href=\"https://app.sperax.io/\"]"]
    },
    {
      "path": "/", "section": "spa", "title": "Farms — extra yield on LP tokens",
      "narration": "Prefer more upside? Provide liquidity and stake your LP tokens in a Sperax Farm — some pools pay up to 100% APR. Sperax Farms even lets other DAOs launch their own farms with zero code.",
      "highlight": false,
      "targets": ["[data-framer-name=\"Provide Liquidity\"]", "[data-framer-name=\"Stake your liquidity pool tokens in our designated farms to earn upto 100% APR.\"]"]
    },
    {
      "path": "/", "section": "spa", "title": "Get started",
      "narration": "That’s the loop — deposit, hold, earn, exit whenever you want. Hit Launch App to connect your wallet and mint your first USDs.",
      "highlight": true,
      "targets": ["[data-framer-name=\"Launch App\"]", "a[href=\"https://app.sperax.io/\"]"]
    }
  ]
}
```

## Adjusting the selectors

Every stop's `targets` array is a **fallback chain** — the first visible match wins:

1. **Primary** — the selector most likely to still be correct.
2. **Secondary** — a nearby, independently-verified element, used if the primary was renamed or removed (a re-theme, an A/B test).
3. If both miss, `@three-ws/tour` itself falls back to any element marked `[data-tour-target]`, then the page's `h1` or primary call-to-action, and finally narrates with **no spotlight at all** rather than failing the stop. A missing selector never breaks the tour.

The primary/secondary selectors here target `data-framer-name` attributes — usds.sperax.io is built with [Framer](https://framer.com), which stamps each layer's designer-given name onto the rendered DOM (e.g. `data-framer-name="Why Choose USDs?"`). Those names are set by hand in the Framer canvas and are far more stable across republishes than Framer's auto-generated CSS class hashes, which rotate on every publish — that's why they're used here instead of classes.

**To re-pin a stop to a different element** once you have the real page open in a browser:

1. Right-click the element → **Inspect**.
2. Look for a `data-framer-name` attribute (or add `data-tour-target` directly to the element in your CMS/component if you control the markup — it always takes priority).
3. Replace the stop's `targets` array with `["[data-framer-name=\"Your Value\"]", "<a fallback selector>"]`, or paste the new selector into the Tour Builder's stop editor by clicking **Re-pick** (works against any page you can open in the builder's own tab, or hand-edit the downloaded `curriculum.json`).

## Selector & fact provenance

Every selector and every number in the narration above traces back to a live source fetched on 2026-07-08:

- **usds.sperax.io** (HTTP 200) — the real marketing site; every `data-framer-name` selector chain above was confirmed present in its fetched DOM.
- **docs.sperax.io** — `master.md`, `master/auto-yield.md`, `staking-protocol.md`, `sperax-farms-protocol.md`, `buyback-contract.md`, `governance.md`, `getting-started-on-our-dapp/minting-and-redeeming-usds.md` — sourced the 2019 founding date, the 70/30 auto-yield/buyback split, the named yield strategies (Aave, Compound, Stargate), and the veSPA/staking mechanics.
- **app.sperax.io** (the connected-wallet dashboard where minting, redeeming, and staking actually execute) returned an HTTP 403 Cloudflare JS challenge and could not be fetched from the environment this template was built in. The "Stake SPA for veSPA" and "Get started" stops therefore target the verified `Launch App` button on usds.sperax.io rather than a guessed dashboard element — re-pin those two once you have authenticated access to the real staking and mint/redeem pages, using the re-pinning steps above. The narration for both is already accurate against the docs sources listed.

## How @three-ws/tour handles a missing selector

This is covered by an automated test — [`tour-sdk/test/director.test.mjs`](https://github.com/nirholas/three.ws/blob/main/tour-sdk/test/director.test.mjs) — which pins the fallback chain: primary selector → secondary selector → the page's own heading/CTA → no spotlight, narrate anyway. A stop never hard-fails a tour.

## Where to go next

- **[Tour Builder](/tour-builder)** — load the template and try it yourself.
- **[3D Store Guide for Shopify](/tutorials/shopify-store-guide)** — the original no-code walkthrough this template pattern builds on.
- **[Advanced store guide](/tutorials/shopify-store-guide-advanced)** — hand-write a curriculum from scratch, multi-page tours, real spoken voices, the JavaScript API.
- **[`@three-ws/tour` on npm](https://www.npmjs.com/package/@three-ws/tour)** — the open-source engine both templates run on.
