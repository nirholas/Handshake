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
  `adrydevel/robinhood-chain-sdk` audited from the author's own zip 2026-07-11: VAPORWARE
  (fake chain ID 64288, dead RPC domain, placeholder addresses, padded tests) — build
  clean-room, do not fork.
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
8. Wallet/onboarding kit (no wagmi connector kit; 4663 is not a default network anywhere).
9. Canonical tokenlist, alert bots, chain status page, USDG human-checkout — all absent.

## Workstreams

The pack expanded into 19 prompts — see [00-INDEX.md](00-INDEX.md) for the authoritative list,
waves, and status. Original workstream sketch (RH-01…RH-08) for context:

- **RH-01 Chain plumbing** → shipped inside the core SDK (prompt 01, BUILT 2026-07-12).
- **RH-02 Market Data API + x402** → prompts 04 (standalone hood-api) + 12 (three.ws api/v1).
- **RH-03 SDK** → prompts 01/02/03 (core, hood-js, hoodkit).
- **RH-04 MCP + agent skill** → prompt 06.
- **RH-05 /markets display** → prompt 12.
- **RH-06 Purchase flow** → prompt 12 (memecoins open; Stock Tokens display-only pending owner).
- **RH-07 /play worlds + firehose** → prompt 13.
- **RH-08 x402 USDG settlement rail** → prompt 05 (+ INTEGRATION.md seam for three.ws).
- Later additions: 07 traders, 08 launcher, 09 examples, 10 tutorials, 11 CLI, 14 connect kit,
  15 tokenlist, 16 alerts, 17 erc8056, 18 status, 19 hood-pay.

## Sequencing

Wave 1 (done) → Wave 2 (libraries/infra) → Wave 3 (applications + three.ws surfaces) →
Wave 4 (tutorials last). Marketing: X thread per phase (x-posting playbook); submit toolkit to
Arbitrum Open House buildathons for distribution; list hood-api on x402 bazaars/x402scan;
register MCPs in the modelcontextprotocol registry + Smithery.

## Owner decisions needed
1. Blanket commit approval for Robinhood Chain content in this campaign, or per-commit sign-off?
2. Stock Token purchase geo-gating: US-block buy UI only, or display-only at launch?
3. Funded settlement wallet on chain 4663 (ETH gas float + USDG) for hood402/hood-pay mainnet.
4. npm publish token (all packages ship publish-ready).
5. Testnet faucet requires Turnstile + Google Sign-In in a real browser — grab funds once for
   the shared test wallet, or approve an alternative funding path.
