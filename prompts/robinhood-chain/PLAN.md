# Robinhood Chain Campaign — Research + Build Plan

> Drafted 2026-07-11 from a 4-agent research sweep (chain facts, GitHub, npm, infra/gap landscape).
> COMMIT GATE: everything in this campaign references a non-$THREE crypto project. Per CLAUDE.md,
> no commit ships without explicit owner approval of that content. Owner directed this campaign
> on 2026-07-11; confirm approval per-commit or get a blanket sign-off before the first push.

## Ground truth (verified 2026-07-11)

- **Mainnet LIVE since 2026-07-01.** Permissionless Arbitrum Orbit L2, settles to Ethereum,
  blobs DA, ETH gas, 100ms blocks, ERC-4337 supported.
- **Chain ID 4663** (mainnet) / **46630** (testnet). Public RPC `https://rpc.mainnet.chain.robinhood.com`,
  Alchemy is the recommended provider (`robinhood-mainnet.g.alchemy.com/v2/{key}`), Blockscout
  explorer + Pro API at `robinhoodchain.blockscout.com`, public sequencer feed
  `wss://feed.mainnet.chain.robinhood.com`. Testnet faucet drips ETH + test Stock Tokens
  (TSLA, AMZN, PLTR, NFLX, AMD): `https://faucet.testnet.chain.robinhood.com/`.
- **`viem@^2.55.0` ships `robinhood` + `robinhoodTestnet` chain defs** (published 2026-07-08).
  No custom chain config needed anywhere.
- **Assets:** ~95 tokenized Stock Tokens (plain ERC-20, 18 decimals, each with a live Chainlink
  price feed; corporate actions via ERC-8056 `uiMultiplier()`); **USDG** (Paxos) is the dollar
  rail (>$260M week one); **no native chain token** (airdrop talk is pure speculation).
  Memecoin meta is real: $560M+/day DEX volume, NOXA + "The Odyssey" pump.fun-style launchpads
  graduating coins to Uniswap v3, CASHCAT hit ~$150M cap.
- **Programmatic trading is open:** Uniswap v2/v3/v4 + UniswapX, 1inch, Arcus (zero-fee stock
  DEX), Lighter (perps), Morpho are live. Stock Tokens are standard transferable ERC-20s.
- **Compliance line:** Stock Tokens may not be offered/sold to US persons (also CA/UK/CH limits).
  Enforced legally + at issuance/front-ends, not at contract level. Memecoins carry no such
  restriction. → Stock Token BUY flows must be geo-gated; display/data is fine; memecoin swaps
  are unrestricted.
- **Official tooling vacuum:** no Robinhood SDK, no official chain MCP (their Trading MCP at
  `agent.robinhood.com/mcp/trading` is brokerage-only, US-only), no market-data REST API for
  Stock Tokens, no launchpad firehose, chain absent from Graph Studio. Robinhood's GitHub org
  has zero original chain repos.
- **Ecosystem is ~2 weeks old:** ~40 repos, almost all 0-star. Standouts: `nhevers/project-r0x`
  (MIT, 122★, x402 facilitator + USDG agent OS on chain 4663 — the one serious competitor,
  squarely in our x402 lane), `arambarnett/robinhood-chain-mcp` (MIT, read-only chain MCP),
  `ismailmoazami/robinhood-chain-quickstart` (MIT Foundry template),
  `BankrBot/skills` hoodmarkets pack (known-contracts.json = Stock Token address source).
  `adrydevel/robinhood-chain-sdk` is the closest SDK but license-ambiguous (README-MIT, no
  LICENSE file) — do not fork until resolved; build clean-room instead.
- **Data providers we already integrate cover the chain:** DefiLlama has chain/RWA/bridge pages
  (our fixture already carries chainId 4663), CoinGecko API has live+historical chain data plus
  "Robinhood Chain Meme" and "Robinhood Chain Stocks Ecosystem" categories, GeckoTerminal +
  DEXTools track its pools, Dune has full support.
- **Distribution:** Robinhood committed $1M to Arbitrum Open House 2026 (4 buildathons + 2
  founder houses). Priority verticals: DEXs, perps, lending.

## Confirmed market gaps (nobody has these)

1. Unified tokenized-equity market-data API (Robinhood + xStocks + Ondo in one schema:
   price, 24/7 candles, holders, DEX volume, premium/discount vs underlying, multipliers).
   RWA.xyz is enterprise-paid; CoinGecko has no equity semantics.
2. Cross-venue tokenized-stock screener ("DEX Screener for equities") with arb/premium alerts.
3. MCP server + agent tooling for the chain itself (not the brokerage).
4. Portfolio tracking that reads `uiMultiplier()` correctly (every generic tracker misstates
   balances after splits/dividends).
5. Launchpad/memecoin WebSocket firehose (PumpPortal-equivalent) — raw material is the public
   sequencer feed + Blockscout.
6. x402-payable APIs on/for the chain (r0x is day-one; no incumbent).
7. A polished chain SDK on npm (zero exist).

## Workstreams

### RH-01 — Chain plumbing (foundation, do first)
`api/_lib/robinhood-chain.js`: viem clients (public RPC + Alchemy failover), chain constants,
Stock Token registry (seed from Robinhood docs /chain/contracts + BankrBot known-contracts.json,
refresh from Blockscout), Chainlink feed reader with staleness guards, `uiMultiplier()` reader,
USDG address/decimals. Testnet twin for E2E (faucet-funded). Everything below consumes this.

### RH-02 — Market Data API + x402 (`api/v1/robinhood/*`)
Extends the existing Market Data API + x402 catalog patterns (`api/v1/market`, `api/v1/tokenized`):
- `/api/v1/robinhood/stocks` — all Stock Tokens: Chainlink price, DEX price, premium/discount,
  multiplier-adjusted, 24h volume/liquidity (GeckoTerminal/CoinGecko + on-chain).
- `/api/v1/robinhood/stocks/:symbol` — detail incl. candles, holders (Blockscout), feeds.
- `/api/v1/robinhood/coins` — memecoins/launchpad tokens (CoinGecko category + GeckoTerminal pools).
- `/api/v1/robinhood/chain` — TVL/protocols/bridge flows (DefiLlama — extend existing provider).
- `/api/v1/robinhood/portfolio/:address` — multiplier-correct portfolio valuation (gap #4).
- `/api/v1/tokenized/equities` — THE flagship: unified cross-issuer equity API
  (Robinhood + xStocks public API + Ondo/Chainlink feeds) in one schema (gap #1).
Pricing: free tier + x402 USDC per-call above quota, same rails as the rest of the catalog.
Register in the x402 directory + `api/v1/_catalog.js`.

### RH-03 — SDK: `@three-ws/robinhood-chain` (first real SDK in market)
Clean-room TypeScript, `viem@^2.55.0` peer dep. Modules: stockTokens (registry/prices/
multipliers), swap (Uniswap v3/UniswapX quoting + execution, memecoin + stock paths),
launchpads (NOXA/Odyssey watch), usdg (transfers + x402-style payment helper), portfolio.
Publish under `packages/`, README + runnable examples, testnet E2E in CI. npm publish needs
owner token (known blocker — queue behind walk/tour/IRL publishes).

### RH-04 — MCP server + agent skill
`robinhood-chain` MCP: token discovery, quotes (Chainlink + DEX), swap building, portfolio,
launchpad feed — wraps RH-01/RH-02/RH-03. Paid tools via x402 like our existing MCP. Plus a
Claude Agent Skill. The two existing MIT MCPs are read-only and 0-star; ours is the productized
one wired to real market data.

### RH-05 — /markets integration (display)
- Robinhood Chain section in /markets: stocks table (24/7 equity prices — a thing CoinGecko
  can't show properly), memecoin screener, chain TVL page.
- Detail pages per Stock Token and per coin, following the markets detail-page patterns.
- Cross-venue equity screener page: same ticker across Robinhood Chain / xStocks / Ondo with
  premium/discount + arb spread (gap #2 — screenshot bait).

### RH-06 — Purchase flow
Swap on chain 4663 via Uniswap/1inch routed through our existing EVM wallet flows (MetaMask
agentic CLI already in stack; chain def from viem). Memecoins: open to all. Stock Tokens:
geo-gate buy UI for US (display remains open); server-side check + clear disclosure copy.
Bridge deep-links (LI.FI/Relay/Across) for funding.

### RH-07 — /play: Live 3D worlds for Robinhood Chain coins
Port the pump.fun /play formula: deterministic 3D world per launchpad coin (NOXA graduations,
CoinGecko meme category), walk in as avatar, live trades driving the world via a firehose built
on `wss://feed.mainnet.chain.robinhood.com` (gap #5 — this firehose is also sellable via RH-02).
Stretch: Stock Token "trading floors" — a 3D floor per ticker (AAPL floor at 2am on a Saturday,
live Chainlink tape) — display-only, no geo issue.

### RH-08 — x402 USDG settlement rail (accept payments ON the chain)
Add Robinhood Chain USDG as an accepted x402 settlement network for our existing paid endpoints
(we already run multi-rail: Solana USDC, X Layer). r0x proves demand; we'd be the first
established x402 catalog accepting USDG-on-4663. Needs: settlement wallet on 4663, facilitator
support, tiny ETH gas float.

## Sequencing

Phase 1 (now): RH-01 → RH-02 (stocks/coins/chain endpoints) + RH-05 (markets display).
Phase 2: RH-07 (/play worlds — needs the firehose from RH-02), RH-03 (SDK).
Phase 3: RH-04 (MCP), RH-06 (purchase), RH-08 (USDG rail).
Marketing: X thread per phase (x-posting playbook); submit toolkit to Arbitrum Open House
buildathons for distribution.

## Owner decisions needed
1. Blanket commit approval for Robinhood Chain content in this campaign, or per-commit sign-off?
2. RH-06 Stock Token purchase geo-gating: US-block buy UI only, or exclude Stock Token
   purchase entirely (display + memecoin swaps only) at launch?
3. RH-08 needs a funded settlement wallet on chain 4663 (ETH gas float; owner keys policy).
4. npm publish token for RH-03 (existing blocker across all package publishes).
