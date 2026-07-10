# x402 Overhaul — Shared Context (READ FIRST, every prompt in this folder requires it)

You are rebuilding three.ws's paid-agent offering so it's something crypto users and their AI
agents **actually use**. This file is the single source of truth. It is static reference
written up-front — reading it is NOT a dependency on another agent's work. Every prompt in
this folder is **fully independent**: it can run in its own fresh chat, in any order, in
parallel with the others, and complete 100% on its own. Nothing here waits on another prompt.

---

## Why this exists (the standard every new endpoint must clear)

Our current x402 endpoints are a graveyard: 30 days of live data = **1.81K transactions,
$5.87 volume, 10 buyers.** They're novelties (`dance-tip`, `mint-to-mesh` cube), me-too LLM
wrappers (`fact-check`, `tutor`, `revenue-vision`), or crippled by being three.ws-only
(`agent-reputation`). Nobody pays for them because they don't answer a question an agent has
mid-task.

**The one test every endpoint you build must pass:** *Would an autonomous crypto agent,
in the middle of a real task, use this because it unblocks its goal?* If you can't name the
task and the agent, the endpoint is wrong — stop and rethink it before writing code.

**The strategy:** two free, genuinely-useful loss-leaders (a bundled **Crypto Data API** and
a free **3D API**) that drive adoption, funneling into a small set of paid uniques
(Forge Pro, Rigged Avatars, Pump Launcher, Vanity, cross-chain Trust). Out-usefulness the
competition; don't out-endpoint them. Three or four things people use beats seventeen nobody
does.

---

## The codebase map (so you never have to hunt)

### Paid endpoint pattern — `api/x402/<slug>.js`
Model any new PAID endpoint on `api/x402/three-intel.js` (clean, DexScreener-backed). Every
paid endpoint:
- imports `paidEndpoint` from `../_lib/x402-paid-endpoint.js` — runs the full 8-step dance
  (CORS → method → access-control → SIWX → 402 challenge → verify → handler → settle →
  `X-PAYMENT-RESPONSE`). You only write route metadata + a handler returning JSON.
- prices via `priceFor('<slug>', '<defaultAtomics>')` from `../_lib/x402-prices.js`. USDC has
  6 decimals: `"1000"` = $0.001, `"10000"` = $0.01, `"100000"` = $0.10, `"1000000"` = $1.00.
  Ops can override with env `X402_PRICE_<SLUG>` (upper-snake of slug).
- networks default to Base mainnet; pass `networks: ['base','solana']` (and `'bsc'`) to
  advertise more. payTo comes from `env.X402_PAY_TO_BASE` / `_SOLANA` / `_BSC`.
- MUST export bazaar discovery metadata (`BAZAAR` object: description, INPUT_SCHEMA,
  OUTPUT_SCHEMA) via `buildBazaarSchema` + `withService` from `../_lib/x402/bazaar-helpers.js`.
  Without a valid discovery extension, agentic.market / x402scan **reject** the entry.

### Free endpoint pattern — `api/<namespace>/<slug>.js`
Free endpoints do NOT use `paidEndpoint`. Use the plain-handler pattern: `cors`, `wrap`,
`error` from `../_lib/http.js`, and rate-limit with `clientIp` + `limits` from
`../_lib/rate-limit.js`. Keyless, no account. Model on any existing plain `api/*.js` route
(e.g. `api/solana-rpc.js`, `api/feed.js`). See each free prompt for its exact namespace.

### How a route appears on x402scan (paid only)
`.well-known/x402.json` is served by `api/wk.js` (name `x402-discovery`). It is a
**manually-mirrored** discovery doc — there are explicit per-route maps in `api/wk.js`
(search `'/api/x402/model-check':`). To publish a NEW paid route you (1) export its `BAZAAR`
block, (2) add its mirror block in `api/wk.js`, (3) run `node scripts/verify-x402-discovery.mjs`
until it passes (it flags any drift between the discovery doc and the live 402). Free
endpoints are discovered via their API index + docs page, not the x402 discovery doc.

### Catalog convention (avoids all cross-prompt file conflicts)
Where a prompt adds an entry to a shared catalog/index, it drops **its own file** in a
catalog directory that the index globs — never edits a shared list. Each prompt says exactly
which directory + filename to create. Because every prompt writes only its own new files
plus localized additions, parallel agents don't collide. (If you must touch a shared file
like `api/wk.js` or `data/changelog.json`, per CLAUDE.md: stage ONLY your explicit paths,
never `git add -A`, re-check `git status` right before commit, and if a concurrent commit
conflicts, re-apply only your hunk.)

### Real data sources (NO MOCKS — CLAUDE.md hard rule)
- **DexScreener** — price/liq/mcap/volume/24h. Public, **no key**. (`three-intel.js` uses it.)
- **Solana RPC** — `api/solana-rpc.js`, `api/_lib/solana/`. Public RPC, no key.
- **pump.fun** — `api/_lib/pump-launch-feed.js`, `pumpfun-ws-feed.js`, `pump-quote.js`,
  `pump-trending-score.js`, `pump-volume-anomaly.js`, `agent-pumpfun.js`. Public feeds.
- **Helius / Birdeye / GMGN** — `api/_lib/helius.js`, `birdeye.js`, `gmgn-feed.js`. These
  MAY need keys (check `api/_lib/env.js` for `HELIUS_*` / `BIRDEYE_*`). See "never blocked".
- **Token meta** — `token-metadata.js`, `solana-token-meta.js`, `token-market.js`, `sol-price.js`.
- **Balances** — `api/_lib/balances.js`.
- **Free 3D** — `api/forge-nim.js`, `api/nim-forge.js`, `api/forge.js`, `_lib/forge-job-token.js`.

---

## You are NEVER blocked — decision defaults (so you never stop to ask)

The owner is tired of agents stalling for input. For EVERY common stop-point, here is the
pre-authorized decision. Apply it and keep going. Do not end your turn with a question.

| Situation | Do this — do NOT ask |
|---|---|
| A data provider needs an API key that's absent in env | Degrade gracefully: return every field you can from the keyless sources (DexScreener + public Solana RPC + pump.fun public feeds). Never fail the whole call, never mock. Note the degraded field as `null` with a `source` note. (CLAUDE.md: ship working fallbacks.) |
| Paid endpoint needs a real payment to fully test | Free endpoints need no payment. For paid ones, test the handler function directly + assert the 402-challenge shape via the endpoint's exported metadata; full funded E2E is owned by the OKX stream's runbook, not you. Prove correctness without a live payment. |
| Commit references crypto (pump.fun, Solana tokens, DexScreener) | Pre-approved for THIS work: generic coin-agnostic plumbing where the mint is supplied at runtime is CLAUDE.md mechanical-exception #1, and `$THREE` is our own coin. In tests/fixtures use `$THREE` (CA `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`) or a synthetic placeholder (`THREEsynthetic1111…`). Do NOT hardcode a real third-party mint in committed fixtures — use a placeholder. With that, commit freely; no owner ping needed. |
| Unsure what price to set | Use the default in your prompt's table. It's env-overridable later. Move on. |
| Unsure where a helper/pattern lives | It's in the codebase map above. If still unclear, grep; then model on `api/x402/three-intel.js` (paid) or `api/solana-rpc.js` (free). |
| A shared file conflicts with a concurrent agent | Re-run `git status`, re-apply only your hunk, stage your explicit paths, commit. Never revert their work. |
| Something feels out of scope for your prompt | Do exactly your prompt's scope, fully. Note the adjacent gap in your PROGRESS entry for another prompt. Don't half-do two things. |

If you hit a genuine blocker not covered here (rare), implement everything else 100% first,
then state the ONE specific blocker with exactly what's needed — never leave the rest unfinished.

---

## Definition-of-done template (every prompt inherits this)

- [ ] Feature built, wired, reachable; zero mocks/stubs/TODOs/commented-out code (CLAUDE.md).
- [ ] Every state handled: success, empty, error, bad input, rate-limited, upstream-down.
- [ ] Real data verified: hit the live endpoint, paste the real JSON response in your report.
- [ ] `npm test` green; new tests added following `tests/` conventions; output pasted.
- [ ] Docs: per CLAUDE.md — free/dev-facing capability → `docs/` + the API's docs page;
      new public page → `data/pages.json`; new surface → `STRUCTURE.md` row.
- [ ] `data/changelog.json` entry (holder-readable, correct tags) for anything user-visible.
- [ ] `git diff` self-reviewed line-by-line; committed with EXPLICIT paths (never `-A`);
      pushed with `git push threews main` — the only push target. Never push/pull/fetch/merge
      `threeD` (retired `nirholas/3D-Agent` mirror, diverged history).
- [ ] `npx vercel build` trap: if you ran it, check `head -1` of changed `api/*.js` for
      `__defProp`; recover with `git restore -- api/ public/`.
- [ ] Append a dated entry to `prompts/x402-overhaul/PROGRESS.md` (create if absent): what
      shipped, the live response you captured, adjacent gaps noticed.

## Anti-laziness gates (every prompt inherits these)

- "Returns 200" is not done. The response must be REAL, correct, and useful to the named
  agent use-case. Paste the proof.
- No endpoint ships without you having answered, in its docs: *which agent, doing what task,
  pays/uses this, and why they'd pick us.* If you can't, the endpoint is wrong.
- Free means free: keyless, no account, generous rate limit. Don't sneak a paywall or a
  required key into a "free" endpoint.
- Match the existing code's style, error handling, and naming. Read the neighbor file first.

## Dev commands
```
npm run dev                          # Vite, port 3000
npm test                             # test suite
node scripts/verify-x402-discovery.mjs   # validates x402scan discovery doc (paid routes)
npm run build:pages                  # regenerates + validates changelog / pages
```
