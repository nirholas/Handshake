# 15 — Canonical token list: `hood-tokenlist`

Read `prompts/robinhood-chain/_shared.md` first. Wave 2: requires core SDK's verified registry
(`robinhood/robinhood-chain-sdk/`).

## Mission
Build `robinhood/hood-tokenlist/` — THE token list for Robinhood Chain in the Uniswap tokenlist
standard. None exists; the first trusted list becomes infrastructure every DEX UI, wallet, and
aggregator consumes. This is a data product: its value is verification rigor + freshness.
npm `hood-tokenlist` (fallbacks: `robinhood-chain-tokenlist`, `@hoodkit/tokenlist`).

## Deliverables

1. **`tokenlist.json`** — schema-valid per `@uniswap/token-lists` (validate in CI-less test):
   - All Stock Tokens from the SDK registry (re-verify each against Blockscout during build).
   - USDG, WETH, and canonical bridged assets.
   - Vetted memecoins: graduated launchpad coins passing objective inclusion criteria you
     define and PUBLISH (e.g. graduated to Uniswap, ≥ N days old, ≥ N holders, liquidity ≥ $X,
     verified contract, no honeypot flags via simulated sell). The criteria doc is part of the
     product — inclusion must be rules-based, never editorial.
   - Logos: Stock Tokens get clean generated ticker-monogram SVGs (consistent system, no
     trademarked logos — we cannot ship Apple's logo); memecoins use their on-chain/launchpad
     metadata image where resolvable, monogram fallback. All assets self-hosted in the repo.
2. **Extensions** — use the tokenlist `extensions` field for our value-add per token:
   `chainlinkFeed`, `uiMultiplier` support flag, `assetClass: 'stock-token' | 'memecoin' | 'stablecoin'`,
   `launchpad`, eligibility note pointer for stock tokens. Document the extension schema.
3. **Refresh pipeline** — `scripts/refresh.mjs`: re-verifies every entry live (exists, symbol
   matches, still has liquidity), applies inclusion/removal rules, bumps tokenlist version
   semantics correctly (major = removal, minor = add, patch = metadata). Deterministic output,
   meaningful diff. Document the operational cadence (owner runs or crons it).
4. **Distribution surfaces** — the list served from the Pages docs site at a stable URL
   (`docs/tokenlist.json` mirrored from the canonical root file by the build script), npm
   package exporting the JSON + a typed loader, README instructions for adding the list to
   Uniswap/wallet UIs by URL.

## Requirements
- Tests: schema validation, address checksums, no-duplicates, logo file existence, inclusion-
  rule unit tests, and a live re-verification test hitting Blockscout for a sample.
- `docs/` static site per `_shared.md`: landing renders the ENTIRE list beautifully live from
  the JSON (searchable/filterable table with logos, class badges, feed links) — it doubles as
  the chain's de-facto token directory; criteria page; extension schema page; "use this list"
  integration snippets.
- Honesty rule: if a memecoin fails criteria, it's out — no exceptions, no $THREE-style
  promotion of any token in this list (it's neutral infrastructure; note: $THREE is Solana and
  does not belong here regardless).

## Done checklist
- [ ] Schema-valid list with every entry re-verified live during the build (counts in report).
- [ ] Inclusion criteria published + unit-tested; refresh script idempotent (run twice → no diff).
- [ ] Directory page renders the real list locally; stable-URL serving documented.
- [ ] `npm pack` clean; report includes list stats (tokens by class, exclusions with reasons).
