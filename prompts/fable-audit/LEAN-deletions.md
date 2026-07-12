# LEAN — Dependency removals & de-duplication

**Severity:** Lean (no runtime bug) · **Area:** Deps / dedup · **Commit-gate:** ⚠ partial

The repo is genuinely clean — no esbuild-trap files, no committed `dist/`, no
fake-data arrays, no stub/TODO markers in first-party code. These are the real, small
wins. Each is independent; do them as separate commits. **Verify every removal with
`npm ls <pkg>` and a build before deleting** — dynamic imports and HTML entry points
create false positives.

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

## 3. Remove zero-reference deps (after `npm ls` peer check)
- `@solana-program/compute-budget` — zero mentions anywhere; `ComputeBudgetProgram`
  comes from `@solana/web3.js`. Not a peer of `@solana/kit` (verified).
- `@solana-program/system` — only in `multiplayer/package-lock.json`, never imported.
- `mppx` — zero code references (only skill markdown + `specs/`). **⚠ BNB/other-coin
  lib → removal commit hits the $THREE commit gate; get owner approval before staging.**
- Verify each: `npm ls <pkg>` shows no other package depends on it, and a full build
  passes.

## 4. Relocate `axios` from root to `mcp-bridge/package.json`
Only 2 direct imports, both in `mcp-bridge/src/` (`bazaar-discover.js`,
`x402-axios-client.js`). Move the dependency declaration to that workspace; remove
from root. (Relocation, not deletion.)

## 5. De-duplicate SOL-price fetching (dedup, not deletion)
Canonical `api/_lib/sol-price.js` (`solPriceUsd()`) exists, but ~10 files inline
their own CoinGecko/Jupiter/Pyth fetch: `api/_lib/agent-wallet.js`,
`avatar-wallet.js`, `balances.js`, `market-fallbacks.js`,
`trust/subject-reputation.js`, `x402/pipelines/cross-chain-cost.js`,
`x402/pipelines/sniper-intel-enrich.js`, `api/coin/exchange.js`,
`api/cron/news-archive-append.js`, `api/pump/helius-stats.js`. Route them all through
`solPriceUsd()` (~30-50 LOC removed, one cache path). `src/shared/usd-price.js` is a
separate frontend copy — leave it (different runtime).

## 6. Generate `data/skills/seed.json` from source (bloat + drift)
`seed.json` (2,701 lines, ~796KB) embeds verbatim copies of ~115 individual
`SKILL.md` bodies — the largest file in the tree; every skill fix must be made twice
(e.g. finding M4 lives in both). Add a build step that generates `seed.json` (and the
`public/skills/`, `dist/`, `examples/skills/` copies) from the source `SKILL.md`
files. **⚠ some skill bodies reference other coins → the regeneration diff may hit the
commit gate; check before staging.** Larger effort — treat as its own task.

## 7. De-duplicate committed draco vendor libs
`public/three/draco/` and `public/scene-studio/draco/` hold **identical** encoder/
decoder files (verified same md5, ~3.3MB duplicated). Point one at the other (build
copy or symlink) or serve a single canonical path. Cosmetic weight only.

## Do NOT remove (verified false positives)
- `@solana-program/stake` — `helius-sdk` dynamically imports it; guarded by
  `scripts/audit-deploy-artifacts.mjs`.
- `wawa-lipsync` — real ESM import in `public/demos/lipsync-tts.html:147`.
- `undici` — the custom SSRF dispatcher in `api/_lib/ssrf.js`.
- `@x402/axios`, `@x402/fetch` — legit x402 plumbing.
- `nanoid` — 2 sites; swap to `crypto.randomUUID()` is optional/low value (tiny dep).
- The 3 vite configs (`vite.config.js`, `vite.config.artifact.js`, `vitest.config.js`)
  and `vercel.json` — all live/distinct.

## Estimated net
~4-5 deps dropped/relocated, ~7 files simplified, ~30-50 LOC of SOL-price dup
removed. No large dead-code bonfire available — the repo doesn't carry that debt.
