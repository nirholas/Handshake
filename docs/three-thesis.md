# The $THREE Thesis: Why the three.ws Token Deserves a Serious Look

**Token:** `$THREE`
**Chain:** Solana (Token-2022 mint, 6 decimals)
**Contract address:** `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`
**Platform:** [three.ws](https://three.ws), open source (Apache-2.0), [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws)
**Live token page:** [/three-token](https://three.ws/three-token)
**Last revised:** 2026-08-25

> This document is a research thesis, not investment advice. Every claim below is sourced to a file in the three.ws repository or to a public listing. Where the repository is silent (supply schedule, team allocation, governance) this document says so instead of guessing. Section 14 lists every risk the platform's own documentation admits to. Read it before you read anything else.

---

## Table of contents

1. [The one-paragraph version](#1-the-one-paragraph-version)
2. [What three.ws actually is](#2-what-threews-actually-is)
3. [The scale of what has been built](#3-the-scale-of-what-has-been-built)
4. [The core argument: a token attached to a machine that earns](#4-the-core-argument-a-token-attached-to-a-machine-that-earns)
5. [Every $THREE utility and sink, in full](#5-every-three-utility-and-sink-in-full)
6. [Revenue routing: how platform income turns into $THREE demand](#6-revenue-routing-how-platform-income-turns-into-three-demand)
7. [The buy-side engines: daily buyback and the micro-buy loop](#7-the-buy-side-engines-daily-buyback-and-the-micro-buy-loop)
8. [The revenue engine underneath: x402 and the agent economy](#8-the-revenue-engine-underneath-x402-and-the-agent-economy)
9. [The self-funding treasury and its zero-leak record](#9-the-self-funding-treasury-and-its-zero-leak-record)
10. [Distribution, listings, and verification](#10-distribution-listings-and-verification)
11. [Ecosystem, partners, and enterprise surfaces](#11-ecosystem-partners-and-enterprise-surfaces)
12. [Why the narrative fits the moment](#12-why-the-narrative-fits-the-moment)
13. [Roadmap and the catalysts still in front of the token](#13-roadmap-and-the-catalysts-still-in-front-of-the-token)
14. [Risks, caveats, and what the repo admits about itself](#14-risks-caveats-and-what-the-repo-admits-about-itself)
15. [What is not documented (and what a diligent holder should ask)](#15-what-is-not-documented-and-what-a-diligent-holder-should-ask)
16. [How to evaluate the thesis over time](#16-how-to-evaluate-the-thesis-over-time)
17. [Summary of the bull case](#17-summary-of-the-bull-case)
18. [Appendix: source index](#18-appendix-source-index)

---

## 1. The one-paragraph version

Most tokens are a story looking for a product. $THREE is the reverse: it is the coin of a shipping, open-source, revenue-generating platform that gives AI agents a 3D body, an on-chain identity, a wallet, and a way to get paid. The platform (three.ws) has published 2,738 changelog entries in about four and a half months, exposes 761 public pages, ships 89 npm packages and 39 MCP servers, and runs a live pay-per-call economy (x402) with over one million individually priced datapoints. The token is wired into that machine at every level: hold-to-access tiers create standing demand, a 20% discount on plans and premium passes creates spend demand, a policy that commits 50% of platform revenue to market buybacks creates buy-side pressure, a micro-buy loop turns every settled x402 call into a small $THREE purchase, and on-chain agent deploys route their fee to the buyback wallet. Supply is never destroyed by the platform; instead the treasury buys. The token trades on MEXC, LBank, KCEX, Bybit Alpha, KuCoin Alpha, and every major Solana DEX, is Jupiter-verified, Phantom-verified, and a verified project on pump.fun. It is a real product's real coin, and the product is one of the more complete agent-economy stacks in the open-source world.

The thesis is not "number go up." The thesis is: **if agents become economic actors, they need bodies, identities, wallets, and rails, and three.ws has shipped all four with $THREE in the middle.**

---

## 2. What three.ws actually is

The tagline is "Give your AI a body." The platform does five things (README, "core functions"):

1. **Generate.** Text, up to six photos, or a sketch becomes a textured GLB model through the Forge pipeline. There is a free draft tier that requires no account. Paid tiers unlock high-quality generation (200k polygons plus PBR materials) and game-ready export (Unity and Unreal retopology).
2. **Render.** glTF 2.0 and GLB in WebGL 2.0 on three.js r184, with Draco, KTX2, and Meshopt compression, and zero server-side processing on the render path.
3. **Embody.** An LLM brain (Claude), a tool loop of up to eight iterations per turn, morph-target emotion blending, and ARKit-52 lip-sync. The avatar does not just look alive; it acts.
4. **Register.** On-chain identity via ERC-8004 on any EVM chain, or a Metaplex Core NFT on Solana. Agents get a provable, portable identity.
5. **Embed.** An `<agent-3d>` web component plus five widget types and OpenGraph / oEmbed support, so any site can host a live avatar.

On top of those five, the platform layers an entire agent economy:

- **Custodial agent wallets** (Solana plus EVM keypair per agent, AES-256-GCM at rest, HKDF-derived keys) with a single spend-policy module that every one of five spend paths passes through at the signing boundary.
- **x402 pay-per-call endpoints** settling USDC on Solana (primary, self-hosted facilitator), USDC on Base, and a BSC leg, with an optional $THREE accept entry.
- **A skill and asset marketplace** priced only in $THREE.
- **An agent labor market** with $THREE escrow and skill-author royalties.
- **Agora**, a persistent agent-plus-human economy where bounties escrow in $THREE by default.
- **USDC agent vaults**, where strangers can back a verified trading agent.
- **Coin launches** where every mint address launched through three.ws starts with `3ws`, a tamper-evident brand mark ground into the keypair itself.
- **Trust primitives** (cross-chain agent reputation and on-chain identity verification) that outside agents pay to query.
- **A multiplayer world (`/play`)** with a strictly separated in-game currency and a $THREE cosmetics boutique.
- **An MCP endpoint** at `https://three.ws/api/mcp` behind a full OAuth 2.1 authorization server, so any MCP-capable AI client can drive the platform.

Infrastructure: a single Google Cloud Run container serves the frontend, the route table, and every API handler; Neon Postgres, Cloudflare R2, and Upstash Redis behind it; a self-hosted Cloud Run GPU fleet (L4s plus one RTX PRO 6000 Blackwell) for text-to-3D, rigging, and motion; 110 Cloud Scheduler crons (the `crons` array in `vercel.json`) keep the economy ticking.

The point of listing all of this: **$THREE is not attached to a landing page.** It is attached to a system with dozens of live, wired, money-moving surfaces.

---

## 3. The scale of what has been built

Numbers measured directly from the repository on 2026-09-01 (the external figures, such as GitHub, npm downloads, registry counts, and settlement totals, are as of 2026-08-25):

| Dimension | Figure |
|---|---|
| Public pages (`data/pages.json`) | **761** across 10 sections (Crypto 137, Build 69, Learn 397, Main 56, Labs 22, Blog 39, and more) |
| Changelog entries (`data/changelog.json`) | **2,738**, dated 2026-04-15 to 2026-09-01 |
| Changelog tag mix | fix 1,219 · improvement 1,107 · feature 1,016 · infra 330 · docs 234 · security 218 · sdk 182 |
| npm packages published under @three-ws | **101** (42 of them MCP servers, 6,225 downloads in the last 30 days); 89 live under `packages/` in this repo |
| Root `package.json` | 277 scripts, 142 dependencies, version 1.5.2 |
| MCP servers in the official registry | **72** under `io.github.nirholas` (including `three-token-mcp`, `threews-3d-studio`, `threews-pumpfun`, `x402-mcp`, `agora-mcp`, `metaplex-agent`) |
| Docs mentioning $THREE | 89 markdown files |
| Cloud Scheduler crons | 110 |
| Crypto news archive | **660,000+ articles** from September 2017 onward, 192 publisher feeds in 18 languages |
| DeFi pools indexed | ~15,000 live pools |
| Individually priced x402 datapoints | **1,000,000+** at $0.0005 each |
| Priced x402 endpoints in the live discovery catalog | **4,519** |
| x402 settlements through the self-hosted facilitator | **110,416** on-chain, plus 803,483 payment verifications |
| Validator attestations and custody proofs on Solana | **3,000** attestations, 126,522 custody proofs across 244 epochs |
| GitHub | 104 stars, 26 forks, 21 contributors, 60 pull requests, 9,508 commits; 111 related open-source repos with 1,222 stars between them |
| ERC-8004 registries | live at one CREATE2 address on **12 EVM mainnets** |

The changelog cadence matters more than any single number. 2,673 holder-readable entries in roughly 130 days is about twenty shipped changes per day, every day, with 216 of them tagged security. This is what a team that is actually building looks like. The changelog is public at [three.ws/changelog](https://three.ws/changelog), with RSS and JSON feeds, and every entry is pushed automatically to the holders' Telegram channel (@three_ws) by a cron that diffs the feed against database state. Holders do not have to wonder whether development continues; it is announced to them twenty times a day.

The codebase is also **open source under Apache-2.0**. Anyone can verify every claim in this document by reading the code. A token whose mechanics can be audited by reading a public repo is a fundamentally different asset from a token whose mechanics live in a whitepaper.

---

## 4. The core argument: a token attached to a machine that earns

Strip away the feature list and the argument for $THREE reduces to four linked claims:

**Claim 1: The platform earns money.** It sells 3D generation, rigging, remeshing, voice cloning, agent embodiment, coin launches, vanity addresses, data intelligence, DeFi analytics, market data, reputation scoring, identity verification, and over a million priced datapoints, all through x402 pay-per-call rails, plus subscription plans (Pro, Team, Enterprise), a Premium Data API pass, and marketplace fees. The customers include humans, but increasingly the customers are other AI agents that pay USDC to call an endpoint without a human in the loop.

**Claim 2: A published policy routes that money into $THREE.** The economy policy in `api/_lib/token/config.js` states: every $THREE the platform charges routes to treasury, a holder-rewards pool, and (on a sale) the seller. Supply is never destroyed; the treasury funds buybacks instead. Separately, `THREE_BUYBACK_COMMIT_BPS` defaults to 5,000: **50% of platform revenue committed to market buybacks**, with the code comment explaining the team chose the conservative floor of the credible 50 to 80% band "so the platform over-delivers rather than over-promises."

**Claim 3: Holding the token is rewarded, not just spending it.** The hold-to-access tier ladder (Bronze at $25 held through Genesis at $2,500 held) grants compute discounts up to 30% and free-quota multipliers up to 10x, resolved from live USD value of tokens *held, never spent*. The documentation calls this "a deflation-free status lever that creates standing demand rather than one-time spend." Rider passes, holder worlds, token-gated embeds, `/play` access, Coin Clash enlistment, and the metaplex deploy-fee waiver all read live balances the same way.

**Claim 4: Spending the token is cheaper than spending anything else.** Plans are 20% off in $THREE. Premium Data API passes are 20% off in $THREE. The marketplace prices only in $THREE. The labor market escrows only in $THREE. Agora bounties escrow in $THREE by default. Game cosmetics and paid wheel spins are $THREE-only. The documentation says it outright: "the platform coin is always the cheapest way in."

Put together: demand comes from three directions at once (hold, spend, and treasury buy), the platform never sells, and the platform never burns. That is a coherent monetary design, and it is unusually well-specified in code rather than in marketing copy.

---

## 5. Every $THREE utility and sink, in full

This section is deliberately exhaustive. Each item names the mechanism, the numbers, and where in the repository it lives.

### 5.1 Hold-to-access tiers

Source of truth: `api/_lib/three-tier.js`; documentation: `docs/hold-to-access.md`.

| Level | Tier | Hold (USD value) | Compute discount | Free-quota multiplier |
|---:|---|---:|---:|---:|
| 0 | Member | $0 | none | 1x |
| 1 | Bronze | $25 | 5% | 2x |
| 2 | Silver | $100 | 10% | 3x |
| 3 | Gold | $500 | 20% | 5x |
| 4 | Genesis | $2,500 | 30% | 10x |

How it works under the hood:

- Three resolvers: a pure `tierForUsd(usd)`, an RPC-plus-price `resolveUserTier(user)`, and a pure HMAC `verifyTierPass(token)` with zero latency.
- **Signed tier passes.** A holder's `{wallet, level, usd}` is sealed into a 10-minute HMAC token. Edge services and the Colyseus multiplayer server gate on the pass alone, so an RPC or price-feed outage never wrongly locks a holder out.
- The enforcement keystone is `requireFeatureAccess()` in `api/_lib/require-three.js`. Resolution order: comped account, then tier pass, then on-chain session tier, then anonymous Member. Every failure degrades gracefully to Member and returns a clean 402, never a 500.
- A blocked request returns a structured `402 three_hold_required` payload carrying `held`, `required`, `usd_to_go`, an `acquire` block with the mint, symbol, swap URL, and pump.fun URL, and a `pay_per_use` alternative. One round trip tells the user exactly how far they are from the next tier and how to close the gap.
- The compute discount is applied to every fixed-price action via `discountBps` in `api/pricing.js`. The free-quota multiplier lifts the anonymous free-generation ceiling via `rateMultiplier` in `api/forge.js`. Both are live and not feature-gated.

### 5.2 The perk registry with an integrity flag

`api/_lib/three-access.js` keeps a registry where each perk carries an `enforced` boolean. The documentation's stated purpose: "so the platform never promises an unwired perk." That honesty is itself a feature of the token design.

| Feature | Minimum tier | Status | Pay-per-use fallback |
|---|---|---|---|
| `forge.high` (200k poly + PBR generation) | Bronze | **Live** | yes |
| `forge.gameready` (Unity/Unreal export) | Bronze | **Live** | yes |
| `worlds.private` | Silver | Planned (spec written, migration drafted) | no |
| `mcp.priority` | Silver | Planned | no |
| `worlds.branded` | Gold | Planned | no |
| `drops.early` | Gold | Planned (drop endpoints exist) | no |
| `names.first_dibs` (rare `*.threews.sol`) | Genesis | Planned (SNS exists) | `name.auction` |

Activation order per `docs/hold-to-access.md`: `worlds.private` first, then `names.first_dibs`, then `drops.early`, with `mcp.priority` and `worlds.branded` deferred until a backend exists. Every one of these is a future catalyst for standing demand at a specific tier.

### 5.3 Pay-in-$THREE discounts on plans and passes

- **Paid plans** (`docs/plan-checkout.md`): Pro, Team, and Enterprise are payable in USDC at 1:1, SOL at live rate, or **$THREE at a 20% discount** (`THREE_PLAN_DISCOUNT_BPS` default 2,000, capped at 5,000). Pro at $49 becomes $39.20 in $THREE. Quotes are live-priced, pin the exact on-chain amount, expire in 10 minutes, are memo-nonce bound, settle at `finalized` commitment, and are protected by a unique index on `tx_hash`.
- **Premium Data API pass** (`docs/premium.md`): Developer $19.99 (about $15.99 in $THREE) at 120 requests per minute; Pro $99 (about $79.20) at 600 per minute; Enterprise $499 (about $399.20) at 2,000 per minute. Thirty days each. This is the gateway to the 660,000-article crypto news archive.
- **Credits top-up** accepts SOL and THREE (`api/credits/index.js`).

### 5.4 Hold-to-discount on on-chain agent deploys

From `packages/metaplex-agent-mcp/README.md`:

| $THREE in the paying wallet | Mainnet deploy fee |
|---|---|
| under 50,000 | 0.02 SOL |
| 50,000 or more | 0.01 SOL |
| 250,000 or more | **free** |

The fee rides inside the same transaction that creates the asset, so a failed deploy costs nothing. It is disclosed before signature. Critically, **the fee is paid to the wallet the $THREE buyback lane spends from**, which means every on-chain agent deploy is converted into $THREE buy pressure. Nothing is staked or locked; the balance is read live at transaction-build time. A `three_status` MCP tool prices a deploy for any wallet and returns live market and buyback figures. Changelog, 2026-08-19: "Deploying an agent on-chain now buys $THREE, and holders deploy free."

### 5.5 The marketplace prices only in $THREE

`docs/viability.md`: `currency_mint = THREE_TOKEN_MINT`, chain Solana, GMV denominated in whole $THREE at 6 decimals. Skills list in the 80 to 1,200 $THREE band, assets in the 600 to 4,000 band (`docs/circulation-engine.md`). The platform fee (`MARKETPLACE_PLATFORM_FEE_BPS`) defaults to 0% with a 10% cap, is deducted from the listed price so the buyer is never marked up, and settles in the same signature.

### 5.6 Agent labor market with $THREE escrow

`docs/labor-market.md`, live at `/labor-market`. A poster escrows the $THREE reward into a dedicated platform escrow wallet. On pass: worker payout, a 10% skill-author royalty (`LABOR_SKILL_ROYALTY_BPS`, capped at 50%), and any auction surplus back to the poster. On fail: full refund. Settlement is idempotent by `settle_key`.

### 5.7 Agora: earn $THREE by working

`docs/agora.md` and `packages/agora-mcp/README.md`. A persistent agent-plus-human economy built on AgenC. The loop is register, board, claim, work, complete with proof, earn $THREE. On mainnet, bounties escrow in the $THREE mint by default. This is the token as wages, not just as a fee.

### 5.8 The in-game economy at `/play`

`docs/in-game-economy.md`. Two strictly separated currencies: **Cash** (a pure game resource, never on-chain) and **$THREE** (on-chain, from the player's connected wallet). $THREE is never awarded by gameplay and cosmetics bought with it are visual only, so there is no pay-to-win and no inflationary emission.

- **The $THREE Boutique** sells premium wardrobe cosmetics. Prices are server-set (the client price is never trusted), one split transaction, the server re-fetches the confirmed transaction from RPC and checks destination and amount, and a Redis-backed settlement guard consumes both the quote nonce and the signature so one payment grants exactly one item across every world and restart.
- **Wheel of Fortune ("Fortune's Folly")**: one free spin per 12 hours, or $3 worth of $THREE per paid spin, twenty wedges at equal odds, gated at average skill level 3.
- **Every paid $THREE sale and paid spin splits 50% to the holder-rewards sink and 50% to treasury.**

### 5.9 Token-gated 3D embeds

`docs/token-gated-3d-embeds.md`. `POST /api/embed/gate-create` (or the MCP tool `create_gated_embed`) with `{ minAmount, chain: 'solana' }`; **omitting `mint` defaults to $THREE**. Proof is server-side only: a SIWS-signed single-use expiring nonce plus a live `getTokenAccountsByOwner` balance read; an HMAC access token scoped to gate, asset, and wallet with a 10-minute TTL; `gate-verify` rate-limited per IP and per wallet. Below the bar, the viewer sees a designed locked teaser: "Hold {min_amount} {symbol} to unlock." Raising the requirement invalidates every prior token immediately. Any creator on the internet can now make their 3D content a $THREE holder perk.

### 5.10 Holder worlds and coin communities

- `HOLDER_MIN_USD` defaults to $8, the USD floor to enter a coin's holder world (`api/_lib/holder-pass.js`). Passes are 10-minute HMAC tokens verified byte-for-byte by the Colyseus server.
- `/play` gate: `PLAY_GATE_MINT` falls back to the $THREE mint, `PLAY_GATE_MIN` defaults to one whole token (`api/_lib/play-pass.js`).
- **Coin Clash** (`docs/clash.md`): enlistment gated on a live on-chain holding, described as "an early demo of a bigger community-warfare idea the platform is building for $THREE."

### 5.11 The Rider pass

`api/_lib/rider.js`: `REQUIRED_AMOUNT = 8000` $THREE. Granted two ways: by holding, or by paying 8,000 $THREE into the rider vault (recorded by a Helius webhook), so a payer who later sells is not revoked. Both sources are honored by `GET /api/rider/check`. The verdict is cached per wallet for ten minutes whenever both sources answered, so an RPC outage mid-session returns the wallet's last verdict marked stale (`x-rider-stale: 1`) instead of refusing the gate; a wallet never checked before gets a typed `503 rpc_unavailable` with `Retry-After`.

### 5.12 x402 rail acceptance

`X402_ACCEPT_THREE_SOLANA` advertises $THREE alongside USDC as a second accept entry on the same 402 challenge (`docs/x402-endpoints.md`). Agents paying for services can pay in the platform's own coin.

### 5.13 One-signature spend allowances

`src/three-allowance.js`: a holder authorizes a $THREE spending cap once, via Solana's native Subscriptions and Allowances program. Non-custodial, tokens stay in the wallet, the cap is the hard ceiling the platform delegate can touch. This removes the per-purchase signing friction that kills micro-spend economies.

### 5.14 The user-invoked burn primitive

`packages/three-token-mcp/README.md` calls it "the first MCP server whose actions burn a token." Tools: `three_price`, `three_balance`, and `three_burn` (marked destructive). The default split is 50% to the incinerator and 50% to treasury; `burnBps = 10000` burns everything. Bounded by `MAX_BURN_USD` (default $100) and gated by `REQUIRE_CONFIRM` (default on). The mint is asserted canonical before signing so a compromised endpoint cannot redirect the burn, and destinations are read at runtime from `/api/token/config`, never hardcoded. Note the distinction: the **platform** never burns; **users and their agents** can choose to.

### 5.15 Circulation engine demand

`docs/circulation-engine.md`. A pool of real platform-owned agents with custodial wallets runs real actions through the same code paths a user-owned agent uses: `buy_skill` (the buyer acquires $THREE via the trade engine and pays the seller in $THREE SPL), `buy_asset` (real $THREE SPL), tips and payments in real SOL, real pump.fun launches (fewer than eight per day), and real ERC-8004 registrations. `ensureThree()` sizes each $THREE purchase to the shortfall plus 8% headroom. This produces genuine on-chain $THREE buys and marketplace GMV, with the honesty constraint the doc itself states: manufactured demand only reaches platform-owned sellers, never user wallets, so nothing leaves the loop as a payout. It is real money and real buys; it is not third-party demand, and the platform says so.

---

## 6. Revenue routing: how platform income turns into $THREE demand

`api/_lib/token/config.js` defines the split policies. Every basis-point set sums to 10,000 and the rounding remainder goes to the highest leg so per-leg atomics reconcile exactly.

| Policy | Applies to | Seller / creator | Treasury (funds buybacks) | Rewards (holder reflections) |
|---|---|---:|---:|---:|
| `consumption` | Forge paid tiers, voice clone, MCP-3D, Granite, selfie-to-avatar | none | **70%** | **30%** |
| `spin` | paid wheel spins | none | **50%** | **50%** |
| `marketplace_sale` | skills, animations, avatars, assets, collectible resales | **90%** | 5% | 5% |
| `scarcity_mint` | scarcity drops, rare-name auctions, pay-to-mint | none | **80%** | **20%** |
| `copy_performance_fee` | copy-trading fee on realized profit only | leader **80%** | 15% | 5% |

Two things to notice. First, the treasury leg is explicitly "funds buybacks," so consumption revenue in $THREE is recycled into market demand rather than sitting idle. Second, the rewards leg funds holder reflections: the public `GET /api/three-token/revenue-share` endpoint exposes `revenue_share_pool_pct` (currently 10), `revenue_share_pool_usd`, and `per_token_yield` alongside price, supply, and holder count.

The wallets fail closed in production. If `THREE_TREASURY_WALLET` or `THREE_REWARDS_WALLET` is unset, the platform returns a typed 503 rather than routing real funds to a placeholder. Nobody's money goes to a default address by accident.

---

## 7. The buy-side engines: daily buyback and the micro-buy loop

### 7.1 The daily buyback (`api/_lib/token/buyback.js`)

- Converts accumulated platform USDC revenue into market buys of $THREE on Jupiter, then routes the bought tokens to the treasury. The code states plainly: "NO platform burn: supply is never destroyed by this lane."
- **Published commitment: 50% of platform revenue** (`THREE_BUYBACK_COMMIT_BPS` default 5,000).
- Per-run maximum $250 (`THREE_BUYBACK_MAX_USD`), dust floor $10, slippage 3%.
- Custody and accounting are deliberately decoupled: the spend is driven by the buyback wallet's live USDC balance, while the public "revenue earned" figure reads the `agent_revenue_events` fee ledger. This keeps the earned-versus-deployed ratio honest and auditable.
- Execution is gated by `THREE_BUYBACK_ENABLED`. Until an operator funds the wallet and opts in, a scheduled run is a recorded no-op. (See risk 4 in section 14.)

### 7.2 The micro-buy loop (`docs/three-microbuy.md`)

| | Daily buyback | Micro-buy loop |
|---|---|---|
| Cadence | a few large buys per day | many tiny buys per minute (target ~60/min) |
| Ticket | $10 to $250 | ~$0.01 |
| Trigger | scheduled cron | a settled x402 call |
| Direction | buy-only | buy-only |

"Neither ever sells $THREE." Each micro-buy is triggered by a paid x402 call to `/api/x402/three-buy` (a $0.001 toll that goes to the ring treasury), after which the endpoint executes exactly one USDC-to-$THREE Jupiter market buy from a dedicated micro-buy wallet. Bought tokens sweep to the treasury every 30 ticks.

Safety design: off by default; a $50 daily cap reserved atomically in Redis before any broadcast; a fail-closed `cap_unverifiable` state if neither Redis nor the ledger can confirm today's spend; a fail-closed toll so a direct payer can never amplify past the cap; `three-buy` is marked `autobuy: false` in the ring catalog so generic rotation never fires real buys; an immutable row per call in `three_microbuy_runs`; and a 0 to 255 atomic jitter per buy so byte-identical Jupiter transactions never collide on signature.

Public accountability: `/api/three-token/stats` exposes `token.microbuy` with lifetime and today's buys, $THREE bought, USDC deployed, and cap used. Anyone can check whether the loop is running and how much it has bought.

### 7.3 Why "buyback, never burn" is the right design

Burn-based tokenomics look good on a slide and bad in a treasury. A burn permanently converts revenue into nothing; a buyback converts revenue into an asset the platform still controls, which can fund liquidity, reflections, holder rewards, or future buybacks. The three.ws policy chooses buy pressure without deflation and says so in code. The user-invoked burn remains available for anyone who wants deflation on their own terms.

### 7.4 External buyback precedent

On 2026-06-08, three.ws won the DEXTools Social Boost. DEXTools executed a **$5,543 buyback** and its wallet subsequently held **2.47M $THREE** (`blog/three-ws-dextools-social-boost-buyback.html`). Third-party capital has already been deployed into the token on the strength of the community.

---

## 8. The revenue engine underneath: x402 and the agent economy

The buyback and micro-buy engines are only as strong as the revenue behind them. This is what feeds them.

### 8.1 The x402 price catalog (`docs/x402-endpoints.md`)

All defaults, all overridable per endpoint via `X402_PRICE_<SLUG>`:

- Intelligence: `token-intel`, `crypto-intel`, `three-intel` at $0.01; `fact-check` at $0.10
- DeFi composites: `defi-radar`, `yield-scan`, `stablecoin-health` at $0.005; `market-pulse` at $0.005
- Market data: about 17 `market-*` endpoints at $0.001
- Trust: `agent-reputation` $0.01; `onchain-identity-verify` $0.005; `pump-agent-audit` $0.02
- 3D and agents: `embody` $1.00; `pipeline-rig` $0.05; `pipeline-remesh`, `gameready`, `stylize` $0.03; `remix-asset` $0.25 with a creator royalty of up to 20% on-chain
- Launch and vanity: `pump-launch` $5.00; vanity addresses $0.01 to $0.50 for 3 characters or fewer, $2.50 to $10 for 4 to 5, premium $1 to $50 by rarity
- Micro: `billboard` $0.05, `tutor` $0.01 per answer, `llm-proxy` $0.005, `club-cover` $0.01, `dance-tip`, `three-buy`, `pay-by-name`, `notify` at $0.001
- **The datapoint fabric**: `/api/x402/d/<family>/...` exposes over one million individually priced datapoints at $0.0005 each

### 8.2 Money routing on those endpoints (`docs/money-map.md`)

Generic x402 endpoints route 100% to the platform. Creator-facing endpoints route 0% to the platform: `skill-call`, `service`, `asset-download`, `animation-download`, and `pay-by-name` pay the author or creator directly via `payTo` override; `cosmetic-purchase` gives creators 50% (cap 90%); `dance-tip` gives 100% to the dancer. The platform takes its cut where it does the work and passes through where a creator does.

### 8.3 The autonomous x402 loop (`docs/autonomous-x402.md`)

The platform pays real USDC to call its own and bazaar-discovered endpoints on a cadence, feeding the sniper oracle and keeping the rails exercised. A daily USDC spend cap is enforced and every call is logged to `x402_autonomous_log`. The documentation is explicit: "Payments are real on chain, no mocks, no simulations."

### 8.4 The agent economy volume ledger

`/agent-economy-volume` publishes all-time USDC settled between agents from `agent_hires`, counted only where `status = 'completed'`, meaning the USDC settled on-chain and the signature is on file. Public, unauthenticated, cached for 15 to 30 seconds. The doc notes that an empty ledger returns "a real zero shape": the platform would rather show zero than show a fabricated number.

### 8.5 Trust primitives: why an outside agent pays us (`docs/trust-primitives.md`)

- **`agent-reputation`** ($0.01 per call): a cross-chain 0 to 100 score for a Solana wallet, SPL or pump.fun mint, EVM address, ERC-8004 id, or three.ws agent. Deterministic, available-weighted across six dimensions (activity, age, counterparties, holdings, reliability, attestations), with unreadable dimensions surfaced as explicit caveats rather than silently zeroed. Batch mode handles up to 25 subjects, plus fleet-wide sweep, leaderboard, and decay-report modes.
- **`onchain-identity-verify`** ($0.005 per call): verifies an identity-to-address claim across ENS, SNS, EVM deployer and owner, SPL mint and freeze authority, Metaplex update authority, ERC-8004 `ownerOf` and `getAgentWallet`, and the three.ws index. Three-valued verdict (`true`, `false`, `"unverifiable"`), "never a false positive."

The stated moat: "Competing reputation endpoints only know agents minted on their own platform, useless the moment the counterparty is from somewhere else." Cross-chain trust data is a product every agent economy will need and few will build.

### 8.6 USDC agent vaults (`docs/vaults.md`)

Strangers stake USDC behind a verified trading agent. The opening gate is real: at least 12 closed trades, net-positive realized P&L, at least 5 distinct coins, churn share at most 40%. Terms: performance fee 0 to 50% (default 10%) charged only on a backer's realized gain at redemption; max drawdown 1 to 90% (default 25%); required per-trade and daily budgets. A fresh keypair per vault, AES-256-GCM at rest, every decrypt audit-logged; exact BigInt accounting; NAV re-derived on every read; later deposits priced against pre-deposit NAV so nobody is diluted; seven ordered guards run before the key is decrypted; a share-price drawdown breaker with a ratcheting high-water mark; and a fully public audit ledger written before funds move. The documented example trade buys the $THREE mint.

---

## 9. The self-funding treasury and its zero-leak record

`docs/autonomous-economy.md` and `docs/money-map.md` describe a closed-loop wallet system:

| Wallet | Role |
|---|---|
| Funding root (`WwwuGbqHrwF5...T3WwW`) | Reserve; funder only; never trades, launches, or settles |
| Engine wallet (`wwwqv...HGUn`) | pump.fun launcher, buyback relayer, reflection and lottery payouts |
| Treasury / receiver (`wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU`) | All inbound x402 |
| Ring payer (`X4o2...astML`) | The autonomous x402 payment ring |
| a2a-payer (`Huch...Lmh6Z`) | Co-signs agent-to-agent USDC |
| Fee-payer (`GGf9...5XQj`) | Network fees on x402 settlements |

The loop is root to engines to work to surplus to root. A `treasury-topup` cron runs every 30 minutes; surplus above operating float sweeps back. Two rules are enforced in code, not convention: **top-up is allowlist-locked** to the `SOLANA_SIGNERS` registry, and **sweepback is destination-locked** to the funding root. "Money can only move inside the set of wallets the platform owns."

The system audits itself. A `wallets-leak-scan` runs every 15 minutes, an `x402-ring-leak-scan` every 10 minutes, and an `economy-reconcile` every 30 minutes. **As of 2026-07-12 the scanners had examined 44,122 transactions across every wallet and found zero leaks, ever.** The figure is not a frozen marketing number; it is re-derivable from `wallet_scan_cursor.scanned_total` and `.leaks_total` at any time.

For a token holder this matters in a specific way: the treasury that is supposed to buy $THREE is protected by machinery designed to make it impossible for funds to leave the platform's own wallet set without a recorded verdict.

---

## 10. Distribution, listings, and verification

A token can have perfect mechanics and no liquidity. $THREE has both real venues and real trust badges.

### 10.1 Centralized exchanges

| Venue | Status | Notes |
|---|---|---|
| **MEXC** spot THREE/USDT | Live since 2026-06-02 | Confirmed via MEXC exchange info: contract address, full name "three.ws", spot trading allowed. Roughly $56.5k 24h quote volume at time of the August review. |
| **LBank** THREE/USDT | Live | $600,824 in 24h volume on 2026-08-16 per CoinGecko |
| **KCEX** THREE/USDT | Live | Tracked by CoinGecko |
| **Bybit Alpha** | Live | Official announcement |
| **KuCoin Alpha** | Live | Official announcement |
| **Binance Web3** (web3.binance.com) | Live | Wallet aggregator |
| **Coinbase** | Listed (2026-05-05) | Visible in Coinbase Wallet |

### 10.2 Solana DEX liquidity (CoinGecko-tracked, 24h USD volume on 2026-08-16)

PumpSwap three/SOL $48,861 · Meteora three/SOL $18,130 · Orca three/SOL $13,445 · a second Meteora pool. GeckoTerminal pool: `5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z`.

### 10.3 Derivatives

**derp.trade** offers leverage on $THREE. A perpetuals market is a meaningful maturity signal for a Solana token.

### 10.4 Trust badges and data aggregators

- **Jupiter Verified** (the default Solana swap router's trust list)
- **Phantom Verified** (the default Solana wallet's trust list)
- **fomo** (fomo.family) in-app verification, which matters mostly as protection against lookalike mints
- **pump.fun verified project** badge on the coin page, plus a pump.fun-published feature article, "Three Builds With Tech Giants," on the official coin page. The platform reads pump.fun's verification status live on every request to `/api/three-token/stats` rather than hardcoding it; the same shared badge component renders on `/three-token` and the dashboard so the two can never disagree. The copy is deliberately precise: "verified project," not partner, endorsement, or investment.
- **CoinGecko** (id `three-ws`) and **CoinMarketCap** (live since 2026-05-17, with a community profile)
- **Investing.com**
- **DEXTools** (Social Boost winner)

### 10.5 The August 2026 listing update

`docs/coingecko-listing-update-2026-08.md` documents a disciplined sweep. The team confirmed the MEXC market through the exchange's own API and submitted it to CoinGecko (request CU1608260002, filed 2026-08-16). It swept nineteen other exchanges and confirmed no market on each, traced a WEEX rumor to SEO pages and declined to submit it, and explained why Alpha venues cannot be submitted under their parent exchanges without misstating where liquidity sits. That is the same honesty discipline that shows up in the codebase, applied to listings.

Official channels: X `@trythreews`, Telegram `@three_ws` and community `t.me/three_ws_community`.

---

## 11. Ecosystem, partners, and enterprise surfaces

The pump.fun article title ("Three Builds With Tech Giants") is earned. From `docs/listings.md` and `docs/partners.md`:

**Named program statuses (the only two the platform claims):**
- **OpenAI Select Partner**
- **NVIDIA Inception member** (2026-07), with a self-hosted Cloud Run GPU fleet (L4s plus an RTX PRO 6000 Blackwell) behind text-to-3D, rigging, and motion, surfaced at `/nvidia`

**Cloud marketplaces:**
- **Alibaba Cloud International Marketplace**: live, with a product listing, storefront, and an editorial blog feature
- **AWS Marketplace**: integration built, deployed, and conformant with the Concurrent Agreements rules AWS made mandatory 2026-06-01; the product listing itself is not yet created in the management portal
- **Google Cloud Marketplace**: open to partnership; production already runs on Cloud Run, and three.ws is a Google Cloud for Web3 Startups member with a grant of up to $200k in credits over two years
- **Azure Marketplace**: roadmap only

**Infrastructure and credits:** Quicknode Startup Program (accepted 2026-07), Google Cloud for Web3 Startups, NVIDIA Inception.

**Directories and registries:** BNB Chain Dappbay (live, categories AI Agent Launchpad, AI Data, AI Infra); x402scan; the MCP Registry (`io.github.nirholas`); VS Code Marketplace and Open VSX (`threews.vscode-x402`); OpenAI Plugin Directory (gating requirement already met via the public OAuth 2.1 MCP server); OpenAI Cookbook PR #2874 submitted 2026-07-21 (unmerged).

**Media:** IBM Community blog, HackerNoon (auto-imported from the three.ws announcements RSS), Alibaba Cloud Marketplace Blog, pump.fun coin-page article.

**Partner cards on `/partners` (eight):** OpenAI, IBM, AWS, Google Cloud, Alibaba Cloud, NVIDIA, HackerNoon, Quicknode. The partner doc itself draws the boundary: no endorsement is claimed anywhere, and only the two program statuses above come from the partner side.

**OKX:** three.ws is agent #2632 "three.ws 3D Studio" on OKX.AI with A2MCP endpoints. The listing was rejected in review on 2026-07-04 for not yet matching the OKX Agent Payments Protocol standard; resubmission is pending. The endpoints are reachable directly meanwhile.

**MetaMask:** SIWE sign-in, MetaMask and Consensys named as ERC-8004 co-authors, and MetaMask Agent Wallet early access listed among distribution posts.

What this adds up to: a Solana memecoin-launched token whose platform has a foothold in the OpenAI, NVIDIA, Google, AWS, Alibaba, IBM, and BNB ecosystems. That combination is rare.

---

## 12. Why the narrative fits the moment

Three converging trends make three.ws the right shape of product for 2026:

**1. Agents are becoming economic actors.** x402 (HTTP 402 pay-per-call) has moved from proposal to production. Agents now pay for data, compute, and services without a human clicking approve. three.ws is on both sides of that trade: it sells services to agents and its own agents buy from others. Its self-hosted Solana facilitator means it does not depend on a third party to settle.

**2. Agents need identity and trust.** ERC-8004 (co-authored by MetaMask and Consensys) and Metaplex Core give agents portable on-chain identities. three.ws registers on both, and sells the cross-chain reputation and identity-verification primitives that let strangers decide whether to transact. This is the credit-bureau layer of the agent economy, and it is priced at a penny a call.

**3. Agents need bodies.** Text chat is not the end state of AI interaction. Voice, expression, and presence are. three.ws's core competence, rigged and animated 3D avatars with emotion blending and lip-sync that any site can embed, is the interface layer. The pipeline runs on its own GPU fleet, not a rented API.

$THREE sits at the intersection: it is the fee token, the discount token, the access token, the escrow token, the wage token, and the buyback target for a platform that does all three.

**Solana-first is a deliberate advantage.** The platform's operating rules state that Solana is the home chain and every EVM chain is secondary. Low fees and fast finality are what make $0.0005 datapoints and $0.01 micro-buys economically possible in the first place. A pay-per-call agent economy at these price points cannot run on mainnet Ethereum.

**Open source is a deliberate advantage.** Anyone can audit the split policies, the buyback logic, the cap enforcement, the leak scanners, and the tier resolvers. Trust that can be verified compounds; trust that must be taken on faith decays.

---

## 13. Roadmap and the catalysts still in front of the token

From the README roadmap:

| Phase | Theme | Status |
|---|---|---|
| 0 | Foundations: viewer, runtime, ERC-8004 and Metaplex Core identity, embed layer | Shipped |
| 1 | Selfie-to-avatar engine | Capture, reconstruction, rigging, storage, and draft mint wired end to end; likeness fidelity is the open track |
| 2 | Agent personalization and voice cloning | Voice clone, persona, and memory seeds shipped behind `/demos`; main-flow integration next |
| 3 | **On-chain economy**: agent tokens, reputation markets, royalties | Bonding-curve sim, EAS reputation viewer, 0xsplits and EAS SDKs landed; per-call skill royalties accrue in `royalty_ledger`; contracts and audits next |
| 4 | Open inference network (decentralized GPU) | Node-operator client (CPU and CUDA) and `/api/nodes` job queue with signed, server-recomputed receipts shipped; Livepeer federation behind a flag |

Token-specific catalysts, in rough order of proximity:

1. **Buyback and micro-buy activation.** Both engines are built, tested, capped, and publicly accountable via `/api/three-token/stats`. Flipping `THREE_BUYBACK_ENABLED` and `THREE_MICROBUY_ENABLED` with funded wallets turns published policy into daily on-chain buys.
2. **Perk activation.** `worlds.private` at Silver is fully specified (migration drafted, gate written, test planned). `names.first_dibs` at Genesis and `drops.early` at Gold follow. Each activation gives a specific tier a specific reason to exist.
3. **CoinGecko MEXC market addition** (request filed 2026-08-16).
4. **Listing follow-through**: AWS Marketplace product creation, OKX.AI resubmission, OpenAI Plugin Directory submission, Cookbook PR merge.
5. **Phase 3 contracts and audits**: agent tokens, reputation markets, and royalty contracts on-chain would make $THREE the settlement asset of a far larger economy.
6. **Phase 4 open inference network**: independent node operators serving production traffic would turn three.ws from a platform into a protocol.
7. **Coin Clash** expanding into "a bigger community-warfare idea the platform is building for $THREE."

Phase targets stated in the README: 10k avatars per day at launch; 1,000 test users end to end at 4/5 likeness or better; 30% week-2 retention on minted agents; 1,000 agents minted with active on-chain reputation; 50% of production agent traffic served by independent nodes.

---

## 14. Risks, caveats, and what the repo admits about itself

A thesis that hides the risks is a pitch. These are the risks the three.ws documentation states about itself, plus the structural ones any holder should weigh.

1. **Most holder perks are Planned, not Live.** Only two of seven registered gated features (`forge.high`, `forge.gameready`) are enforced today. The compute discount and quota multiplier are live. The `enforced` flag exists precisely so the platform never promises an unwired perk, but a holder buying for `worlds.private` or `names.first_dibs` is buying a roadmap.

2. **The burn policy is internally inconsistent.** `api/_lib/token/config.js` states "NO PLATFORM BURNS, supply is never destroyed," while `api/three-token/[action].js` ships an `AGENT_DEPLOY_BURN = 1000` constant and a `/burns` ledger reporting 1,000 $THREE burned per agent deploy. Blog posts from May and June 2026 describe a "planned buyback-and-burn." No document reconciles these. A holder should treat the current code policy (buyback, no platform burn) as authoritative and the deploy-burn ledger as an open question.

3. **Older blog claims predate current mechanics.** The May 2026 listing and CoinMarketCap posts describe buyback-and-burn and the Rider VR gate as the token's utility; the current code implements buyback-without-burn plus the tier ladder. The direction of travel is toward more utility, but the public record has drift.

4. **The buyback and micro-buy engines are off by default and operator-gated.** The 50% commitment is policy independent of whether any given run is enabled or funded. Until the flags are on and the wallets funded, the buy-side pressure described in section 7 is designed, tested, and dormant. The public stats endpoint will show exactly when that changes.

5. **Circulation-engine activity is platform-owned by design.** The buys are real and on-chain, but the sellers are platform agents. It is not organic third-party demand and the documentation says so explicitly.

6. **The marketplace platform fee and pump trade fee default to 0%.** The take-rate exists as a knob but is off unless configured. Marketplace GMV does not currently produce platform revenue.

7. **Several distribution milestones are pending, not done.** AWS Marketplace listing not yet created, OKX.AI rejected 2026-07-04 with resubmission pending, OpenAI Cookbook PR unmerged since 2026-07-21, Azure roadmap-only.

8. **Alpha venue liquidity is invisible to CoinGecko.** Bybit Alpha and KuCoin Alpha volume cannot be submitted, so aggregator volume understates real liquidity. This cuts both ways: the token is more liquid than CoinGecko shows, and that liquidity is harder to verify.

9. **Historical accounting corrections.** The platform has published its own mistakes: marketplace analytics once counted 10,454 free trials as "sales" and reported 6.2M $THREE of volume against zero confirmed purchases (fixed; money aggregates now gate on `status = 'confirmed'`); the circulation engine once bought too little $THREE to afford its own listings, so GMV read zero while fees went out (fixed by shortfall sizing). These are to the team's credit as disclosures, and to the holder's attention as evidence that reported metrics have needed correction before.

10. **Vault risk, in the platform's words:** "the platform can sign for the vault," "a vault owner can change the performance fee and the risk terms after you have deposited," and "there is no server-side 'are you sure' step, no preview mode, and no undo."

11. **A fail-open path exists.** The older `three-gate.js` returns `eligible: true` on an RPC failure. The newer tier-pass path fails to Member (closed). Gating that relies on the older path can be bypassed during an RPC outage.

12. **Funding is not secured.** The README states plainly that inference GPUs, training compute, multi-firm smart-contract audits, token-launch liquidity, indexer infrastructure, node-operator credits, and engineering headcount are "required for the vision; neither is funded yet." The Google Cloud credit grant (up to $200k over two years) covers a meaningful part of the compute line but not the audits or headcount.

13. **The mandatory risk disclosure applies to $THREE payments.** Before any first real-funds action, including `$THREE token payments`, users must acknowledge that "three.ws is experimental software, losses can be total, autonomous agents act without asking again." The platform requires that acknowledgment from its users; a holder should hold the same view.

14. **General token risk.** A pump.fun-launched Solana token is a high-volatility asset. Liquidity is concentrated on a handful of venues. The platform's revenue, while real, is early. The buyback commitment is a policy the operator controls, not a smart contract the operator cannot change.

---

## 15. What is not documented (and what a diligent holder should ask)

The repository is silent on the following. Their absence is a fact, not a red flag by itself, but a serious holder should seek answers from the team's official channels.

- **No supply, distribution, allocation, vesting, or emissions table.** The only supply-shaped number in the repo is an illustrative example response in `docs/api-reference.md` for the token-security endpoint: supply of about 999.68M tokens, mint authority revoked, freeze authority revoked, top-1 holder 6.6%, top-5 14.7%, top-10 22.3%, liquidity about $196.7k. Treat these as a documentation sample, not a live assertion. Live figures come from `/api/three-token/stats` and the on-chain mint.
- **No team or treasury allocation, lockups, or LP-burn statement.**
- **No governance, staking, or voting mechanism.** $THREE is a utility and access token, not a governance token, and the repo does not claim otherwise.
- **No documented emissions to users.** The in-game economy is explicit that $THREE is never awarded by gameplay. Agora and the labor market pay $THREE, but from escrow funded by posters, not from inflation.
- **No cumulative revenue, cumulative buyback USD, or holder count in the docs.** All of these are read live from public endpoints (`/api/three-token/stats`, `/revenue-share`, `/leaderboard`, `/agent-economy-volume`) rather than quoted in prose. That is the correct design, and it means the numbers in this document are a snapshot that the endpoints will outdate.

Questions worth asking: What is the treasury's current $THREE and USDC balance? How is the deploy-burn ledger reconciled with the no-platform-burn policy? What is the team's own holding and is it locked?

---

## 16. How to evaluate the thesis over time

Because the platform exposes its economy through public endpoints, the thesis is falsifiable. A holder can track it without trusting anyone:

| Signal | Where to look | What confirms the thesis |
|---|---|---|
| Buybacks are running | `GET /api/three-token/stats` (`buyback` summary) | Non-zero USDC deployed, rising lifetime $THREE bought |
| Micro-buy loop is running | same endpoint, `token.microbuy` | Today's buys greater than zero, cap-used percentage moving |
| Platform revenue is growing | `GET /api/three-token/revenue-share` (`platform_revenue_usd`) and `/agent-economy-volume` | Month-over-month growth in settled USDC |
| Holder base is growing | `GET /api/three-token/leaderboard`, `total_holders` in stats | Rising holder count, falling top-10 concentration |
| Perks are activating | `api/_lib/three-access.js` `enforced` flags | More entries flip to `true` |
| Development continues | [three.ws/changelog](https://three.ws/changelog), @three_ws Telegram | Daily entries keep landing |
| Treasury stays clean | `wallet_scan_cursor` figures cited in `docs/autonomous-economy.md` | Scanned total rising, leaks total stays zero |
| Listings expand | CoinGecko `three-ws` markets tab | MEXC added, new venues appear |
| Verification holds | `verified` field in `/api/three-token/stats` | Stays `true` |

If buybacks never turn on, perks never activate, or revenue does not grow, the thesis weakens and the endpoints will show it. If they do, the endpoints will show that too.

---

## 17. Summary of the bull case

1. **A real, shipping, open-source product** with 761 pages, 101 npm packages, 72 MCP servers in the official registry, 4,519 priced x402 endpoints with 110,416 on-chain settlements, and 2,738 changelog entries in four and a half months. The code is public and every mechanic in this document can be read. The week-by-week record is in [The First 19 Weeks](./the-first-19-weeks.md).
2. **A complete agent-economy stack**: bodies (3D avatars), identities (ERC-8004 and Metaplex Core), wallets (custodial with a single spend-policy boundary), rails (x402 with a self-hosted Solana facilitator), trust (cross-chain reputation and identity verification), and markets (skills, assets, labor, bounties, vaults).
3. **The token is wired into every layer**: hold-to-access tiers, 20% discounts on plans and passes, marketplace-only currency, labor and bounty escrow, game cosmetics, gated embeds, holder worlds, rider passes, deploy-fee waivers, x402 acceptance, and one-signature allowances.
4. **Three simultaneous demand vectors**: standing demand from holding, spend demand from discounts, and buy-side demand from a published 50%-of-revenue buyback commitment plus a per-call micro-buy loop. The platform never sells and never burns.
5. **Every deploy buys $THREE.** On-chain agent deploy fees are paid to the buyback wallet, and large holders deploy free.
6. **Real liquidity and real trust**: MEXC, LBank, KCEX, Bybit Alpha, KuCoin Alpha, Binance Web3, Coinbase Wallet, PumpSwap, Meteora, Orca, perps on derp.trade, Jupiter Verified, Phantom Verified, pump.fun verified project, CoinGecko, CoinMarketCap, a DEXTools Social Boost win with a $5,543 third-party buyback.
7. **Enterprise and ecosystem footprint**: OpenAI Select Partner, NVIDIA Inception, Google Cloud for Web3 Startups, Alibaba Cloud Marketplace live, AWS Marketplace conformant, BNB Dappbay, MCP Registry, x402scan, IBM and HackerNoon coverage, a pump.fun feature article.
8. **A treasury that audits itself**: 44,122 transactions scanned, zero leaks ever, with allowlist-locked top-ups and destination-locked sweepbacks enforced in code.
9. **A team that publishes its own mistakes** (trial-counting, under-sized buys, listing rumors it declined to submit) and gates every perk behind an integrity flag so it cannot promise what it has not wired.
10. **A narrative that matches the moment**: agents becoming economic actors need exactly what three.ws sells, on the only chain where sub-cent pricing works.

And the honest counterweight: the buy engines are dormant until switched on, most perks are still roadmap, the burn story has drift, supply and allocation are undocumented, and the platform itself tells every user that losses can be total.

$THREE is a good choice to *look at* because it is one of the very few tokens where looking is possible. The mechanics are in the code, the numbers are on public endpoints, and the risks are written down by the people who built it. Do the looking.

---

## 18. Appendix: source index

Every file referenced in this thesis, relative to the repository root:

- `README.md` (core functions, roadmap, funding needs)
- `STRUCTURE.md` (surface map, marketplace accounting correction)
- `CLAUDE.md` (promoted-coin policy, Solana-first policy)
- `package.json`, `data/pages.json`, `data/changelog.json`, `public/mcp-catalog.json`
- `api/_lib/token/config.js` (economy policy, split policies)
- `api/_lib/token/buyback.js` (daily buyback)
- `api/_lib/three-tier.js`, `api/_lib/three-access.js`, `api/_lib/require-three.js`, `api/_lib/comp-access.js`, `api/_lib/three-gate.js`
- `api/_lib/holder-pass.js`, `api/_lib/world-gate.js`, `api/_lib/play-pass.js`, `api/_lib/rider.js`
- `api/_lib/economy-master.js`, `api/_lib/economy-sweepback.js`
- `api/three-token/[action].js`, `api/pricing.js`, `api/forge.js`, `api/credits/index.js`
- `src/three-access.js`, `src/three-lock.js`, `src/three-allowance.js`, `src/pump/verified-badge.js`, `src/solana/vanity/brand.js`
- `docs/hold-to-access.md`, `docs/plan-checkout.md`, `docs/premium.md`, `docs/viability.md`, `docs/money-map.md`
- `docs/circulation-engine.md`, `docs/three-microbuy.md`, `docs/autonomous-economy.md`, `docs/autonomous-x402.md`, `docs/x402-endpoints.md`, `docs/agent-economy-volume.md`
- `docs/labor-market.md`, `docs/agora.md`, `docs/in-game-economy.md`, `docs/token-gated-3d-embeds.md`, `docs/clash.md`, `docs/vaults.md`, `docs/trust-primitives.md`
- `docs/coin-launches.md`, `docs/mint-mark.md`, `docs/agent-wallets.md`, `docs/risk-acknowledgment.md`, `docs/exit-lab.md`
- `docs/listings.md`, `docs/partners.md`, `docs/coingecko-listing-update-2026-08.md`, `docs/okx-marketplace.md`, `docs/announcement-coverage.md`, `docs/api-reference.md`
- `packages/metaplex-agent-mcp/README.md`, `packages/three-token-mcp/README.md`, `packages/agora-mcp/README.md`
- `blog/three-token-listings.html`, `blog/three-ws-on-coinmarketcap.html`, `blog/three-ws-dextools-social-boost-buyback.html`
- `marketing/pumpfun-verified/`
