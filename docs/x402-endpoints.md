# x402 Paid Endpoints

three.ws exposes a catalog of HTTP endpoints that charge per call over
[x402](x402.md): the caller hits the endpoint, receives a `402 Payment Required`
challenge, settles a small USDC payment, and retries with an `X-PAYMENT` header to
get the result. This page is the reference for **our own** paid endpoints, their
prices, and the price-override scheme.

To call these as a buyer, see [x402 buyer client](x402-buyer.md). For the loop
that calls many of them on a schedule, see [Autonomous x402 loop](autonomous-x402.md).

> Source: handlers under [`api/x402/`](../api/x402/), pricing
> [`api/_lib/x402-prices.js`](../api/_lib/x402-prices.js), shared handler
> [`api/_lib/x402-paid-endpoint.js`](../api/_lib/x402-paid-endpoint.js).

---

## Pricing model

Every endpoint declares a default price in **USDC atomics** (6 decimals, so
`10000` = $0.01). Operators override any price at deploy time:

```
X402_PRICE_<SLUG>=<atomics>
```

where `<SLUG>` is the upper-snake-case form of the endpoint slug — e.g.
`agent-reputation` → `X402_PRICE_AGENT_REPUTATION`, `token-intel` →
`X402_PRICE_TOKEN_INTEL`. A non-integer value logs a warning and falls back to the
default. Defaults are intentionally low (a demo/dev curve); production deployments
should tune them to real unit economics.

## Networks and settlement

Endpoints advertise the networks they accept in the 402 challenge. The platform
settles **USDC on Solana** (primary, always-on via the self-hosted facilitator)
and, when configured, **USDC on Base** (EVM) and a **BSC leg** (contract-mediated
`direct` scheme, advertised only when `X402_PAY_TO_BSC` is set). On the Solana
rail, `X402_ACCEPT_THREE_SOLANA` optionally advertises **$THREE** alongside USDC
as a second accept entry on the same challenge. The relevant config (see
[Configuration](configuration.md)):

| Key                                                  | Meaning                              |
| ---------------------------------------------------- | ------------------------------------ |
| `X402_PAY_TO_SOLANA` / `X402_PAY_TO_BASE`            | Receiving address per network.       |
| `X402_ASSET_MINT_SOLANA` / `X402_ASSET_ADDRESS_BASE` | USDC mint / contract.                |
| `X402_FACILITATOR_URL_SOLANA` / `_BASE`              | Facilitator that verifies + settles. |
| `X402_ADVERTISE_BASE`                                | Opt-in to advertise Base without CDP (see below). |
| `X402_RECEIPT_SIGNING_KEY`, `OFFER_RECEIPT_*`        | Signed receipt issuance.             |

**Base is gated on a settleable facilitator.** Solana always leads the 402
challenge. Base is advertised only when it can actually settle — either CDP
credentials are set (`CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`, routing Base to
Coinbase) **or** the operator opts in with `X402_ADVERTISE_BASE=true`. A bare
`X402_FACILITATOR_URL_BASE` being set is deliberately *not* enough: a
decommissioned facilitator answers `/verify` with `404 Application not found`, so
an ungated Base accept would let a buyer pay and then fail settlement with a 502.
The gate (`baseSettleable()` in `x402-spec.js`) keeps such a rail out of both the
live 402 and the discovery catalog until it is provably settleable.

The shared handler in `x402-paid-endpoint.js` builds the challenge
(`buildRequirements()`), verifies the submitted payment, settles it, runs the
endpoint logic, and issues a signed receipt.

### When settlement capacity runs dry

Solana settles in sponsor mode: the platform's fee wallet
(`X402_FEE_PAYER_SOLANA`) co-signs and pays the network fee. The
self-facilitator refuses to settle whenever that wallet drops below
`X402_SPONSOR_SOL_FLOOR_LAMPORTS` (0.02 SOL), which protects the wallet from
being drained to zero mid-flight. That refusal is **temporary capacity, not an
outage**, and the whole path says so:

| Layer                     | Behaviour while the sponsor is below its floor                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 402 challenge             | The Solana accept is **not advertised**. Other configured networks still are, so the endpoint stays payable.      |
| No network left to offer  | `503 settlement_unavailable`, retryable, never the `500 no_payto_configured` misconfiguration error.             |
| A payment that still lands | `503 settlement_unavailable`. Only a genuinely unexplained settle failure is `502 settle_failed`.                 |

**Buyers should treat `503 settlement_unavailable` as retry-after**, the same as
any capacity signal. No signed payment is consumed by a doomed settle, and the
accept reappears automatically within about a minute of the wallet being
refunded (each instance re-reads the balance at most once per 20s).

Operators: the funding root tops the fee wallet back up automatically
(`/api/cron/treasury-topup`). Because the master funding wallet *is* the sponsor
wallet in the default deployment, the sweep reserves the settle floor plus
`ECONOMY_MASTER_SPONSOR_HEADROOM_SOL` (0.03) on top of its own reserve, so
funding engines can never starve settlement. Check the effective value in the
cron's `sweepFloorSol` field.

## Where payments land

Most endpoints pay the **platform receiver** (`X402_PAY_TO_SOLANA` /
`X402_PAY_TO_BASE` / `X402_PAY_TO_BSC`). Money reaches a third party by one of two
distinct mechanisms — don't conflate them:

**1. `payTo` override** — the 402 challenge names a different receiver, so the
buyer's USDC settles **directly** to that wallet and the platform never holds it:

| Endpoint | Receiver | Source |
| -------- | -------- | ------ |
| `/api/x402/skill-call` | skill **author** | `author_payto_*` ([skill-call.js:205](../api/x402/skill-call.js#L205)) |
| `/api/x402/service` | service **provider** | `row.payout_address` ([service.js:91](../api/x402/service.js#L91)) |
| `/api/x402/asset-download` | 3D-asset **creator** | `creator_payto_*` ([asset-download.js:124](../api/x402/asset-download.js#L124)) |
| `/api/x402/animation-download` | clip **creator** | `creator_payto_*` ([animation-download.js:115](../api/x402/animation-download.js#L115)) |
| `/api/x402/pay-by-name` | **buyer-named** wallet | resolved name/`.sol`/address, direct SPL transfer ([pay-by-name.js:280](../api/x402/pay-by-name.js#L280)) |

**2. Post-settlement split** — the USDC lands in the **platform receiver**, then a
*separate* treasury forwards a share out-of-band (these are NOT `payTo` overrides):

| Endpoint | Lands in | Then forwarded to | By |
| -------- | -------- | ----------------- | -- |
| `/api/x402/cosmetic-purchase` | platform receiver | **creator** 50% (≤90% cap) | `COSMETIC_SPLIT_TREASURY_SECRET_KEY_B64` ([cosmetics-economy.js:203](../api/_lib/cosmetics-economy.js#L203); the 50% default and 90% ceiling are [L31-L32](../api/_lib/cosmetics-economy.js#L31)) |
| `/api/x402/dance-tip` | platform receiver | **dancer** (full tip) | `club-payouts` cron ([club/sweep.js](../api/_lib/club/sweep.js)) paying from `CLUB_SOLANA_TREASURY_SECRET_KEY_B64` ([club/payouts.js:55](../api/_lib/club/payouts.js#L55)) |
| `/api/x402/club-cover` | platform receiver (kept) | — (funds the club float; issues a door pass) | — |

`/api/x402/ring-settle` is an **internal** primitive (`discoverable:false`) — it is
deliberately not advertised in the 402 challenge or the discovery catalog; it
recirculates funds back to `X402_PAY_TO_SOLANA` to keep the closed loop balanced
([ring-settle.js:18](../api/x402/ring-settle.js#L18)). The full wallet-by-wallet
picture — every receiver, tip, split, treasury, and fee rate — is in the
[money map](money-map.md).

## Intel & oracle endpoints

These return market/polling information and are the ones the autonomous loop pays
for to feed the oracle and sniper.

| Endpoint                        | Default    | Returns                                                                                     |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `/api/x402/token-intel`         | $0.01      | Live market intel for any token (price, 24h change, market cap, liquidity, volume, signal). |
| `/api/x402/crypto-intel`        | $0.01      | Agent-readable crypto market signal (bullish/bearish/neutral) + rationale.                  |
| `/api/x402/three-intel`         | $0.01      | Intel focused on $THREE.                                                                    |
| `/api/x402/fact-check`          | $0.10      | Claim fact-check with cited sources, authority weights, and a SHA-256 attestation. A free daily quota per IP runs first; over-quota checks pay the x402 price. |
| `/api/x402/symbol-availability` | $0.001     | Whether a ticker symbol is taken; `-batch` variant $0.005.                                  |
| `/api/x402/bazaar-feed`         | $0.001     | x402 bazaar service listings feed.                                                          |

## Market intelligence endpoints

Agent-ready answers composed over live market data — composites, verdicts, and
risk flags rather than raw category feeds (the raw feeds stay free at
`/api/defi/*`, `/api/coin/*`, and `/api/news/*`; these paid surfaces are the
loss-leader funnel's paid tier). Every one refuses before settlement when it has
no data to sell, so a buyer is never charged for missing data. The
DeFiLlama-backed boards (`defi-radar`, `yield-scan`, `stablecoin-health`,
`hack-check`) and `market-mood` keep a shared last-good copy
(`cacheWrapLastGood` in `api/_lib/cache.js`) for 15 minutes past their normal
TTL: a short upstream blip serves that recent copy rather than a refusal, and the
pre-settle `503` fires only when there has never been data to serve. Their
upstream reads go through `api/_lib/upstream-fetch.js` (bounded timeout, one
retry), and `three-intel` reads $THREE's market through the shared failover
reader (`api/_lib/market/token-market.js`: Birdeye, tokens.xyz, DexScreener,
GeckoTerminal, DefiLlama, Raydium) instead of a single DexScreener call.

| Endpoint                        | Default | Returns                                                                                          |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `/api/x402/defi-radar`          | $0.005  | One-call DeFi composite: total TVL, 24 h TVL gainers/losers, top fee earners, top DEX volumes.   |
| `/api/x402/yield-scan`          | $0.005  | Screens 15k+ live yield pools by chain/TVL/stablecoin with APY breakdown + per-pool risk flags.  |
| `/api/x402/stablecoin-health`   | $0.005  | Peg deviation (bps) + on-peg/drifting/depegged verdict + supply flow per stablecoin, depeg alerts. |
| `/api/x402/hack-check`          | $0.002  | Protocol name → clean / incident-history verdict over the full DeFi exploit database.           |
| `/api/x402/market-heatmap`      | $0.002  | Top coins with 1 h/24 h/7 d momentum + breadth stats (CoinGecko→CoinPaprika failover).          |
| `/api/x402/gas-oracle`          | $0.001  | Live fee tiers for Ethereum + Base (real `eth_feeHistory`) and Solana priority-fee percentiles.  |
| `/api/x402/market-mood`         | $0.002  | Fear & Greed × 192-feed news sentiment composite (0–100) with divergence flag + driver headlines. |
| `/api/x402/news-pulse`          | $0.002  | Per-ticker news coverage: mentions, velocity vs prior window, sentiment split, top headlines.    |
| `/api/x402/robinhood-portfolio` | $0.002  | Multiplier-correct Stock Token portfolio for a Robinhood Chain wallet: each symbol's true position (balance x ERC-8056 uiMultiplier) at on-chain Chainlink NAV, plus total USD value. |

There is also a registry-derived `market-*` family — one endpoint per raw data
category, projected from `api/_lib/market-data/registry.js`. Each is $0.001
USDC per call unless noted, and every one has a free counterpart at the path
named in its description:

| Endpoint                        | Default | Returns                                                                                          |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `/api/x402/market-coins`        | $0.001  | Ranked coin market table — price, market cap, 24h volume, 24h/7d change, 7-day sparkline for up to 250 coins, with sector scoping and id search. |
| `/api/x402/market-coin`         | $0.001  | Full profile for one coin by CoinGecko id or Solana contract — market stats, ATH/ATL, supply, links, dev/community metrics, sentiment. |
| `/api/x402/market-chart`        | $0.001  | Historical USD price series for any coin — `[timestamp, price]` pairs over 1/7/30/90/365 days.  |
| `/api/x402/market-categories`   | $0.001  | CoinGecko sector leaderboard (AI, layer-1, memecoins, DeFi, RWA, …) ranked by market cap, each with 24h cap/volume change and its top-3 coins. |
| `/api/x402/market-global`       | $0.001  | Whole-market snapshot — total market cap, 24h volume, BTC/ETH dominance, active coins, Fear & Greed index. |
| `/api/x402/market-trending`     | $0.001  | Last 24h's most-searched coins, categories, and NFT collections — early attention signal before it shows up in price. |
| `/api/x402/market-exchanges`    | $0.001  | Top 100 spot exchanges by CoinGecko trust score — 24h volume in BTC/USD, country, year established. |
| `/api/x402/market-derivatives`  | $0.001  | Top 100 perp futures by 24h volume (price, funding rate, open interest); `?view=exchanges` for the derivatives-venue leaderboard. |
| `/api/x402/market-gas`          | $0.001  | Live ETH gas in slow/standard/fast tiers from real `eth_feeHistory`, with USD cost estimates for transfer/swap/mint. |
| `/api/x402/market-defi`         | $0.001  | Top 100 DeFi protocols by TVL (DeFiLlama) with 1d/7d change, chains, category, plus whole-market TVL totals. |
| `/api/x402/market-chains`       | $0.001  | Cross-chain TVL leaderboard — top 100 chains with native token and % share of locked value.      |
| `/api/x402/market-yields`       | $0.001  | ~15,000 DeFi yield pools, filterable by chain/project/stablecoin/search, sortable by TVL or dust-guarded APY. |
| `/api/x402/market-stablecoins`  | $0.001  | Top 100 stablecoins by circulating supply with live price (peg health), mechanism, and chain deployments. |
| `/api/x402/market-fees`         | $0.001  | Top 100 protocols by 24h fees or revenue (`?type=`) with 1d/7d/30d totals and whole-market chart. |
| `/api/x402/market-dex-volumes`  | $0.001  | Top 100 DEXes by 24h volume, with 7d volume, WoW change, chains, and market-share.               |
| `/api/x402/market-hacks`        | $0.001  | Full DeFiLlama hack history — amount stolen, technique, chains, funds returned; searchable, with all-time/12mo loss stats. |
| `/api/x402/market-pulse`        | $0.005  | Flagship one-call market bundle: global stats, Fear & Greed, top-10 coins, trending, ETH gas, DeFi TVL, stablecoin supply, DEX volume, protocol fees — each section degrades independently. |

Beneath the named endpoints sits the **datapoint fabric**: `/api/x402/d/<family>/…`
(one route, `api/x402/d/[...path].js`) serves 1,000,000+ individually priced
datapoints at **$0.0005** USDC each by default, overridable per family with
`X402_PRICE_DATAPOINT_<FAMILY>`. See [Market data API](market-data-api.md#the-datapoint-fabric--1000000-standalone-endpoints).

## Agent & reputation endpoints

| Endpoint                            | Default   | Returns                                    |
| ----------------------------------- | --------- | ------------------------------------------ |
| `/api/x402/agent-reputation`        | $0.01     | Cross-chain 0–100 trust score for any wallet/mint/agent id ([trust primitives](trust-primitives.md)). |
| `/api/x402/agent-bouncer`           | $0.01     | Access-gate decision for an agent/wallet.  |
| `/api/x402/onchain-identity-verify` | $0.005    | Verifies an on-chain identity claim.       |
| `/api/x402/skill-marketplace`       | $0.001    | Skill listings + pricing.                  |
| `/api/x402/skill-call`              | per skill | Invoke a listed agent skill.               |
| `/api/x402/pump-agent-audit`        | $0.02     | Audit of a pump agent's behavior/holdings. |

## Generation & 3D endpoints

| Endpoint                                                    | Default   | Returns                                                                                      |
| ----------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------- |
| `/api/x402/forge`                                           | tiered    | Text/image → 3D model (price by tier; GPU-bound). Every settled generation also lands in the public community gallery (`forge_creations`) stamped with the payer, settle signature, and price; the gallery shows a Solscan-linked "x402" provenance badge. See [Avatar pipeline](avatar-pipeline.md). |
| `/api/x402/embody`                                          | $1.00     | **Embodiment.** One call, an agent buys itself a body: prompt or image in → rigged, voiced 3D avatar out, plus a durable persona id and a one-tag `<iframe>` embed for any website. Settles on delivery — a failed generation never charges. See [Embodiment](embody.md). |
| `/api/x402/pipeline`                                        | per stage | **One call, full 3D asset pipeline** — text or GLB in, rigged/optimized game-ready GLB out. Ordered chain of `generate → rig → remesh → gameready → stylize`; the 402 quote is the exact sum of the requested stages. Poll free at `/api/forge?job=<id>` for per-stage progress. See [3D pipeline](3d-pipeline.md). |
| `/api/x402/pipeline-rig`                                    | $0.05     | **Pipeline — Rig.** Static GLB in → animation-ready rigged GLB out (skeleton + skin weights). One paid call, durable URL. See [3D pipeline](3d-pipeline.md). |
| `/api/x402/pipeline-remesh`                                 | $0.03     | **Pipeline — Remesh.** Retopologize a GLB (triangle/quad/lowpoly, repair, decimate to a face budget) with texture re-baked. GLB in → GLB out. See [3D pipeline](3d-pipeline.md). |
| `/api/x402/pipeline-gameready`                              | $0.03     | **Pipeline — Game-Ready.** Retopologize to a poly budget + PBR re-bake for real-time engines. GLB in → engine-ready GLB out. See [3D pipeline](3d-pipeline.md). |
| `/api/x402/pipeline-stylize`                                | $0.03     | **Pipeline — Stylize.** Geometric restyle (voxel/brick/voronoi/lowpoly) that rebuilds the mesh. GLB in → GLB out. See [3D pipeline](3d-pipeline.md). |
| `/api/x402/pipeline-rembg`                                  | $0.01     | **Pipeline — Background Removal.** Image in → transparent PNG out (clean reference view for image→3D). See [3D pipeline](3d-pipeline.md). |
| `/api/x402/mint-to-mesh`, `/api/x402/mint-to-mesh-batch`    | $0.001    | Token/mint → 3D mesh; `mint-to-mesh-batch` runs a set at $0.05.                              |
| `/api/x402/model-check`, `/api/x402/model-validation-sweep` | $0.001    | Validate a GLB / sweep a batch. (`model-check` is kept as a paid convenience; the same inspection is free at `/api/3d/inspect`.) |
| `/api/x402/avatar-optimize-batch`                           | $0.001    | Batch optimization pass over the top N avatars.                                              |
| `/api/x402/animation-download`, `/api/x402/asset-download`  | per asset | Paid asset/animation delivery.                                                               |

## Launch, naming & utility endpoints

| Endpoint                                                                                                                                                                  | Default        | Returns                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`/api/x402/pump-launch`](pump-launcher.md)                                                                                                                               | $5.00          | **Pump Launcher** — deploy a brand-new pump.fun token in one paid call. No SOL, no wallet, no account: the server fronts the deploy cost and signs the create tx; you pay USDC. Optional vanity mint. Full flow + funnel in [pump-launcher.md](pump-launcher.md). |
| [`/api/x402/vanity`](vanity.md)                                                                                                                                           | $0.01–$0.50 (≤3) · $2.50–$10 (4–5, inventory-only) | **Vanity Grinder** — get a brand-new Solana address that starts with your ticker/prefix and/or ends with a suffix, for a branded token mint or agent/treasury wallet. Checks the pre-ground warehouse first for **instant delivery** (`source: "inventory"`); falls back to a live grind (`source: "ground"`) up to 3 chars. Keypair or importable BIP-39 mnemonic; nothing stored; optional `sealTo` ECIES. Full doc: [vanity.md](vanity.md). |
| [`/api/x402/vanity-verifiable`](vanity.md#tier-2--provably-fair-grinder)                                                                                                  | $0.02–$0.40    | **Provably-fair grinder** — same grind with a signed commit–reveal receipt proving the key was ground fresh and never kept. Spec: [PROTOCOL-vanity.md](PROTOCOL-vanity.md). |
| [`/api/x402/vanity-premium`](vanity.md#tier-3--premium-inventory)                                                                                                         | $1–$50 by rarity | **Premium inventory** — buy a pre-ground 4–5+ char brandable address from stock. GET lists available patterns + prices (free); `?address=…` buys via x402 and delivers the key **once** (ciphertext destroyed on delivery). Browsable at `/vanity/premium`. |
| `/api/x402/pay-by-name`                                                                                                                                                   | $0.001         | Resolve and pay a `@username` / `.sol` name / raw address (see [Agent wallets](agent-wallets.md)); the paid resolve toll is $0.001, the transfer amount itself is buyer-specified. A name that resolves to nothing returns `404 not_found` and the payment is left unsettled, so an unresolvable name is free. |
| `/api/x402/did`                                                                                                                                                           | $0.001         | **POST** is the DID verification canary: it resolves three.ws's published W3C DID document over its real public route, structurally validates it, and returns `{ verified, latency_ms, configured, checks }`. `configured: false` means the resolver answered 404 or could not be reached at all. `mode: "sweep"` audits recent agent identities for resolvable key material instead. **GET** is the free publisher for `/.well-known/did.json`; every other verb returns `405`. |
| `/api/x402/three-buy`                                                                                                                                                     | $0.001         | Micro-buy service: one settled toll payment triggers one small, real on-chain USDC to $THREE buy funded by the micro-buy wallet (driven by the `three-buy-loop` cron). |
| `/api/x402/billboard`                                                                                                                                                     | $0.05          | Post to the on-platform billboard.                                                                                          |
| `/api/x402/dance-tip`                                                                                                                                                     | $0.001         | Tip a club performer.                                                                                                       |
| `/api/x402/club-cover`                                                                                                                                                    | $0.01          | **GET**: pole-club door cover charge; a paid wallet re-enters free for the pass window. **POST** sells a read of the club at the same price: `mode: "snapshot"` (default) returns membership growth/churn for a `club`, `mode: "revenue"` returns the door + floor take for a `period` (`24h`, `7d`, `14d`, `30d`, `all`). |
| `/api/x402/cosmetic-purchase`                                                                                                                                             | per item       | Buy a cosmetic; the price comes from the catalog rarity, never the client. Ownership is recorded to the `account` query param. A wallet that already paid re-confirms for free with SIWX, but only for itself or for an account that already owns the item, so one purchase can never unlock the cosmetic on a third account. |
| `/api/x402/tutor`                                                                                                                                                         | $0.01 / answer | Paid tutoring; a session accumulates a running tab across answers.                                                          |
| `/api/x402/spend-session`                                                                                                                                                 | $0.01          | Open a metered spend session.                                                                                               |
| `/api/x402/llm-proxy`                                                                                                                                                     | $0.005         | Paid LLM proxy.                                                                                                             |
| `/api/x402/notify`                                                                                                                                                        | $0.001         | Notification gateway (Telegram + the autonomous loop's `canary` heartbeat lane).                                            |
| `/api/x402/wallet-connect`                                                                                                                                                | $0.001         | Wallet-bridge connect probe.                                                                                                |
| `/api/x402/permit2-paid-demo`                                                                                                                                             | $0.001         | Reference endpoint for the Permit2 / EIP-2612 gasless-approval scheme.                                                      |
| `/api/x402/remix-asset`                                                                                                                                                   | $0.25          | Paid remix of a published, remixable 3D asset — generates a new anchored model and routes the source creator's royalty (≤20%) on-chain. |
| `/api/x402/cross-chain`                                                                                                                                                   | $0.005         | Cross-chain bridge status monitor. (`/api/x402/network-cost` is the free read of the cross-chain cost snapshots the autonomous loop settles hourly.) |
| `/api/x402/rate-limit-probe`, `/api/x402/schema-check`                                                                                                                    | $0.001         | Paid diagnostic probes used by the autonomous loop.                                                                         |
| `/api/x402/auth-health`, `/api/x402/api-key-health`, `/api/x402/feed-health`, `/api/x402/telegram-health`, `/api/x402/solana-register-health` | $0.001         | Paid SLA/health probes for each backend dependency (auth, API keys, the live feed, Telegram, Solana register). |

> Prices above marked "per call / per tier / per source" are computed by the
> handler rather than a flat default; check the handler and any
> `X402_PRICE_<SLUG>` override for the exact figure in your deployment. Each
> endpoint declares its own default inline via
> `priceFor('<slug>', '<atomics>')` (resolver:
> [`api/_lib/x402-prices.js`](../api/_lib/x402-prices.js)) — grep a handler for
> `priceAtomics` / `priceFor(` to see its figure — and every default is
> overridable with `X402_PRICE_<SLUG>` as described above.

## Observability, revenue & ops endpoints

Several endpoints in `api/x402/` report on the platform itself. The paid ones
charge a token fee (they are real, sellable observability products an agent can
consume); a few are **free** read surfaces that happen to live in the same
directory.

| Endpoint                           | Default  | Returns                                                                                                                                                           |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/x402/analytics`              | $0.005   | Platform reports: club and listing analytics.                                                                                                                     |
| `/api/x402/mcp-tool-catalog`       | $0.001   | Snapshot of every MCP tool (name, paid/free, price, input shape) and a diff vs the last snapshot (added / removed / re-priced tools).                           |
| **Free read surfaces**             | —        | —                                                                                                                                                                 |
| `/api/x402/my-receipts`            | free     | A buyer's own settled receipts, gated by a wallet signature (SIWX) rather than a payment.                                                                         |
| `/api/x402/mcp-perf`               | free     | MCP tool latency dashboard data.                                                                                                                                  |
| `/api/x402/service-pricing-report` | free     | Tracked upstream-dependency price catalog + active price-increase/-drop alerts.                                                                                   |
| `/api/x402/granite-health`         | free     | IBM Granite inference SLA feed, read from the verdicts the autonomous loop's paid 6-hourly probe writes.                                                          |
| `/api/x402/glb-optimization-report`| free     | GLB Size Optimizer catalog feed: what the `glb-size-optimizer` autonomous-loop entry has measured.                                                                |
| `/api/x402/network-cost`           | free     | Cross-chain payment-cost recommendation feed from the hourly cross-chain-cost pipeline snapshots.                                                                 |
| `/api/x402/runway-lab`             | free     | Live seed for [/economy-lab](https://three.ws/economy-lab): the fee wallet's real SOL balance and hard floor, the running deploy's governor config, today's spend from `x402_self_facilitator_log`, observed fee-per-settle and 24h demand, and the refusal histogram bucketed by cause (governor / floor / dust guard / duplicate). Read-only; every field is already public through `/api/x402-ring` and `/api/x402-status`. |
| `/api/x402/echo`                   | free     | httpbin for x402 — decodes your `X-PAYMENT` header (signatures redacted) and returns a local verify verdict without settling. See [x402 dev tools](x402-dev-tools.md). |
| `/api/x402/debug`                  | free     | Diagnoses a failed 402 exchange (`{challenge, payment, response}`) into an ordered `{severity, field, problem, fix}` list. See [x402 dev tools](x402-dev-tools.md).     |
| `/api/x402/verify-receipt`         | free     | Recomputes a paid response's SHA-256 attestation and confirms a settlement tx on-chain. See [x402 dev tools](x402-dev-tools.md).                                       |
| `/api/x402/inference-verify`       | free     | Audits a metered-inference receipt from a paid `llm-proxy` call: per-check verdicts for the issuer signature, the node's response signature, prompt/response hash re-derivation from raw text, on-chain settlement confirmation, and whether the issuer matches the platform's published signers. See [Run an inference node](inference-node-operator.md). |

## $THREE only

Any endpoint that references a coin references **$THREE**
(`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`). Endpoints that accept an
arbitrary token (e.g. `token-intel`, `mint-to-mesh`) take the mint as runtime
input and do not promote any specific token.

## Related

- [Pump Launcher](pump-launcher.md) — the full launch flow, inputs/outputs, and the free `symbol` → launch → `launches` funnel.
- [x402 protocol](x402.md) — the challenge/settle mechanics.
- [x402 buyer client](x402-buyer.md) — how to pay these endpoints in code.
- [Financial controls](financial-controls.md): where settled payments are recorded.
- [Autonomous x402 loop](autonomous-x402.md) — the scheduled buyer that drives volume through these endpoints.
- [MCP tools](mcp-tools.md) — the same capabilities exposed as paid MCP tools.
