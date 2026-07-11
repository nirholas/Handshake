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
and, when configured, **USDC on Base** (EVM). The relevant config (see
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

## Where payments land

Most endpoints pay the **platform receiver** (`X402_PAY_TO_SOLANA` /
`X402_PAY_TO_BASE` / `X402_PAY_TO_BSC`). Money reaches a third party by one of two
distinct mechanisms — don't conflate them:

**1. `payTo` override** — the 402 challenge names a different receiver, so the
buyer's USDC settles **directly** to that wallet and the platform never holds it:

| Endpoint | Receiver | Source |
| -------- | -------- | ------ |
| `/api/x402/skill-call` | skill **author** | `author_payto_*` ([skill-call.js:159](../api/x402/skill-call.js#L159)) |
| `/api/x402/service` | service **provider** | `row.payout_address` ([service.js:92](../api/x402/service.js#L92)) |
| `/api/x402/asset-download` | 3D-asset **creator** | `creator_payto_*` ([asset-download.js:121](../api/x402/asset-download.js#L121)) |
| `/api/x402/animation-download` | clip **creator** | `creator_payto_*` ([animation-download.js:112](../api/x402/animation-download.js#L112)) |
| `/api/x402/pay-by-name` | **buyer-named** wallet | resolved name/`.sol`/address, direct SPL transfer ([pay-by-name.js:256](../api/x402/pay-by-name.js#L256)) |

**2. Post-settlement split** — the USDC lands in the **platform receiver**, then a
*separate* treasury forwards a share out-of-band (these are NOT `payTo` overrides):

| Endpoint | Lands in | Then forwarded to | By |
| -------- | -------- | ----------------- | -- |
| `/api/x402/cosmetic-purchase` | platform receiver | **creator** 50% (≤90% cap) | `COSMETIC_SPLIT_TREASURY_SECRET_KEY_B64` ([cosmetics-economy.js:31](../api/_lib/cosmetics-economy.js#L31)) |
| `/api/x402/dance-tip` | platform receiver | **dancer** (full tip) | `club-payouts` cron from `CLUB_SOLANA_TREASURY_SECRET_KEY_B64` ([club/sweep.js:19](../api/_lib/club/sweep.js#L19)) |
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
| `/api/x402/fact-check`          | per source | Claim fact-check with cited evidence.                                                       |
| `/api/x402/symbol-availability` | $0.001     | Whether a ticker symbol is taken; `-batch` variant $0.005.                                  |
| `/api/x402/bazaar-feed`         | $0.001     | x402 bazaar service listings feed.                                                          |

## Market intelligence endpoints

Agent-ready answers composed over live market data — composites, verdicts, and
risk flags rather than raw category feeds (the raw feeds stay free at
`/api/defi/*`, `/api/coin/*`, and `/api/news/*`; these paid surfaces are the
loss-leader funnel's paid tier). Every one refuses before settlement when its
upstream is down — a buyer is never charged for missing data.

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

There is also a registry-derived `market-*` family (`/api/x402/market-coins`,
`market-chart`, `market-yields`, …) — one endpoint per raw data category,
projected from `api/_lib/market-data/registry.js`.

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
| `/api/x402/forge`                                           | tiered    | Text/image → 3D model (price by tier; GPU-bound). See [Avatar pipeline](avatar-pipeline.md). |
| `/api/x402/embody`                                          | $1.00     | **Embodiment.** One call, an agent buys itself a body: prompt or image in → rigged, voiced 3D avatar out, plus a durable persona id and a one-tag `<iframe>` embed for any website. Settles on delivery — a failed generation never charges. See [Embodiment](embody.md). |
| `/api/x402/pipeline`                                        | per stage | **One call, full 3D asset pipeline** — text or GLB in, rigged/optimized game-ready GLB out. Ordered chain of `generate → rig → remesh → gameready → stylize`; the 402 quote is the exact sum of the requested stages. Poll free at `/api/forge?job=<id>` for per-stage progress. See [3D pipeline](3d-pipeline.md). |
| `/api/x402/pipeline-rig`                                    | $0.05     | **Pipeline — Rig.** Static GLB in → animation-ready rigged GLB out (skeleton + skin weights). One paid call, durable URL. See [3D pipeline](3d-pipeline.md). |
| `/api/x402/pipeline-remesh`                                 | $0.03     | **Pipeline — Remesh.** Retopologize a GLB (triangle/quad/lowpoly, repair, decimate to a face budget) with texture re-baked. GLB in → GLB out. See [3D pipeline](3d-pipeline.md). |
| `/api/x402/pipeline-gameready`                              | $0.03     | **Pipeline — Game-Ready.** Retopologize to a poly budget + PBR re-bake for real-time engines. GLB in → engine-ready GLB out. See [3D pipeline](3d-pipeline.md). |
| `/api/x402/pipeline-stylize`                                | $0.03     | **Pipeline — Stylize.** Geometric restyle (voxel/brick/voronoi/lowpoly) that rebuilds the mesh. GLB in → GLB out. See [3D pipeline](3d-pipeline.md). |
| `/api/x402/pipeline-rembg`                                  | $0.01     | **Pipeline — Background Removal.** Image in → transparent PNG out (clean reference view for image→3D). See [3D pipeline](3d-pipeline.md). |
| `/api/x402/mint-to-mesh`, `/api/x402/mint-to-mesh-batch`    | per call  | Token/mint → 3D mesh; `mint-to-mesh-batch` runs a set at $0.05.                              |
| `/api/x402/model-check`, `/api/x402/model-validation-sweep` | $0.001    | Validate a GLB / sweep a batch.                                                              |
| `/api/x402/glb-optimization-report`                         | per call  | GLB size/optimization analysis.                                                              |
| `/api/x402/avatar-optimize-batch`                           | $0.001    | Batch optimization pass over the top N avatars.                                              |
| `/api/x402/animation-download`, `/api/x402/asset-download`  | per asset | Paid asset/animation delivery.                                                               |

## Launch, naming & utility endpoints

| Endpoint                                                                                                                                                                  | Default        | Returns                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`/api/x402/pump-launch`](pump-launcher.md)                                                                                                                               | $5.00          | **Pump Launcher** — deploy a brand-new pump.fun token in one paid call. No SOL, no wallet, no account: the server fronts the deploy cost and signs the create tx; you pay USDC. Optional vanity mint. Full flow + funnel in [pump-launcher.md](pump-launcher.md). |
| [`/api/x402/vanity`](vanity.md)                                                                                                                                           | $0.01–$0.50 (≤3) · $2.50–$10 (4–5, inventory-only) | **Vanity Grinder** — get a brand-new Solana address that starts with your ticker/prefix and/or ends with a suffix, for a branded token mint or agent/treasury wallet. Checks the pre-ground warehouse first for **instant delivery** (`source: "inventory"`); falls back to a live grind (`source: "ground"`) up to 3 chars. Keypair or importable BIP-39 mnemonic; nothing stored; optional `sealTo` ECIES. Full doc: [vanity.md](vanity.md). |
| [`/api/x402/vanity-verifiable`](vanity.md#tier-2--provably-fair-grinder)                                                                                                  | $0.02–$0.40    | **Provably-fair grinder** — same grind with a signed commit–reveal receipt proving the key was ground fresh and never kept. Spec: [PROTOCOL-vanity.md](PROTOCOL-vanity.md). |
| [`/api/x402/vanity-premium`](vanity.md#tier-3--premium-inventory)                                                                                                         | $1–$50 by rarity | **Premium inventory** — buy a pre-ground 4–5+ char brandable address from stock. GET lists available patterns + prices (free); `?address=…` buys via x402 and delivers the key **once** (ciphertext destroyed on delivery). Browsable at `/vanity/premium`. |
| `/api/x402/pay-by-name`                                                                                                                                                   | per call       | Resolve and pay an SNS/ENS name (see [Agent wallets](agent-wallets.md)).                                                    |
| `/api/x402/did`                                                                                                                                                           | per call       | Decentralized identifier resolution.                                                                                        |
| `/api/x402/billboard`                                                                                                                                                     | $0.05          | Post to the on-platform billboard.                                                                                          |
| `/api/x402/dance-tip`                                                                                                                                                     | $0.001         | Tip a club performer.                                                                                                       |
| `/api/x402/club-cover`                                                                                                                                                    | $0.01          | Pole-club door cover charge; a paid wallet re-enters free for the pass window.                                              |
| `/api/x402/cosmetic-purchase`                                                                                                                                             | per item       | Buy a cosmetic.                                                                                                             |
| `/api/x402/tutor`                                                                                                                                                         | $0.01 / answer | Paid tutoring; a session accumulates a running tab across answers.                                                          |
| `/api/x402/spend-session`                                                                                                                                                 | $0.01          | Open a metered spend session.                                                                                               |
| `/api/x402/llm-proxy`                                                                                                                                                     | per call       | Paid LLM proxy.                                                                                                             |
| `/api/x402/notify`                                                                                                                                                        | $0.001         | Notification gateway (Telegram + the autonomous loop's `canary` heartbeat lane).                                            |
| `/api/x402/wallet-connect`                                                                                                                                                | $0.001         | Wallet-bridge connect probe.                                                                                                |
| `/api/x402/permit2-paid-demo`                                                                                                                                             | $0.001         | Reference endpoint for the Permit2 / EIP-2612 gasless-approval scheme.                                                      |
| `/api/x402/remix-asset`                                                                                                                                                   | $0.25          | Paid remix of a published, remixable 3D asset — generates a new anchored model and routes the source creator's royalty (≤20%) on-chain. |
| `/api/x402/cross-chain`, `/api/x402/network-cost`                                                                                                                         | per call       | Cross-chain cost comparison.                                                                                                |
| `/api/x402/rate-limit-probe`, `/api/x402/schema-check`                                                                                                                    | $0.001         | Paid diagnostic probes used by the autonomous loop.                                                                         |
| `/api/x402/auth-health`, `/api/x402/api-key-health`, `/api/x402/feed-health`, `/api/x402/granite-health`, `/api/x402/telegram-health`, `/api/x402/solana-register-health` | $0.001         | Paid SLA/health probes for each backend dependency (auth, API keys, the live feed, IBM Granite, Telegram, Solana register). |

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
| `/api/x402/analytics`              | $0.005   | Platform reports — pick `report=revenue` for the x402 endpoint-revenue summary (see [x402 revenue & receipts](x402-revenue.md)), plus club and listing analytics. |
| `/api/x402/mcp-tool-catalog`       | per call | Snapshot of every MCP tool — name, paid/free, price, input shape — and a diff vs the last snapshot (added / removed / re-priced tools).                           |
| **Free read surfaces**             | —        | —                                                                                                                                                                 |
| `/api/x402/my-receipts`            | free     | A buyer's own settled receipts, gated by a wallet signature (SIWX) rather than a payment.                                                                         |
| `/api/x402/mcp-perf`               | free     | MCP tool latency dashboard data.                                                                                                                                  |
| `/api/x402/service-pricing-report` | free     | Tracked upstream-dependency price catalog + active price-increase/-drop alerts.                                                                                   |
| `/api/x402/echo`                   | free     | httpbin for x402 — decodes your `X-PAYMENT` header (signatures redacted) and returns a local verify verdict without settling. See [x402 dev tools](x402-dev-tools.md). |
| `/api/x402/debug`                  | free     | Diagnoses a failed 402 exchange (`{challenge, payment, response}`) into an ordered `{severity, field, problem, fix}` list. See [x402 dev tools](x402-dev-tools.md).     |
| `/api/x402/verify-receipt`         | free     | Recomputes a paid response's SHA-256 attestation and confirms a settlement tx on-chain. See [x402 dev tools](x402-dev-tools.md).                                       |

## $THREE only

Any endpoint that references a coin references **$THREE**
(`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`). Endpoints that accept an
arbitrary token (e.g. `token-intel`, `mint-to-mesh`) take the mint as runtime
input and do not promote any specific token.

## Related

- [Pump Launcher](pump-launcher.md) — the full launch flow, inputs/outputs, and the free `symbol` → launch → `launches` funnel.
- [x402 protocol](x402.md) — the challenge/settle mechanics.
- [x402 buyer client](x402-buyer.md) — how to pay these endpoints in code.
- [x402 revenue & receipts](x402-revenue.md) — where settled payments are recorded and how to read endpoint revenue.
- [Autonomous x402 loop](autonomous-x402.md) — the scheduled buyer that drives volume through these endpoints.
- [MCP tools](mcp-tools.md) — the same capabilities exposed as paid MCP tools.
