# Production Issues — three.ws / 3D-Agent

> Source: Vercel log export `3dagent-log-export-2026-05-24T23-46-48.json`
> 64,919 log records. 7,385 are 5xx. 13,274 are 4xx/5xx total.
>
> **Agent directive: Fix every item. No questions. No stubs. Wire 100%. Update when done.**

---

## CRITICAL — Fix Immediately

### 1. `pump-agent-stats` cron — 7,000+ consecutive 504 timeouts

**Endpoints:** `/api/cron/pump-agent-stats` across all deployments
**Volume:** ~7,200 504 timeouts. `3dagent-lkvpaeq68` alone has 4,085.

**Root cause:** The cron calls Pump.fun/Solana RPC for up to 100 mints per run. The public Solana RPC rate-limits at 429 immediately, so the retry loop (500ms → 1s → 2s → 4s) burns through Vercel's 30-second function timeout every single invocation without doing any useful work.

```
Server responded with 429 Too Many Requests. Retrying after 500ms delay...
Server responded with 429 Too Many Requests. Retrying after 1000ms delay...
Server responded with 429 Too Many Requests. Retrying after 2000ms delay...
Server responded with 429 Too Many Requests. Retrying after 4000ms delay...
Vercel Runtime Timeout Error: Task timed out after 30 seconds
```

**Fix:**
- In `api/cron/[name].js` → `handlePumpAgentStats`: add a wall-clock deadline check — bail out of the mint loop when `Date.now() - startMs > 22_000` (leave buffer before Vercel's 30s kill).
- Track a "circuit-open" flag in Upstash/KV: if the last 3 runs all timed out on 429, skip the run and log `{ skipped: 'rpc_circuit_open' }` — prevents piling invocations that all fail identically.
- The retry logic inside `pumpStatsSnapshotMint` must catch 429 and re-throw immediately (no retries) when already under a deadline. The outer loop catches and logs it.
- Use a configured RPC endpoint (`SOLANA_RPC_URL` env var) — the free mainnet endpoint is rate-limited by default. If `SOLANA_RPC_URL` is already set in production env, confirm it's not also using the public endpoint.

**File:** `api/cron/[name].js` lines 631–825

---

### 2. `api/marketplace/agents` — 105 × 500 errors

**Endpoint:** `GET /api/marketplace/agents` (the main public listing)
**Volume:** 105 errors, plus 4 each on `/agents/1e6af976...`, `/agents/7f117fa4...`, `/agents/c5a761fe...`

**Root cause:** Unknown — the logs don't capture the error message body for this endpoint. The `handleList` query in `api/marketplace/[action].js:279` is a large JOIN across 6 tables with 4 correlated subqueries (reviews, skill_purchases, asset_prices). Most likely: a DB timeout (Neon cold-start or query plan issue), or a missing column referenced in the query.

**Fix:**
- Add `try/catch` around the primary `sql\`` query in `handleList`, log the full error with `console.error('[marketplace/list]', err)`, and return a structured 500 response so the message appears in future logs.
- Add a `statement_timeout` to the Neon connection for this query (e.g., `sql\`SET LOCAL statement_timeout = '8000'\`` before the main query) — prevents silent hangs.
- Check that all referenced columns exist: `skill_purchases.confirmed_at`, `agent_reviews.rating`, `asset_prices.is_active`, `avatars.thumbnail_key`. Run `\d` on each table in Neon console to verify.

**File:** `api/marketplace/[action].js` lines 279–355

---

### 3. `api/club/leaderboard` — 16 × 500 errors

**Endpoint:** `GET /api/club/leaderboard`
**Volume:** 16 errors

**Root cause:** No error message captured in logs. The query joins `club_dancer_wallets` and `club_tips` tables. Most likely the `paid_at` column referenced in the query (`case when t.paid_at is null`) doesn't exist on `club_tips`, or one of the tables is missing entirely.

**Fix:**
- Wrap the `runForWindow(window)` call with try/catch and log: `console.error('[club/leaderboard]', err)` — without this, the `wrap()` helper returns a 500 with no server-side log line.
- Verify `club_dancer_wallets` and `club_tips` tables exist in Neon. If `club_tips` is missing the `paid_at` column, add it: `ALTER TABLE club_tips ADD COLUMN paid_at timestamptz;`
- The leaderboard is also missing a `vercel.json` route. It works via Vercel's default file-based routing (the file exists at `api/club/leaderboard.js`), but confirm this by testing `/api/club/leaderboard` on the deployed URL.

**File:** `api/club/leaderboard.js`

---

### 4. `api/threews/subdomain` — 5 × 500 (ESM import crash)

**Error message:**
```
[api] unhandled file:///var/task/node_modules/@bonfida/spl-name-service/dist/esm/instructions/burnInstruction.js:1
import"../node_modules/buffer/index.js";import{TransactionInstruction as i}from"@solana/web3.js"
```

**Root cause:** `@bonfida/spl-name-service` ships as an ES module that uses bare `import` syntax. Vercel's Node.js serverless runtime bundles API functions as CJS by default; when the bundler encounters a bare ESM `import` inside a dependency it can't tree-shake, it crashes at runtime.

**Fix:**
- In `api/threews/subdomain.js` (or in `api/_lib/threews-sns.js`), wrap the import of anything from `@bonfida/spl-name-service` or `src/solana/sns-subdomain.js` in a dynamic `await import()` so the module is resolved at call time, not at function cold-start.
- Alternatively: add `"@bonfida/spl-name-service"` and `"@solana/web3.js"` to the `external` array in `vite.config.js` for the API build so Vercel's bundler leaves them as native requires and doesn't try to inline them.
- Also add `ZAUTH_API_KEY` to Vercel env (see issue #8) — the 500 also emits `[zauth] disabled` which suggests the request hits that check before crashing.

**Files:** `api/threews/subdomain.js`, `api/_lib/threews-sns.js`, `vite.config.js`

---

### 5. `api/mocap/clips` — 6 × 500 errors

**Endpoint:** `GET /api/mocap/clips` and `POST /api/mocap/clips`
**Volume:** 6 errors (plus 2 × 405)

**Root cause:** The `handleList` function builds a raw SQL string with positional params. The Neon serverless client does NOT support interpolated `sql\`...\`` fragments inside another tagged template. The comment in the code acknowledges this but the actual positional param array approach may have a gap when `kindFilter` is provided and the `SUPPORTED_FORMATS` check intersects with the param ordering.

**Fix:**
- Add `console.error('[mocap/clips/list]', err)` in the catch block so the actual error appears in logs.
- Audit the raw SQL params array in `handleList` — ensure the `$N` placeholder indices match the `params.push()` order exactly, especially for the `kind` filter branch that appends conditionally.
- The 405 on `POST /api/mocap/clips` is suspect: the handler accepts both GET and POST. Verify `vercel.json` has no route that rewrites this to a GET-only path. (Currently no vercel.json entry for this path — it relies on default routing, which should be fine.)

**File:** `api/mocap/clips.js`

---

### 6. `api/permissions/list` — 2 × 500 errors

**Endpoint:** `GET /api/permissions/list`
**Volume:** 2 errors

**Fix:** Add error logging in `api/permissions/[action].js` — same pattern as above. No message in logs means the error is swallowed. Log it and investigate the actual DB query.

**File:** `api/permissions/[action].js`

---

### 7. Solana RPC 429 — all `/api/agents/{id}/solana` endpoints

**Volume:** 400+ endpoints returning 404 (agent not found in DB), multiple returning 200 with logged errors.

**Error message (200 responses):**
```
[agents/solana/wallet] balance fetch failed Error: failed to get balance of account X:
Error: 429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}
```

**Root cause:** The public Solana mainnet RPC (`api.mainnet-beta.solana.com`) is shared and rate-limits heavily. Every agent wallet balance check hits it directly with no caching.

**Fix:**
- In `api/agents/solana/_handlers.js` (or wherever `getConnection()` is called for balance checks): wrap the `getBalance()` call in a try/catch. On 429, return a cached value from Upstash (if available) rather than failing. Set a 60-second TTL on the cached balance.
- If `SOLANA_RPC_URL` is not set in production env, add a fallback list of public RPC endpoints and rotate on 429.
- The 404s on `/api/agents/{uuid}/solana` are not rate-limit errors — those agents simply don't have a Solana wallet registered in the DB. These are expected and not fixable without the agents creating wallets. They're not bugs.

**Files:** `api/agents/solana/` handlers

---

### 8. `api/chat` — 18 × 502 errors

**Endpoint:** `POST /api/chat`
**Volume:** 18 502 (bad gateway) responses

**Root cause:** The upstream AI API (Anthropic or OpenAI via a worker proxy) is returning 5xx during these calls. The `api/chat.js` handler forwards the response status verbatim, so a 502 from the provider becomes a 502 to the client.

**Fix:**
- In `api/chat.js`: when the upstream returns 5xx, retry once after 500ms before propagating the error to the client.
- Log `console.error('[chat] upstream error:', upstream.status, text)` so future logs show what the actual upstream error message is.
- If the worker proxy itself is the issue, check `workers/` for the chat proxy and add proper upstream error handling there too.

**File:** `api/chat.js`

---

## ENVIRONMENT CONFIGURATION — Required for Full Feature Parity

### 9. `ZAUTH_API_KEY` not set — affects 30+ endpoints

**Endpoints affected:** `api/agents`, `api/agent-actions`, `api/auth/wallets`, `api/avatars`, `api/keys`, `api/marketplace/agents/mine`, `api/mcp`, `api/users/me/purchased-skills`, `api/widgets`, `api/x402-pay`, and many more.

**Log message:** `[zauth] disabled: ZAUTH_API_KEY not set` — appears on virtually every authenticated endpoint.

**Root cause:** The `zauth` middleware (`api/_lib/zauth.js`) is a zero-knowledge auth layer that requires `ZAUTH_API_KEY` to be set. When unset it disables itself and falls back to the regular session/bearer auth. The `[zauth] disabled` log line is emitted at INFO level but appears in error-level log exports because it co-occurs with auth failures.

**Fix:** Set `ZAUTH_API_KEY` in Vercel environment variables for the production project. If zauth is intentionally disabled, suppress the log line so it doesn't pollute error analysis: change the `console.warn('[zauth] disabled...')` to `if (process.env.NODE_ENV !== 'production') console.warn(...)`.

**File:** `api/_lib/env.js` line ~426, `api/_lib/zauth.js` (or wherever the log fires)

---

### 10. `api/avatars/reconstruct` — 14 × 501 (not configured)

**Root cause:** `REPLICATE_RECONSTRUCT_MODEL` env var is not set. The Replicate provider (`api/_providers/replicate.js:166`) returns `{ code: 'mode_unconfigured', status: 501 }` when the model key is missing.

**Fix:** Set `REPLICATE_RECONSTRUCT_MODEL` in Vercel env. The default fallback model is `firtoz/trellis` (see `api/_providers/replicate.js:60`). If intentionally disabled, the 501 response is correct behavior — but the `api/avatars/regenerate-status` poll loop should surface a user-facing "Reconstruction unavailable" message rather than silently spinning.

---

### 11. `api/onboarding/avaturn-session` — 10 × 501 (not configured)

**Root cause:** `AVATURN_API_KEY` not set in production. The endpoint at `api/onboarding/[action].js:37` returns 501 when the key is missing.

**Fix:** Set `AVATURN_API_KEY` in Vercel env, or update the frontend that calls this endpoint to show a graceful "Avatar editor unavailable" state rather than surfacing the 501 as a user-visible error.

---

### 12. `api/auth/register` — NeonDB cold-start failures

**Error message:**
```
Unhandled Rejection: NeonDbError: Error connecting to database: fetch failed
  at execute (...@neondatabase/serverless/index.mjs:1549)
  at async seedDefaultAgent (api/_lib/seed-default-agent.js:20)
```

**Root cause:** `seedDefaultAgent` is called after successful registration but Neon's serverless HTTP driver occasionally fails with a network error on first connection (cold pool). The rejection is unhandled so it 500s the response even though the user account was already created.

**Fix:** In `api/_lib/seed-default-agent.js`, wrap the entire function body in try/catch. Log failures but **do not propagate** — a missing seed agent is recoverable (the user can create one manually). The registration endpoint should return 201 regardless of whether seeding succeeded.

**File:** `api/_lib/seed-default-agent.js`

---

## ROUTING GAPS — Missing vercel.json entries

### 13. `api/agent-strategy` — 404 (no vercel.json route, endpoint exists)

The file `api/agent-strategy.js` exists and is complete. Vercel's default file routing *should* serve it, but the 404s in logs suggest it's not being routed. Add an explicit entry to `vercel.json`:

```json
{ "src": "/api/agent-strategy", "dest": "/api/agent-strategy" }
```

---

### 14. `api/widgets/index` — 404/405

`GET /api/widgets/index` returns 404. The widgets listing may be at `/api/widgets` only. Verify the client code is calling the correct path. Add a route alias in `vercel.json` if needed:
```json
{ "src": "/api/widgets/index", "dest": "/api/widgets" }
```

---

## LOWER PRIORITY

### 15. `api/agents/8004/search` — 6 × 504 (ERC8004 search timeout)

The ERC8004 search endpoint is timing out on complex on-chain queries. Add a timeout guard and return partial results rather than a 504. Limit query complexity.

---

### 16. `api/x402-pay` — 503 (2 occurrences)

The x402 payment processing endpoint returned 503 (service unavailable) twice. Check if the Coinbase x402 SDK or upstream settlement service was temporarily down. Add retry logic for transient 5xx from the upstream payment network.

---

### 17. `/.well-known/x402` — 405 Method Not Allowed (11 occurrences)

External scanners/bots are hitting `/.well-known/x402` with POST/DELETE methods. The `wk.js` handler only accepts GET (correct). The 405 responses are expected behavior — **not a bug**. No fix needed. Optionally add these bot IPs to a deny list if they're causing load.

---

### 18. `cron/erc8004-crawl` — multiple 504 timeouts

ERC8004 crawl cron times out on some deployments. The `ERC8004_BLOCK_CHUNK = 2000` may be too large for certain RPC providers. Reduce to `1000` and confirm the cursor persists correctly between invocations.

**File:** `api/cron/[name].js` line ~119

---

## Summary Table

| Priority | Endpoint | Status | Root Cause | Volume |
|----------|----------|--------|------------|--------|
| P0 | `pump-agent-stats` cron | 504 | Solana RPC 429 burns timeout | 7,200+ |
| P0 | `api/marketplace/agents` | 500 | DB query failure (unlogged) | 109 |
| P0 | `api/club/leaderboard` | 500 | Missing table/column (unlogged) | 16 |
| P1 | `api/threews/subdomain` | 500 | `@bonfida` ESM import crash | 5 |
| P1 | `api/mocap/clips` | 500 | SQL positional param bug | 6 |
| P1 | `api/permissions/list` | 500 | Unlogged error | 2 |
| P1 | `api/agents/*/solana` | 200+err | Solana RPC 429, no cache | 400+ |
| P1 | `api/chat` | 502 | Upstream AI API 5xx, no retry | 18 |
| P1 | `api/auth/register` | 500 | NeonDB cold-start, unhandled | ~10 |
| P2 | `ZAUTH_API_KEY` unset | log noise | Env var missing | pervasive |
| P2 | `api/avatars/reconstruct` | 501 | `REPLICATE_RECONSTRUCT_MODEL` unset | 14 |
| P2 | `api/onboarding/avaturn-session` | 501 | `AVATURN_API_KEY` unset | 10 |
| P3 | `api/agent-strategy` | 404 | Possible missing vercel.json route | 2 |
| P3 | `api/widgets/index` | 404 | Wrong path or missing route | 3 |
| P3 | `api/agents/8004/search` | 504 | Query timeout | 6 |
| P3 | `api/x402-pay` | 503 | Upstream payment network transient | 2 |
