# LEAN — Dependency removals & de-duplication

**Severity:** Lean (no runtime bug) · **Area:** Deps / dedup · **Commit-gate:** ⚠ partial

The repo is genuinely clean — no esbuild-trap files, no committed `dist/`, no
fake-data arrays, no stub/TODO markers in first-party code. These are the real, small
wins. Each is independent; do them as separate commits.

> **Status (2026-07-29):** items 3, 4, 5 and 7 are closed — see the per-item notes
> and **Actual net** at the bottom. Items 3 and 4 were **withdrawn**: every
> "unused" dependency turned out to be load-bearing. Items 1, 2 and 6 are open.

**Verify every removal with a peer-dependency check, a dynamic-import grep, and a
build before deleting.** `npm ls <pkg>` is not sufficient: it does not distinguish a
package required as a `peerDependency`, and a `from '<pkg>'` grep does not see
`import('<pkg>')`. Both gaps produced false positives in this file (items 3 and 4).

## 1. Remove `node-fetch` (highest-confidence)
7 usage sites, **all** in `workers/` (agent-anchor, agent-screen-worker,
agent-sniper). Node 24 has a global `fetch`. Migrate the 7 files (drop the
`import fetch from 'node-fetch'` line), then remove the dep from the relevant
`package.json`.
- Verify: `grep -rn "node-fetch" workers/ api/ src/ packages/` → zero after; workers
  still run.

## 2. Replace `query-string` with native `URLSearchParams`
Exactly one call: [src/app.js:184](../../src/app.js) —
`queryString.parse(location.hash)`. Replace with
`Object.fromEntries(new URLSearchParams(location.hash.replace(/^#/, '')))` (adjust
for the hash's actual format), remove the dep.
- Verify: `grep -rn "query-string" src/ api/` → zero; the hash-parsing path works.

## 3. ~~Remove zero-reference deps~~ — WITHDRAWN, all three are required peers
**Nothing removed. The "zero code references" reading was right and the conclusion
was still wrong: every one of these is a non-optional `peerDependencies` entry of a
package the root already depends on, so the root declaration is what satisfies it.
They belong in `package.json` exactly as they are.** Same class as
`@solana-program/stake` in the "Do NOT remove" list below.

| Dep | Required by | Declared range |
|---|---|---|
| `@solana-program/compute-budget` | `helius-sdk` (peer, not optional) | `^0.15.0` — root pins `^0.15.0` |
| `@solana-program/system` | `helius-sdk` (peer, not optional) | `^0.12.0` |
| `mppx` | `@bnb-chain/mpp` (peer, not optional; root dep at `^0.2.0`) | `^0.6.28` — root pins `^0.6.31` |

- Evidence: `node -e "console.log(require('./node_modules/helius-sdk/package.json').peerDependencies)"`
  → lists compute-budget, stake, system, token, `@solana/kit`; `peerDependenciesMeta`
  is `undefined`, so none are optional. Same check on `@bnb-chain/mpp` → `mppx`, `viem`.
- Dropping them would leave the peer satisfied only by npm's auto-peer-install
  behaviour, which is not a contract worth depending on for a live payment/RPC path.
- The lockfile-dependents sweep that found this: walk `package-lock.json`'s
  `packages` map and print every entry whose `dependencies`/`peerDependencies`
  mention the candidate. `npm ls <pkg>` alone does not distinguish a peer.

## 4. ~~Relocate `axios` from root to `mcp-bridge/package.json`~~ — WITHDRAWN
**Nothing moved.** Root first-party code does use axios: `api/_lib/x402-user-payer.js:166`
does `import('axios')` (a *dynamic* import, which is why a `from 'axios'` grep
missed it) and hands the instance to `wrapAxiosWithPayment` from `@x402/axios`.
`@x402/axios` also declares `axios` as a non-optional peer, and root code imports
it. Native `fetch` cannot substitute: `wrapAxiosWithPayment` takes an axios
instance by contract. `axios` stays a root dependency. (`mcp-bridge` and
`character-studio` already declare their own copies, so the workspaces are fine
either way.)

## 5. De-duplicate SOL-price fetching — DONE (4 call sites migrated)
Two canonical helpers, not one, because half these call sites price ETH/BNB/MATIC
rather than SOL:
- `api/_lib/sol-price.js` → `solPriceUsd()` — SOL spot, 60s cache, 7 sources.
- `api/_lib/market-fallbacks.js` → `fetchCoinPriceUsd(id)` / `fetchCoinPriceUsdOrNull(id)`
  — any CoinGecko id, CoinGecko → DefiLlama → Kraken/Coinbase/Bitfinex.

Migrated, each preserving its original failure contract:

| File | Was | Now | Failure semantics kept |
|---|---|---|---|
| `api/_lib/agent-wallet.js` | bare CoinGecko ETH fetch + 5-min memo | `fetchCoinPriceUsd('ethereum')` + same 5-min memo | still **throws** when every source is down (callers divide by it to size a spend) |
| `api/_lib/trust/subject-reputation.js` | bare CoinGecko fetch per chain native | `fetchCoinPriceUsdOrNull(cgId)` | still **null** on miss → holdings dimension unavailable, never an error |
| `api/_lib/x402/pipelines/cross-chain-cost.js` | one CoinGecko call for `solana,ethereum` | `solPriceUsd()` ‖ `fetchCoinPriceUsdOrNull('ethereum')` | still **`{sol:null, eth:null}`** on failure → USD columns blank, gas units still recorded |
| `api/pump/helius-stats.js` | bare CoinGecko fetch + private 60s cache + staleness flag | `solPriceUsd()` + new `solPriceInfo()` / `solChange24hPct()` | `sol_price_stale` and `sol_change_24h` unchanged on the wire |

New in `api/_lib/sol-price.js` (needed to retire the last private cache):
- `solPriceInfo()` — sync read of the shared cache: `{ price, at, stale, change24h }`.
  `stale` is true only when a good price is being served past its refresh window,
  so a page can still tell "couldn't refresh" from "no price yet".
- `solChange24hPct()` — 24h delta, 5-min cache. Free when CoinGecko answered the
  price call; otherwise CoinGecko → DefiLlama `/percentage`. This is a net gain:
  the old single-source field went null whenever CoinGecko rate-limited.

Verified live (not mocked): `/api/pump/helius-stats` over a real HTTP round trip →
`200`, `sol_price: 73.45`, `sol_change_24h: 0.269` (served by the DefiLlama
fallback while CoinGecko was cooling), `cache-control: public, max-age=3`.
`fetchCoinPriceUsd('ethereum')` → `1903.72`; `fetchCoinPriceUsdOrNull('binancecoin')`
→ `568.11`; a bogus id → `null`.

**Still inline (not touched, out of this pass's scope):** `avatar-wallet.js` and
`balances.js` already route through `solPriceUsd()` for SOL but keep a separate
inline ETH read; `x402/pipelines/sniper-intel-enrich.js`, `api/coin/exchange.js`,
`api/cron/news-archive-append.js` were not audited here. `src/shared/usd-price.js`
stays as-is — different runtime (browser), deliberate copy.

## 6. Generate `data/skills/seed.json` from source (bloat + drift)
`seed.json` (2,701 lines, ~796KB) embeds verbatim copies of ~115 individual
`SKILL.md` bodies — the largest file in the tree; every skill fix must be made twice
(e.g. finding M4 lives in both). Add a build step that generates `seed.json` (and the
`public/skills/`, `dist/`, `examples/skills/` copies) from the source `SKILL.md`
files. **⚠ some skill bodies reference other coins → the regeneration diff may hit the
commit gate; check before staging.** Larger effort — treat as its own task.

## 7. De-duplicate draco vendor libs — DONE
Correction to the original finding: the files were **never committed**. Both trees
were gitignored and regenerated from `node_modules/three` by
`scripts/copy-three-decoders.mjs` at postinstall, which wrote the same source to two
destinations. So the waste was in the deployed image (~3.3 MB shipped twice), not in
git. All 9 files verified byte-identical by md5 before deleting.

Now one canonical copy at `/three/draco/`, shared by both apps:
- `scripts/copy-three-decoders.mjs` — dropped the second destination; also removes a
  stale `public/scene-studio/draco/` from existing checkouts on the next install.
- `src/scene-studio/loader.js:31`, `src/scene-studio/vendor/js/Loader.js:296,1115`,
  `pages/scene.html:70` — `setDecoderPath`/`<script src>` repointed to `/three/draco/`.
  Same-origin absolute paths, so the shared copy resolves from the subapp unchanged.
- `.gitignore` — dropped the now-dead `public/scene-studio/draco/` rule.
- `scripts/audit-deploy-artifacts.mjs` — the dist guard asserted
  `scene-studio/draco/draco_encoder.js`; now asserts `three/draco/draco_encoder.js`,
  and additionally `scene-studio/basis/basis_transcoder.wasm`, which Scene Studio's
  KTX2 loader needs and nothing was guarding.
- `docs/ux-flows/03-3d-editing-viewer.md` — decoder path corrected.
- `public/scene-studio/basis/` is a genuinely separate, committed tree and stays.

Verified: `node scripts/copy-three-decoders.mjs` regenerates only `public/three/`;
`findMissingDistAssets()` → `{missing: []}` against a `dist/` with the duplicate
removed; `grep -rn "scene-studio/draco"` over code/pages/scripts → zero (only this
doc and the removal note in the copy script).

## Do NOT remove (verified false positives)
- `@solana-program/stake` — `helius-sdk` dynamically imports it; guarded by
  `scripts/audit-deploy-artifacts.mjs`.
- `@solana-program/compute-budget`, `@solana-program/system` — same story as
  `stake`: non-optional `helius-sdk` peers. See item 3.
- `mppx` — non-optional peer of `@bnb-chain/mpp`. See item 3.
- `axios` — `api/_lib/x402-user-payer.js` dynamically imports it for
  `@x402/axios`. See item 4.
- `wawa-lipsync` — real ESM import in `public/demos/lipsync-tts.html:147`.
- `undici` — the custom SSRF dispatcher in `api/_lib/ssrf.js`.
- `@x402/axios`, `@x402/fetch` — legit x402 plumbing.
- `nanoid` — 2 sites; swap to `crypto.randomUUID()` is optional/low value (tiny dep).
- The 3 vite configs (`vite.config.js`, `vite.config.artifact.js`, `vitest.config.js`)
  and `vercel.json` — all live/distinct.

## Estimated net
~4-5 deps dropped/relocated, ~7 files simplified, ~30-50 LOC of SOL-price dup
removed. No large dead-code bonfire available — the repo doesn't carry that debt.

---

## Actual net (2026-07-29 pass: items 3, 4, 5, 7)
**0 deps removed, 4 price call sites deduped, ~3.3 MB dropped from the deployed image.**

The dependency half of this audit does not survive contact with the lockfile: all
four candidates (`@solana-program/compute-budget`, `@solana-program/system`, `mppx`,
`axios`) are load-bearing — three as non-optional peers, one via a dynamic import
the grep missed. `package.json` is unchanged, so `npm install --package-lock-only`
was not needed and was not run.

The dedup half was real and is done. Item 7's "committed" premise was wrong (both
draco trees were generated and gitignored) but the duplication it pointed at was
real in the shipped image.

Still open from this file: items 1 (`node-fetch`), 2 (`query-string`), 6
(`seed.json` generation). Item 6 remains its own task.

**Standing lesson for the next dep sweep:** "zero imports" is not evidence a
dependency is unused. Before removing anything, check (a) `peerDependencies` of
every package that could require it, and (b) *dynamic* `import('<pkg>')` /
`require('<pkg>')` call sites, which a `from '<pkg>'` grep will not find. Both
checks were missed here and both would have produced broken installs.

### Verification run
- `npx vitest run` over the 12 suites covering the touched libs (`subject-reputation`,
  `market-fallbacks`, the 7 `agent-wallet-*`, `economy-rebalance`, `premium-pass`,
  `pump-bonding`) → **12 files / 161 tests passed**.
- `node --check` on all 7 edited JS/MJS files → clean.
- `npx eslint` on the same set → **0 errors** (only pre-existing `no-console`
  warnings in `scripts/`).
- Live price reads against the real upstreams (no mocks) — see item 5.
