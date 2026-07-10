# Redis (Upstash) — quota, burn rate, and limiter classification

The platform's distributed rate limiters and the shared cache run on a single
Upstash Redis store. On the free plan that store has a hard ceiling of
**500,000 commands/month**. When the ceiling is hit, every `critical: true`
limiter **fails closed** — which blocks every paid forge generation and every
x402 payment platform-wide. This is not theoretical: in early June 2026 the
previous store burned ~42,000 commands/day and exhausted the quota in ~12 days,
taking the paid surface down for all users.

This doc is the deliberate-decision playbook: what burns quota, how to see the
burn before it's a crisis, and when/how to upgrade.

## Upstash plan management

### Current plan

Free tier: 500,000 requests/month. Store: `three-ratelimit`
(`store_QnjIWaKv4d5MvmA9`).

### Upgrade trigger

Upgrade to the Pay-As-You-Go plan when **projected monthly usage exceeds
400,000 requests (~80% of the free ceiling)**. At $0.20 per 100k additional
commands the cost is negligible relative to the revenue lost during a quota
outage.

"Projected monthly" = today's command count × 30. It is computed and surfaced
automatically — see _Visibility_ below — so the trigger fires on a number, not a
hunch.

### How to upgrade

1. Upstash console → `three-ratelimit` store → Billing → Upgrade to
   Pay-As-You-Go.
2. **No code change required** — the store endpoint and token remain the same,
   so `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are untouched.
3. Update this doc with the plan-change date.

### Reducing burn without upgrading

See `api/_lib/rate-limit.js` — limiters marked `local: true` use **zero Redis
commands** (per-instance in-memory enforcement). Eligible candidates: status-poll
limiters, public health-check limiters, public read endpoints, cron rate guards.
**Never mark a `critical: true` limiter as `local`** — the fail-closed behavior
on a missing/exhausted Redis is the correct safety behavior for money-moving
operations.

## Visibility

### Health endpoint

`GET /api/forge?health` includes a `redis` block:

```json
"redis": {
  "dailyCommands": 9120,
  "monthlyBudget": 500000,
  "projectedMonthly": 273600,
  "percentUsed": 54.7,
  "status": "ok"
}
```

- `percentUsed` is the share of the **daily** budget (`500000 / 30 ≈ 16,667`)
  consumed today — 100% projects to exactly the monthly ceiling.
- `status`: `ok` (≤70%), `warning` (>70%), `critical` (>90%), or `unknown`
  (usage could not be read — never a fabricated number).
- A `critical` Redis status degrades the endpoint's `overall` to `degraded`,
  so the early warning rides the same signal as a dead backend.

Source: `api/_lib/redis-usage.js` (`getRedisBurn` / `evaluateRedisBurn`). The
daily command count is read from the **Upstash Management API**
(`GET https://api.upstash.com/v2/redis/stats/{id}`, HTTP Basic auth with
`UPSTASH_EMAIL` : `UPSTASH_MANAGEMENT_API_KEY`), falling back to the REST
`/stats/daily` summary. These are read-only credentials distinct from the
limiter's command token; when none are configured, burn reports `unknown` and
degrades nothing.

### Ops alert

`api/cron/forge-smoke.js` (daily cron) reads the same burn number and pages the
ops Telegram channel when the 30-day projection crosses a threshold:

- **> 400,000 (80%)** → warning: "Redis on track to exceed quota …".
- **> 450,000 (90%)** → critical: "forge + x402 outage imminent …".

Requires `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERTS_CHAT_ID` (shared with the rest
of the ops alerting). The alert is advisory and never fails the smoke run.

### Config

| Env var | Purpose | Required? |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | limiter + cache commands (and REST `/stats/daily` fallback) | yes (already set) |
| `UPSTASH_EMAIL` | Management API basic-auth user | for burn visibility |
| `UPSTASH_MANAGEMENT_API_KEY` | Management API key (read-only usage) | for burn visibility |
| `UPSTASH_REDIS_STORE_ID` | store id for the Management API | defaults to the live store |

## Redis call-site catalogue

Every Redis touch is one of three classes. The class decides whether it may move
to `local` (no Redis command) or must stay Redis-backed.

- **local** — per-instance in-memory is sufficient; spends zero Redis commands.
  Only for high-frequency, low-stakes flood guards where cross-instance
  coordination buys nothing.
- **critical** — cost/money-moving or auth-security; must be Redis-backed and
  **fail closed** when Redis is absent/exhausted.
- **cross-instance-required** — correctness depends on shared state across
  serverless instances (atomic spend ledgers, idempotency/replay dedup, shared
  feeds/caches). Redis-backed, but fails *open* or degrades rather than denying.

### Rate limiters (`api/_lib/rate-limit.js`)

| Limiter | Class | Note |
| --- | --- | --- |
| `mcp3dStatus` | local | generation status poll — highest-frequency call; per-instance cap |
| `publicIp` | local | generic public reads (explore/showcase/feeds) — flood guard only |
| `notificationsRead` | local | nav-badge poll (30s + focus/nav) — per-user, no shared resource |
| `auditLogRead` | local | per-user audit-log browse/poll |
| `tokenPriceIp` | local | cache-served price reads; upstream Jupiter is rate-limit-free |
| `widgetRead` | local | embedded-widget read fetch — continuous third-party-page polling |
| `pinStatusIp` | local | pin-status progress poll |
| `authIp`, `registerIp`, `verifyEmailIp`, `forgotPasswordEmail`, `resendVerifyUser` | critical | auth/credential-guessing — fail closed |
| `chatUser`, `chatIp`, `chatHostKeyGlobal`, `brainChatUser`, `brainChatIp`, `livepeerIp` | critical | paid LLM inference |
| `mcp3dGenerate`, `mcpValidate`, `mcpInspect`, `mcpOptimize`, `mcpBazaar`, `mcpAgent`, `mcpAgentPay` | critical | paid compute / paid tools |
| `avatarPayoutDaily`, `agentBuy`, `x402PayGlobal`, `videoGenerateUser`, `videoGenerateGlobal` | critical | real money movement |
| `bountyJudge`, `voiceClone`, `ttsSpeakUser`, `ttsSpeakIp` | critical | paid synthesis / inference |
| all other `*Ip` / `*User` read & write limiters | cross-instance-required | distributed per-principal caps; fail open on outage |

### Direct Redis usage (cache, feeds, ledgers)

| File | Class | Operation |
| --- | --- | --- |
| `api/_lib/cache.js` | cross-instance-required | shared cache GET/SET/DEL (read-memo + single-flight in front to cut burn) |
| `api/_lib/feed.js` | cross-instance-required | activity feed LPUSH/LTRIM/LRANGE (8s read-coalesce window) |
| `api/_lib/usage.js` | cross-instance-required | usage-event buffer RPUSH/LRANGE/LTRIM (batched flush) |
| `api/_lib/x402-spending-ledger.js` | critical / cross-instance-required | atomic INCRBY spend caps per hour/day/address |
| `api/_lib/a2a/spend-ledger.js` | critical / cross-instance-required | agent-to-agent daily payout caps |
| `api/_lib/x402/idempotency-cache.js` | critical / cross-instance-required | payment replay dedup (GET/SET) |
| `api/_lib/builds-store.js` | cross-instance-required | build metadata + per-mint index cache |
| `api/_lib/alerts.js` | cross-instance-required | ops-alert dedup + hourly ceiling |
| `api/x402-pay.js`, `api/feed-stream.js`, `api/_lib/channel-feed-sources.js`, `api/_lib/pumpfun-mcp.js` | cross-instance-required | demo payment feed + feed reads |
| `api/cron/uptime-check.js`, `api/cron/quota-check.js`, `api/cron/flush-usage-events.js` | cross-instance-required | cron cache snapshots + buffer drain |

> The spend-ledger and idempotency entries are both critical (money-moving) and
> cross-instance-required (atomicity across instances) — they can never move to
> `local`, and they must keep Redis-backed atomic increments even under quota
> pressure. They are the floor on how low burn can go without an upgrade.

### History

- **2026-06-12** — previous store hit the 500k ceiling; all paid lanes failed
  closed. New store `three-ratelimit` provisioned (same limits), daily
  forge-smoke + limiter health probe added. `mcp3dStatus` moved to `local`.
- **2026-06-14** — `publicIp`, `notificationsRead`, `auditLogRead`,
  `tokenPriceIp`, `widgetRead`, `pinStatusIp` moved to `local`; burn-rate block
  added to `/api/forge?health`; projected-quota Telegram alert added to the
  forge-smoke cron; this doc created.

## Data durability

Keys in the active Upstash store fall into two durability classes.

### Durable keys — must survive store rotation

These keys hold user-owned data. If the store is rotated (new free-tier store
provisioned) without migrating them, user data is lost.

| Pattern | Type | TTL | What it holds |
| --- | --- | --- | --- |
| `cosmetics:owned:<account>` | SET | 2 years | Cosmetics purchased via x402 — a user's paid unlocks |
| `x402:pay:call:<tx_hash>` | STRING | 30 days | Payment dedup record by transaction hash — prevents replay |
| `featured-builds:<mint>` | STRING/JSON | 45 days | Forge build gallery index per mint |
| `play-build:<id>` | STRING/JSON | 45 days | Individual forge build thumbnail + metadata |
| `x402:pay:feed` | LIST (≤50 items) | none | Recent x402 payment activity feed |
| `feed:events` | LIST (≤200 items) | none | General platform activity feed |

### Ephemeral keys — safe to lose

These keys regenerate automatically within seconds to minutes.

| Pattern | Why safe |
| --- | --- |
| `rl:*` | Rate-limit windows; rebuild on next request |
| `x402:rl:*` | Subscription rate-limit sorted sets; rebuild on next call |
| `forge-smoke:last` | Last cron result; regenerated on next run (≤24h) |
| `uptime:snapshots` | Rolling 24h probe data; regenerated on next uptime cron |
| `uptime:daily` | 90-day aggregate; rebuilds incrementally from new probes |
| `usage:buffer` | Usage-event RPUSH buffer; flushed to DB by cron, then DEL'd |
| `feed:joined:<key>` | World-join dedup (60s TTL) |
| `rep:<agentId>:<chain>` | Reputation cache (5-min TTL) |
| `quota:redis` | Quota check cache (25h TTL) |
| `a2a:spend:<mandateId>` | A2A mandate spend ledger; mandate-scoped, short-lived |
| `<route>|<paymentId>` | Idempotency cache for x402 paid endpoints |

## Store rotation procedure

When a store must be rotated (quota exhausted, billing migration, etc.):

### Step 1 — Recover dead store credentials

The dead store's REST URL and token are needed for migration. Try in order:

1. **Upstash console** — log in at [console.upstash.com](https://console.upstash.com),
   locate the old store, click "REST API" tab. Copy URL and token.

2. **Cloud Run service env / prior revisions** — the live store creds are set on
   the `three-ws-api` service (`UPSTASH_REDIS_REST_URL` plaintext,
   `UPSTASH_REDIS_REST_TOKEN` via Secret Manager `upstash-redis-rest-token`). If a
   cred was overwritten, the old value is still readable from the revision that
   used it:
   ```bash
   gcloud run services describe three-ws-api --region us-central1 \
     --project aerial-vehicle-466722-p5 --format=yaml | grep -A1 UPSTASH
   gcloud run revisions list --service three-ws-api --region us-central1 \
     --project aerial-vehicle-466722-p5   # then `describe <old-revision>` for its env
   ```

3. **Known active store** (for local dev): `smiling-crane-148172.upstash.io`,
   credentials in `.env.local` as `three_KV_REST_API_*`. This is the
   `three-ratelimit` store provisioned 2026-06-12.

### Step 2 — Dry-run and review

```bash
DEAD_REDIS_URL=<old-url> DEAD_REDIS_TOKEN=<old-token> \
  node scripts/migrate-redis.mjs --dry-run
```

Review the output. Expected: all `cosmetics:owned:*` and build keys appear
under COPY. If the count looks wrong (e.g. 0 cosmetics when purchases are
known to have been made), check that DEAD_REDIS_URL points to the correct store.

### Step 3 — Run the migration

```bash
DEAD_REDIS_URL=<old-url> DEAD_REDIS_TOKEN=<old-token> \
  node scripts/migrate-redis.mjs
```

The script uses `SET NX` for strings and `SADD` for sets, so re-running is
safe — it never clobbers newer data that landed in the active store after the
rotation.

### Step 4 — Post-migration verification

**Cosmetics** — check that a wallet known to have purchased a cosmetic still
owns it:
```bash
curl -s "https://three.ws/api/cosmetics?wallet=<address>" | jq '.items | length'
```

**Payment feed** — confirm the x402 pay feed is non-empty:
```bash
curl -s "https://three.ws/api/x402-pay?feed=1" | jq '.feed | length'
```

**Build gallery** — verify a known agent's forge builds are visible:
```bash
curl -s "https://three.ws/api/builds?mint=<mint>" | jq '.builds | length'
```

### Backup strategy

- Run `node scripts/migrate-redis.mjs --dry-run` monthly (or wire it to a
  cron) to log durable key counts. A sudden drop signals data loss before
  users notice.
- Upstash supports point-in-time snapshots on paid plans. Enable this once
  the store is on Pay-As-You-Go to avoid needing a migration window at all.
- The migration window for the free plan is the first few days of each billing
  month (when quota resets) or after a plan upgrade.
