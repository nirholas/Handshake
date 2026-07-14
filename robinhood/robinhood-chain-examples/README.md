# Robinhood Chain Examples

A collection of runnable example projects for **Robinhood Chain** — an
Arbitrum Orbit L2 (chain ID `4663`, testnet `46630`) that hosts Robinhood's
tokenized Stock Tokens, a Chainlink price-feed registry, USDG, and two native
memecoin launchpads (NOXA and The Odyssey).

Every example is a small, self-contained project you can `npm install` and
run in under a minute. They start from a raw `viem` read with no SDK and
build up to a live dashboard, a Telegram bot, and a paper-trading strategy
loop — showing exactly what the
[`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk) SDK does for
you at each step.

**Browse the gallery:** [nirholas.github.io/robinhood-chain-examples](https://nirholas.github.io/robinhood-chain-examples/)
— example 07's live price page is embedded and running right on the landing
page, and every README below is rendered with syntax highlighting.

## Prerequisites

- **Node.js ≥ 20** for every example (all use native ESM and, where relevant,
  the built-in `WebSocket`/`fetch`).
- **No wallet, key, or funds** for examples 01, 02, 03, 05, 06, 07, 08, 12,
  and 14 — they are read-only (or paper-trading, no real funds) against the
  public Robinhood Chain RPC.
- Example 04's swap **quote** is also read-only; **executing** needs a funded
  testnet key (see [Environment variables](#environment-variables)).
- The [`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk) SDK is
  on npm as `hoodchain`. Examples pin `^0.1.0` in their `package.json` — a
  plain `npm install` resolves it. If you're developing against an unreleased
  local SDK build instead, see [Installing `hoodchain`](#installing-hoodchain).
- Examples 09, 10, 11, and 13 are **not built** — they depend on sibling
  packages (`hood-api`, `hood402`, `hood-mcp`, `hood-launcher`) that haven't
  shipped yet. Each has a README explaining exactly what's missing.

## Installing `hoodchain`

Every published example depends on `hoodchain` (pinned `^0.1.0`), resolved
normally from npm:

```bash
npm install
```

If you're working against an unreleased local SDK checkout instead of the
published package, install it as a sibling build after the regular install:

```bash
npm install ../../../robinhood-chain-sdk
```

That relative path assumes this repo and
[`robinhood-chain-sdk`](https://github.com/nirholas/robinhood-chain-sdk) are
checked out as siblings under a common parent directory.

## Which package do I need?

| You want to… | Use | Try |
|---|---|---|
| Read one price, zero dependencies | `viem` only | Example 01 |
| Read prices / portfolios in a Node script | `hoodchain` | Examples 02, 03 |
| Ship a static page with live prices | raw client-side RPC, no build step | Example 07 |
| Build a React app | `hoodchain` + a local hook (`hoodkit` not shipped yet) | Example 08 |
| Trade or launch on-chain | `hoodchain`'s `swap` / `launchpads` modules | Examples 04, 05, 14 |
| Run a chat bot | `hoodchain` + [grammY](https://grammy.dev) | Example 12 |
| Charge or pay for an API call | `hood402` (not shipped yet) | Examples 09, 10 |
| Give an LLM agent chain tools | `hood-mcp` (not shipped yet) | Example 11 |

## Examples

| # | Example | What it demonstrates | Difficulty | Run |
|---|---------|----------------------|------------|-----|
| 01 | [`read-stock-price`](examples/01-read-stock-price) | Read one Stock Token's Chainlink price feed with `viem` only — no SDK, addresses spelled out by hand. | Beginner | `cd examples/01-read-stock-price && npm install && npm start` |
| 02 | [`stock-price-sdk`](examples/02-stock-price-sdk) | The same read in three lines using `hoodchain`'s bundled 95-token registry and typed errors. | Beginner | `cd examples/02-stock-price-sdk && npm install && npm start` |
| 03 | [`portfolio-valuation`](examples/03-portfolio-valuation) | Multiplier-correct portfolio valuation — the ERC-8056 `uiMultiplier()` math generic trackers get wrong, swept across all 95 tokens in one multicall. | Intermediate | `cd examples/03-portfolio-valuation && npm install && npm start` |
| 04 | [`swap-memecoin`](examples/04-swap-memecoin) | Quote (and, with a funded key, execute) a Uniswap v3 swap on testnet — the same code path swaps mainnet memecoins. | Intermediate | `cd examples/04-swap-memecoin && npm install && npm start` |
| 05 | [`watch-launches`](examples/05-watch-launches) | Stream NOXA and The Odyssey launchpad activity into one `Launch` shape. | Intermediate | `cd examples/05-watch-launches && npm install && npm start` |
| 06 | [`firehose`](examples/06-firehose) | Decode the raw Arbitrum Nitro sequencer feed into typed transactions ~100–300ms before RPC sees them. | Advanced | `cd examples/06-firehose && npm install && npm start` |
| 07 | [`live-price-webpage`](examples/07-live-price-webpage) | A dependency-free `index.html` showing live prices for 11 Stock Tokens via client-side JSON-RPC. | Beginner | `cd examples/07-live-price-webpage && npm install && npm start` |
| 08 | [`portfolio-dashboard`](examples/08-portfolio-dashboard) | A Vite + React dashboard wrapping example 03's logic in a polling hook with designed loading/empty/error states. | Intermediate | `cd examples/08-portfolio-dashboard && npm install && npm run dev` |
| 09 | [`x402-paid-api-call`](examples/09-x402-paid-api-call) | *Not built* — client paying a `hood-api` endpoint via `hood402`. | Advanced | Blocked on `hood-api`, `hood402` |
| 10 | [`x402-sell-your-api`](examples/10-x402-sell-your-api) | *Not built* — a paid endpoint using `hood402` middleware. | Advanced | Blocked on `hood402` |
| 11 | [`mcp-agent-session`](examples/11-mcp-agent-session) | *Not built* — a scripted MCP client driving `hood-mcp` tools. | Advanced | Blocked on `hood-mcp` |
| 12 | [`telegram-price-bot`](examples/12-telegram-price-bot) | A grammY Telegram bot: `/price AAPL`, `/trending` — deployable on any free tier. | Intermediate | `cd examples/12-telegram-price-bot && npm install && TELEGRAM_BOT_TOKEN=... npm start` |
| 13 | [`launch-a-coin-testnet`](examples/13-launch-a-coin-testnet) | *Not built* — launching a token via `hood-launcher`'s direct rail. | Advanced | Blocked on `hood-launcher` |
| 14 | [`agent-paper-trader`](examples/14-agent-paper-trader) | A minimal momentum strategy loop polling real prices, simulating fills against a virtual USDG balance — no real funds. | Intermediate | `cd examples/14-agent-paper-trader && npm install && npm start` |

Each example folder has its own `README.md` with a full walkthrough, real
captured output, and the specific concept it's teaching — start with the
table above, then open the linked README for the one you want to run.

## Environment variables

| Variable | Used by | Required? |
|----------|---------|-----------|
| `ROBINHOOD_CHAIN_PRIVATE_KEY` | [`04-swap-memecoin`](examples/04-swap-memecoin) | Only to execute a swap (`--execute` flag). Must be a testnet key funded from the [testnet faucet](https://faucet.testnet.chain.robinhood.com/). Without it, the example prints a quote and exits — it never fabricates a transaction. |
| `TELEGRAM_BOT_TOKEN` | [`12-telegram-price-bot`](examples/12-telegram-price-bot) | Required to start the bot. Get one free from [@BotFather](https://t.me/BotFather). Without it, the example exits with a helpful message. |
| `PORT` | [`07-live-price-webpage`](examples/07-live-price-webpage) | Optional. Overrides the default port (`8007`) for the convenience static server (`serve.js`). |

No example reads a `.env` file or requires an API key beyond the two above —
every read goes straight to the public Robinhood Chain RPC
(`https://rpc.mainnet.chain.robinhood.com`) or the public sequencer feed
(`wss://feed.mainnet.chain.robinhood.com`).

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
│   ├── 08-portfolio-dashboard/    Vite + React dashboard
│   ├── 09-x402-paid-api-call/     gap note — blocked on hood-api/hood402
│   ├── 10-x402-sell-your-api/     gap note — blocked on hood402
│   ├── 11-mcp-agent-session/      gap note — blocked on hood-mcp
│   ├── 12-telegram-price-bot/     grammY bot
│   ├── 13-launch-a-coin-testnet/  gap note — blocked on hood-launcher
│   └── 14-agent-paper-trader/     paper-trading strategy loop
├── docs/                          static gallery site (GitHub Pages, generated)
├── tools/build-docs.mjs           docs generator (marked + highlight.js)
├── LICENSE
└── README.md
```

`docs/` is generated, not hand-written — see [Docs site](#docs-site) below.

## Docs site

`docs/` is a static gallery: a landing page with example 07 embedded and
running live, plus one syntax-highlighted page per example rendered from its
`README.md` at build time (no client-side markdown fetching). Rebuild it with:

```bash
npm install       # marked + highlight.js, build tooling only
npm run docs:build
```

**One-time GitHub Pages setup:** repo Settings → Pages → Deploy from a branch
→ `main` / `/docs`. No GitHub Actions — this campaign doesn't use them; run
`npm run docs:build` locally and commit the output whenever an example or its
README changes.

## SDK feedback (from building every example)

Notes for whoever builds the next wave of Robinhood Chain packages, captured
while wiring these 14 examples against `hoodchain`:

- **`hoodchain` itself is solid.** Every example that could be built (01–08,
  12, 14) worked first-try against the real registry, real feeds, and real
  testnet pools — no workarounds needed. `getPortfolio`'s single-multicall
  sweep and the typed error classes (`UnknownSymbolError`, `StaleFeedError`,
  …) made the "designed error state" requirement trivial to satisfy honestly.
- **The biggest gap is `hoodkit` (React hooks).** Example 08 had to hand-roll
  a `useHoodPortfolio` polling hook because `hoodkit` doesn't exist yet. It's
  shaped so a real `hoodkit` export slots in as a one-line import swap — but
  every future React example will hit this same wall until it ships.
- **`hood402` blocks two examples outright** (09, 10) and is the natural next
  build: `hoodchain`'s own `usdg.ts` already documents that USDG has no
  EIP-2612 `permit`, so `hood402`'s approval flow needs an on-chain `approve`
  step baked in from day one, not bolted on later.
- **`hood-mcp` and `hood-launcher`** are single-purpose wraps of
  `getQuote`/`getPortfolio`/`getRecentLaunches` and the launchpad factory
  addresses already in `hoodchain`'s `launchpads.ts` — both are thin once
  `hoodchain` is the foundation, no new chain research required.
- **Testnet faucet remains the one real blocker for live execution.** Example
  04's swap quote and example 13's future launch both work end-to-end except
  for the final funded transaction — the public faucet's Turnstile + Google
  Sign-In gate (documented in `prompts/robinhood-chain/_shared.md`) is a
  human-in-the-browser step no agent can complete non-interactively.

## Learn more

- [`hoodchain` SDK](https://github.com/nirholas/robinhood-chain-sdk) — the
  TypeScript SDK these examples build on (Stock Token registry, Chainlink
  quotes, portfolio math, Uniswap v3 swaps, launchpad watchers, sequencer
  firehose).
- [three.ws](https://three.ws) — built by [nirholas](https://x.com/nichxbt).

## License

All rights reserved. See [LICENSE](LICENSE).
