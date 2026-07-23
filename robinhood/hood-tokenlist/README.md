# hood-tokenlist

The canonical token list for **Robinhood Chain** (chain ID 4663), in the
[Uniswap token-lists standard](https://github.com/Uniswap/token-lists). Every Stock Token, USDG,
WETH, and every launchpad memecoin that passes a published, rules-based verification funnel.
Every address is re-verified against live chain state on every refresh; nothing is hand-curated.

## Website — [nirholas.github.io/hood-tokenlist](https://nirholas.github.io/hood-tokenlist/)

The project site is an interactive **library card catalog**: the list is filed into drawers you pull open, and each token is an index card you flip through. The front carries the on-chain metadata (address, decimals, Chainlink feed, launchpad, V3 pool, launch block); flip it and the back shows the exact criteria that entry passed on-chain, rubber-stamped. Drawer-pull and card-flip are the navigation. It is a single self-contained page in [`docs/`](docs/) (real token data embedded inline, zero network requests), so it deploys anywhere static and works from `file://`.

Deploy your own copy in one click:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nirholas/hood-tokenlist)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/nirholas/hood-tokenlist)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/nirholas/hood-tokenlist&project-name=hood-tokenlist&output-directory=docs)

| Target | How |
| --- | --- |
| **GitHub Pages** | Settings → Pages → Source: `main` / `/docs`. Serves the site and the stable-URL `tokenlist.json` mirror at `nirholas.github.io/hood-tokenlist/`. No build step. |
| **Cloudflare Pages** | The button above, or `wrangler pages deploy docs`. Config in [`wrangler.toml`](wrangler.toml). |
| **Netlify / Vercel** | The buttons above. Publish directory is `docs/` ([`netlify.toml`](netlify.toml), [`vercel.json`](vercel.json)). |

**Stable URL (always the current list):**

```
https://nirholas.github.io/hood-tokenlist/tokenlist.json
```

**Directory site (live, searchable):** https://nirholas.github.io/hood-tokenlist/

## What's in the list

| Class | Source | Verification on every refresh |
| --- | --- | --- |
| Stock Tokens (95) | hoodchain SDK registry (full Blockscout discovery) | on-chain `symbol`/`name`/`decimals`/`uiMultiplier`, shared EIP-1967 beacon check, cross-check against [Robinhood's contracts registry](https://docs.robinhood.com/chain/contracts), Chainlink feed answers |
| USDG, WETH | official contracts registry | on-chain identity + ETH/USD and USDG/USD feed verification by `description()` |
| Memecoins | full event-history scan of NOXA (`TokenLaunched`) and The Odyssey (`PoolMigrated`) | 9 objective rules: provenance, known quote, liquidity of at least $2,500, at least 7 days old, at least 50 holders, simulated sell + transfer, schema-valid identity, no ticker spoofing, one token per symbol. [Full criteria](https://nirholas.github.io/hood-tokenlist/criteria.html) |

Value-add per token lives in `extensions`: `assetClass`, `chainlinkFeed` (+ decimals),
`supportsUiMultiplier` (ERC-8056), `launchpad`, `uniswapV3Pool` (+ fee tier), `launchBlock`, and
an `eligibility` marker on Stock Tokens. Schema:
[extensions page](https://nirholas.github.io/hood-tokenlist/extensions.html) and
[`src/index.d.ts`](src/index.d.ts).

Logos are self-hosted in [`logos/`](logos/): deterministic ticker-monogram SVGs for Stock Tokens
(no trademarked artwork), each memecoin's own art where resolvable (monogram fallback).

## Use it

### In a DEX UI or wallet

Any interface that accepts token lists by URL (Uniswap-compatible interfaces, wallets,
aggregators): paste the stable URL above in "Manage token lists".

### As an npm package

```sh
npm i hood-tokenlist
```

```js
import { tokens, stockTokens, memecoins, getToken, getTokensBySymbol, pricedTokens } from 'hood-tokenlist'

getToken('0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9') // AAPL entry
getTokensBySymbol('TSLA')                              // [TSLA entry]
pricedTokens()                                          // every entry with a Chainlink feed

// or the raw JSON, no helpers:
import list from 'hood-tokenlist/tokenlist.json' with { type: 'json' }
```

TypeScript definitions ship with the package (`TokenInfo`, `TokenExtensions`, `AssetClass`).

### Reading Stock Token data correctly

Two Robinhood-Chain-specific rules integrators must not skip:

1. **ERC-8056 positions**: true position = raw balance x `uiMultiplier()` (1e18-scaled).
   Every stock entry sets `extensions.supportsUiMultiplier: true`.
2. **Feed prices are already multiplier-adjusted**: never re-apply `uiMultiplier` to a
   Chainlink answer.

Stock Tokens are tokenized debt securities and may not be offered, sold, or delivered to US
persons (further limits: Canada, UK, Switzerland). Every stock entry carries
`extensions.eligibility: "not-for-us-persons"` so buy flows can gate on it. Displaying the data
is unrestricted. Details: [criteria page](https://nirholas.github.io/hood-tokenlist/criteria.html#eligibility).

## Refresh pipeline

```sh
npm run refresh
```

`scripts/refresh.mjs` re-verifies the entire list live against the public RPC
(`https://rpc.mainnet.chain.robinhood.com`), Blockscout, and the on-chain Chainlink feeds:

- Stock Tokens: identity multicall + beacon slot + feed answers + docs-registry cross-check.
- Memecoins: rescans the complete NOXA and Odyssey event history from genesis, then applies the
  [published criteria](https://nirholas.github.io/hood-tokenlist/criteria.html) with live
  liquidity, holder, and honeypot-simulation checks.
- Output is deterministic: tokens sorted by symbol then address, stable key order, and version
  semantics per the standard (major = removal, minor = add, patch = metadata). A refresh that
  changes nothing produces a byte-identical `tokenlist.json`, so diffs are always meaningful.
- `docs/tokenlist.json`, `docs/tokenlist.data.js`, and `docs/logos/` are mirrored from the
  canonical root artifacts by the same script; never edit the mirrors by hand.
- `data/refresh-report.json` records stats and every exclusion with its reasons.

The script is strictly read-only on-chain: it signs nothing and spends nothing.

**Cadence**: run weekly (or after notable launchpad activity) and commit the diff. The whole run
takes a few minutes, dominated by the launchpad history scan and per-survivor checks.

## Tests

```sh
npm test
```

- `tests/schema.test.mjs`: validates `tokenlist.json` against the official
  `@uniswap/token-lists` JSON schema; asserts the docs mirror is byte-identical.
- `tests/integrity.test.mjs`: EIP-55 checksums, no duplicate addresses/symbols, every logo file
  exists (root + docs mirror), tags defined, per-class extension invariants, anti-spoof holds,
  typed loader agrees with the JSON.
- `tests/criteria.test.mjs`: unit tests for every inclusion rule (age, holders, liquidity,
  identity, spoofing, collision resolution).
- `tests/version.test.mjs`: version-bump semantics.
- `tests/live.test.mjs`: live re-verification of a deterministic sample (base assets, first and
  last stock token, every memecoin) against mainnet RPC and Blockscout on every test run.

## Docs site (GitHub Pages)

The [`docs/`](docs/) folder is a static site: the full searchable directory with live Chainlink
prices and chain height, the criteria page, and the extension schema page. One-time setup after
pushing: repository Settings > Pages > Deploy from a branch > `main` > `/docs`. The page also
works locally (`npx serve docs`, or open `docs/index.html` directly; a `tokenlist.data.js`
fallback covers `file://`).

## Publishing (owner steps)

```sh
npm publish --access public
```

The package ships `tokenlist.json`, `src/` (loader + types), and `logos/`. `npm pack --dry-run`
must be clean first. After a refresh changes the list, publish a package version whose semver
matches the list's own version bump.

## Repo layout

```
tokenlist.json            the canonical list (root artifact)
src/index.mjs             typed loader (ESM)
src/index.d.ts            TypeScript definitions
scripts/refresh.mjs       full re-verification + rebuild pipeline
scripts/lib/              rpc, chain reads, criteria, version, monogram, blockscout
logos/                    self-hosted logo assets, keyed by checksummed address
docs/                     GitHub Pages site + stable-URL mirror of the list
data/robinhood-docs-registry.json   official-registry cross-check fixture
data/refresh-report.json  stats + per-token exclusion reasons from the last refresh
tests/                    schema, integrity, criteria, version, live suites
```

## License

All rights reserved. See [LICENSE](./LICENSE).

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
