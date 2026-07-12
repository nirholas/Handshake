# learn-robinhood-chain

**The definitive learning site for building on [Robinhood Chain](https://docs.robinhood.com/chain/) (chain ID 4663).**

Twelve tutorials, zero to shipping an autonomous agent, every one of them performed on real mainnet/testnet data during the build — not described secondhand. Static site, self-contained, no CDN dependencies, deploys to GitHub Pages from `docs/`.

**Live site:** `https://nirholas.github.io/learn-robinhood-chain/` (after Pages setup — see below)

## How to use this course

Work through the tutorials in order — each one lists the specific prior tutorial it depends on, and later lessons (a portfolio tracker, a paid API, an autonomous agent) assume the SDK fluency the earlier ones build. That said, it's structured so you can jump straight to a section if you already know the basics:

- New to Robinhood Chain entirely? Start at **Tutorial 1** and read straight through.
- Already comfortable connecting to an EVM chain and just want to build? Skim **Tutorial 3** (the Stock Token multiplier trap — the one piece of domain knowledge every other tutorial assumes) and start building at **Tutorial 4**.
- Here for monetization or agents specifically? Tutorials 8–11 stand mostly on their own once you've done 4–6.

Every tutorial ends with a **"What you built"** recap and a **Troubleshooting** section for the errors you're actually likely to hit. Code blocks have copy buttons; nothing in a tutorial was written without being run for real first (see [the honesty standard](#the-honesty-standard-this-repo-holds-itself-to) below).

## Prerequisites

- [Node.js](https://nodejs.org) ≥ 20 and a terminal.
- Any code editor.
- Comfort reading TypeScript/JavaScript and basic `bigint` arithmetic (Tutorial 3 explains the one gotcha this course cares about).
- A wallet you control, for the tutorials with a write step (6, 8, 10, 11) — testnet funds are enough; no mainnet capital is required to complete the course.
- No prior Robinhood Chain or Solidity experience assumed. Tutorial 1 builds the mental model from zero.

## Table of contents

| # | Tutorial | Section | Time |
| --- | --- | --- | --- |
| 1 | [What Robinhood Chain actually is](docs/01-what-is-robinhood-chain/) | Foundations | 10 min |
| 2 | [Connect and read the chain in 5 minutes](docs/02-connect-and-read/) | Foundations | 5 min |
| 3 | [Stock Tokens explained for developers](docs/03-stock-tokens-explained/) | Foundations | 12 min |
| 4 | [Your first app: a live price ticker](docs/04-live-price-ticker/) | Building | 15 min |
| 5 | [Portfolio tracker done right](docs/05-portfolio-tracker/) | Building | 15 min |
| 6 | [Swapping on-chain: quotes, slippage, execution](docs/06-swapping-on-chain/) | Building | 20 min |
| 7 | [Streaming the chain: launchpads + firehose](docs/07-streaming-the-chain/) | Building | 18 min |
| 8 | [Sell your API for USDG with x402](docs/08-sell-your-api-for-usdg/) | Monetizing & agents | 25 min |
| 9 | [Give your AI agent chain access with MCP](docs/09-ai-agent-chain-access/) | Monetizing & agents | 22 min |
| 10 | [Build an autonomous trading agent](docs/10-autonomous-trading-agent/) | Monetizing & agents | 30 min |
| 11 | [Launch a coin programmatically](docs/11-launch-a-coin/) | Monetizing & agents | 20 min |
| 12 | [Ship it: deploy and go mainnet](docs/12-ship-it/) | Capstone | 18 min |

Every tutorial is built on the open-source [`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk) TypeScript SDK. Real prices, real transaction hashes, real firehose throughput numbers, and — in Tutorial 8 — a real bug this course found and fixed while writing the payment-verification example, documented rather than smoothed over.

## Local preview

```bash
npm install
npm run dev     # builds content/ -> docs/, then serves it at http://localhost:4173
```

Or separately:

```bash
npm run build    # renders content/*.md -> docs/ (the static site generator, build.mjs)
npm run serve    # serves the already-built docs/ folder
```

`docs/` is committed — it's what GitHub Pages deploys. Always run `npm run build` before committing a content change; nothing rebuilds it for you on push.

## Architecture

- **`build.mjs`** — the static site generator. Renders `content/*.md` (ordered by `content/meta.json`) through [`marked`](https://www.npmjs.com/package/marked) with a custom renderer (heading anchors, copy-button code blocks via [`highlight.js`](https://www.npmjs.com/package/highlight.js), `:::note`/`:::warning`/`:::tip`/`:::danger` callout blocks) into styled HTML pages, plus a build-time search index. `marked` and `highlight.js` are **build-time only** — nothing in `docs/` fetches them or any other CDN resource at runtime.
- **`assets/`** — hand-written CSS and vanilla JS, copied verbatim into `docs/assets/` at build time:
  - `styles.css` — the whole design system (theme-aware CSS custom properties, dark by default, light via `data-theme`).
  - `app.js` — theme toggle, code-block copy buttons, mobile nav, per-tutorial "mark complete" progress (stored in `localStorage`), TOC scrollspy.
  - `search.js` — hand-rolled offline search over the build-time index (`assets/search-index.json`). No lunr, no server.
  - `ticker.js` — the landing page's live chain-stats strip: raw JSON-RPC over `fetch` against the public Robinhood Chain mainnet RPC, decoded by hand (no viem in the browser bundle — this is the zero-dependency reference implementation Tutorial 4 links to).
- **`content/`** — one Markdown file per tutorial plus `meta.json` (title, section, description, prerequisites, "what you'll build," ordering). Add a tutorial by adding both.
- **`serve.mjs`** — a zero-dependency static file server for local preview that mimics GitHub Pages' `/slug/` → `/slug/index.html` routing.

## Adding a tutorial

1. Write `content/NN-your-slug.md`. Use `:::tip`, `:::note`, `:::warning`, `:::danger` for callouts; fenced code blocks get automatic syntax highlighting and a copy button.
2. Add an entry to the `pages` array in `content/meta.json` — `slug` must match the filename (without `.md`), `section` groups it in the sidebar and landing page.
3. `npm run build && npm run serve`, check it at `http://localhost:4173`.
4. **Actually perform what you're documenting.** Every code sample in this repo was run for real against Robinhood Chain (mainnet reads, or testnet where a funded wallet was available) before it was written down. A tutorial that wasn't performed doesn't belong here — see the honesty standard below.

## The honesty standard this repo holds itself to

- Every command shown was actually run; every output block is a real, unedited capture (or is explicitly labeled otherwise).
- Where something couldn't be verified in the build environment — a testnet write blocked on the browser-gated faucet, an unverified factory ABI — the tutorial says so plainly, with the specific reason, rather than presenting untested code as proven.
- If testing surfaces a real bug (Tutorial 8's payment-verification example did), the tutorial documents the bug and the fix, not just the fixed version — that's more useful than a tutorial that never shows what wrong looks like.

## One-time GitHub Pages setup

1. Push this repo to GitHub as `learn-robinhood-chain`.
2. **Settings → Pages → Build and deployment → Source: "Deploy from a branch."**
3. Branch: `main`, folder: `/docs`. Save.
4. Live within a minute or two at `https://<your-username>.github.io/learn-robinhood-chain/`.

No GitHub Actions workflow is used or required — `docs/` is a pre-built, committed artifact.

## Related

- **[hoodchain](https://github.com/nirholas/robinhood-chain-sdk)** — the TypeScript SDK every tutorial here is built on: Stock Tokens, Chainlink quotes, multiplier-correct portfolios, Uniswap v3 swaps, USDG, launchpad watchers, and the sequencer firehose.

## License

Apache License 2.0 © 2026 nirholas — see [LICENSE](./LICENSE).

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
