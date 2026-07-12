# hoodchain

**The TypeScript SDK for [Robinhood Chain](https://docs.robinhood.com/chain/) (chain ID 4663).**

Typed, tree-shakeable, viem-native. Stock Tokens with multiplier-correct math, Chainlink
quotes with staleness guards, Uniswap v3 swaps, USDG, launchpad watchers for NOXA & The
Odyssey, and the raw sequencer firehose.

- **95 verified Stock Tokens** — discovered on Blockscout, verified on-chain against the
  single shared `Stock` beacon, shipped as checked-in data you can regenerate and re-verify
  with one command.
- **34 live Chainlink feeds** — mapped from Chainlink's official directory, each verified
  answering `latestRoundData()` at generation time.
- **Multiplier-correct portfolios** — the SDK's share math is asserted against each token's
  own on-chain `balanceOfUI()` in the live test suite.
- **Zero runtime dependencies** — `viem` is a peer; `ws` is an optional peer (Node ≤ 21
  firehose only).

Docs: **https://nirholas.github.io/robinhood-chain-sdk/** · API reference: `/api` on the docs site

## Install

```bash
npm install hoodchain viem
```

Node ≥ 20. Until the package is on npm, install from a checkout: `npm i ../robinhood-chain-sdk`.

## Quickstart

```ts
import { createHoodClient, getQuote, getPortfolio } from 'hoodchain'

const hood = createHoodClient() // mainnet 4663, public RPC, multicall batching on

// Chainlink quote — the answer is the multiplier-adjusted price of one TOKEN
const aapl = await getQuote(hood, 'AAPL')
console.log(`AAPL: $${aapl.priceUsd}`)

// Multiplier-correct portfolio for any address
const portfolio = await getPortfolio(hood, '0xYourAddress')
console.log(`total: $${portfolio.totalUsd.toFixed(2)}`)
for (const p of portfolio.positions) {
  console.log(`${p.symbol}: ${p.balanceTokens} tokens = ${p.shareEquivalent} shares → $${p.valueUsd}`)
}
```

### The two mistakes every generic tracker makes (and this SDK doesn't)

Stock Tokens implement ERC-8056: `uiMultiplier()` is the 1e18-scaled shares-per-token
ratio, and it rises with splits and reinvested dividends instead of rebasing balances.

1. **USD value is `balance × feed price` — nothing else.** Robinhood's Chainlink feeds
   already return the multiplier-adjusted token price. Multiplying by the multiplier again
   double-counts every corporate action.
2. **Raw balances are not share counts.** Share-equivalents are
   `balance × uiMultiplier ÷ 1e18`. hoodchain computes both numbers per position, and its
   live tests assert the share math equals the token contract's own `balanceOfUI()`.

## Modules

| Module | What you get |
| --- | --- |
| `client` | `createHoodClient({ chain, rpcUrl?, transport?, account? })` over viem's official `robinhood`/`robinhoodTestnet` chain defs |
| `stocks` | `getQuote` (staleness-guarded), `getMultiplier`, `getPosition`, `getPortfolio` |
| registry | `listStockTokens`, `getStockToken('TSLA')`, `getRegistry()` — 95 verified entries, JSON also exported at `hoodchain/registry/stock-tokens.json` |
| `swap` | `quoteSwap` (all fee tiers + two-hop via WETH/USDG), `buildSwapTx`, `executeSwap`, `ensureApproval` |
| `usdg` | `parseUsdg`/`formatUsdg` (6 decimals), balances, transfers, approvals |
| `launchpads` | `getRecentLaunches`, `watchLaunches`, `watchCurveTrades`, `watchGraduations` for NOXA + The Odyssey |
| `feed` | `subscribeFeed` — the sequencer firehose, transactions decoded pre-RPC; `watchTransfers` for simple confirmed events |
| `errors` | typed hierarchy under `HoodchainError` (`StaleFeedError`, `NoRouteError`, …) |

### Swaps

```ts
import { parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createHoodClient, executeSwap, TESTNET_ADDRESSES, TESTNET_STOCK_TOKENS } from 'hoodchain'

const hood = createHoodClient({
  chain: 'testnet',
  account: privateKeyToAccount(process.env.ROBINHOOD_CHAIN_PRIVATE_KEY as `0x${string}`),
})

const { hash, receipt, quote } = await executeSwap(hood, {
  tokenIn: TESTNET_ADDRESSES.weth,
  tokenOut: TESTNET_STOCK_TOKENS.NFLX,
  amountIn: parseEther('0.0001'),
}) // quotes → approves if needed → sends → waits for the receipt
```

Routing probes every v3 fee tier directly plus two-hop routes through WETH and USDG and
takes the best output. Zero-liquidity pools (common for Stock Token pairs) are skipped;
if nothing fills you get a typed `NoRouteError`.

> **Stock Token eligibility.** Stock Tokens are tokenized debt securities (issuer:
> Robinhood Assets (Jersey) Ltd) and may not be offered, sold, or delivered to US persons
> (additional limits: Canada, UK, Switzerland). The restriction is legal/front-end, not
> contract-level. Reads and sells are never gated, but any swap that *acquires* a
> canonical Stock Token throws `StockTokenEligibilityError` until the operator passes
> `acknowledgeStockTokenEligibility: true` to `createHoodClient`, affirming eligibility.

### Launchpads

```ts
import { createHoodClient, watchLaunches } from 'hoodchain'

const hood = createHoodClient()
const unwatch = watchLaunches(hood, (launch) => {
  // NOXA launches list instantly with a pool; Odyssey launches start on a bonding curve
  console.log(`[${launch.launchpad}] ${launch.token} by ${launch.creator}`)
})
```

### Firehose

```ts
import { subscribeFeed } from 'hoodchain'

const sub = await subscribeFeed((msg) => {
  for (const tx of msg.transactions) console.log(tx.hash, tx.transaction.to)
}) // every sequenced tx, ~100–300ms before it's queryable over RPC
sub.close()
```

Uses the global `WebSocket` on Node ≥ 22 and browsers; on Node 20/21 install the optional
`ws` peer.

## The registry

`src/registry/stock-tokens.json` is generated and checked in. Regenerate + re-verify:

```bash
npm run refresh-registry
```

The pipeline discovers canonical `<Name> • Robinhood Token` entries on Blockscout,
verifies **on-chain** that every token's EIP-1967 beacon slot points at the one shared
`Stock` beacon, reads back symbol/name/decimals/multiplier via multicall, maps Chainlink's
official feed directory by ticker, verifies every feed answers with a positive 8-decimal
price, and refuses to write on any mismatch. Provenance (block number, counts, sources)
is embedded in the JSON.

## Examples

Five runnable scripts in [`examples/`](./examples) — quotes, portfolio, a real testnet
swap, launchpad watching, and the firehose. `npm run build` first (they import the built
package by name), then e.g. `npx tsx examples/quote.ts`.

## Testing

```bash
npm test          # unit: registry integrity, quote/multiplier math, calldata, feed decoding
npm run test:live # integration: real mainnet reads + (env-gated) real testnet swap
```

`test:live` hits the public RPC: Chainlink quotes for every priced token, USDG supply,
QuoterV2 quotes both directions, launchpad log scans, 30s of live firehose, and the
`balanceOfUI()` cross-check. The testnet swap E2E runs when `ROBINHOOD_CHAIN_PRIVATE_KEY`
holds a funded testnet key — fund one at
[faucet.testnet.chain.robinhood.com](https://faucet.testnet.chain.robinhood.com/)
(browser-only: Cloudflare Turnstile + Google Sign-In; drips 0.01 ETH + five of each test
Stock Token per 24 h).

Wallet keys live in env vars only. Never commit `.env` (already gitignored).

## Docs site (GitHub Pages)

The static site in [`docs/`](./docs) works by opening `docs/index.html` locally — the
landing page reads live Stock Token prices from the public RPC in your browser. One-time
Pages setup: **Settings → Pages → Deploy from a branch → `main` → `/docs`**. Regenerate
the API reference with `npm run docs:api`.

## Publishing (maintainers)

```bash
npm run build && npm test
npm publish --access public
```

## License

Apache-2.0 © 2026 nirholas

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
