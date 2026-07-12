# 12 — three.ws integration: /markets display + purchase

Read `prompts/robinhood-chain/_shared.md` first. Wave 3. THIS PROMPT MODIFIES THE three.ws APP
(not a standalone repo). All CLAUDE.md rules apply directly — and the COMMIT GATE is absolute:
build in the working tree, do NOT commit (Robinhood-referencing content needs explicit owner
approval per commit).

## Mission
Make three.ws the best place to SEE Robinhood Chain and a working place to BUY its coins:
a Robinhood Chain section inside our existing /markets surface, detail pages, and a purchase
flow — following the established patterns (read the neighboring market handlers and pages
before writing anything; match their style, caching, failover, and design tokens).

## Deliverables

1. **API layer** (`api/v1/robinhood/…` following `api/v1/market/*` conventions):
   - `stocks.js`, `stocks-detail.js`, `coins.js`, `launches.js`, `chain.js` — same data spec as
     prompt 04's endpoints. If `robinhood/hood-api/` is deployed, proxy it with failover to
     direct upstream calls; if not, implement direct (DefiLlama provider already knows chain
     `robinhood-chain` — extend `api/v1/_providers.js`; CoinGecko categories
     `robinhood-chain-meme` / stocks-ecosystem; GeckoTerminal pools; Chainlink reads via viem).
   - Wire routes in `vercel.json` (it's the LIVE route table — follow existing entries), respect
     the rate-limiter bucket conventions (dedicated bucket, NOT `public:ip` — see
     play-lobby-429 lesson), and register x402 pricing for the premium endpoints in the
     existing catalog exactly like current `api/v1` paid endpoints.
2. **/markets/robinhood hub page** — three tabs: Stocks (24/7 tokenized-equity board: Chainlink
   price, DEX premium, volume, sparklines), Coins (memecoin screener: new/graduating/trending),
   Chain (TVL, bridge flows, stats). Reuse the existing markets page components/CSS tokens; add
   the hub to /markets navigation and `data/pages.json` (path, title, description, added date).
3. **Detail pages** — `/markets/robinhood/stock/:symbol` and `/markets/robinhood/coin/:address`
   following the existing markets detail-page pattern (memory: markets detail-page expansion):
   chart, stats grid, holders, recent trades, contract links (Blockscout), and for stocks the
   premium/discount history vs Chainlink NAV.
4. **Purchase flow** — "Buy" on coin detail pages: EVM wallet connect (injected/EIP-6963, match
   any existing EVM wallet plumbing in the codebase — search before building new), chain-switch
   helper to 4663 (viem chain def), Uniswap v3 quote + swap with slippage control, bridge
   deep-link (LI.FI/Relay) for users without funds on 4663. Stock Tokens: DISPLAY-ONLY at
   launch — show an eligibility-gated "Trade on DEX" outbound link with the disclosure instead
   of an in-house buy (owner decision pending; leave the buy path cleanly implementable).
5. **Docs + changelog** — `docs/` entry per the Documentation rules, `data/changelog.json`
   entry (feature), STRUCTURE.md row for the new surface.

## Requirements
- Definition of Done from CLAUDE.md in full: dev server run, real browser exercise, zero console
  errors, all states designed (loading skeletons, empty, error with retry), responsive,
  accessible, `npm test` green including any new tests (add handler tests following
  `tests/api/` patterns; remember the rewrite-query test lesson for parameterized routes).
- Performance: the stocks board must not fan out 95 RPC calls per request — batch via
  multicall/cached snapshot with a short TTL, consistent with existing market caching.

## Done checklist
- [ ] Hub + both detail page types live locally with real data; purchase flow executes a real
      testnet swap (config-flag testnet mode) — evidence in report.
- [ ] Routes in vercel.json; pages.json + changelog + STRUCTURE.md updated; docs written.
- [ ] NOTHING committed. Report lists exact files changed for owner review.
