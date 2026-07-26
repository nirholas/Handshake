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

> **This table is now machine-checked.** `npm run triage:gcp`
> ([gcp-logs.md](gcp-logs.md)) sweeps WARNING+ logs across the whole Cloud Run
> fleet, matches them against these signatures, and emits a classified action
> plan; agents run the loop via the `/gcp-triage` skill. When you document a
> new signature here, also add it to `KNOWN_SIGNATURES` in
> [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs).

> **You no longer need a log export to see most of this.** The platform now
> self-reports internal-dependency health: **[/status](https://three.ws/status)**
> renders it with a plain-language fix for each degradation, and
> **`/api/healthz`** carries a machine-readable `subsystems` block (cache, database,
> Helius RPC, x402 ring, **x402 settlement success**, **Forge 3D generation**, world, x402 config). The uptime cron
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

## 🔴 502 wave on `/api/x402/*` from `threews-x402-autonomous/1.0` (ring-duplicate-signature)

```
HTTP 502 POST /api/x402/<any endpoint>   ua: threews-x402-autonomous/1.0   (~334/day since 2026-07-09)
```

- **Source:** the x402 autonomous ring paying its own endpoints; the settle
  step fails, so the paid handler returns 502 with a settle_failed body. No
  app-level ERROR accompanies it (the handler responds, nothing crashes).
- **Root cause (diagnosed 2026-07-17):** same-priced ring payments created in
  the same tick share a blockhash and compile to byte-identical Solana
  transactions, hence the same signature. Only the first lands; the rest die
  at preflight as already-processed, surfaced by the RPC as a bare
  "Transaction simulation failed" with empty logs.
- **Triage tip:** settle_failed with empty simulation logs plus interleaved
  on-chain successes means duplicate signature, not RPC or blockhash trouble.
- **Fixed in code:** commit `93430b4fb` adds an auto-nonce to `payX402` so
  every payment is byte-unique, and reports a precise
  `broadcast_failed:already_processed` reason via a `getSignatureStatuses`
  probe. The monitor (`npm run triage:gcp`) classifies this wave as `owner`
  while the fix awaits deploy (signature `ring-duplicate-signature-502` in
  [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs)).
- **Resolve (owner, deploy):** ship the committed fix:
  `npm run build:gcp && npm run deploy:gcp`. If the wave persists on the
  revision carrying `93430b4fb`, remove the monitor signature and
  re-investigate; do not let the classification mask a new failure.
- **Now watched continuously:** this wave went undetected for eight days
  because every sensor read "ring armed / discovery up" while a third of
  settles silently failed. The **x402 settlement success** subsystem
  ([api/_lib/ops/x402-settle-health.js](../../api/_lib/ops/x402-settle-health.js))
  closes that blind spot: it reads the ring's own `x402_autonomous_log`
  outcomes over a 3h window and reports the settle SUCCESS RATE, counting only
  payment-rail faults (5xx / 402 / RPC / broadcast / confirm) and excluding
  caller errors (http_400/404/405/409), benign guards (cap, low USDC), and
  downstream notes. It rolls into `/api/healthz`, `/status`, and the
  uptime-cron escalation (pages on first sight, re-pages hourly, clears on
  recovery). States: `ok` ≥ 90% settle rate, `degraded` 50–90%, `down` < 50%,
  `unknown` below 20 settle attempts in-window (a quiet ring is not a fault).
  A NEW settle-fault reason is caught automatically; a new *benign* reason that
  shows up as a fault is the one thing to teach it — add the token to the
  fault/exclusion rules in that module, the same learn-once loop as
  `KNOWN_SIGNATURES` here.

---

## 🔴 5xx storm on paid x402 routes from platform agent traffic (x402-wallets-dry)

```
HTTP 502/503 GET|POST /api/x402/*, /api/mcp   ua: threews-x402-autonomous/1.0 or threews-x402-seed/1.0
```

- **Source:** the platform's own agent economy (ring, seeders, autonomous
  buyers) paying its own endpoints while the economy wallets are out of SOL
  for transaction fees.
- **Symptom map:** `502` = fee wallet below its SOL floor; `503` = the payer's
  self-pay refused; `402` from a ring agent = its buyer wallet is out of USDC.
- **Not a code bug.** The economy-rebalance keypair crash (assigned
  `loadSignerKeypair`'s wrapper to `keypair`, read `.publicKey` of undefined)
  is fixed and live in commit `bb02839f9`. When
  `POST /api/cron/economy-rebalance` (Bearer `CRON_SECRET`) answers
  `skipped: insufficient_sol_surplus`, the wallets genuinely hold nothing to
  swap; at the 94-calls/min ring shape the burn is ~1-1.4 SOL/day.
- **Resolve (owner, money):** send SOL (or USDC) to the economy master
  `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`. The treasury-topup cron
  distributes to the engines within minutes and economy-rebalance restores the
  payer's USDC float. Recovery is visible as: rebalance returns
  `results[].status: "swapped"`, healthz `x402_settle` back to `ok`, the 5xx
  storm stops.
- **Alternative to daily funding:** throttle the ring to funded runway
  (`X402_RING_TICK_CONCURRENCY`, cadence and cap knobs on the Cloud Run
  service) so burn matches what the owner wants to spend.
- **Monitor signature:** `x402-wallets-dry-5xx` in
  [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs), classified `owner`.

---

## 🟡 503 with "exceeded its quota limit for … nvidia_l4_gpu_allocation" (gpu-quota-starved)

```
HTTP 503 GET /health   (model-* service)   textPayload: The request failed because the project exceeded its quota limit for run.googleapis.com/nvidia_l4_gpu_allocation_no_zonal_redundancy
```

- **Source:** every L4 GPU engine draws from ONE regional pool
  (`NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion`, granted 3 in
  us-central1). When warm `min-instances` across the fleet pin all of them, a
  min-0 service can never allocate: every request, including the Cloud
  Scheduler health ping, 503s without an instance ever starting.
- **Resolve (env-action, pre-approved):** find the idle holder first. Measure
  real job traffic (POST requests, not liveness pings) for each warm GPU
  service over a few days; a warm L4 with zero jobs is dead weight. Free it:
  `gcloud run services update <service> --region us-central1 --min-instances=0`.
  2026-07-26 case: `model-hunyuan3d` held a warm L4 with 0 jobs in 3 days while
  `model-text2motion` 503'd for hours; freeing it brought text2motion back
  (health 200, ~14 s cold start) with no code change.
- **Quota raise:** a preference to 16 is filed and reconciling:
  `gcloud alpha quotas preferences list --project=aerial-vehicle-466722-p5`
  (`l4-no-zonal-us-central1-8`). us-east4 also holds 3 granted L4s if a lane is
  ever worth porting. Fleet map and the do-not-repeat lessons:
  [docs/ops/gcp-credits-plan.md](gcp-credits-plan.md).
- **Monitor signature:** `gpu-quota-starved` in
  [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs), classified
  `env-action` (matches on the request entry's textPayload).

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

## 🟢 `Error: Invalid name account provided` (at `@bonfida/spl-name-service` → `resolveName` in pay-by-name.js) — `sns-name-not-found`

- **Source:** [api/x402/pay-by-name.js](../../api/x402/pay-by-name.js) `resolveName()`,
  the `.sol` resolution branch calling `sns.resolve(conn, bare)`.
- **What it means:** the x402 pay-by-name resolver was asked for a `.sol` name
  that has no on-chain name account (a name that does not exist). The `await
  sns.resolve(...)` call is wrapped in `try/catch` and correctly returns `null`,
  so the caller gets a clean `404 not_found` — there is **no user impact**. The
  `ERROR` line appears anyway because `@bonfida/spl-name-service` runs several
  lookup strategies in parallel: the awaited promise rejects and is caught, but a
  sibling promise also rejects and is left un-consumed, so Node surfaces the
  orphan rejection with an async stack that still points back through
  `resolveName` → `handleResolve`. It is caught chatter, not a fault.
- **Resolve:** 🟢 nothing required. It fires on a steady low cadence from callers
  probing names that are not registered. If it ever spikes, check *who* is
  resolving (request logs for `/api/x402/pay-by-name`) rather than the resolver.

---

## 🟢 HTTP 503 `/api/community/*`, `/api/clash*` — `cc_unconfigured` (cc-unconfigured-503)

```
HTTP 503 GET /api/community/worlds   body: {"error":"cc_unconfigured","error_description":"CoinCommunities is not configured"}
```

- **Source:** [api/community/worlds.js](../../api/community/worlds.js) throws
  its designed `UnconfiguredError` 503 because `CC_API_KEY` is not set. Swept
  2026-07-26: the key exists nowhere — not on the Cloud Run service, not in
  `.env`/`.env.local`, not in Secret Manager. The coin-worlds lobby renders its
  empty state; nothing is crashing.
- **Resolve (owner, credential):** provision a CoinCommunities API key
  (api.coin-communities.xyz), then:
  `gcloud run services update three-ws-api --region us-central1 --update-env-vars CC_API_KEY=<key>`.
- **Monitor signature:** `cc-unconfigured-503` in
  [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs), classified `owner`.

---

## 🟢 HTTP 503 `/health` on a model worker, UA `Google-Cloud-Scheduler` — `worker-coldstart-health-503`

- **Source:** the keep-warm Cloud Scheduler probe hitting a GPU/model worker
  (model-text2motion, model-hunyuan3d-21, model-rig, ...) while the instance is
  cold-booting. These workers stream hundreds of MB of weights before their
  server reports ready, so a probe landing in that 30-60s window gets a 503.
- **What it means:** nothing is wrong; the probe exists precisely to absorb
  this cold start so a user never pays it. Verified 2026-07-26 on
  model-text2motion: 503 at 21:xx, "text2motion ready" logged 30 seconds later.
- **Resolve:** 🟢 nothing required. Investigate only if the SAME service shows
  this across several consecutive sweeps, which means it is crash-looping
  instead of finishing boot (`npm run logs -- -s <service> --since 1h`).
- **Monitor signature:** `worker-coldstart-health-503` in
  [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs), `self-healing`.

---

## 🟢 `[pump/launch-agent] send failed ... pre-broadcast simulation failed` — `pump-launch-sim-rejected`

```
ERROR  502 POST /api/pump/launch-agent
[pump/launch-agent] send failed Error: pre-broadcast simulation failed: {"InstructionError":[1,{"Custom":6015}]}
```

- **Source:** [api/pump/launch-agent.js](../../api/pump/launch-agent.js). The
  handler simulates every launch transaction before broadcasting it.
- **What it means:** the simulation REFUSED a launch that would have failed
  on-chain (pump program custom errors: curve state raced another buyer,
  slippage moved, metadata rejected). That refusal protects the user's fees;
  the caller gets a clean 502 and a retry lands (2026-07-26 case: the same
  user's 201 followed within a minute).
- **Resolve:** 🟢 nothing required for isolated occurrences. Investigate if
  the 502 group on `/api/pump/launch-agent` becomes sustained or one wallet
  repeats the failure many times (then decode the specific custom error code
  against the pump program's IDL).
- **Monitor signature:** `pump-launch-sim-rejected` in
  [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs), `self-healing`.

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
