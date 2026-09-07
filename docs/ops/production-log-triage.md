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
> For the whole-surface answer to "what's wrong with three.ws?", run
> `npm run triage:gcp:deep`: on top of the log sweep it probes the deployed
> version, TLS expiry, fleet revision readiness, every advertised page on the
> live site, cron drift and liveness, pending DB migrations, service-wallet
> floors, and custodial-key health, all read-only and concurrent.

> **You no longer need a log export to see most of this.** The platform now
> self-reports internal-dependency health: **[/status](https://three.ws/status)**
> renders it with a plain-language fix for each degradation, and
> **`/api/healthz`** carries a machine-readable `subsystems` block (database, cache,
> rate limiter, Helius RPC, the whole Solana RPC lane tier (`rpc_lanes`), x402 ring,
> **x402 settlement success**, **Forge 3D generation**, **object storage**, world,
> sniper, the OKX chat bot, x402 config). The uptime cron
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

## 🔴 `The request signature we calculated does not match the signature you provided` (r2-credential)

**Signature.** Any of: a 502 from `POST /api/forge` or `/api/gpt-forge` carrying that
sentence, `[cdn-object] signed read failed, serving public bucket domain`,
`[forge] object storage rejected the generation`, `[register/prep] object storage
rejected the manifest`, or `object_storage: down` in `/api/healthz`.

**What it is.** Cloudflare R2 is refusing our signed requests. The access key id is
recognized (that would be `InvalidAccessKeyId`); the SECRET is wrong. Every signed
operation fails at once, read and write.

**Blast radius, which is the whole product.** 3D generation dies before it writes a
row: the reference image cannot be parked, so text→3D fails on the website AND on
the ChatGPT surfaces (they share the bucket, not the endpoint). Uploads cannot land.
Agent registration cannot store its manifest. `/cdn/*` cannot read an object, so
every avatar, thumbnail and GLB on the site falls back to the public bucket domain.

**First seen 2026-09-07**, ~00:19 UTC: generation stopped dead for nearly five hours
and was reported by users in Telegram, not by us, because nothing here had a signal
for it. Two gaps were closed in the same change and both are worth knowing about:
`forge_generation` read `ok, 89% success` throughout (its ledger only contains
generations that got far enough to write a row, so a total stop looked like a quiet
hour), and `isStorageInfrastructureError` matched only the compact
`SignatureDoesNotMatch` code, which appears in `err.name` and never in the sentence
above. `object_storage` now probes the credential directly and the forge sensor now
reports a stall.

**Resolution (owner).** Re-set the secret on the Cloud Run service:

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars S3_SECRET_ACCESS_KEY=<secret>   # or --update-secrets for a Secret Manager ref
```

Two traps that produce this exact error and look like a correct value:
- On R2 the **Secret Access Key is the SHA-256 digest of the API token**, not the
  token value. Pasting the token itself signs into `SignatureDoesNotMatch`.
- A **trailing newline** in the stored secret fails identically. `env.js` trims
  credential-class values now, so a padded value can only bite a consumer that
  reads `process.env` directly.

Verify with `curl -s https://three.ws/api/healthz | jq '.subsystems.subsystems[]
| select(.name=="object_storage")'`, then one `POST /api/forge {"prompt":"cube"}`.

**No code change routes around it.** The read path fails over to the public bucket
domain (rate-limited, so it is a degradation, not a fix) and writes cannot fail over
at all.

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
- **Fixed and deployed (2026-07-17):** commit `93430b4fb` adds an auto-nonce to
  `payX402` so every payment is byte-unique, and reports a precise
  `broadcast_failed:already_processed` reason via a `getSignatureStatuses`
  probe. The wave stopped on the revision carrying the fix, so the dedicated
  monitor signature (`ring-duplicate-signature-502`) has been retired from
  [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs); ring self-pay 5xx
  now classifies under `x402-wallets-dry-5xx` (next section), which is a
  funding shape, not this bug.
- **If this exact shape recurs** (settle_failed, empty simulation logs,
  interleaved on-chain successes) on a revision carrying `93430b4fb`, treat it
  as a regression and re-investigate the payment builder; do not fund wallets
  for it, and do not let the wallets-dry classification mask it.
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
  buyers) paying its own endpoints while something in the settle path fails.
- **Three distinct causes look identical in the HTTP logs (2026-07-28: all
  three fired in one window). Diagnose from app logs before acting:**
  1. `npm run logs -- -s three-ws-api --app --grep "fee_wallet_below_floor" --since 1h`
     hits = the sponsor fee wallet drifted under
     `X402_SPONSOR_SOL_FLOOR_LAMPORTS`. Self-heal territory: run
     `POST /api/cron/treasury-topup`; its `reclaimIdleAgentSol` leg refunds the
     fee wallet from idle agent SOL (commit `d6a7bf2a4`). No owner money needed
     unless every reclaim source reports `at_or_below_floor`.
  2. `--grep "data_unavailable"` hits = paid endpoints refunding honestly (no
     charge) because no market source could answer. Since 2026-07-28
     crypto-intel prices bonding-curve pump.fun mints from the pump.fun feed
     (the sniper-intel pipeline passes `mint`), so a recurrence at volume means
     a data-source outage, not wallets.
  3. `--grep "broadcast_failed"` hits = a settle transaction failed simulation;
     the reason now keeps the simulation-log tail (the actual cause).
     `insufficient funds` on the token transfer = the ring payer's USDC float
     dipped below per-tick volume; `POST /api/cron/economy-rebalance` restores
     it (expect `results[].status: "swapped"`).
- **Symptom map:** `502` = fee wallet below its SOL floor or settle broadcast
  failed; `503` = the payer's self-pay refused or a data_unavailable refund;
  `402` from a ring agent = its buyer wallet is out of USDC.
- **The quiet variant: no storm at all, just a settle-rate collapse
  (`no_solana_accept`).** Observed 2026-07-29 16:00 UTC. The sponsor drifts
  under its floor and
  [buildRequirements()](../../api/_lib/x402-paid-endpoint.js) WITHDRAWS the
  Solana accept from every 402 challenge (`sponsorKnownBelowFloor()`), so the
  ring, which is Solana-only, never gets to attempt a payment. There is no 5xx
  storm to grep, because nothing is being rejected. The fingerprint is:
  settlements collapse (that hour: 735/h to 13/h) while rail faults stay at
  their normal level (~100/h all day), and `no_solana_accept` in
  `x402_autonomous_log` goes from exactly 0 to 300-400/h. Confirm the mechanism
  from outside the box, no logs needed:
  `curl -s https://three.ws/api/x402/three-intel | jq '.accepts[].network'`.
  Only `eip155:8453` back, no `solana:mainnet`, means the accept is withdrawn.
  Fix is the same free self-heal as cause 1 above (`treasury-topup`). Since
  2026-07-30 healthz reports this itself: `x402_settle.metrics.cause` is
  `sponsor_floor` (vs `fee_governor` when the wallet fee governor is pacing the
  window, or `rail` for real payment-rail faults) and `detail` names the
  withdrawal, so the sensor no longer points at the facilitator for a funding
  problem.
- **The loud variant: a rail-shaped storm that is really a dry sponsor
  (`InsufficientFundsForRent`).** Observed 2026-08-28. This is the quiet
  variant's opposite and it is easy to misread, because every symptom points at
  the rail. The sponsor held 0.000899107 SOL against the 0.02 SOL floor, which
  is 0.0000082 SOL of spendable headroom, less than two transaction fees, so
  every transaction it fee-paid failed at simulation:
  `simulation_failed:{"InsufficientFundsForRent":{"account_index":0}}` on the
  verify path and `sweep_broadcast_failed:Simulation failed ... account (0) with
  insufficient funds for rent` on the sweep path. **Account index 0 of a
  compiled Solana message is the fee payer**, so that error is never about the
  buyer's USDC: it is the sponsor being too poor to sign.

  Why the quiet variant's guard did not catch it: `sponsorKnownBelowFloor()` was
  only ever written by `getBalance`, and all four paid Solana RPC lanes were over
  quota in the same window. `refreshSponsorFloorState()` fails open on an RPC
  error by design, so the guard never learned the sponsor was dry and the ring
  spent three hours attempting payments that could not settle: 95 attempts, 0
  settled. Since 2026-08-28 the settle path reads the verdict off the failure
  itself (`noteSponsorRentFailure()` in
  [self-facilitator.js](../../api/_lib/x402/self-facilitator.js)), which costs no
  RPC call and works precisely when the RPC is too degraded to answer one, and
  the sensor counts a fee-payer rent failure as a floor signal rather than a rail
  fault. Before that fix healthz reported `cause: rail` and its hint sent the
  reader to duplicate signatures and RPC preflight.

  **Confirm in one command, no logs needed:**
  `curl -s https://api.mainnet-beta.solana.com -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW"]}'`
  Under 20,000,000 lamports is below the floor; under ~900,000 the wallet cannot
  pay a single fee. Fix is the owner top-up below.
- **Not a code bug.** The economy-rebalance keypair crash (assigned
  `loadSignerKeypair`'s wrapper to `keypair`, read `.publicKey` of undefined)
  is fixed and live in commit `bb02839f9`. When
  `POST /api/cron/economy-rebalance` (Bearer `CRON_SECRET`) answers
  `skipped: insufficient_sol_surplus`, the wallets genuinely hold nothing to
  swap; at the 94-calls/min ring shape the burn is ~1-1.4 SOL/day.
- **Resolve (owner, money — only after all three greps above are exhausted):**
  send SOL (or USDC) to the economy master
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
  It matches **any** `threews-*` user agent, because the ring calls its own paid
  routes under several: `threews-x402-autonomous/1.0`, `threews-x402-seed`,
  `threews-ring-agent/<persona>` (persona agents), `threews-x402-wallet-monitor`
  and `threews-x402-thumbnail-regen`. Matching only the first two used to leak
  the rest into `investigate` on every sweep with the same root cause.
- **NOT this class: `fee_runway_exhausted`.** A settle refused with
  `fee_runway_exhausted:<spent>+<next>><budget>` is the **wallet fee governor**
  pacing a platform wallet's daily fee burn to its funded runway — a designed
  throttle, not an outage, and no action is required. Volume resumes at UTC
  midnight or immediately when the wallet is topped up (the budget scales with
  live balance). See docs/x402-ring-economy.md "The wallet fee governor". Only
  `fee_wallet_below_floor` and `insufficient_sol_surplus` mean the wallets are
  actually dry.

  **It answers 503 `settlement_unavailable`, not 502.** Until 2026-08-06 this
  refusal was the one deliberate throttle the settle path's retryable branch
  missed, so it went out as `502 settle_failed` and read as an outage to every
  buyer, trust monitor and internal pipeline: 15,619 of the autonomous loop's
  20,030 `http_502` rows in the preceding 48 hours were this one reason. A
  `502 settle_failed` cluster is therefore now genuinely unexplained and worth
  investigating; a `503 settlement_unavailable` cluster is the governor or the
  sponsor floor, and the reason token tells you which. The autonomous loop also
  checks fee admission before it pays now, so a paced wallet shows up as
  `fee_runway_exhausted` skips in `x402_autonomous_log` rather than as failed
  paid calls.

  **The sensor reads through the status codes now.** `x402_autonomous_log` is
  reason-blind for refusals that arrive over HTTP (the row says `http_503` or,
  pre-2026-08-06, `http_502`; the reason lives only in
  `x402_self_facilitator_log.reject_reason`). Since 2026-08-07 the healthz
  `x402_settle` sensor reconciles those status-only 5xx rows against the
  facilitator book for the same window, re-attributing them to `fee_governor` /
  `sponsor_floor` before it computes the rate. So `metrics.cause` is trustworthy
  even for governed refusals recorded as bare 5xx, the settle rate judges the
  rail alone, and a `cause: "rail"` verdict now genuinely means the rail. (The
  2026-08-05 storm read `down`/`rail` at settle 26.1% under exactly this
  blindness; the same data now reads as governor pacing with a healthy rail.)

---

## 🟡 HTTP 502 on `/api/coin/*` — `coingecko-quota-exhausted-502`

```
HTTP 502 GET /api/coin/detail?id=<coin-id>
body: {"error":"upstream_error","error_description":"coin data is unavailable right now — retry shortly"}
```

- **Source:** [api/_lib/coingecko.js](../../api/_lib/coingecko.js) `geckoFetch()`
  exhausted every rung — live fetch, in-memory stale buffer (30 min) and the
  durable Upstash last-good copy (6 h) — so the handler surfaced its 502.
- **What it usually means: the demo KEY, not the upstream.** CoinGecko's demo
  tier caps at **10,000 calls per month**. Once the cap is hit, every request
  carrying `COINGECKO_API_KEY` gets a 429 (`error_code: 10006`) for the rest of
  the billing period — while the *identical request without the key* is still
  answered by the keyless public tier. An exhausted key is therefore strictly
  worse than no key. On **2026-07-28** it took `/api/coin/detail`, `/tickers`
  and `/exchange` to a hard 502 for hours; the pages that survived only did so
  off their durable last-good copies.
- **Confirm in one call** (`$KEY` from the Cloud Run env):

  ```sh
  curl -s -H "x-cg-demo-api-key: $KEY" https://api.coingecko.com/api/v3/key
  # {"status":{"error_code":10006,"error_message":"You've reached 10,000 calls limit. …"}}
  ```

- **Self-healing since 2026-07-28.** `geckoFetch` now treats the key as a
  resource that can go bad: a keyed 401/403/429 benches the key for 15 minutes
  and immediately retries the same URL keyless, and `geckoHeaders()` (shared
  with [api/\_lib/market-fallbacks.js](../../api/_lib/market-fallbacks.js)) stops
  attaching a benched key at all. A monthly quota reset or a key upgrade
  recovers on its own with no redeploy. Pinned by
  [tests/coingecko-key-health.test.js](../../tests/coingecko-key-health.test.js).
- **Resolve:** a *lingering* 502 after that means the keyless tier is throttled
  too (Cloud Run egress IPs are shared and CoinGecko rate-limits per IP). Stop
  paying the wasted round trip, config-only and pre-approved:

  ```sh
  gcloud run services update three-ws-api --region us-central1 \
    --remove-env-vars COINGECKO_API_KEY
  ```

  Then tell the owner the key needs a paid tier (or to wait for the monthly
  reset). Re-add with `--update-env-vars COINGECKO_API_KEY=<key>` once renewed.
- **Monitor signature:** `coingecko-quota-exhausted-502` in
  [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs), classified `env-action`.

---

## 🟡 `429 Client Error … huggingface.co` → `LocalEntryNotFoundError` on a model worker — `hf-hub-rate-limited`

```
requests.exceptions.HTTPError: 429 Client Error: Too Many Requests for url:
  https://huggingface.co/facebook/dino-vitb16/resolve/main/config.json
We had to rate limit your IP (2600:1900:0:2d0e::2801).
huggingface_hub.utils._errors.LocalEntryNotFoundError: An error happened while trying to locate the file on the Hub …
ERROR:    Application startup failed. Exiting.
Container called exit(3).
Default STARTUP TCP probe failed 1 time consecutively for container "server-1" on port 8080.
```

- **Source:** a model worker whose model construction pulls a file from
  huggingface.co **at startup**. 2026-07-28 case: `model-triposr`, whose
  TripoSR `DINOSingleImageTokenizer` calls `hf_hub_download("facebook/dino-vitb16",
  "config.json")` while building the graph — the TripoSR checkpoint itself was
  already local on the gcsfuse mount, but that one 454-byte config was not.
- **What it means:** anonymous HF pulls are rate-limited **per IP**, and Cloud
  Run egress IPs are shared with the rest of the region. When HF says no, the
  app never listens on `$PORT`, the startup probe fails, and Cloud Run kills the
  revision — a crash loop that scales to zero and 503s every request. **No boot
  path may depend on a live huggingface.co fetch.**
- **The token trap:** the pinned `huggingface_hub` reads the **legacy**
  `HUGGING_FACE_HUB_TOKEN` env var. Setting `HF_TOKEN` alone changes nothing
  (verified: the retry 429'd identically).
- **Resolve (config-only, pre-approved).** Stage the file into the HF cache
  layout inside the already-mounted weights bucket, then point the worker at it.
  `<sha>` is the repo's current commit from
  `https://huggingface.co/api/models/<org>/<repo>` (field `sha`):

  ```sh
  # 1. build the cache layout locally
  SHA=$(curl -s https://huggingface.co/api/models/facebook/dino-vitb16 | jq -r .sha)
  D=hub/models--facebook--dino-vitb16
  mkdir -p "$D/refs" "$D/snapshots/$SHA"
  printf '%s' "$SHA" > "$D/refs/main"
  curl -sL -o "$D/snapshots/$SHA/config.json" \
    "https://huggingface.co/facebook/dino-vitb16/resolve/$SHA/config.json"

  # 2. stage it (the bucket is gcsfuse-mounted at /weights on every model worker)
  gsutil -m cp -r hub gs://three-ws-model-weights/hf-cache/

  # 3. point the worker at it, offline
  gcloud run services update model-triposr --region us-central1 \
    --update-env-vars HF_HOME=/weights/hf-cache,HF_HUB_OFFLINE=1,HUGGING_FACE_HUB_TOKEN=<HF_TOKEN from .env>
  ```

  Plain files work — `hf_hub_download` only checks `refs/<revision>` for the
  commit hash and then `os.path.exists()` on the snapshot path, so the blob
  symlinks a real HF cache uses are not required.
- **Monitor signature:** `hf-hub-rate-limited` in
  [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs), classified `env-action`.

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
- **Check the mark against the REAL cap first (2026-07-29).** The high-water mark is a config value, not a measurement, and it has been set to a phantom cap before. Confirm both numbers before touching anything else:

  ```sh
  psql "$DATABASE_URL" -c 'SHOW neon.max_cluster_size'                                    # the real ceiling
  psql "$DATABASE_URL" -c 'SELECT pg_size_pretty(pg_database_size(current_database()))'    # the live footprint
  npm run logs -- --all --grep "project size limit" --since 7d                             # real 53100s, if any
  ```

  If `max_cluster_size` is far above the mark and there are no `project size limit` errors, the skips are **self-inflicted** and the fix is to raise the mark (config-only, pre-approved). On 2026-07-29 that read 16TB against a ~2.5 GB footprint while the mark sat at 3072, so the mark was raised to `8192`. See [db-retention.md](db-retention.md#sizing-the-high-water-mark-read-before-changing-it) for the sizing rule.
- **This gate has starved the money path.** On 2026-07-28 at 18:42 the branch crossed a mark set equal to the assumed cap, and 56 crons skipped in one minute — including `economy-rebalance`, which refills the x402 fee wallet. The fee wallet then starved and every settle returned `fee_wallet_below_floor` for four hours. `economy-rebalance` is deliberately **not** gated any more; do not re-add `requireWriteCapacity` to a cron on the funding path.
- **Resolve (capacity):** the write crons stay skipped only while `pg_database_size > high-water`. In order: (a) raise `DB_RETENTION_HIGH_WATER_MB` if the real cap has headroom (the usual answer, see above); (b) raise the **Neon compute/storage plan** if it genuinely does not; (c) tighten `PUMP_INTEL_RETENTION_DAYS` / `PUMP_INTEL_MIN_RETENTION_DAYS` to shed the firehose faster. None is a code change — the gate and the valve are covered by [tests/cron-storage-backoff.test.js](../../tests/cron-storage-backoff.test.js).

---

## 🟢 `ws error: Unexpected server response: 301`

```
ws error: Unexpected server response: 301
```

- **Source:** `@solana/web3.js`'s internal `rpc-websockets` client, under the pump.fun trade firehose ([api/_lib/pump-onchain-trades.js](../../api/_lib/pump-onchain-trades.js)).
- **What it means:** an RPC lane in the shared chain serves JSON-RPC happily over **HTTP** but refuses the **WebSocket** upgrade. rpc-websockets treats every failure as transient and reconnects in a tight background loop for the life of a warm instance, so one bad lane produces ~100 identical lines an hour (measured 2026-07-29: `solana.leorpc.com` → 301, `solana-mainnet.gateway.tatum.io` → 402).
- **Already fixed — this should be self-healing now.** Each lane's socket is probed once before use, and a structural refusal (301/302/307/308, 401/402/403/404/405/410/501) benches that lane for the process while a transient one (429, 5xx, reset) benches it for 5 minutes. The bench policy is a pure function (`classifyWsFailure`) covered by [tests/pump-onchain-ws-lanes.test.js](../../tests/pump-onchain-ws-lanes.test.js). Expect at most one `ws lane benched (structural): <host>` line per lane per process instead of the storm.
- **If the storm returns:** a lane is failing in a way the classifier reads as transient when it is really permanent. Probe it directly and add its status to the structural list:

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' -m 8 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    https://<rpc-host>
  ```

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
- **But do not read this line as "only Helius is affected."** It watches one
  provider; see the `rpc_lanes` section below for the whole-tier view.

---

## 🔴 Every paid Solana RPC lane exhausted at once (`rpc_lanes` degraded)

```
/api/healthz → subsystems.rpc_lanes: degraded
  "all 3 paid lanes exhausted; serving from 6 free lanes"
```

- **Source:** `checkRpcLanes()` in
  [api/_lib/ops/subsystem-health.js](../../api/_lib/ops/subsystem-health.js),
  reading `rpcLaneHealth()` from
  [api/_lib/solana/connection.js](../../api/_lib/solana/connection.js).
- **What it means:** every endpoint the platform PAYS for is parked in quota
  cooldown simultaneously, so all Solana traffic is running on free public
  nodes. The platform stays UP (that is the failover chain working), but free
  nodes are aggressively throttled, and the symptom set is diffuse and easy to
  misdiagnose: intermittent 502/503/504 on on-chain routes, `broadcast_failed`
  settles, slow balance reads, sniper and pump routes timing out.
- **Why this sensor exists.** On 2026-07-29 the Helius plan
  (`-32429 max usage reached`), QuickNode's daily cap (`-32003 daily request
  limit reached`) and Alchemy's monthly cap (`429 Monthly capacity limit
  exceeded`) were ALL exhausted at the same time, and nothing surfaced it: the
  only RPC sensor watched Helius, through per-instance memory, so a freshly
  started instance reported `premium RPC healthy` while every premium lane was
  returning errors. Verify any lane by hand with a single call:
  ```sh
  curl -s "<endpoint>" -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW"]}'
  ```
- **Resolve (owner, money):** top up or upgrade the exhausted plans (Helius,
  QuickNode, Alchemy). Nothing else clears a quota; the cooldowns simply expire
  and re-trip while traffic exceeds the free tiers.
- **Do NOT "fix" it by promoting the reserve.** `SOLANA_RPC_LAST_RESORT_URLS`
  exists to keep a metered endpoint in reserve; naming that same URL in
  `SOLANA_RPC_URL` or `QUICKNODE_RPC_URL` makes it the primary (the chain
  dedupes to the first occurrence) and burns the reserve first. That exact
  misconfiguration was live until 2026-07-29. See
  [docs/solana.md](../solana.md) for the full priority contract.
- **Repointing the primary at a free node hides this sensor on older builds.**
  `checkRpcLanes()` counts whichever URL `SOLANA_RPC_URL` names as paid
  capacity, so pointing it at a keyless node during an outage makes the paid
  tier read healthy at the exact moment all of it is dark. Cross-check by
  probing each provider by hand with the `getBalance` call above before
  trusting a green `rpc_lanes` row.
- **Whole-tier runbook:** [solana-rpc-lanes.md](solana-rpc-lanes.md) has the
  one-sweep probe over every configured lane, the measured per-lane capability
  matrix (which free node refuses which method, and why PublicNode as primary
  silently breaks holder gating), the rotate-vs-fail classification contract,
  and the recovery commands.

---

## 🟡 `[solana-rpc] https://<host> 403`, cooling 30m, failing over

- **Source:** `cooldownMsFor()` in
  [api/_lib/solana/connection.js](../../api/_lib/solana/connection.js).
- **What it means:** depends entirely on the body, and the two cases need
  opposite responses.
  - **A real credential failure** (bad or expired key). The lane is benched for
    30 minutes and stays benched. Fix the key.
  - **A refused call shape.** Some keyless nodes answer 403 to reject ONE
    request while serving everything else. PublicNode does this for
    `getTokenAccountsByOwner` filtered by `programId`:
    `{"code":-32602,"message":"Request blocked. Details: blocked parameter: params.1.programId"}`.
- **Why it mattered:** token and USDC balance readers make that call constantly,
  so when it was sized as a 30-minute auth bench, the primary evicted itself on
  its own routine traffic and every Solana call cascaded down the chain onto the
  exhausted paid lanes. Measured 2026-07-30, this was the last remaining
  `solana-rpc` line in production after the primary was repointed.
- **Resolve:** 🟢 nothing required for the blocked-call-shape case. Since
  commit `955146961` the rotating fetch recognises the refusal and demotes
  just that (lane, method) pair (`markMethodDemotion`) with no lane cooldown
  at all, so the node keeps serving every other call shape; the exported
  `markEndpointCooldown` path still sizes a shape refusal at 30 s instead of
  the 30 min auth bench. The monitor classifies the short-cooldown line as
  `solana-rpc-policy-block` (self-healing) in
  [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs). 🔴 for the credential
  case, rotate the key on that provider.
- **Tell them apart:**
  ```sh
  npm run logs -- -s three-ws-api --grep "403" --since 1h
  ```
  A body naming `Request blocked` / `blocked parameter` is the harmless case.
  Anything else is a key problem.

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

- **Source:** every `api/community/*` and `api/clash/*` handler throws the
  designed `UnconfiguredError` 503 from [api/_lib/coin-communities.js](../../api/_lib/coin-communities.js)
  because `CC_API_KEY` is not set. Re-swept 2026-08-08: the key still exists
  nowhere, not on the Cloud Run service (checked all 200 env vars), not in
  `.env`/`.env.local`, not in Secret Manager. Nothing is crashing, and every
  surface has a designed answer for it:
  - `/worlds` fails over to the live pump.fun trending feed and tags the
    response `source: "pump-trending"`, so the world picker stays populated.
  - `/messages` renders the town's unavailable state and a locked composer
    ("Posting opens soon"); the live feed stays open.
  - `/holder-pass` drives the Play holders gate to its `unavailable` state
    ("Holder check is offline") with a working one-click path into the coin's
    open world. Before 2026-08-08 this was the one dead end: the gate showed
    the raw upstream string with retry-only actions that could never succeed.
  - `/clash/*` pins the battle tabs on a human message and stops the 5s poll
    on the first `cc_unconfigured` answer.
- **Resolve (owner, credential):** provision a CoinCommunities API key
  (api.coin-communities.xyz), then:
  `gcloud run services update three-ws-api --region us-central1 --update-env-vars CC_API_KEY=<key>`.
- **Monitor signature:** `cc-unconfigured-503` in
  [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs), classified `owner`.

---

## 🟢 HTTP 503 `/api/galaxy` — `watsonx_unavailable` (watsonx-unconfigured-503)

- **Source:** [api/galaxy.js](../../api/galaxy.js). The Agent Galaxy positions
  its stars with IBM Granite embeddings on watsonx.ai; without credentials there
  is no semantic space to place anything in, so it answers a designed 503 rather
  than inventing coordinates.
- **What it means:** `WATSONX_API_KEY` and `WATSONX_PROJECT_ID` (or
  `WATSONX_SPACE_ID`) exist **nowhere** — not on the Cloud Run service, not in
  `.env`, not in Secret Manager (swept 2026-07-29).
- **No broken user path.** [src/galaxy.js](../../src/galaxy.js) matches this
  exact error and renders a designed empty state ("IBM Granite isn't connected …
  once watsonx credentials are configured, the universe lights up here"), so the
  `/galaxy` page explains itself instead of failing. Nothing to fix in code.
- **Resolve (owner, credential):** provision watsonx credentials at
  `cloud.ibm.com`, then:
  `gcloud run services update three-ws-api --region us-central1 --update-env-vars WATSONX_API_KEY=<key>,WATSONX_PROJECT_ID=<id>`.
- **Monitor signature:** `watsonx-unconfigured-503` in
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

- **Source:** [api/pump/[action].js](../../api/pump/[action].js), action `launch-agent`. The
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

## 🟢 `Error: seat reservation expired.` (Colyseus, three-ws-multiplayer) — `colyseus-seat-expired`

- **Source:** `@colyseus/ws-transport` `WebSocketServer.onConnection`, on the
  `three-ws-multiplayer` service.
- **What it means:** matchmaking handed the client a seat, and the client did
  not complete the WebSocket upgrade within the reservation TTL (slow network,
  a closed tab, a mobile browser backgrounding the page mid-join). The server
  correctly refuses the stale ticket; the client's next join request gets a
  fresh seat. Observed cadence is a handful per week, which is normal churn
  for public rooms.
- **Resolve:** 🟢 nothing required. Investigate only if it spikes together
  with real "can't join" reports (then suspect load-balancer or WebSocket
  upgrade latency in front of the service, not Colyseus itself).
- **Monitor signature:** `colyseus-seat-expired` in
  [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs), `self-healing`.

---

## 🟢 `Uncaught signal: 10, pid=…, tid=…, fault_addr=0.` (three-ws-redis-proxy ONLY) — `redis-proxy-srh-crash`

- **Source:** the pinned third-party image `hiett/serverless-redis-http:0.0.10`
  (SRH, the Upstash-protocol HTTP proxy in front of Redis) running as
  `three-ws-redis-proxy`.
- **What it means:** the SRH runtime aborts sporadically (observed ~3x/day) and
  Cloud Run restarts the instance. `minScale 2` keeps a warm sibling serving
  during the restart, and the API's cache layer rides the blip via its circuit
  breaker + in-memory fallback (see §cache above) — healthz `cache` stays `ok`
  through these events, so there is no user impact at the observed rate.
- **Resolve:** 🟢 nothing required day-to-day. The durable fix is bumping the
  SRH image tag on `three-ws-redis-proxy`, which changes a running binary and
  therefore waits for owner approval like any deploy. Investigate only if the
  crash rate climbs to many per hour or healthz `cache` degrades.
- **Scope note:** the monitor classifies this **only** for
  `three-ws-redis-proxy`. An identical `Uncaught signal` line from any other
  service stays `investigate` — do not generalize this signature.
- **Monitor signature:** `redis-proxy-srh-crash` in
  [scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs), `self-healing`
  (service-scoped via its `services` field).

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
