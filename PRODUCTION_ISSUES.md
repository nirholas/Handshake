# Production Issues — Vercel Log Audit (2026-05-24)

**Directive:** Fix every item below completely. No shortcuts, no stubs, no TODOs. Wire 100%. Real APIs, real implementations. Do not report back until every issue is resolved and verified.

---

## CRITICAL — Repeated 500 errors

### 1. Missing DB table: `agent_reviews`
- **Error:** `NeonDbError: relation "agent_reviews" does not exist` — 52× 500 from `/api/marketplace/[action]`
- **Root cause:** `api/marketplace/[action].js:317-318` and `:377-378` query `agent_reviews` table which is absent from `api/_lib/schema.sql` entirely.
- **Fix:** Add `agent_reviews` table to schema.sql (columns: `id uuid PK`, `agent_id uuid FK→agent_identities`, `user_id uuid FK→users`, `rating int`, `review text`, `created_at timestamptz`). Apply additive `ALTER TABLE IF NOT EXISTS` style. Also add a separate `api/marketplace/reviews.js` handler if it doesn't already work for the `reviews` action.

### 2. Missing DB tables: `x_triggers`, `x_scheduled_posts`, `x_pending_reviews`
- **Error:** `column "agent_id" does not exist` — 72× from `/api/cron/[name]` run-x-triggers
- **Root cause:** `api/cron/[name].js:2686` queries `x_triggers` with columns `id, user_id, agent_id, kind, config, auto_publish, last_fired_at, last_state`. None of these three tables exist in `api/_lib/schema.sql`.
- **Fix:** Add all three tables to schema.sql:
  - `x_triggers(id uuid PK, user_id uuid FK→users, agent_id uuid FK→agent_identities, kind text, config jsonb, auto_publish bool, enabled bool, last_fired_at timestamptz, last_state jsonb, created_at timestamptz)`
  - `x_scheduled_posts(id uuid PK, user_id uuid FK→users, agent_id uuid FK→agent_identities, text text, scheduled_at timestamptz, published_at timestamptz, created_at timestamptz)`
  - `x_pending_reviews(id uuid PK, user_id uuid FK→users, trigger_id uuid FK→x_triggers, agent_id uuid FK→agent_identities, text text, reviewed_at timestamptz, approved bool, created_at timestamptz)`

### 3. Missing DB column: `club_tips.amount_atomics`
- **Error:** `column "total_atomics" does not exist` — 7× 500 from `/api/club/leaderboard`
- **Root cause:** `api/club/leaderboard.js` computes `sum(t.amount_atomics)` aliased as `total_atomics`. The column `amount_atomics` doesn't exist in the production `club_tips` table (schema.sql has it defined but the migration hasn't run or production table was created from an older schema).
- **Fix:** Add `ALTER TABLE club_tips ADD COLUMN IF NOT EXISTS amount_atomics numeric;` migration to schema.sql. Verify `club_tips` schema matches all columns leaderboard.js and tips.js reference.

---

## HIGH — Infrastructure & Rate Limiting (thousands of errors)

### 4. Solana RPC Rate Limiting (Helius 429) — 900+ errors
- **Error:** `[agents/solana/wallet] balance fetch failed ... 429 Too Many Requests: max usage reached` — 900+ occurrences across `/api/agents/[id]`
- **Root cause:** Helius free/starter plan being exhausted. Every agent page load triggers a live Solana RPC call for balance. No caching.
- **Fix:**
  - Add Redis/KV cache in `api/_lib/balances.js` (or inline in `api/agents/[id].js`): cache balance responses for 60s per wallet address.
  - Implement RPC endpoint rotation: fall through to public RPC (`https://api.mainnet-beta.solana.com`) when Helius returns 429.
  - Add exponential backoff retry (max 2 retries, 500ms/1s delays) before the fallback.
  - Same treatment for `getSignaturesForAddress` activity calls.

### 5. Cron Timeout (504) — 393 occurrences
- **Error:** `Vercel Runtime Timeout Error: Task timed out after 30 seconds` — from `index-delegations` cron
- **Root cause:** EVM delegation indexer fetches too many blocks in one invocation; ETH mainnet RPC caps `eth_getLogs` at 50-block ranges. Each cron run tries to catch up many hundreds of blocks before the 30s deadline.
- **Fix:**
  - In `api/cron/[name].js` `indexDelegations` handler: reduce block batch size to ≤25 for mainnet (chainId=1), ≤50 for L2s.
  - Add a hard time budget check (`Date.now() - start > 22000`) after each batch and break early, saving cursor progress.
  - Log a warning on early exit so the next invocation continues from the saved cursor.

### 6. OpenRouter Free Model Rate-Limited — 7× 502 from `/api/chat`
- **Error:** `[chat:openrouter] 429 ... meta-llama/llama-3.3-70b-instruct:free is temporarily rate-limited`
- **Root cause:** Free tier model rate-limited upstream; no fallback model configured.
- **Fix:** In the OpenRouter chat path, add model fallback chain: on 429, retry once with `meta-llama/llama-3.1-8b-instruct:free`, then fall back to `anthropic/claude-haiku` (paid). Log which model was actually used in the response.

---

## HIGH — Missing Env Vars (configuration gaps)

### 7. `X402_AGENT_SOLANA_SECRET_BASE58` not set — 1× 503
- **Error:** `[api] unhandled Error: agent wallet not configured (set X402_AGENT_SOLANA_SECRET_BASE58)` from `/api/x402-pay`
- **Root cause:** `api/x402-pay.js:287` throws when env var is absent. This error is unhandled (bubbles to Vercel as a 503).
- **Fix:** Wrap `loadAgentKeypair()` call in a try/catch that returns `error(res, 503, 'config_missing', 'payment processing not available')` — same pattern used for subdomain minting. Also verify the env var is set in Vercel production dashboard.

### 8. `ZAUTH_API_KEY` not set — 1954× 500 from `/api/threews/subdomain`
- **Error:** `[zauth] disabled: ZAUTH_API_KEY not set` logged at `level=info` but response is 500
- **Root cause:** The zauth instrument layer logs the "disabled" message but something else in `api/threews/subdomain.js` is throwing. Investigate: the subdomain handler calling into zauth when disabled may have an unguarded code path.
- **Fix:** Confirm `api/_lib/zauth.js` `instrument()` returns cleanly (noop) when `ZAUTH_API_KEY` is absent. The 500 status on these requests indicates a secondary crash — trace the actual stack and fix the unhandled error. Set `ZAUTH_API_KEY` in Vercel env if the zauth service is in use.

---

## HIGH — Unhandled Errors / Missing Error Handling

### 9. `@bonfida/spl-name-service` ESM bundling crash — 2× 500 from `/api/threews/subdomain`
- **Error:** `[api] unhandled file:///var/task/node_modules/@bonfida/spl-name-service/dist/esm/instructions/burnInstruction.js:1 import"../node_modules/buffer/index.js"` — SyntaxError from module parse
- **Root cause:** Vercel's bundler is hitting an ESM module that re-imports `buffer` with a bare relative specifier that breaks in the serverless bundle.
- **Fix:** Pin `@bonfida/spl-name-service` to a CommonJS-compatible version or add a Vercel `bundler` override in `vercel.json` to externalize it: `{ "functions": { "api/threews/subdomain.js": { "excludeFiles": "" } } }`. Alternatively switch to a direct Solana RPC call for SNS resolution to avoid the broken dependency.

### 10. `api/permissions/[action].js` — unhandled UUID validation — 1× 500
- **Error:** `NeonDbError: invalid input syntax for type uuid: "missing-id-xyz"` 
- **Root cause:** `handleList` passes user-supplied `id` directly into a UUID column without validation.
- **Fix:** Before the SQL query, validate with `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)` and return `error(res, 400, 'invalid_id', 'id must be a valid UUID')` if invalid.

### 11. `api/widgets/view` — FK violation on insert — 1× error
- **Error:** `insert or update on table "widget_views" violates foreign key constraint "widget_views_widget_id_fkey"`
- **Root cause:** Widget views are being logged for widget IDs that don't exist in the `widgets` table (deleted or invalid).
- **Fix:** Wrap the `widget_views` insert in a try/catch — this is a best-effort analytics write. Swallow FK violation errors (Postgres error code `23503`) silently. Already 204 status but the unhandled error logs it as a warning.

### 12. `api/mocap/clips.js` — NeonDB `$1` syntax error still in production — 2× 500
- **Error:** `NeonDbError: syntax error at or near "$1"` from `handleList`
- **Root cause:** Fix was committed locally but may not be deployed, OR there is a second code path in `handleList` with the nested `sql\`...\`` template fragment pattern.
- **Fix:** Audit the entire `handleList` function in `api/mocap/clips.js`. Every `sql\`...\`` that uses another `sql\`...\`` as a fragment must be converted to the positional-params pattern. Deploy.

---

## MEDIUM — Missing Routes (404s)

### 13. `/api/agents/[id]/solana` → 404 for 500+ requests
- **Error:** 404 for `/api/agents/{uuid}/solana` — hits from many real agent UUIDs
- **Root cause:** `vercel.json:603-604` routes `/api/agents/([^/]+)/solana` → `/api/agents/[id]` but the `[id].js` handler doesn't handle the `/solana` sub-action — it likely returns 404 for unrecognised paths.
- **Fix:** In `api/agents/[id].js`, detect when the request path ends with `/solana` (check `req.url.includes('/solana')`), extract the agent UUID, and forward to the Solana wallet/balance handler. Return the correct Solana data (balance, address, etc.) at that endpoint.

### 14. `/api/agent-strategy` — 404 × 2
- **Error:** 404 for `/api/agent-strategy`
- **Root cause:** No handler file exists at `api/agent-strategy.js` and no route in `vercel.json`.
- **Fix:** Create `api/agent-strategy.js` implementing whatever the strategy endpoint should do (check git history / callers for intent), or add a redirect to the correct endpoint in `vercel.json`.

### 15. Template literal in URL — `/agent/$%7Bo(p.value)%7D` — 2× 404
- **Error:** 404 for `/agent/${o(p.value)}` (URL-encoded template literal)
- **Root cause:** A JS template literal is being used as an href instead of being evaluated — likely a `href="\`/agent/${...}\`"` vs `href="/agent/${...}"` bug in a frontend component.
- **Fix:** Search the frontend code for `href="\`/agent/` or `href='` + template literals and fix the string interpolation.

---

## MEDIUM — Method Not Allowed (405s)

### 16. x402 endpoints don't handle HEAD requests — 100+ occurrences
- **Error:** 405 for `HEAD /api/x402/skill-marketplace`, `HEAD /api/x402/model-check`, `HEAD /api/x402/dance-tip`, `HEAD /api/x402/symbol-availability`, `HEAD /.well-known/x402`
- **Root cause:** Health checkers and x402station probers send HEAD requests; the route handlers only accept GET/POST.
- **Fix:** In `api/_lib/http.js` `method()` helper (or in `wrap()`), respond to HEAD requests with the same headers as GET but no body. Standard HTTP: HEAD must be supported wherever GET is. Add `'HEAD'` to allowed methods lists in all x402 handlers.

### 17. `GET /api/x402/mint-to-mesh-batch` — 405 × 127
- **Error:** 405 for GET on a POST-only endpoint
- **Root cause:** `mint-to-mesh-batch.js` only allows POST but bots/probers are hitting it with GET.
- **Fix:** The `method()` helper should return a proper `405 Method Not Allowed` with an `Allow: POST` header. Check that the current implementation does this (don't just return 405 with no body — include `Allow` header per RFC 7231).

### 18. `GET /api/webhooks/replicate` — 405 × 4
- **Error:** 405 for GET on webhook endpoint
- **Root cause:** Webhooks only accept POST; GET needs to return 405 with `Allow: POST`.
- **Fix:** Same as above — confirm `api/webhooks/replicate.js` returns proper 405 with `Allow` header for non-POST methods.

### 19. `/api/x402/permit2-paid-demo` — accepts PUT/PATCH/DELETE — 10× 405
- **Error:** Multiple 405s on methods that should not be accepted
- **Fix:** Tighten `method()` guard to only allow the intended methods (GET or POST). Return `405 { Allow: 'GET, POST' }` for everything else.

---

## MEDIUM — Cron / Background Job Failures

### 20. `index-delegations` ETH mainnet getLogs range error — 7× per run
- **Error:** `RPC eth_getLogs error: eth_getLogs is limited to 0 - 50 blocks range`
- **Root cause:** The indexer builds block ranges larger than 50 for mainnet (chainId=1).
- **Fix:** In `api/cron/[name].js` delegation indexer, enforce `const BATCH = chainId === 1 ? 25 : 150;` (mainnet is the bottleneck; other RPCs allow larger). Already partially noted under issue #5 — this is the specific constraint.

### 21. `index-delegations` fetch failures — 54 occurrences
- **Error:** `{"stage":"index-delegations","chainId":1,"error":"fetch failed"}` and `{"error":"This operation was aborted"}`
- **Root cause:** Vercel function hitting 30s timeout mid-HTTP fetch to RPC endpoint; or network blip.
- **Fix:** Add `AbortController` with 10s timeout on each RPC fetch inside the indexer. Catch `AbortError` and `fetch failed` separately; on timeout, save cursor and return 200 (partial success) instead of letting the whole function timeout at 30s.

### 22. `api/club/tips-stream` timing out — 5× at 300s
- **Error:** `Vercel Runtime Timeout Error: Task timed out after 300 seconds` from SSE stream endpoint
- **Root cause:** SSE streams are holding connections open past Vercel's 300s Pro function limit.
- **Fix:** Implement keep-alive heartbeat that sends a `: ping` comment every 25s. When approaching 280s (`Date.now() - start > 280000`), send a `retry: 1000` SSE directive and close the connection cleanly so the client auto-reconnects. This prevents the hard timeout while maintaining the streaming UX.

---

## LOW — Cleanup & Configuration

### 23. `api/auth/[action].js` seed-default-agent DB connection flaps — 6 failures
- **Error:** `[seed-default-agent] failed ... error: 'Error connecting to database: fetch failed'`
- **Root cause:** Transient Neon connection failures during auth flow. Currently the error is caught and logged but auth continues — verify the handler doesn't block sign-in on seed failure.
- **Fix:** Confirm that `seed-default-agent` failures are fire-and-forget (non-blocking). If auth returns 200 even when seeding fails, this is acceptable. Add retry with 1s delay (one retry only) before giving up.

### 24. Fake/test agent UUID in production — `11111111-2222-3333-4444-555555555555` 404 × 5
- **Error:** 404 for `/api/agents/11111111-2222-3333-4444-555555555555`
- **Root cause:** Test/placeholder UUID being requested in production — likely hardcoded in a client or demo page.
- **Fix:** Search frontend/demo code for `11111111-2222-3333-4444-555555555555` and replace with a real agent UUID or make the endpoint handle gracefully.

### 25. `api/marketplace/theme)` — 404 with trailing `)` in URL × 1
- **Error:** 404 for `/api/marketplace/theme)` — a `)` character leaked into the URL
- **Root cause:** Client-side bug — a URL is being constructed with an unclosed parenthesis (e.g., `\`/api/marketplace/${action)\`...`).
- **Fix:** Search marketplace-related frontend code for the malformed URL construction and fix the string concatenation/template.

---

## Schema Migration Required

The following SQL must be added to `api/_lib/schema.sql` and applied to the production Neon database:

```sql
-- agent_reviews (for marketplace ratings)
CREATE TABLE IF NOT EXISTS agent_reviews (
    id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_id     uuid        NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating       int         NOT NULL CHECK (rating BETWEEN 1 AND 5),
    review       text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_id, user_id)
);
CREATE INDEX IF NOT EXISTS agent_reviews_agent_id ON agent_reviews(agent_id);
CREATE INDEX IF NOT EXISTS agent_reviews_user_id  ON agent_reviews(user_id);

-- x_triggers (social automation triggers)
CREATE TABLE IF NOT EXISTS x_triggers (
    id             uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id       uuid        REFERENCES agent_identities(id) ON DELETE SET NULL,
    kind           text        NOT NULL,
    config         jsonb       NOT NULL DEFAULT '{}',
    auto_publish   boolean     NOT NULL DEFAULT false,
    enabled        boolean     NOT NULL DEFAULT true,
    last_fired_at  timestamptz,
    last_state     jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x_triggers_user_id ON x_triggers(user_id) WHERE enabled;

-- x_scheduled_posts (queued social posts)
CREATE TABLE IF NOT EXISTS x_scheduled_posts (
    id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id     uuid        REFERENCES agent_identities(id) ON DELETE SET NULL,
    text         text        NOT NULL,
    scheduled_at timestamptz NOT NULL,
    published_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x_scheduled_posts_pending ON x_scheduled_posts(scheduled_at) WHERE published_at IS NULL;

-- x_pending_reviews (posts waiting for human approval before publish)
CREATE TABLE IF NOT EXISTS x_pending_reviews (
    id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trigger_id   uuid        REFERENCES x_triggers(id) ON DELETE SET NULL,
    agent_id     uuid        REFERENCES agent_identities(id) ON DELETE SET NULL,
    text         text        NOT NULL,
    reviewed_at  timestamptz,
    approved     boolean,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x_pending_reviews_user_pending ON x_pending_reviews(user_id) WHERE reviewed_at IS NULL;

-- club_tips — add amount_atomics if table predates the column
ALTER TABLE club_tips ADD COLUMN IF NOT EXISTS amount_atomics numeric;
```

---

## Summary by Priority

| # | Issue | Errors | Status |
|---|-------|--------|--------|
| 1 | Missing `agent_reviews` table | 52× 500 | Schema + deploy |
| 2 | Missing `x_triggers`/`x_scheduled_posts`/`x_pending_reviews` | 72× errors | Schema + deploy |
| 3 | `club_tips.amount_atomics` column missing | 7× 500 | ALTER TABLE |
| 4 | Solana RPC 429 rate limiting | 900+ errors | Cache + fallback RPC |
| 5 | Cron 30s timeout | 393× 504 | Batch size + time budget |
| 6 | OpenRouter free model rate-limited | 7× 502 | Model fallback chain |
| 7 | `X402_AGENT_SOLANA_SECRET_BASE58` not set | 1× 503 | Error handler |
| 8 | `ZAUTH_API_KEY` not set causing 500s | 1954× | Fix or set env var |
| 9 | Bonfida ESM bundling crash | 2× 500 | Pin/externalize dep |
| 10 | UUID validation in permissions | 1× 500 | Input validation |
| 11 | widget_views FK violation | 1× | Swallow FK errors |
| 12 | `mocap/clips` `$1` syntax error persists | 2× 500 | Re-audit + redeploy |
| 13 | `/api/agents/[id]/solana` 404 | 500× 404 | Route handler |
| 14 | `/api/agent-strategy` missing | 2× 404 | Create handler |
| 15 | Template literal in URL | 2× 404 | Frontend string fix |
| 16 | x402 HEAD requests → 405 | 100× 405 | Add HEAD support |
| 17-19 | Various 405 missing Allow header | 150+ | Method guards |
| 20 | getLogs range >50 blocks | 7× | Reduce batch size |
| 21 | Index fetch timeouts | 54× | AbortController |
| 22 | tips-stream 300s timeout | 5× | SSE keep-alive + reconnect |
| 23 | seed-default-agent flaps | 6× | Verify non-blocking |
| 24 | Test UUID in production | 5× | Remove hardcoded UUID |
| 25 | Malformed marketplace URL | 1× | Fix template literal |
