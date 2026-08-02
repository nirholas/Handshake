# backlog/ progress log

Cross-chat handoff. Append one block per work order attempt: what you measured,
what you changed, what is left, and who owns it. Newest at the bottom.

Format:

```
## <date>: <NN work-order name>
Measured: <the numbers you read, with the command>
Did: <what changed, with commit SHAs or env var names>
Left: <exactly what remains, and who owns it>
```

---

## 2026-08-01: pack created

Measured (see the snapshot table in [00-INDEX.md](00-INDEX.md)): prod at `6cc0370dc`
with no deploy gap, `x402_settle` down at 25.9% with `fee_runway_exhausted` at
85,331 rejects against 562 `broadcast_failed`, RPC lanes at 1/3 paid serving,
forge at 100%, fact-check benchmark unrun, Draco transcode fixed on the running
image, media CORS at the site edge already permissive.

Did: wrote ten work orders covering every open item carried by ISSUES.md and the
retired campaign logs. Dropped the Draco item from ISSUES.md against live
evidence rather than leaving a fixed item on the tracker.

Left: all ten work orders are unstarted.

## 2026-08-01: 05 R2 bucket CORS
Measured (`node scripts/set-r2-cors.mjs --probe`, plus raw curl against both hosts):
site edge PASS (`three.ws/avatars/*.glb` returns `access-control-allow-origin: *`
to any origin); public bucket host FAIL (`pub-*.r2.dev` returns no header to a
foreign origin, preflight `OPTIONS` 403); presigned PUT preflight MIXED (204 for
`three.ws`, `*.vercel.app`, `localhost:3000`; 403 for `www.three.ws`,
`*.app.github.dev`, `localhost:5173`). The live policy is one allowlist rule
serving both reads and writes, predating the script's read/write split. Item
confirmed, not closed.

Did: added a credential-free `--probe` mode to `scripts/set-r2-cors.mjs` that
measures the enforced policy with object-scoped keys and exits 1 on drift, so
this is verifiable without an admin token. Rewrote the script's usage block and
`scripts/README.md` to drop `vercel env pull` and name the real credential
sources. Documented which host needs `/api/glb` and which does not, measured, in
`docs/media-api.md`, `docs/character-library.md`, and both embed tutorials
(`render-avatar-images.md` was recommending the proxy for a `three.ws` URL that
never needed it). Updated ISSUES.md item 9 with the measurement table. Changelog
entry added. `npm run audit:docs` clean.

Left: applying the policy. Blocked on one credential, not on code: the only R2
token reachable here (`S3_*` in `.env`, identical to the Cloud Run service env)
is object-scoped and 403s on Get/PutBucketCors, and Secret Manager holds no R2 or
Cloudflare admin token (checked with working gcloud auth). Owner: mint an
"Admin Read & Write" R2 token scoped to `chatty-storage`, put it in `.env.local`
as `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, run `node scripts/set-r2-cors.mjs`,
confirm with `--probe`. Keep `/api/glb` either way.

## 2026-08-01: 01 x402-settle-runway (config landed, verify pending)

Measured: `fee_runway_exhausted` 85,264 of 85,887 settle failures (healthz);
`master_sol` 0.0108, `spendable_sol` 0, `master_operating_sol` 0.02, deficit
0.019 with an empty reclaim plan (`treasury-topup?dry=1`).

Did: `ECONOMY_MASTER_OPERATING_SOL=0.3` and `X402_WALLET_FEE_RUNWAY_DAYS=1` on
`three-ws-api` (revision `three-ws-api-00354-m2n`, config-only, pre-approved).
Re-read dry run: deficit now 0.299 and `agent_reclaim` plans 0.1229 SOL back to
the master from two agent wallets, so the */30 treasury cron self-heals from
here without a manual fund move. Recurrence guard: appended a measured-constants
test block to `tests/x402-wallet-fee-governor.test.js` (12/12 green) pinning
that the default config sustains a full day at the measured burn. A parallel
session is landing budget pacing (`pacedFeeBudgetLamports`) in the governor
itself; the two changes compose.

Left: re-read healthz after a full budget window (3h+) and confirm settle >90%
with `fee_runway_exhausted` no longer top; whoever finishes the pacing arc
commits the governor + test file together.

## 2026-08-01: 09 telegram-bots-durability (done)

Measured: both feeds ran as codespace-local processes; local graduation bot pid
killed after cutover, local all-claims process already dead (port 3901 silent).

Did: deployed both to Cloud Run in `aerial-vehicle-466722-p5` us-central1 as
always-on singletons (`--min-instances 1 --no-cpu-throttling`, private, SA-pinned,
tokens in Secret Manager with per-secret `secretAccessor` grants for the runtime
SA, env shipped via YAML file). Both verified live post-deploy: graduation bot
on websocket transport with `delivery.status: ok`, all-claims bot posted a
$1,252.18 instant claim minutes after boot. Killed the local twin (matched by
`/proc/<pid>/cwd`) to stop duplicate `getUpdates` 409s. Decoder provenance and
deploy/revival docs added to the second bot's README in its own repo (committed
there as 066f77d; push blocked by the rotated PAT, owner refresh needed).

Left: nothing for the feeds themselves. The 066f77d docs commit needs a push
once a fresh PAT lands. Both service names and revival steps are in the bot
READMEs and agent memory.

## 2026-08-01: 01 x402-settle-runway (root cause corrected, waste removed, capital still owner-gated)

Measured (before): `GET /api/x402/runway-lab` and `POST /api/cron/treasury-topup?dry=1`.
The work order's premise is WRONG on two counts and the corrections matter.
`master_deficit_sol` is **0.019172, already positive** (not the claimed 0), and
`runway_days` is **already 1** (not 3), so both config levers were either applied
or moot. The binding constraint is capital plus demand, not config:

| Fact | Value |
|---|---|
| Fee wallet (role `sponsor`) | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` |
| Its balance / spendable | 0.010827589 SOL / 8,827,589 lamports |
| Daily fee budget | 10,000,000 lamports (the `minBudgetLamports` heartbeat floor, which already EXCEEDS spendable) |
| Observed fee per settle | 5,040 lamports (`observed_median_24h`) |
| Funded capacity | ~1,984 settles/day (`projected_settles_per_day` 1,751) |
| Actual demand | 3,726/hour = **89,424/day** |
| Refusals | `fee_runway_exhausted` 85,264 of 85,899 |

Demand is **45x** funded capacity. Every one of those 85,264 refusals happened at
the LAST step of the handshake, after an ATA read, a signature, and a facilitator
`verify` that simulates against an RPC node. That is ~170k wasted RPC round-trips
a day, and it is the same load that holds `rpc_lanes` at 1/3 serving: work order
01 and work order 02 share this root cause.

Did: added `assessFeeAdmission()` to `api/_lib/x402/wallet-fee-meter.js` and wired
it into `payX402` (`api/_lib/x402/pay.js`) immediately before the first RPC call,
so an unfundable call is skipped in one step instead of after five. It reuses the
governor's own math through `effectiveBudgetLamports`, so the caller-side gate and
the settle-path meter can never disagree; `tests/x402-fee-admission.test.js` (18
tests) pins that parity explicitly, plus the fail-open contract and the refusal
cache's UTC-midnight boundary. Refusals now carry the `fee_runway_exhausted`
reason token, which `api/_lib/ops/x402-settle-health.js` already classifies as a
governed throttle rather than a rail fault, so the rail stops reporting `down`
with `http_502` for what is a budget decision. `npm run gate` green before and
after. Changelog entry added (tags `fix`, `infra`).

This removes waste; it does NOT raise settled volume, and nothing here should be
read as a recovery of the settle rate. Total settles stay capped by the funded
budget until capital moves.

Left (all owner-gated, none of it config):
1. **Capital.** Sustaining current demand needs ~0.45 SOL/day of fee burn against
   a sponsor wallet holding 0.0108 SOL. Either fund it or cut demand; the
   `X402_RING_TICK_CALLS=6`/min ring tick is only ~8,640/day of the ~89,424, so
   most demand is ungoverned co-tenant pipelines and cutting it means pacing them.
2. **The reclaim self-heal is silently failing.** `?dry=1` plans 0.122875505 SOL
   reclaimable from two platform agent wallets (`Atlas #22` 0.068390963,
   `Echo #22` 0.054484542) into the master, and the non-dry cron has been running
   roughly every minute, yet the SOL is still there and `economy_master_ledger`
   holds **zero** `agent_reclaim` rows ever. Cause: production runs `6cc0370dc`,
   which predates `recordAgentReclaim`, so the failing leg writes no row at all.
   The instrumentation that would name the cause is already on `main` and ships
   with the next deploy. Firing the non-dry reclaim by hand is stop-and-ask gate 1.
3. **Security, unrelated but found here:** `ECONOMY_MASTER_SECRET_BASE58` is a
   PLAINTEXT env var on the Cloud Run service, while `X402_FEE_PAYER_SECRET_BASE58`
   beside it is a Secret Manager `secretRef`. Any principal with `run.services.get`
   can read that master wallet key. Recommend rotate + move to Secret Manager.

## 2026-08-02: 03 sponsor-runway-automation (code complete, capital owner-gated)
Measured, before (`/api/ops/payment-outcomes` with the ops secret from Secret
Manager `ops-dashboard-secret`, plus `curl /api/x402/three-intel | jq
'.accepts[].network'`): sponsor `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`
at 0.0108 SOL, settle floor 0.002 (prod `X402_SPONSOR_SOL_FLOOR_LAMPORTS=2000000`,
not the 0.02 code default), measured burn 0.058981 SOL/day over 7d from 50,001
successful settles, runway 0.2d. Accepts carried BOTH networks; the settle sensor
read `cause: rail`. Fifteen minutes later, mid-verification, the same wallet
crossed its floor: 0.0018556 SOL, accepts collapsed to `['eip155:8453']` only,
and the sensor flipped to `cause: sponsor_floor` with `noSolanaAccept: 148`.
The failure this work order describes reproduced live, and the new sensor named
it correctly in both regimes without a code change between the two reads.

Did:
- New `api/_lib/x402/sponsor-runway.js`: `measureSponsorBurn()` (fee_lamports over
  a parameterised window, fail-soft), `computeSponsorRunway()` and
  `formatSponsorRunwayAlert()` (both pure). Runway is reported twice: `runway_days`
  to empty (what a funding ask is sized against) and `runway_days_to_floor`, which
  is what the status and the alert key off, because settling stops at the floor.
- `checkRingWallets()` now measures the burn every 10-minute tick and fires the
  alert through `sendOpsAlert` (dashboard row always, Telegram when wired).
  Thresholds: `X402_SPONSOR_RUNWAY_ALERT_DAYS` (3), `X402_SPONSOR_BURN_WINDOW_DAYS`
  (7). `unknown` (unreadable balance, or an idle rail with no measurable burn)
  never pages. The dashboard read passes a no-op sender, so it still cannot alert.
- `/api/ops/payment-outcomes` and the `/admin/ops` card now consume that one
  verdict instead of recomputing burn, so the board and the alert can never
  disagree. Both floors are reported separately: `settle_floor_sol` (where
  settling stops) and `sol_floor` (the ring's 1.5x watch floor).
- `recordAgentReclaim()` / `buildAgentReclaimRows()` in `economy-ledger.js`, called
  from `treasury-topup`: `inflow` per return, `inflow_failed` per failure with the
  stage (`read` / `recover` / `send`), and an `agent_reclaim` summary written even
  on a no-op, so "ran and found nothing" (`nothing_reclaimable`, needs money) and
  "could not run" (`blocked`, an RPC or key problem, free) stop being the same
  absence of rows. Read-error rows capped at 20/run with the true count kept in the
  summary. The chain-append loop was extracted and is now shared by all three
  recorders.
- Tests: `tests/x402-sponsor-runway.test.js` (14, arithmetic + the rendered alert
  string), `tests/x402-sponsor-runway-monitor.test.js` (6, that the monitor
  actually sends it), 7 added to `tests/economy-sweepback.test.js` for the ledger
  rows. Docs: `docs/ops/payment-outcomes.md` (thresholds table, statuses, why
  `unknown` never pages), `docs/x402-ring-economy.md`. Changelog entry (infra).
- Verified end to end against the real DB and live chain, not only in unit tests:
  the endpoint returned `runway_status: critical` and the `/admin/ops` card
  rendered `settle floor 0.002 - burn 0.058279/day over 7d (49557 settles) -
  runway 0d to floor (alerts under 3d)` in a headless browser, no console errors
  from page code.

Gate: `check:rules` clean on the 11 files (diff-scoped). `test:gate` 86/86,
`test:gate-3d` 527/527, all MCP/route/handler/page/x402/guard audits pass. Three
pre-existing reds, none mine and none regressed: `workers/okx-chat-bot` has no
README (another agent's WO-08, in flight), `pages/ghost-copy.html` has 1 token-hex
drift (another agent), and `audit:tour-atlas` reports the same 17 problems at base
commit `6cc0370dc` (verified in a detached worktree).

Left, both stop-and-ask gate 1, numbers rendered for the owner:
1. **Free first, no owner money.** `POST /api/cron/treasury-topup?dry=1` plans
   0.122875505 SOL reclaimable into the master from two platform agent wallets
   (`Atlas #22` 6FL9viFy2WrYMWPd3HAQA4Bxm5qxQWoQMn3T9GbcwxEB 0.068390963 SOL,
   `Echo #22` 8u5raEaz7Qjm5hRzNxwzXiZtjTkdgQ3Co6G6S5WNxFTs 0.054484542 SOL), 0 read
   errors, 110 sources at floor. That is ~2 days at the measured burn. Firing it
   non-dry moves funds and needs an explicit yes.
2. **Capital.** 0.816 SOL to the SPONSOR or the economy master buys 14 days at the
   measured 0.0583 SOL/day. Never per-agent wallets. Note the master IS the
   sponsor here (same address, same balance).
3. **Deploy.** Production runs `6cc0370dc`; every item above ships with the next
   deploy, which is owner-gated. Until then the alert is dormant.
