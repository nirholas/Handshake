# erc8056

Reference implementation of **[ERC-8056](https://eips.ethereum.org/EIPS/eip-8056)** (Scaled UI
Amount / `uiMultiplier()`), the corporate-actions standard used by tokenized equities such as
Robinhood Chain Stock Tokens.

When a tokenized stock splits or reinvests a dividend, its raw ERC-20 balances never change.
Instead the issuer updates one number, `uiMultiplier()`, and every correct integration scales
its display and valuation by it, exactly once. Every naive integration gets this wrong in one of
two ways: showing raw balances as shares (understates positions) or re-applying the multiplier
to an already-adjusted price feed (double-counts corporate actions). This package makes both
mistakes hard: the math is bit-for-bit the on-chain math, and the price types make the wrong
valuation branch a compile error.

The full explainer, with live on-chain data: **https://nirholas.github.io/erc8056/**

## Website

The site in [`docs/`](docs/) is a single self-contained `index.html` (inline CSS + JS, zero external requests, works from `file://`). It presents ERC-8056 as a **typewritten RFC with living margins**: the spec reads as a monospaced document, every clause carries a margin annotation that expands in place when engaged, and following a cross-reference (`§4`, `§5`, `§6`) draws a connecting line between the clauses. Every figure is real, pinned to live chain 4663 state.

Deploy the `docs/` folder anywhere static:

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/nirholas/erc8056)
[![Deploy to Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/nirholas/erc8056)
[![Deploy to Cloudflare Pages](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nirholas/erc8056)

Config lives in [`wrangler.toml`](wrangler.toml), [`netlify.toml`](netlify.toml), and [`vercel.json`](vercel.json). Each points the platform at `docs/`.

- Tiny: about 2.5 kB gzipped, zero runtime dependencies (viem is a peer).
- Verified: every semantic claim is pinned to live Robinhood Chain mainnet state by the test
  suites (Vitest live reads + Foundry fork tests), not folklore.
- Solidity included: `IERC8056.sol` interfaces and a commented reference consumer contract.

## Install

```sh
npm install erc8056 viem
```

## Quickstart

```ts
import { createPublicClient, http } from 'viem'
import { robinhood } from 'viem/chains'
import {
  readUiMultiplier, readMultiplierState, watchMultiplier,
  trueBalance, trueValue, adjustedPrice, rawPrice,
  supportsErc8056, detectErc8056,
} from 'erc8056'

const client = createPublicClient({ chain: robinhood, transport: http() })
const WEEK = '0xc93a8c440CEa26D7445dF01729f193b27965099f' // a live Stock Token

// The multiplier: underlying shares per token, 18-decimal fixed point.
const multiplier = await readUiMultiplier(client, WEEK)
// 2006182524271844660n on 2026-07-15: 1 raw WEEK token = 2.0062 shares.

// Rule 1 - positions. Raw balances understate holdings:
const shares = trueBalance({ raw: rawBalance, multiplier })
// Bit-for-bit the on-chain balanceOfUI() math (raw * multiplier / 1e18, floored).

// Rule 2 - valuation. Declare what kind of price you hold; a bare number
// does not compile:
const viaFeed = trueValue({
  raw: rawBalance,
  multiplier,
  price: adjustedPrice(100.62), // Chainlink on Robinhood Chain: USD per TOKEN,
})                              // multiplier already applied - it is NOT re-applied

const viaShareQuote = trueValue({
  raw: rawBalance,
  multiplier,
  price: rawPrice(100.53), // off-chain equity quote: USD per SHARE,
})                         // multiplier applied exactly once

// Corporate-action monitoring (UIMultiplierUpdated events):
const unwatch = watchMultiplier(client, WEEK, (update) => {
  console.log(`${update.oldMultiplier} -> ${update.newMultiplier}, effective ${update.effectiveAt}`)
})

// Scheduled-but-not-yet-effective changes:
const { current, pending } = await readMultiplierState(client, WEEK)

// Graceful detection - a plain ERC-20 resolves to false, nothing throws:
await supportsErc8056(client, someToken)
await detectErc8056(client, someToken) // per-extension ERC-165 report
```

## The one trap, spelled out

On Robinhood Chain, **Chainlink Stock Token feed answers are already multiplier-adjusted**: the
answer is the price of one TOKEN, not one underlying share. Robinhood's docs state it, and the
market confirms it (at block 10,745,112 the Uniswap v3 SGOV/USDG pool priced the token at
$100.6075 vs the feed's $100.6215, while the unadjusted share price was $100.5252). So:

| Your price source | Construct with | Multiplier applied by `trueValue` |
| --- | --- | --- |
| Chainlink feed on Robinhood Chain | `adjustedPrice(usd)` | never (already inside the price) |
| Off-chain share quote (exchange, broker) | `rawPrice(usd)` | exactly once |

Passing a bare `number` as `price` is a type error. That is deliberate.

## API

| Export | What it does |
| --- | --- |
| `readUiMultiplier(client, token)` | Read `uiMultiplier()`; throws `Erc8056NotImplementedError` for non-implementers |
| `supportsErc8056(client, token)` | `true`/`false`, never throws; ERC-165 first, direct probe fallback |
| `detectErc8056(client, token)` | Full report: core, ERC-165 route, per-extension flags |
| `readMultiplierState(client, token)` | Current + scheduled multiplier (`pending` is `null` unless a change is queued) |
| `watchMultiplier(client, token, cb)` | Poll-based watcher for `UIMultiplierUpdated`; returns unwatch |
| `trueBalance({ raw, multiplier })` | Underlying-share balance, floored like on-chain `balanceOfUI` |
| `trueValue({ raw, multiplier, price, decimals? })` | USD value with the multiplier applied exactly once |
| `adjustedPrice(usd)` / `rawPrice(usd)` | Branded price constructors (the only way to make a `StockPrice`) |
| `toUiAmount(raw, multiplier)` / `fromUiAmount(ui, multiplier)` | Spec conversion math, computed locally (the on-chain conversion extension is not deployed) |
| `erc8056Abi`, `INTERFACE_IDS`, `MULTIPLIER_ONE` | ABI fragments, ERC-165 IDs, `10n ** 18n` |

All interface IDs (`0xa60bf13d`, `0x4bd27648`, `0x57854fc3`, `0xd890fd71`) are from the spec,
re-derived from selector XOR, and confirmed by live `supportsInterface` reads.

## Solidity

`contracts/src/IERC8056.sol` declares all four spec interfaces plus an `ERC8056InterfaceIds`
constants library. `contracts/src/ERC8056Consumer.sol` is the commented reference pattern for
consuming ERC-8056 tokens from another contract: detection, true balances, and both valuation
branches, with the multiplier deliberately absent from the adjusted-feed branch.

Fork tests run against live mainnet Stock Tokens (read-only, no keys, no funds):

```sh
cd contracts
forge soldeer install
forge test --fork-url https://rpc.mainnet.chain.robinhood.com
```

They assert, against the chain itself: mandatory ERC-165 answers on AAPL/SGOV/WEEK, live
multiplier values, `totalSupplyUI == totalSupply * uiMultiplier / 1e18` bit-for-bit,
`balanceOfUI` agreement on a real top holder, the absence of the conversion extension, and that
the valuation math never re-applies the multiplier.

## Deployed reality vs the draft

Facts about Robinhood's deployed `Stock` implementation
([`0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2`](https://robinhoodchain.blockscout.com/address/0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2?tab=contract),
verified source) that the spec draft alone will not tell you:

- The optional transfer event is emitted as `TransferWithScaledUI`, not the draft's
  `TransferWithUIAmount`. Both event ABIs ship in `erc8056Abi`; indexers need the deployed
  flavor's topic (`0x37e7f0db...3802`).
- The conversion extension (`toUIAmount`/`fromUIAmount`) is not implemented; calls revert. This
  package computes the conversions locally instead.
- Issuer updates go through `updateMultiplier(uint256)` / `updateMultiplier(uint256,uint256)`.
- After a scheduled change activates, `newUIMultiplier()`/`effectiveAt()` retain the last
  applied values; "pending" means a future `effectiveAt` AND a differing value.
  `readMultiplierState` encodes exactly that.

## Tests

```sh
npm test          # unit math + type-level tests (misuse must not compile)
npm run test:live # live reads against Robinhood Chain mainnet (public RPC, read-only)
```

## Docs site

`docs/` is a self-contained static site (the explainer above, with a live multiplier widget
reading chain 4663 client-side). One-time GitHub Pages setup: repository Settings, then Pages,
then deploy from branch `main`, folder `/docs`.

## Publishing (owner step)

```sh
npm publish --access public
```

## License

All rights reserved. See [LICENSE](./LICENSE).

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
