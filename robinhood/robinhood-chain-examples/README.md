# Robinhood Chain Examples

A collection of runnable example projects for **Robinhood Chain** — an
Arbitrum Orbit L2 (chain ID `4663`, testnet `46630`) that hosts Robinhood's
tokenized Stock Tokens, a Chainlink price-feed registry, USDG, and two native
memecoin launchpads (NOXA and The Odyssey).

Every example is a small, self-contained Node.js (or static HTML) project you
can `npm install` and run in under a minute. They start from a raw `viem`
read with no SDK and build up to a live-updating dashboard, showing exactly
what the [`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk) SDK
does for you at each step.

## Prerequisites

- **Node.js ≥ 20** for every example (all use native ESM and, where relevant,
  the built-in `WebSocket`/`fetch`).
- **No wallet, key, or funds** are required for examples 01, 02, 03, 05, 06,
  07, and 08 — they are read-only against the public Robinhood Chain RPC.
- Example 04's swap **quote** is also read-only; **executing** the swap needs
  a funded Robinhood Chain testnet key (see [Environment variables](#environment-variables)).
- The [`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk) SDK is
  not published to npm yet. Every example that depends on it installs it as a
  local sibling build — see [Installing `hoodchain`](#installing-hoodchain)
  below. Examples 01 and 07 use plain `viem` only and need no SDK install.

## Installing `hoodchain`

Examples 02, 03, 04, 05, 06, and 08 depend on the `hoodchain` npm package
(pinned `^0.1.0` in each `package.json`). Until it's published, install it
from the local SDK build after the regular `npm install`:

```bash
npm install
npm install ../../../robinhood-chain-sdk
```

That relative path assumes this repo (`robinhood-chain-examples`) and
[`robinhood-chain-sdk`](https://github.com/nirholas/robinhood-chain-sdk) are
checked out as siblings under a common parent directory. Once `hoodchain` is
on npm, drop the second command — the version pinned in `package.json` is
enough.

## Examples

| # | Example | What it demonstrates | Run |
|---|---------|----------------------|-----|
| 01 | [`read-stock-price`](examples/01-read-stock-price) | Read one Stock Token's Chainlink price feed with `viem` only — no SDK, addresses spelled out by hand. | `cd examples/01-read-stock-price && npm install && npm start` (or `node index.js NVDA`) |
| 02 | [`stock-price-sdk`](examples/02-stock-price-sdk) | The same read in three lines using `hoodchain`'s bundled 95-token registry and typed errors. | `cd examples/02-stock-price-sdk && npm install && npm install ../../../robinhood-chain-sdk && npm start` (or `node index.js MSFT GOOGL AMD`) |
| 03 | [`portfolio-valuation`](examples/03-portfolio-valuation) | Multiplier-correct portfolio valuation — the ERC-8056 `uiMultiplier()` math generic trackers get wrong, swept across all 95 tokens in one multicall. | `cd examples/03-portfolio-valuation && npm install && npm install ../../../robinhood-chain-sdk && npm start` (or `node index.js 0xYourAddress`) |
| 04 | [`swap-memecoin`](examples/04-swap-memecoin) | Quote (and, with a funded key, execute) a Uniswap v3 swap on Robinhood Chain testnet — the same code path swaps mainnet memecoins. | `cd examples/04-swap-memecoin && npm install && npm install ../../../robinhood-chain-sdk && npm start` (quote only) or `ROBINHOOD_CHAIN_PRIVATE_KEY=0x... node index.js --execute` |
| 05 | [`watch-launches`](examples/05-watch-launches) | Stream NOXA and The Odyssey launchpad activity — recent-history scan plus a live poll, decoded into one `Launch` shape. | `cd examples/05-watch-launches && npm install && npm install ../../../robinhood-chain-sdk && npm start` (or `node index.js 0` to stream forever) |
| 06 | [`firehose`](examples/06-firehose) | Decode the raw Arbitrum Nitro sequencer feed (`wss://feed.mainnet.chain.robinhood.com`) into typed transactions ~100–300ms before they're queryable over RPC. | `cd examples/06-firehose && npm install && npm install ../../../robinhood-chain-sdk && npm start` (or `node index.js 30 0xAddress` to filter) |
| 07 | [`live-price-webpage`](examples/07-live-price-webpage) | A single dependency-free `index.html` showing live Chainlink prices for 11 Stock Tokens, read client-side via JSON-RPC `eth_call` — no backend, no build step. | `cd examples/07-live-price-webpage && npm install && npm start` → http://localhost:8007 (or just open `index.html` directly) |
| 08 | [`portfolio-dashboard`](examples/08-portfolio-dashboard) | A small Vite + React dashboard wrapping example 03's portfolio logic in a polling hook (`useHoodPortfolio`) with designed loading/empty/error states. | `cd examples/08-portfolio-dashboard && npm install && npm install ../../../robinhood-chain-sdk && npm run dev` |

Each example folder has its own `README.md` with a full walkthrough, expected
output, and the specific concept it's teaching — start with the table above,
then open the linked README for the one you want to run.

## Environment variables

| Variable | Used by | Required? |
|----------|---------|-----------|
| `ROBINHOOD_CHAIN_PRIVATE_KEY` | [`04-swap-memecoin`](examples/04-swap-memecoin) | Only to execute a swap (`--execute` flag). Must be a testnet key funded from the [testnet faucet](https://faucet.testnet.chain.robinhood.com/). Without it, the example prints a quote and exits — it never fabricates a transaction. |
| `PORT` | [`07-live-price-webpage`](examples/07-live-price-webpage) | Optional. Overrides the default port (`8007`) for the convenience static server (`serve.js`). |

No example reads a `.env` file or requires an API key — every read goes
straight to the public Robinhood Chain RPC (`https://rpc.mainnet.chain.robinhood.com`)
or the public sequencer feed (`wss://feed.mainnet.chain.robinhood.com`).

## Repository layout

```
robinhood-chain-examples/
├── examples/
│   ├── 01-read-stock-price/       viem-only baseline
│   ├── 02-stock-price-sdk/        hoodchain SDK equivalent
│   ├── 03-portfolio-valuation/    multiplier-correct portfolio math
│   ├── 04-swap-memecoin/          Uniswap v3 quote + guarded execute
│   ├── 05-watch-launches/         NOXA + The Odyssey launch stream
│   ├── 06-firehose/               raw sequencer feed decoder
│   ├── 07-live-price-webpage/     zero-dependency static price page
│   └── 08-portfolio-dashboard/    Vite + React dashboard
├── LICENSE
└── README.md
```

## Learn more

- [`hoodchain` SDK](https://github.com/nirholas/robinhood-chain-sdk) — the
  TypeScript SDK these examples build on (Stock Token registry, Chainlink
  quotes, portfolio math, Uniswap v3 swaps, launchpad watchers, sequencer
  firehose).
- [three.ws](https://three.ws) — built by [nirholas](https://x.com/nichxbt).

## License

[Apache License 2.0](LICENSE) © 2026 nirholas.
