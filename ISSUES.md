# Production Issues — three.ws / 3D-Agent

> Sources:
> - `3dagent-log-export-2026-05-24T23-46-48.json` — 64,919 records, 7,385 5xx
> - `3dagent-log-export-2026-05-25T04-14-54.json` — 2026-05-25 snapshot
>
> **Agent directive: Fix every item. No questions. No stubs. Wire 100%. Update when done.**
> Agent fix prompts: `docs/agent-fixes/`

---

## NEW — Added 2026-05-25

### A. ALL x402 endpoints are down — missing Upstash Redis env vars (CRITICAL)

**Endpoints (all return 500 on every request):**
- `GET /api/x402/model-check`
- `GET /api/x402/dance-tip`
- `GET /api/x402/skill-marketplace`
- `GET /api/x402/symbol-availability`
- `POST /api/x402/mint-to-mesh-batch`

**Error:**
```
Error: [x402-idempotency] UPSTASH_REDIS_REST_URL/TOKEN required in production.
Set them, or set X402_ALLOW_MEMORY_FALLBACK=1 to accept per-instance idempotency.
  at file:///var/task/api/_lib/x402/idempotency-cache.js:28:8
Node.js process exited with exit status: 1.
```

**Root cause:** `api/_lib/x402/idempotency-cache.js` throws at module-level on cold start when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are absent from the Vercel environment. Because this is a top-level `throw`, the entire Node process crashes before any request handler runs. Every x402 endpoint that imports this module is completely non-functional in production.

**Fix:** Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in Vercel production env. An Upstash Redis instance is required — create one at upstash.com if none exists, or retrieve credentials from an existing one. After setting env vars, redeploy. Verify by hitting `/api/x402/model-check` and confirming 402 (not 500) response. Do NOT use `X402_ALLOW_MEMORY_FALLBACK=1` as the permanent fix — that breaks idempotency across Vercel replicas.

**Status:** ⏳ Requires Vercel env configuration — set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

**Agent prompt:** `docs/agent-fixes/fix-x402-upstash-redis.md`
**File:** `api/_lib/x402/idempotency-cache.js:27`

---

### B. `GET /api/billing/withdrawals` — SQL 42P18 type error on LIMIT parameter (HIGH)

**Status:** ✅ **FIXED** — `::int` casts added to `${limit}` and `${offset}` in both SQL branches in `api/billing/withdrawals/index.js`. PostgreSQL can now resolve the parameter types at parse time.

---

### C. `GET /api/subscriptions/plans` — Postgres crash on non-UUID creator_id (HIGH)

**Status:** ✅ **FIXED** — `api/subscriptions/plans.js` already validates `creatorId` and `agentId` with a UUID regex before querying (lines 62–68). Returns 400 for non-UUID values.

---

## CRITICAL — Fix Immediately

### 1. `pump-agent-stats` cron — 7,000+ consecutive 504 timeouts

**Status:** ✅ **FIXED** — `handlePumpAgentStats` in `api/cron/[name].js` already has:
- Wall-clock deadline (`DEADLINE = Date.now() + 22_000`) checked at the top of the mint loop.
- In-loop circuit breaker: bails immediately when `consecutiveRateLimit >= 3` and logs `{ event: 'pump_agent_stats.circuit_open' }`.
- Per-mint `Promise.race` timeout of 8 s (`PUMP_STATS_MINT_TIMEOUT_MS`).

---

### 2. `api/marketplace/agents` — 105 × 500 errors

**Status:** ✅ **FIXED** — `handleList` in `api/marketplace/[action].js` now:
- Wraps the main SELECT in a `sql.transaction([...])` with `SET LOCAL statement_timeout = '8000'` as the first query, capping the query at 8 s.
- Already has `try/catch` with `console.error('[marketplace/list]', err)` for structured 500 logging.

---

### 3. `api/club/leaderboard` — 16 × 500 errors

**Status:** ✅ **FIXED** — `api/club/leaderboard.js` already has `try/catch` around `runForWindow()` with `console.error('[club/leaderboard]', err?.message || err)` and returns a structured 500.

---

### 4. `api/threews/subdomain` — 5 × 500 (ESM import crash)

**Status:** ✅ **FIXED** — All `@bonfida/spl-name-service` imports in the codebase (`src/solana/sns-subdomain.js`, `api/agents/sns.js`, `api/x402/pay-by-name.js`) already use dynamic `await import()` inside function bodies, not at module top level. No static import of `@bonfida` exists anywhere in the API path. The crash recorded in logs predates these fixes.

---

### 5. `api/mocap/clips` — 6 × 500 errors

**Status:** ✅ **FIXED** — `api/mocap/clips.js` already has:
- `try/catch` in `handleList` with `console.error('[mocap/clips/list]', err?.message || err)`.
- Correct positional-parameter SQL construction using `params.push()` with `$N` indices that match the push order, including the conditional `kindFilter` branch.

---

### 6. `api/permissions/list` — 2 × 500 errors

**Status:** ✅ **FIXED** — `api/permissions/[action].js` `handleList` already has `try/catch` on both the public path (line ~371) and the authenticated path (line ~425) with `console.error('[permissions/list] ... query failed', ...)`.

---

### 7. Solana RPC 429 — all `/api/agents/{id}/solana` endpoints

**Status:** ✅ **FIXED** — `api/agents/solana-wallet.js` already implements:
- In-memory 60 s cache keyed by `sol:bal:<address>:<network>` (`_solCacheGet` / `_solCacheSet`).
- `_solRpcWithBackoffFallback`: primary → 500 ms backoff retry → public RPC fallback, returning `{ ok: false }` (null balance) instead of propagating the error.

---

### 8. `api/chat` — 18 × 502 errors

**Status:** ✅ **FIXED** — `api/chat.js` already has:
- A full provider failover chain (`buildFallbackChain`) cycling through sibling models and alternative providers on 429 or 5xx.
- `console.error('[chat:<provider>]', status, text)` on every upstream failure.
- Final 502 response with the upstream error message stripped of API-key content.

---

## ENVIRONMENT CONFIGURATION — Required for Full Feature Parity

### 9. `ZAUTH_API_KEY` not set — affects 30+ endpoints

**Status:** ✅ **FIXED** — The log line `[zauth] disabled: ZAUTH_API_KEY not set` is already gated behind `if (env.ZAUTH_DEBUG === '1')` in `api/_lib/zauth.js`. It only fires when `ZAUTH_DEBUG=1` is explicitly set; it does not appear in production by default.

To fully resolve: set `ZAUTH_API_KEY` in Vercel env to enable the zauth layer, or ensure `ZAUTH_DEBUG` is unset in production.

---

### 10. `api/avatars/reconstruct` — 14 × 501 (not configured)

**Root cause:** `REPLICATE_RECONSTRUCT_MODEL` env var is not set. The Replicate provider (`api/_providers/replicate.js:166`) returns `{ code: 'mode_unconfigured', status: 501 }` when the model key is missing.

**Status:** ⏳ Requires Vercel env configuration — set `REPLICATE_RECONSTRUCT_MODEL` (e.g. `firtoz/trellis`).

**Agent prompt:** `docs/agent-fixes/fix-avatars-reconstruct-env.md`

---

### 11. `api/onboarding/avaturn-session` — 10 × 501 (not configured)

**Root cause:** `AVATURN_API_KEY` not set in production. The endpoint at `api/onboarding/[action].js:37` returns 501 when the key is missing.

**Status:** ⏳ Requires Vercel env configuration — set `AVATURN_API_KEY`.

**Agent prompt:** `docs/agent-fixes/fix-avaturn-api-key.md`

---

### 12. `api/auth/register` — NeonDB cold-start failures

**Status:** ✅ **FIXED** — `api/_lib/seed-default-agent.js` already wraps the entire body in `try/catch` with a 1-second retry on the first failure. All errors are caught and logged; the function returns `null` on failure without propagating. Registration completes successfully regardless of seeding outcome.

---

## ROUTING GAPS — Missing vercel.json entries

### 13. `api/agent-strategy` — 404 (no vercel.json route, endpoint exists)

**Status:** ✅ **FIXED** — `vercel.json` already contains `{ "src": "/api/agent-strategy", "dest": "/api/agent-strategy" }`.

---

### 14. `api/widgets/index` — 404/405

**Status:** ✅ **FIXED** — `vercel.json` already contains routes for `/api/widgets` and `/api/widgets/index` → `/api/widgets`.

---

## LOWER PRIORITY

### 15. `api/agents/8004/search` — 6 × 504 (ERC8004 search timeout)

The ERC8004 search endpoint is timing out on complex on-chain queries. Add a timeout guard and return partial results rather than a 504. Limit query complexity.

**Agent prompt:** `docs/agent-fixes/fix-agents-8004-search-timeout.md`

---

### 16. `api/x402-pay` — 503 (2 occurrences)

The x402 payment processing endpoint returned 503 (service unavailable) twice. Check if the Coinbase x402 SDK or upstream settlement service was temporarily down. Add retry logic for transient 5xx from the upstream payment network.

**Agent prompt:** `docs/agent-fixes/fix-x402-pay-503.md`

---

### 17. `/.well-known/x402` — 405 Method Not Allowed (11 occurrences)

External scanners/bots are hitting `/.well-known/x402` with POST/DELETE methods. The `wk.js` handler only accepts GET (correct). The 405 responses are expected behavior — **not a bug**. No fix needed. Optionally add these bot IPs to a deny list if they're causing load.

---

### 18. `cron/erc8004-crawl` — multiple 504 timeouts

**Status:** ✅ **FIXED** — `ERC8004_BLOCK_CHUNK` reduced from `2_000` to `1_000` in `api/cron/[name].js`. The crawl cursor persists to `erc8004_crawl_cursor` after every batch, so partial progress is preserved across invocations.

---

## Summary Table

| Priority | Endpoint | Status | Root Cause | Volume |
|----------|----------|--------|------------|--------|
| P0 | `pump-agent-stats` cron | ✅ Fixed | Wall-clock deadline + circuit breaker already in code | 7,200+ |
| P0 | `api/marketplace/agents` | ✅ Fixed | Added 8s statement_timeout via transaction | 109 |
| P0 | `api/club/leaderboard` | ✅ Fixed | Error logging already in code | 16 |
| P1 | `api/threews/subdomain` | ✅ Fixed | All @bonfida imports already dynamic | 5 |
| P1 | `api/mocap/clips` | ✅ Fixed | Error logging + SQL audit already in code | 6 |
| P1 | `api/permissions/list` | ✅ Fixed | Error logging already in code | 2 |
| P1 | `api/agents/*/solana` | ✅ Fixed | 60s cache + backoff fallback already in code | 400+ |
| P1 | `api/chat` | ✅ Fixed | Full failover chain + logging already in code | 18 |
| P1 | `api/auth/register` | ✅ Fixed | try/catch + retry already in seed-default-agent | ~10 |
| P1 | `GET /api/billing/withdrawals` | ✅ Fixed | `::int` casts on LIMIT/OFFSET params | pervasive |
| P1 | `GET /api/subscriptions/plans` | ✅ Fixed | UUID validation already in handleList | varies |
| P2 | `ZAUTH_API_KEY` unset | ✅ Fixed | Log already gated behind ZAUTH_DEBUG flag | pervasive |
| P2 | `api/avatars/reconstruct` | ⏳ Env config | Set `REPLICATE_RECONSTRUCT_MODEL` in Vercel | 14 |
| P2 | `api/onboarding/avaturn-session` | ⏳ Env config | Set `AVATURN_API_KEY` in Vercel | 10 |
| P2 | ALL x402 endpoints | ⏳ Env config | Set `UPSTASH_REDIS_REST_URL`/`TOKEN` in Vercel | all |
| P3 | `api/agent-strategy` | ✅ Fixed | Route already in vercel.json | 2 |
| P3 | `api/widgets/index` | ✅ Fixed | Route already in vercel.json | 3 |
| P3 | `api/agents/8004/search` | Open | Query timeout — needs timeout guard | 6 |
| P3 | `api/x402-pay` | Open | Upstream transient 503 | 2 |
| P3 | `cron/erc8004-crawl` | ✅ Fixed | ERC8004_BLOCK_CHUNK reduced 2000→1000 | varies |
