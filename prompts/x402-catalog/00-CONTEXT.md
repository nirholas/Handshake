# 00 — Shared context for the x402 catalog rebuild (read this first, follow every rule)

Every prompt in `prompts/x402-catalog/` starts by telling you to read this file. It exists so
each work order stays small while you still have everything needed to finish **100% without
asking the owner anything**.

## The mandate

On 2026-07-06 the owner reviewed three.ws's listing on x402scan: 17 resources, **$5.87 volume /
10 buyers / 1.81K transactions in 30 days**. Verdict: most endpoints are internal demos wearing
price tags (dance-tip drives the /club page; crypto-intel is documented in its own header as a
demo for /agent-exchange; token-intel/three-intel are DexScreener passthroughs at $0.01 that
agents can get free at the source; skill-marketplace shipped with an EMPTY description).
Only **forge** (text→3D), **vanity** (WASM grinder), and **pump-launch** pass the test every
resource must pass: *"what can I get here that I can't get anywhere else?"*

The rebuild strategy, owner-approved:
1. **A free aggregated Crypto Data API** (`/api/v1/x/*`) — free tier is the funnel; x402 is
   metered overage. Free listings on x402scan get organic adoption because agents can try them
   with zero wallet setup.
2. **A free/cheap AI inference package** — NVIDIA NIM lanes (TRELLIS text→3D, ASR, TTS,
   Audio2Face) + the GCP Vertex image lane, subsidized by credits we already hold.
3. **The 3D Asset Pipeline as the paid product** — generate → rig → animate → optimize →
   deliver. Nobody else in the x402 ecosystem offers any of this.
4. **A clean storefront** — demos delisted, every remaining listing answers the uniqueness
   question in its first sentence.

## Behavioral rules (these override your defaults)

- **NEVER ask the owner a question. NEVER stop for confirmation. NEVER end with "should I…".**
  Pick the most reasonable interpretation and ship. If two options are defensible, pick one,
  note the choice in your final report, and keep going.
- **Complete 100% of your prompt's tasks.** Do not skip a numbered task. Do not do a "first
  pass". If a task turns out to be impossible (upstream API retired, env var genuinely absent),
  build the graceful-degradation path (clear 503 `not_configured`, health probe), document
  exactly what's missing, and finish everything else.
- **Verify upstreams with `curl` BEFORE wiring them.** Third-party API shapes drift. Curl the
  real endpoint, look at the real response, then write the descriptor/transform against what
  you observed. Never wire from memory.
- **No mocks, no fake data, no TODO comments, no stubs, no placeholder copy.** Real APIs, real
  responses, real errors handled at the boundary.
- **Every error has a root cause; find it.** Don't paper over failures with lazy fallbacks.

## The aggregator (the machine most prompts feed)

- **Registry:** `api/v1/_providers.js` — the single source of truth for every third-party API
  three.ws re-offers. Adding an upstream or endpoint = adding a descriptor object here. No new
  route files. Read the descriptor contract in its header comment before touching it.
- **Engine:** `api/_lib/aggregator.js` — `executeUpstream()` does the real fetch (20s timeout,
  key resolution, transform); `getPaidHandler()` wraps an endpoint in the platform's real
  x402 `paidEndpoint` rail.
- **Front door:** `api/v1/x/[...slug].js` — one catch-all route; per request selects a billing
  lane: **BYOK** (caller's own upstream key via `x-provider-key`, pass-through), **plan**
  (three.ws API key/OAuth), or **x402** (no credentials → pay-per-call USDC).
- **Discovery:** `GET /api/v1/x` returns `providerCatalog()`. `api/v1/_catalog.js` holds the
  wider `/api/v1` catalog (`API_META`); native (non-proxy) v1 routes must be registered there.
- **Free-tier contract:** endpoint descriptors may carry `free: { perMin: <n>, perDay: <n> }`.
  Engine support for this field ships in prompt 01 of this campaign (unauthenticated callers
  get that per-IP quota before the 402 kicks in). **Include the `free` field on your endpoints
  regardless of whether prompt 01 has run** — it's inert extra data until the engine reads it,
  so prompts stay order-independent. Choose honest quotas: generous for cheap cached upstreams
  (e.g. 30/min, 5000/day), tight for expensive ones.
- Existing providers: `coingecko`, `defillama`, `openai`. Match their style exactly (tabs,
  `required()` helper, slim `transform`s that strip multi-MB payloads to the fields agents use).

## The x402 rail (for paid endpoints outside the aggregator)

Every paid endpoint under `api/x402/*.js` follows one pattern — read one (e.g.
`api/x402/token-intel.js`) before writing one:
- `paidEndpoint` from `api/_lib/x402-paid-endpoint.js` (settlement; buyer is never charged if
  the handler throws before settlement — keep it that way).
- `buildBazaarSchema` from `api/_lib/x402-spec.js` + `declareHttpDiscovery` / `THREEWS_SERVICE`
  from `api/_lib/x402/bazaar-helpers.js` (v2 bazaar discovery — serviceName ≤32 ASCII chars,
  ≤5 tags ≤32 chars each; a `discoverable: false` resource keeps working but stops being
  indexed by facilitators).
- `priceFor(slug, defaultAtomics)` from `api/_lib/x402-prices.js` — prices in USDC atomics
  (6 decimals, `"10000"` = $0.01), env-overridable via `X402_PRICE_<UPPER_SNAKE_SLUG>`.
- `installAccessControl` from `api/_lib/x402/access-control.js`.

## Verification & docs duties (Definition of Done, every prompt)

- **Tests:** vitest, in `tests/api/*.test.js` — read a neighboring test for the harness pattern
  first. Run targeted: `npx vitest run tests/api/<your-file>.test.js`. Full `npm test` runs
  vitest + playwright and is slow — targeted runs plus the audits below are sufficient.
- **Audits:** if you touched anything under `api/x402/` or bazaar discovery, run
  `npm run audit:x402-catalog`. If you added a page, run `npm run build:pages` (it validates
  `data/pages.json` and `data/changelog.json` and fails on malformed entries).
- **New public page/route** → entry in `data/pages.json` (path, title, description, `added`
  date — feeds sitemap/llms.txt/changelog automatically).
- **Every user-visible change** → entry in `data/changelog.json` (date, holder-readable title +
  summary, tags from: feature/improvement/fix/sdk/infra/docs/security).
- **New top-level directory or product surface** → `README.md` in that directory + row in
  `STRUCTURE.md`.
- **Developer-facing capability** → update `docs/api-reference.md` / `docs/mcp.md` / the
  relevant `docs/*` file, matching neighboring format. Every code sample must actually run.

## Git rules

- **Concurrent agents share this worktree.** Stage explicit paths only — NEVER `git add -A` or
  `git add .`. Re-check `git status` and `git diff --staged` immediately before committing.
- When your tasks are done and verified: commit immediately (no pre-commit audits beyond what
  your prompt lists) and push with `git push threews main`. That is the **only** push target
  (owner decision 2026-07-07). Never push, pull, fetch, or merge `threeD` — the retired
  `nirholas/3D-Agent` mirror, whose `main` has diverged with foreign history; pulling it has
  destroyed files before.
- No GitHub Actions — automation lives in Vercel/workers/scripts, never `.github/workflows/`.
- **Vercel build trap:** `npx vercel build` overwrites `api/*.js` sources in place with esbuild
  bundles. Never run it. If you see a huge `api/` diff starting with `__defProp`, recover with
  `git restore -- api/ public/`.

## $THREE rule (commit gate)

`$THREE` is the platform's only promoted coin — CA `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`.
- **Token-address examples** in code, tests, and docs use the $THREE CA or a clearly-synthetic
  placeholder — never a real third-party mint.
- Generic upstream identifiers as API parameters (`ids=solana,bitcoin`, chain slugs, protocol
  slugs like `uniswap` in a params doc) follow existing committed precedent in
  `api/v1/_providers.js` and are fine — they're infrastructure inputs, not endorsements.
- Never write copy that promotes or recommends any other coin. If a diff would go beyond
  parameter-level references into featuring/endorsing a specific third-party crypto project,
  redesign it to be runtime-parameterized or use $THREE.

## Reporting

End with a short report: what shipped (files + routes), what you verified (commands + results),
the commit hash(es), and any environment gaps the owner must fill
(exact env var names + where to set them). No questions.
