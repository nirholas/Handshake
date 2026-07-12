# 01 — Core SDK: `hoodchain` (the first real Robinhood Chain SDK)

Read `prompts/robinhood-chain/_shared.md` first. It is binding.

## Mission
Build the definitive TypeScript SDK for Robinhood Chain at `robinhood/robinhood-chain-sdk/`.
There is NO official SDK and nothing real on npm — this is a first-mover product and every other
prompt in this pack builds on it. It must be the library you'd expect from Stripe: typed,
tree-shakeable, documented, verified against the live chain.

Names: GitHub repo `robinhood-chain-sdk`; npm `hoodchain` (fallbacks: `hoodchain-sdk`,
`rhchain`). Check availability per `_shared.md`.

## Modules (all real, all verified on-chain)

1. **`client`** — thin factory over viem: `createHoodClient({ chain: 'mainnet' | 'testnet', rpcUrl?, transport? })`
   returning typed public/wallet clients pinned to `robinhood`/`robinhoodTestnet` from
   `viem/chains` (peer dep `viem@^2.55.0`). Multicall batching on by default.
2. **`stocks`** — the Stock Token registry + reads:
   - Build the REAL registry: scrape `https://docs.robinhood.com/chain/contracts` +
     cross-check `BankrBot/skills` `known-contracts.json` + verify every address on Blockscout
     (`/api/v2/tokens/{address}`). Ship it as generated, checked-in data
     (`src/registry/stock-tokens.json`) with a `scripts/refresh-registry.mjs` regenerator that
     re-verifies live. Include symbol, name, address, Chainlink feed address, decimals.
   - `getQuote(symbol)` — Chainlink `latestRoundData()` with staleness guard (configurable
     `maxAgeSeconds`, typed `StaleFeedError`).
   - `getMultiplier(symbol)` — ERC-8056 `uiMultiplier()` read with graceful handling when a
     token predates the interface.
   - `getPosition(address, symbol)` / `getPortfolio(address)` — multiplier-correct balances and
     USD valuation (this is the gap every generic tracker gets wrong — it is the SDK's flagship
     correctness claim; test it explicitly).
3. **`swap`** — real Uniswap v3 quoting + execution on chain 4663: QuoterV2 `quoteExactInputSingle`
   (+ multi-hop via USDG/WETH routes), swap calldata building through the canonical router,
   slippage bounds, deadline handling. Resolve and verify the deployed Uniswap addresses on
   4663 from official Uniswap deployment docs/Blockscout — do not assume Ethereum-mainnet
   addresses. Works for memecoins and Stock Tokens alike; Stock Token swaps emit the eligibility
   disclosure from `_shared.md` in JSDoc and README.
4. **`usdg`** — USDG address/decimals/`transfer`/`approve`/`permit` (EIP-2612 if the contract
   supports it — verify on Blockscout), `formatUsdg`/`parseUsdg`.
5. **`launchpads`** — watch NOXA + The Odyssey: discover their factory/bonding-curve contracts
   (research their verified contracts on Blockscout; the sniper-bot repos tagged
   `robinhood-chain` on GitHub reference them), decode creation + trade events, expose
   `watchLaunches(onLaunch)` and `getRecentLaunches()`.
6. **`feed`** — sequencer firehose client for `wss://feed.mainnet.chain.robinhood.com`:
   reconnecting WebSocket, decoded L2 message stream, plus a filtered
   `watchTransfers({ token })` helper built on RPC logs for consumers who want simpler events.
7. **`errors` / `types`** — typed error hierarchy, exhaustive exported types, JSDoc on every
   public symbol.

## Non-functional requirements
- ESM + CJS dual build (tsup or tsc), `exports` map, `types`, Node ≥ 20, zero runtime deps
  besides viem (+ `ws` for Node WebSocket only, optional-peer for browser).
- Vitest suite: unit (registry integrity — every entry has a Blockscout-verified checksum
  address; quote math; multiplier math) + integration (`test:live`: real mainnet reads —
  quote AAPL or whichever tokens exist, read USDG totalSupply; real testnet swap E2E using
  faucet ETH + faucet TSLA — actually execute it and assert the receipt).
- `examples/` with 5 runnable scripts (quote, portfolio, swap-testnet, watch-launches, firehose).
- `docs/` static site per `_shared.md`: landing page with LIVE ticking Stock Token prices read
  client-side from the public RPC (this is the screenshot), quickstart, full API reference
  (generated from JSDoc via typedoc into the static site, styled to match), architecture page.

## Done checklist (beyond CLAUDE.md's)
- [ ] Registry ships ≥ 90 verified Stock Tokens with feeds (or the true on-chain count with
      evidence if fewer exist — never pad).
- [ ] `npm test` green; `npm run test:live` green with pasted output; testnet swap tx hash in report.
- [ ] `npm pack` clean; README quickstart runs verbatim in a fresh dir via `npm i ../robinhood-chain-sdk`.
- [ ] docs/index.html shows live prices when opened locally.
- [ ] Report per `_shared.md`, including the chosen npm name and registry token count.
