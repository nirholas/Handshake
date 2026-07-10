# Production log triage

Every recurring `error`/`warning` signature that shows up in a production log
export, mapped to its **root cause**, the **exact resolution**, and **who** can
apply it. Built from the `three-ws-character-studio` export on 2026-07-03 and
re-confirmed against the `three.ws` export on 2026-07-05 (same population plus the
two storage-pressure signatures added below — still no code defects). The
signatures are unchanged after the 2026-07-07 move to Google Cloud Run; only the
places you read logs and set env vars changed (Cloud Run + Cloud Scheduler now,
per [docs/ops/gcp-production.md](gcp-production.md)).

The headline finding, so nobody re-derives it: **none of these are code
defects.** Each line is the platform's own graceful-degradation or fail-closed
machinery working correctly — a fallback firing, a circuit breaker holding, a
guard refusing to spend. They are all resolved by an **environment / billing /
activation** action on the Cloud Run service env or in an upstream dashboard, not
by a code change.
Silencing any of them in code would hide a real production signal, so don't.

Severity legend: 🔴 owner decision (money / security / billing) · 🟡 set an env
var or add quota · 🟢 self-healing, no action needed.

> **You no longer need a log export to see most of this.** The platform now
> self-reports internal-dependency health: **[/status](https://three.ws/status)**
> renders it with a plain-language fix for each degradation, and
> **`/api/healthz`** carries a machine-readable `subsystems` block (cache, database,
> Helius RPC, x402 ring, world, x402 config). The uptime cron
> ([api/cron/uptime-check.js](../../api/cron/uptime-check.js)) parks a snapshot
> each tick and re-pages a degradation that persists. Source of the roll-up:
> [api/_lib/ops/subsystem-health.js](../../api/_lib/ops/subsystem-health.js). This
> table remains the deep reference for what each state means and how to clear it.

---

## 🔴 `[ring-invariants] SPEND PATH DISABLED in x402-autonomous-loop`

```
guard env violated:
• X402_CHARITY_AUDIT_BPS = <unset> (expected 0)
• X402_FACILITATOR_URL_SOLANA / X402_SELF_FACILITATOR_ENABLED = enabled=false url=…payai… (expected self)
```

- **Source:** [api/_lib/x402/ring-allowlist.js](../../api/_lib/x402/ring-allowlist.js) `assertRingSpendInvariants`, called each tick by [api/cron/x402-autonomous-loop.js](../../api/cron/x402-autonomous-loop.js).
- **What it means:** the autonomous spend loop is *enabled* but the closed-loop
  guard env is only **half-configured** — `X402_EXTERNAL_ENABLED=false` is set
  (good), but `X402_CHARITY_AUDIT_BPS` is unset and the Solana facilitator still
  points at an external host. The loop **fails CLOSED**: no money moves. It logs
  `error` and fires one throttled critical alert per hour because a partially-off
  guard on a money path is exactly what you want screamed at you.
- **This is not a false alarm** — it accurately reports an unfinished ring
  activation. Resolve it by finishing **or** pausing, not by muting.

**Resolve — pick one (owner):**

1. **Pause cleanly until you're ready to arm the ring** (recommended if you are
   not actively activating): set `X402_AUTONOMOUS_ENABLED=false`. The loop then
   returns `skipped` with **no error and no alert** (guard check never runs).
2. **Finish arming the ring** (moves real USDC — deliberate go-live): set the
   documented safe values from [.env.example](../../.env.example) §x402-ring —
   `X402_CHARITY_AUDIT_BPS=0`, `X402_SELF_FACILITATOR_ENABLED=true`, and either
   unset `X402_FACILITATOR_URL_SOLANA` or point it at
   `https://three.ws/api/x402-facilitator`. Acceptance criteria: the guard env
   set is complete and the coverage sweep settles every catalog entry.

---

## 🔴 `[world-health] world is UNPROTECTED — ADMIN_CODE is not set`

- **Source:** [api/cron/world-health.js](../../api/cron/world-health.js).
- **What it means:** the `world.three.ws` Cloud Run service is serving without
  `ADMIN_CODE`, so every visitor has build rights. Logged as `warning`.
- **Resolve (owner):** set `ADMIN_CODE` on the world service and re-run
  `deploy/world/apply-hardening.sh`. It's a security credential the owner must
  choose and store — not something to auto-generate here.

---

## 🔴 `[text-to-image] replicate billing/credit failure: insufficient credit`

- **Source:** the forge text→image lane.
- **What it means:** the Replicate account is out of credit. The forge already
  **degrades to the free NVIDIA NIM lane** (see the `[forge] paid … lane
  unavailable; degrading to free NVIDIA NIM` line), so image generation keeps
  working at lower fidelity.
- **Resolve (owner):** add credit at `replicate.com/account/billing`. No code
  change — the fallback is already correct.

---

## 🟡 `[x402-audit] insert failed … db query exceeded 3000ms deadline`

- **Source:** [api/_lib/x402/audit-log.js](../../api/_lib/x402/audit-log.js) `logPaymentEvent`.
- **What it means:** the Neon DB is saturated, so a best-effort audit write timed
  out at its 3 s fast-fail budget. This is **fire-and-forget** — the payment was
  already decided and the response already sent (the accompanying `402` is the
  normal x402 challenge, not a failure). The log is throttled to one line/minute
  with a suppressed-count digest by design.
- **Amplification is now fixed in code.** Audit writes no longer fire one Neon
  insert per request. `logPaymentEvent` buffers each event to a Redis list and a
  once-a-minute batch flusher (`flushAuditBuffer`, drained by
  [api/cron/flush-usage-events.js](../../api/cron/flush-usage-events.js) and the
  QStash job) drains them as **one multi-row INSERT** — the same buffer→flush path
  usage events use. So a slow-DB spell no longer self-amplifies into a storm of
  concurrent single-row writes; this line now appears only if the batched flush
  itself hits a genuinely down Neon, and only when Redis is also absent does it
  fall back to the old bounded direct insert. A retention sweep in
  [api/cron/db-retention.js](../../api/cron/db-retention.js) also keeps the ledger
  trimmed (`X402_AUDIT_RETENTION_DAYS`, default 90) so the dashboard aggregates
  that scan it stay fast.
- **Resolve (owner, capacity):** the root cause is still DB headroom — scale the
  Neon compute or add a pooler so writes settle quickly. For more durability
  headroom on the direct-insert fallback, raise `X402_AUDIT_WRITE_TIMEOUT_MS`
  (500–15000, default 3000). Losing these rows loses only telemetry, never a
  payment. Ring spend status (live / paused / guard violations) is now also
  visible in `/api/healthz` under `x402.ring`.

---

## 🟡 `[cron] <name> skipped — db at storage cap (<size>MB ≥ <high-water>MB); retention will reclaim space`

```
[cron] launcher-tick skipped — db at storage cap (593MB ≥ 470MB); retention will reclaim space
```

- **Source:** [api/_lib/http.js](../../api/_lib/http.js) `wrapCron({ requireWriteCapacity: true })`, via `isStoragePressured()` in [api/_lib/db.js](../../api/_lib/db.js). Emitted by the write-heavy crons that opt into the preflight: `launcher-tick`, `coin-intel-observe`, `smart-money-rollup`, `recompute-reputation`, `intel-learn`.
- **What it means:** the Neon branch is over its high-water mark (`DB_RETENTION_HIGH_WATER_MB`, default 470). Rather than run a full write-tick that would fail per-row with SQLSTATE 53100 and flood the logs, each write-heavy cron **preflight-skips** with a single warn and a healthy heartbeat (uptime reads it as up, not stalled). [api/cron/db-retention.js](../../api/cron/db-retention.js) runs every 15 min, tightens its retention window to the floor under pressure, DELETEs + VACUUMs, and the next tick resumes once size drops back under the mark. In the 2026-07-05 export db-retention was scheduled and returning `200` (~3.5 s/run) the whole window — the valve is working; the branch is simply sitting above the mark because the live data footprint exceeds it and Neon's storage GC is not instant.
- **Resolve (owner, capacity):** the write crons stay skipped only while `pg_database_size > high-water`. Pick one: (a) raise the **Neon compute/storage plan** so the branch has headroom above the real footprint; (b) if the branch's actual cap is higher than 470 MB, raise `DB_RETENTION_HIGH_WATER_MB` to match the plan so the write crons stop skipping needlessly; (c) tighten `PUMP_INTEL_RETENTION_DAYS` / `PUMP_INTEL_MIN_RETENTION_DAYS` to shed the firehose faster. None is a code change — the gate and the valve are already correct and covered by [tests/cron-storage-backoff.test.js](../../tests/cron-storage-backoff.test.js).

---

## 🟢 `{"stage":"index-delegations","warning":"time-budget-exceeded","elapsedMs":…,"stoppedAtBlock":…}`

- **Source:** [api/cron/\[name\].js](../../api/cron/[name].js), the delegations indexer (`IDX_TIME_BUDGET_MS`, 22 s — a conservative per-invocation budget that checkpoints the cursor well before any request timeout).
- **What it means:** the indexer hit its per-invocation time budget mid-backfill, so it **saved the cursor at `stoppedAtBlock` and returned** rather than risk a 504. The next tick resumes exactly where it stopped. This is a checkpoint, not a failure — logged as `warning` by design. A run of these back-to-back just means the indexer is draining a block backlog (cold cursor starts a day back); it stops once the cursor catches the confirmed head.
- **Resolve:** 🟢 nothing required — it self-heals as the backlog drains. If it never stops over many hours, the RPC pool is too slow to keep pace; add a faster `IDX_RPC_URLS` endpoint or shrink the per-chain block cap so each tick makes more progress.

---

## 🟢 `[cache] redis SET failed / degraded / circuit opened … memory fallback`

- **Source:** [api/_lib/cache.js](../../api/_lib/cache.js).
- **What it means:** Upstash REST SETs are timing out (a store in a region far
  from the function region is the usual cause). The cache adapter already: fails
  fast at `CACHE_REDIS_CMD_TIMEOUT_MS`, opens a **circuit breaker** after 5
  consecutive failures, adds a **SET-suppression gate** so degraded writes skip
  Redis entirely, and **throttles** every warning to one line/minute. Reads keep
  being served; nothing is on the request critical path.
- **Resolve:** 🟢 nothing required — it self-heals when Upstash recovers (you'll
  see `redis SET recovered`). 🟡 optional: move the cache to a same-region store,
  or provision a dedicated `UPSTASH_CACHE_REST_URL/TOKEN` so best-effort cache
  writes don't contend with the fail-closed rate limiter, or bump
  `CACHE_REDIS_CMD_TIMEOUT_MS` for a distant store.

---

## 🟢 `[three-holders-snapshot] refresh deferred (transient upstream): Solana error #8100002`

- **Source:** [api/cron/three-holders-snapshot.js](../../api/cron/three-holders-snapshot.js).
- **What it means:** Helius DAS returned a 429 (rate limit). The cron classifies
  it as **transient** (via `isRpcRateLimited` on the structured status code),
  logs a `warning` not an `error`, leaves the prior good snapshot intact, and
  self-heals on the next 5-minute tick. Public reads are unaffected.
- **Resolve:** 🟢 nothing required. 🟡 if it's frequent, raise the Helius plan/quota.

---

## 🟢 `[balances] helius quota/rate-limited — skipping it … using public RPC`

- **Source:** [api/_lib/balances.js](../../api/_lib/balances.js) (and the token-market path).
- **What it means:** Helius hit `max usage reached`; the code backs off Helius for
  a few minutes and serves from the **public Solana RPC** in the meantime.
- **Resolve:** 🟢 nothing required — the public-RPC fallback is working. 🟡 raise
  the Helius quota to avoid the degraded window.

---

## 🟢 `[forge] paid TRELLIS lane unavailable (N); degrading text→3D to free NVIDIA NIM` / `nim flux failed, falling back: nim flux timed out`

- **Source:** the forge generation router.
- **What it means:** the paid TRELLIS lane returned a 402/timeout, so forge fell
  back to the free NVIDIA NIM lane, and when a specific NIM model timed out it
  fell back again. Layered fallbacks — generation keeps succeeding.
- **Resolve:** 🟢 nothing required. Tied to the same Replicate billing item above
  if you want the paid high-fidelity lane back.

---

## The owner runbook — every fix as an exact command

Everything red/yellow above, condensed to the actions only the owner can take,
each reduced to a copy-paste command. Nothing here is a code change — the code
paths behind every line are already hardened and covered by tests
([tests/x402-ring-invariants.test.js](../../tests/x402-ring-invariants.test.js),
[tests/cache-circuit-breaker.test.js](../../tests/cache-circuit-breaker.test.js),
[tests/cache-store-routing.test.js](../../tests/cache-store-routing.test.js),
[tests/cron-storage-backoff.test.js](../../tests/cron-storage-backoff.test.js)).
Apply the env writes to the `three-ws-api` Cloud Run service with
`gcloud run services update`; each write rolls out a new revision, so they take
effect as soon as that revision is serving traffic.

### 1. 🔴 World — stop every visitor having build rights (do this first)

The fail-closed patch ([deploy/world/patches/0003-fail-closed-without-admin-code.patch](../../deploy/world/patches/0003-fail-closed-without-admin-code.patch))
is already in the repo; it just isn't live on the running revision. One script
generates the secret, rebuilds, redeploys, and polls `/status` until it reports
`protected:true` (needs Cloud Run / Secret Manager / Cloud Build on project
`aerial-vehicle-466722-p5`):

```bash
bash deploy/world/apply-hardening.sh   # prints the admin code once — store it in a password manager
```

### 2. 🔴 x402 ring — pause cleanly, or finish arming

```bash
# Pause quietly (recommended unless you're actively going live) — kills the hourly guard alert:
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --update-env-vars X402_AUTONOMOUS_ENABLED=false
# …or finish arming (moves real USDC) per docs/x402-ring-economy.md guard-env section.
```

### 3. 🟡 Neon — stop the write-crons preflight-skipping at the storage cap

DB sat at 593 MB vs the 470 MB high-water in the 2026-07-05 export, so
`launcher-tick`, `coin-intel-observe`, `smart-money-rollup`, `recompute-reputation`,
and `intel-learn` were skipping. Pick the lever that matches your Neon plan:

```bash
# (a) If your branch's real cap is well above 470 MB, raise the high-water to match
#     (must stay under the real Neon cap):
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --update-env-vars DB_RETENTION_HIGH_WATER_MB=900
# (b) …or shed the pump.fun firehose faster (keeps the branch smaller):
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --update-env-vars PUMP_INTEL_RETENTION_DAYS=7,PUMP_INTEL_MIN_RETENTION_DAYS=2
# (c) Best durable fix: bump the Neon compute/storage plan in the Neon dashboard.
```

### 4. 🟡 Replicate — restore the paid forge lane (clears the two 502s)

Add credit at `replicate.com/account/billing`. The free NVIDIA NIM + HF lanes
keep serving meanwhile; paid credit brings back the high-fidelity TRELLIS lane.

### 5. 🟡 Upstash / Helius — kill the redis-timeout and 429 warnings (optional)

```bash
# A same-region dedicated cache store ends the 'redis SET failed' flood:
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --update-env-vars UPSTASH_CACHE_REST_URL=<url>,UPSTASH_CACHE_REST_TOKEN=<token>
# …or just give a distant store more headroom:
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --update-env-vars CACHE_REDIS_CMD_TIMEOUT_MS=5000
# Helius 429s: raise the plan/quota in the Helius dashboard (public-RPC fallback covers the gap).
```
