# Robinhood Chain on three.ws

`/markets/robinhood` is three.ws's home for [Robinhood Chain](https://docs.robinhood.com/chain/) —
a permissionless Arbitrum Orbit L2 (chain ID `4663`, settles to Ethereum, ETH gas, ~100ms blocks)
that hosts ~95 tokenized US equities ("Stock Tokens") trading 24/7 alongside a live memecoin
ecosystem. Nothing else offers a clean market-data view of it: GeckoTerminal doesn't index the
chain, and general aggregators have no equity semantics (Chainlink NAV vs. DEX price, corporate
actions). This page — and the API behind it — is that missing layer.

## What's on the page

**`/markets/robinhood`** has three tabs:

- **Stocks** — the 24/7 tokenized-equity board. For every Stock Token: the Chainlink NAV price
  (read live on-chain), the deepest Uniswap DEX price, the premium/discount between them, 24h DEX
  volume, and liquidity. Sortable and searchable.
- **Coins** — a memecoin screener across the chain's two launchpads (**NOXA**, an instant
  Uniswap v3 launcher, and **The Odyssey**, a pump.fun-style bonding curve), split into CoinGecko's
  "Robinhood Chain Meme" / "Robinhood Chain Stocks Ecosystem" / "Robinhood Ecosystem" categories,
  plus a live feed of recent launches read directly from on-chain logs.
- **Chain** — block height, gas, transaction/address counts, and 90 days of chain TVL (DefiLlama).

Every coin and Stock Token links to its own detail page —
`/markets/robinhood/stock/:symbol` (e.g. `/markets/robinhood/stock/AAPL`) and
`/markets/robinhood/coin/:address` — with a price history chart, a full stats grid, holders,
recent transfers, and contract links (Blockscout).

## The buy flow

Coin detail pages carry a real buy panel: connect an injected EVM wallet (MetaMask etc.), switch
to Robinhood Chain (4663) via `wallet_switchEthereumChain` (falling back to
`wallet_addEthereumChain` if the wallet has never seen the chain), get a live Uniswap v3 quote from
`QuoterV2` across all four fee tiers, and swap through `SwapRouter02`'s `exactInputSingle` with a
user-set slippage tolerance. Wallets with no ETH on 4663 yet get a bridge deep-link
([LI.FI](https://jumper.exchange/)) instead of a dead end.

**Stock Tokens are display-only.** They're tokenized debt securities issued by Robinhood Assets
(Jersey) Ltd and may not be offered, sold, or delivered to US persons (additional limits: Canada,
UK, Switzerland) — a legal restriction enforced at front-ends, not the contract level. Their detail
page carries the disclosure and an outbound "Trade on DEX" link instead of an in-house swap; the
buy path is cleanly ready to enable once an operator affirms eligibility (swap
`mountStockEligibilityGate` for `mountBuyPanel` in `src/robinhood-stock.js` — no other wiring
changes).

## API — `/api/v1/robinhood/*`

Free, keyless, real data only:

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/robinhood/chain` | Block height, gas, tx/address counts, chain TVL + 90-day history |
| `GET /api/v1/robinhood/stocks` | Every Stock Token: NAV, DEX price, premium, volume, liquidity (`?q=`, `?sort=`) |
| `GET /api/v1/robinhood/stocks-detail?symbol=AAPL` | One Stock Token in depth: NAV history, all DEX pairs, holders, transfers, links |
| `GET /api/v1/robinhood/coins?category=meme` | Memecoin screener (`category`: `meme` \| `stocks-ecosystem` \| `ecosystem`; `sort`: `market_cap` \| `volume` \| `gainers` \| `losers`) |
| `GET /api/v1/robinhood/coins-detail?address=0x…` | One coin: pools, market stats, holders, transfers, links |
| `GET /api/v1/robinhood/launches` | Recent launches from NOXA + The Odyssey, newest first |

Paid via x402 ($0.002 USDC, Base or Solana):

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/robinhood/portfolio?address=0x…` | Multiplier-correct Stock Token portfolio: every held symbol's true position (raw balance × ERC-8056 `uiMultiplier`) priced at the live Chainlink NAV, plus a total USD value |

Every response carries `source` and `asOf` fields. A miss is a structured error, never a bare 500.

### Why the multiplier matters

Stock Tokens implement **ERC-8056** (`uiMultiplier()`): corporate actions (splits, dividends) are
applied by adjusting the multiplier, not by rebasing balances. `raw balance × uiMultiplier / 1e18
= true position` — reading the raw ERC-20 balance alone misstates a holding after any corporate
action. The portfolio endpoint (and the stocks board's `uiMultiplier` column) always does this
math; Chainlink feed prices are already multiplier-adjusted, so they're never re-multiplied.

## Data sources

- **Chainlink NAV** — read live on-chain via one multicall across every feed-backed Stock Token
  (`latestRoundData` + `uiMultiplier` + `totalSupply`), cached 20s. Never 95 separate RPC calls.
- **DEX price / liquidity / volume** — [DexScreener](https://dexscreener.com) (`chainId: "robinhood"`),
  batched 30 addresses per call for the board.
- **Holders, transfers, token stats, chain stats** — [Blockscout](https://robinhoodchain.blockscout.com) Pro API.
- **Chain TVL** — [DefiLlama](https://defillama.com/chain/robinhood-chain).
- **Memecoin screener** — CoinGecko categories `robinhood-chain-meme`, `robinhood-chain-stocks-ecosystem`, `robinhood-ecosystem`.
- **Recent launches** — decoded on-chain logs from the NOXA and Odyssey launchpad factories
  (Blockscout's log API, filtered by event topic — the public RPC's `eth_getLogs` caps at 10k
  matched logs and can't reliably answer "what's newest").

## Related surfaces

- [Market Data API](./market-data-api.md) — the same paid-endpoint pattern (x402, `priceFor`,
  service-catalog descriptor) applied to the rest of three.ws's market data.
- [Trust primitives](./trust-primitives.md) — score a Robinhood Chain wallet's cross-chain
  reputation before transacting with it.
- [x402 distribution](./x402-distribution.md) — how the paid portfolio endpoint gets discovered
  across the x402 ecosystem.
