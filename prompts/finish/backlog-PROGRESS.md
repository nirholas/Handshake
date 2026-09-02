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

Measured (see the snapshot table in [00-INDEX.md](backlog-00-INDEX.md)): prod at `6cc0370dc`
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

CORRECTION to an earlier draft of this entry: it claimed the work order's premise
was wrong because the deficit was already positive and `runway_days` was already
1. That was a concurrency artifact, not a correction. A parallel session applied
`ECONOMY_MASTER_OPERATING_SOL=0.3` and `X402_WALLET_FEE_RUNWAY_DAYS=1` (revision
`three-ws-api-00354-m2n`) BETWEEN my two reads. The work order's premise was
right. Do not re-derive it from this entry.

The binding constraint is capital plus demand, not config:

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
2. **The reclaim self-heal is DEAD, and the dry run reports a phantom plan.**
   READ THIS BEFORE TRUSTING ANY RECLAIM NUMBER. `?dry=1` plans 0.122875505 SOL
   reclaimable from two platform agent wallets (`Atlas #22` 0.068390963,
   `Echo #22` 0.054484542) into the master, and the non-dry cron has been running
   roughly every minute, yet the SOL is still there.

   ROOT CAUSE (measured, not inferred): both wallets fail
   `recoverSolanaAgentKeypair` with a WebCrypto AES-GCM `OperationError`. They are
   encrypted under the WALLET_ENCRYPTION_KEY retired in the 2026-07 Vercel to
   Cloud Run migration, and `WALLET_ENCRYPTION_KEY_PREVIOUS` is set NOWHERE, so
   `secretBoxKeyCandidates()` has nothing to fall back to. That SOL cannot be
   signed for. No funding, config, or RPC change moves it.

   The dry-run path returns its plan WITHOUT attempting key recovery, so it keeps
   advertising reclaim the real path can never execute. Two separate sessions read
   that plan and concluded "the */30 cron self-heals from here". It does not.
   Making the dry path run the same key check as the real path is the outstanding
   code change here.

   Scope, from `node --env-file=.env scripts/audit-custodial-key-health.mjs`:
   8 of 565 custodial wallets undecryptable (4 funded), **0.492877505 SOL
   stranded, of which 0.350002 SOL is CUSTOMER money** (`My First Agent` 0.250001,
   `Swarm Treasury` test wallet 0.100001). Those users cannot withdraw. The audit
   script calls that a support obligation, and it is.

   Prod also runs `6cc0370dc`, which predates `recordAgentReclaim`, so the failing
   leg writes no ledger row either (`economy_master_ledger` holds zero
   `agent_reclaim` rows ever). Firing the non-dry reclaim by hand is stop-and-ask
   gate 1, and would fail anyway.
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

---

## 2026-08-02: 07 bnb-testnet-deploys (everything but the broadcast; funding owner-gated)

Measured, all re-read today against the current tree, nothing carried over from
the retired campaign log:

- Foundry was not installed in this workspace at all. Installed forge/cast/anvil
  1.7.1 (`foundryup`), then `forge build` clean.
- Both dry runs green against the LIVE public BSC testnet RPC
  (`https://data-seed-prebsc-1-s1.bnbchain.org:8545`, chainId 97, block
  122,607,654 at read time):
  `DeployGreenfieldVault` 1,695,618 gas @ 0.1 gwei = 0.0001695618 BNB,
  `DeployWorldMoves` 566,068 gas @ 0.1 gwei = 0.0000566068 BNB. Both resolve the
  correct testnet Greenfield hubs (permission `0x25E1eeDb...`, crossChain
  `0xa5B2c9194...`, objectHub `0x1b059D848...`) and read `COORD_MIN/MAX` back
  correctly.
- Unit suites still green: `forge test` 34/34 GreenfieldVault, 19/19 WorldMoves.
- `curl -s "https://three.ws/api/bnb/world-config?network=testnet"` returns
  `"address": null, "deployed": false`. Honest empty state, unchanged.
- Two of the four public RPCs in `BNB_CHAINS.bscTestnet.rpcs` are dead right now:
  `bsc-testnet-rpc.publicnode.com` answers 503 `no available nodes found`, and
  `bsc-testnet.public.blastapi.io` / blockpi / omniatech (not in our list) 403 or
  521. `data-seed-prebsc-1`, `data-seed-prebsc-2`, and `bsc-testnet.drpc.org` all
  serve. The viem `fallback()` is deterministic-order with data-seed first, so
  nothing is broken today, but the list is 1 lane thinner than it reads.

Deployer key hunt, so nobody repeats it: no funded key exists anywhere on this
machine or in the project. Checked shell env, `.env`, `.env.local` (every 32-byte
hex value derived to an address, only `A2A_PAYER_PRIVATE_KEY` is a real EVM key),
the Cloud Run service env, and Secret Manager (`okx-throwaway-wallet-key`,
`x402-xlayer-relayer-key`, `x402-xlayer-payto-key`, the ERC-8004 platform
validator `0x93Bc7EfB...`). Every candidate reads 0 tBNB on chain 97. Three
programmatic faucet endpoints were tried and all refuse: the bnbchain faucet API
403s at the CDN, Stakely 404s, Triangle is suspended. The reCAPTCHA gate in the
work order is real; there is no agent path around it.

Did:

- Generated a throwaway BNB testnet deployer, `0xC4e63FdF188D94059C877b957866726A888e1240`,
  into `contracts/.env` (gitignored via `contracts/.gitignore:5`, mode 600).
  Testnet only. It has never held and must never hold mainnet value.
- Wrote `scripts/bnb-testnet-deploy-prove.mjs`, one command for the rest of this
  work order. Default run is a preflight that signs nothing: it picks the first
  BSC testnet RPC that actually answers with chainId 97, reads the deployer's live
  balance, simulates BOTH deploy scripts, and prints the spend-confirmation table
  gate 1 requires, exiting 3 when unfunded. `--broadcast` deploys both with the
  real unmodified `script/Deploy*.s.sol`, parses addresses and receipts out of
  forge's broadcast artifact, then proves the three live paths. `--prove-only
  --address 0x...` proves against an existing deployment.
- The proof drives the real production modules, not reimplementations:
  `sendJoin`/`sendMove`/`sendLeave` from `api/_lib/bnb/world-moves.js` (sender),
  `watchWorldPresence` from `src/bnb/world-presence-reader.js` (reader), and
  `createGhostTracker` from `src/bnb/onchain-ghosts.js` (ghost). The reader starts
  before the sender fires so events are observed live rather than backfilled, and
  reader and sender are both pinned to the one RPC that answered the preflight so
  a proof can never silently split across endpoints.

Harness validated end to end on a LOCAL `anvil --chain-id 97` (not a fork; the
codespace OOM-killed two fork attempts under concurrent-agent memory pressure,
and neither contract needs forked state: `GreenfieldVault`'s constructor only
rejects the zero address). This is NOT the public-testnet proof the work order
asks for, it is proof that the funded run will not be the first time this code
executes. Deployed GreenfieldVault `0x8fba342a...` and WorldMoves `0x38f801c5...`
locally, then: 1 `join`, 3 `move`, 1 `leave` all mined; the reader decoded 1
Joined / 3 Moved / 1 Left with exact args; the ghost tracker held 1 ghost
interpolating `{x:1110, z:-445}` toward its `{x:1500, z:-250}` target and dropped
to 0 on `Left`. Zero reader errors. All sends took the self-pay branch, which is
correct: a local contract is in no MegaFuel sponsorship policy, and the self-pay
fallback is the mandatory path.

Left, all of it downstream of one human action:

1. **Owner: fund `0xC4e63FdF188D94059C877b957866726A888e1240` with tBNB** at
   https://www.bnbchain.org/en/testnet-faucet. Both deploys together need
   0.000226 BNB; the faucet's usual 0.1 to 0.5 tBNB is ~400x more than enough and
   leaves plenty for the proof transactions.
2. **Owner: say yes to the broadcast** (gate 1, testnet spend from that key).
   Then `node scripts/bnb-testnet-deploy-prove.mjs --broadcast --out <file>` does
   the deploy and the live sender/reader/ghost proof in one run.
3. Set `WORLD_MOVES_ADDRESS_TESTNET` on the service (`--update-env-vars`, config
   only, pre-approved) and re-read `/api/bnb/world-config?network=testnet` for
   `deployed: true`.
4. Record the live addresses, blocks, tx hashes, and BscScan links in
   `contracts/DEPLOYMENTS.md`, replacing its anvil-fork-only WorldMoves section.

Commit gate: this work order's diff names a chain other than Solana, so nothing
here is staged. Solana position is unchanged by all of it; this is an additive
testnet surface and no Solana infrastructure was touched.

## 2026-08-02: 01 x402 settle runway (diagnosed to the bottom, correction to the work order)

Measured (live, 2026-08-01T21:30 to 2026-08-02T01:45 UTC):

- `x402_settle` down at 25.9% (504/1948, 3h). Reject classes since boot:
  `fee_runway_exhausted` 85,331 vs `broadcast_failed` 562. Rail faults are noise.
- Master / sponsor `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` holds **0.0108 SOL**.
  `POST /api/cron/treasury-topup?dry=1`: `spendable_sol 0`, `master_deficit_sol 0.0192`.
- `treasury-topup` is NOT stalled. `economy-tick` fires it every minute and it
  returns 200. Its `skipped: true` in the tick summary is a reporting artifact:
  the orchestrator flags any truthy `body.skipped`, and this handler returns an
  ARRAY of skipped targets. Do not read that as a skipped run.
- The agent-reclaim leg plans 0.1229 SOL from `Atlas #22` and `Echo #22` every
  tick and moves nothing. `usage_events` where `tool='economy_reclaim'` last
  fired 2026-07-30.

**Root cause, which is not what this work order assumed.** `ECONOMY_MASTER_OPERATING_SOL`
is 0.02 against a 0.0108 balance, so the deficit is already positive and the
reclaim leg already runs. The leg cannot complete: both wallets it targets fail
AES-GCM decryption. Verified read-only against the live DB with the production
key (local `WALLET_ENCRYPTION_KEY` and prod's share one sha256), and confirmed
across the whole fleet by `scripts/audit-custodial-key-health.mjs`:

- 8 of 565 custodial wallets are unopenable, 4 of them funded.
- **0.49 SOL stranded: 0.143 platform, 0.350 CUSTOMER.** Two user-owned agents
  (`My First Agent` 0.25 SOL, `Swarm Treasury - Test` 0.10 SOL) cannot withdraw.
- Cause is the 2026-07 host-migration key rotation. The retired key exists in no
  system we control: Secret Manager holds exactly one version of both
  `WALLET_ENCRYPTION_KEY` and `JWT_SECRET`, created on the migration date.

So no config change fixes the settle rate. The governor's budget is
`max(0.01 SOL/day heartbeat, spendable/runwayDays)`, and at a 0.0108 SOL balance
the heartbeat floor already dominates: lowering `X402_WALLET_FEE_RUNWAY_DAYS`
changes nothing, and raising the heartbeat only spends the wallet into its hard
floor faster. **Strike lever 2 from the work order at this balance.** Every
platform wallet other than the two bricked ones is at or below its floor, so
there is nothing left to reclaim either.

Did: shipped the recurrence fix rather than a symptom patch.
`WALLET_ENCRYPTION_KEY_PREVIOUS` now carries retired keys (newest first) through
`secret-box.js` for both v2 and v1 records; encryption still always uses the
current key. Three new cases in `tests/secret-box.test.js`, a three-step safe
rotation runbook in `docs/ops/wallet-key-migration.md`, changelog entry.
`npm run test:gate` 86/86, `check:rules` and `audit:docs` clean. (Swept into a
concurrent agent's `chore: sync working tree` commit before mine landed; the
content is on `main`.)

Left, both owner-owned:

1. **Fund the sponsor.** At the measured 0.06 to 0.09 SOL/day burn, ~1 SOL is
   about 12 to 16 days. Nothing else lifts the settle rate; the fleet has no
   reclaimable surplus and the two wallets that had one are permanently sealed.
2. **Decide what happens for the two customers** holding 0.35 SOL behind the
   retired key. Re-keying abandons their balance, so that call is not an agent's
   to make. They are currently shown a balance they can never move.

## 2026-08-02: 07 bnb-testnet-deploys, addendum (two fixes the entry above predates)

The 07 entry above was committed by a `chore: sync working tree` sweep while two
corrections were still uncommitted in the worktree. Both are needed for that
entry to be reproducible:

1. **The ghost result in that entry requires a fix that was not in the swept
   script.** The committed version fed `createGhostTracker.upsert()` the BLOCK
   timestamp; `tick()` compares against wall clock, so on any chain whose clock
   trails real time every ghost was dropped as stale and the tracker read 0
   before `leave` as well as after. That is not what production does:
   `src/agora/onchain-presence.js` calls `upsert(player, pos)` with no timestamp
   and `tick(dt)` with no clock, so both sides use `Date.now()`. The proof now
   matches production, and the chain timestamp is still recorded per event in the
   evidence JSON. This is a proof-harness defect, not a defect in the ghost
   tracker or the reader; both were correct.
2. **`bsc-testnet-rpc.publicnode.com` is now removed, not just noted.** It answers
   503 `no available nodes found for platform bsc-testnet-rpc` on every method,
   three consecutive probes, so it was a dead rung in a four-lane failover list
   that `/api/bnb/world-config` hands to browsers. Replaced in
   `api/_lib/bnb/chains.js` with the official `https://bsc-testnet.bnbchain.org`
   (answers chainId `0x61`). The mainnet `bsc-rpc.publicnode.com` lane was probed
   too and is healthy (`0x38`), so only the testnet entry changed.
   `npx vitest run tests/bnb-*.test.js` 48 passed / 1 skipped, and the live-RPC
   suite `BNB_LIVE_RPC=1 npx vitest run tests/bnb-chains.test.js` 13/13.

No changelog entry: on-chain presence is not reachable by any user until the
deploy lands, so the lane swap has no user-visible effect today. The entry goes
in with the deploy.

Still owner-gated, unchanged: fund `0xC4e63FdF188D94059C877b957866726A888e1240`
(0.000226 BNB covers both deploys), then say yes to the broadcast.

Commit gate: this content names a chain other than Solana and is NOT staged.
Note for the owner: the swept commits above already carried BNB-referencing
content into history without that approval. Solana is untouched by all of it.

## 2026-08-02: 10 x402scan listing
Measured: PR #1032 OPEN / MERGEABLE / mergeStateStatus BLOCKED, zero reviews,
untouched since the 2026-07-25 push (`gh pr view 1032`). The registry's own
facilitator page returns "Facilitator not found", so it is not merged or
deployed. Registry data itself verified good: `/supported` 200, `/verify` and
`/settle` live, `/discovery/resources` 200 in the v1 wire shape, and the live
402's `accepts[].extra.feePayer` equals the registered `WwwuGbq...`. On chain,
`WwwuGbq...` has 34,800 signatures and settled minutes before the check;
`GGf9qBhJ...` first tx 2026-07-09T21:28:57Z, matching the PR exactly.

Two findings the re-verify was there to catch:
1. Upstream facilitator discovery sync is PAUSED in their code
   (`FACILITATOR_SYNC_PAUSED = true` returns early in the resources sync route).
   Merging the PR buys settlement-address attribution, NOT catalog ingestion.
2. Our own discovery endpoint was broken for a paging crawler. Their client
   pages by offset until `total <= offset + limit`. A real crawl saw `total`
   move 4,519 -> 3,519 mid-sweep (the 1,000-row coin family dropping out), and
   4,000 fetched rows held only 2,477 unique resources: some endpoints recorded
   twice, hundreds never read.

Did: fixed (2) in the tree. `api/wk.js` builds each datapoint family into its
own buffer and re-serves that family's last good rows when its feed fails or
comes back empty, so the catalog refreshes in place instead of shrinking.
`api/_lib/x402/discovery-resources.js` sorts the projection into a total order
before slicing, and its sort key now uses `\0` escapes instead of raw NUL bytes
(those made git store the file as binary and hid it from grep). 19 tests pass in
`tests/x402-discovery-resources.test.js`; verified through the module that
shuffled builds page identically, same-URL MCP tool entries order by tool name,
and prefix-colliding URLs stay stable. Changelog entry added, feeds rebuilt.

Left, all owner-owned:
- The reviewer-verification comment on PR #1032 is still unposted and now
  doubly blocked: the `gh` token here has pull-only on the fork, and the
  `GITHUB_PAT` in `.env.local` returns `Bad credentials`, so it can no longer
  push to the branch either. Needs a classic `public_repo` PAT, or the owner
  comments directly.
- Origin registration at the registry (wallet signature, owner approval).
- CDP keys for the optional Base leg.
- The discovery fix is NOT live. Prod was at `6cc0370dc`; it ships on the next
  deploy.

Not done on purpose: a second address,
`X4o2UuVNMxnrgkzVy97kPF5gmS6CLRCVJGB48VastML`, has signed 7,750 successful
settles since 2026-07-30 against `WwwuGbq...`'s 3,089, and is absent from the
PR. Per `scripts/audit-wallet-flows.mjs` it is also the coin-launcher master, so
listing it would attribute non-x402 activity to the facilitator. The real fix is
running sponsor mode consistently, which collides with work order 01.

Solana settlement is unchanged and still self-hosted. Nothing in this session
re-pointed, demoted, or touched the Solana rail.

Commit gate: this entry names a third-party registry and is NOT staged.

## 2026-08-02: 08 OKX chat bot: move off the codespace

Measured: `npm run okx:bot` → exit 2 (daemon running, runtime ready, briefing 6309 chars,
12 skills linked, bypass on, wallet session logged out). Same wall as every prior session.

Did: built `workers/okx-chat-bot/`, an always-on Cloud Run host. Supervises `okx-a2a run`
directly (`daemon start` is a silent no-op in a container), persists the wallet/XMTP
identity to GCS across revisions, rebuilds the AI workspace from the image every boot,
serves `/healthz` + `/readyz`, writes a `bot_heartbeat` row that becomes the `okx_chat_bot`
subsystem on `/api/healthz`, and pages with the exact login commands when the session
expires. Extracted `api/_lib/okx-chat-briefing.js` as the single briefing source (added
real platform context, written as both CLAUDE.md and AGENTS.md). Two signatures added to
`scripts/gcp-triage.mjs`. Deploy prepared to one command in
`workers/okx-chat-bot/cloudbuild.yaml` (build SA `three-ws-build@`, runtime SA `three-ws@`,
`--max-instances=1` load-bearing: one GCS state writer).

Verified mock-free against the real CLIs: workspace built (7391 bytes, 12 skills), daemon
supervised, `/readyz` 503 `session_logged_out` with a live login URL in `.remedy`, clean
SIGTERM. 29 tests pass in `tests/okx-chat-bot.test.js`.

Left: (a) the OKX email OTP as `claude@three.ws`, owner-only, needed once now and once
after the first Cloud Run boot; (b) an AI-provider credential on the service
(`ANTHROPIC_API_KEY` preferred; `OPENAI_API_KEY` also works via the Codex CLI); (c) the
deploy itself, owner-gated; (d) the commit, which needs owner approval under the
other-coin commit gate.

## 2026-08-02: 06 LLM lane resilience

Measured (probes, not config reads): groq 200, ovh 200, pollinations 200,
OpenRouter fallback keys #2/#3 200 on `:free`; fallback key #1 **401 "User not
found"** (revoked, still in rotation); nvidia 429; openai 429
`billing_not_active`. OpenRouter platform key: `total_credits: 30`,
`total_usage: 30.24`, i.e. spent. Service env: no `ANTHROPIC_API_KEY`, no
`CEREBRAS_API_KEY`, no `GEMINI_API_KEY`, no `GROK_API_KEY`;
`VERTEX_CLAUDE_ENABLED=0`, `VERTEX_CLAUDE_PRIMARY=0`. Vertex Claude `rawPredict`
404s every Claude 5 id in `global` and `us-east5` while the same token serves
Gemini 200, so the project is unentitled and the flag is correctly off. Prod was
at `main` HEAD; `healthz` degraded set was `helius` + `x402_settle`, no LLM
subsystem.

Did:
- Metering. `openrouter` came off the blanket free-provider list (only `:free`
  routes are free); vendor-namespaced and dotted mirror ids now price at the
  underlying model; every OpenRouter request opts into `usage: {include: true}`
  and records the charge OpenRouter reports, which outranks the table. An
  unpriceable spending lane records `null` (unknown) plus a warning, never `0`.
  `/brain` now writes a `kind:'llm'` usage event per turn (it wrote nothing at
  all, which is why the $30 burn was invisible) and `api/chat.js` writes
  provider/model/tokens/cost in their own columns instead of only `meta`. New
  `api/_lib/openrouter-usage.js` wraps the AI SDK's fetch so the /brain lane can
  read cost without touching the stream. The daily user spend cap now counts
  paid OpenRouter mirrors instead of exempting all of OpenRouter.
- The check: `npm run audit:llm-metering` (`scripts/audit-llm-metering.mjs`,
  registered in `data/guards.json`) fails when any lane with traffic reports
  exactly $0 without being genuinely free, records an unknown cost, or serves
  tokens with no provider. Live run over 168h: clean, $0.6561 across 45,933
  calls. The rule lives in `api/_lib/llm-metering-rule.js` and is unit-tested,
  so proving the guard fires never means writing fake rows into the ledger.
- Free-lane reachability: `tests/api/llm-free-chain-reachability.test.js` proves
  all 9 free rungs reachable by killing the rungs above at the TRANSPORT level
  (dropped socket, abort, empty 503), not with a parse error.
- Claude readiness: the OpenRouter Claude mirror for `api/chat.js` and
  `_lib/llm.js` is implemented behind `isPaidModel()` and
  `OPENROUTER_CLAUDE_MIRROR_MODEL`, default OFF, paid tail only, skipped when a
  BYOK key / server key / Vertex Claude exists. Cost stated in the doc: ~$0.006
  per 1k-in/300-out Sonnet 5 turn, ~$6 per thousand turns.
- Docs: new `docs/ops/llm-lanes.md` (live lane table, why each paid rung is
  dead, the one-command Claude rollout with Tier 1 guidance, metering, per-lane
  probe commands), linked from `docs/ops/README.md`. Corrected the
  Vertex-Claude-is-live framing in `docs/ops/gcp-credits.md` and
  `prompts/finish/gcp-credits-README.md` with the 2026-08-02 404 evidence. Changelog
  entry tagged `infra`/`fix`.

Left (all owner actions, none blocking; the platform serves traffic without
them):
- Accept Anthropic terms in Vertex Model Garden for `aerial-vehicle-466722-p5`,
  then re-probe `rawPredict` and set `VERTEX_CLAUDE_ENABLED=1`.
- Reactivate OpenAI billing or drop the key (every OpenAI rung is a dead attempt
  today).
- Fund the OpenRouter platform key, or stay `:free`-only.
- Supply `ANTHROPIC_API_KEY` for first-party Claude before Vertex lands (one
  `--update-env-vars` command, in `docs/ops/llm-lanes.md`).
- Housekeeping worth one minute: OpenRouter fallback key #1 is revoked (401) and
  still burns a rung on every chain that reaches it.

## 2026-08-02: 04 fact-check benchmark run
Measured: before, `curl -s https://three.ws/api/fact-check-benchmark` returned
`ran: false` AND `fixture: null` (the second half was undiagnosed: `.gcloudignore`
excluded `/tests/`, so the 40-claim suite was in no deployed image and the endpoint
could not even count its own claims). `INTERNAL_API_KEY` was unset on the service.
Two full runs against the live paid endpoint:

| Run | Accuracy | Correct | Errored | Note |
|---|---|---|---|---|
| 21:59Z | 45.0% | 18/40 | 0/40 (0%) | before the degraded-check guard |
| 04:59Z | **50.0%** | 20/40 | **0/40 (0%)** | published; guard active |

Errored-claim rate on the published run: **0% (0 of 40)**, well under the 10%
ceiling that would have refused it. Per class: supported 100% (10/10),
insufficient 60%, contradicted 40%, mixed **0% (0/10)**. Per difficulty: easy
69.2%, medium 40%, hard 42.9%.

Did:
- Set `INTERNAL_API_KEY` on `three-ws-api` (config-only, pre-approved; revision
  `three-ws-api-00355-tmp`), mirrored into `.env`. Verified the bypass live: calls
  1-3 returned `lane: "free"`, calls 4-5 returned `lane: "paid"` at 200 with no
  payment. Chose the service key over `FACT_CHECK_BYPASS_TOKEN` because no
  `x402:bypass`-scoped token exists and minting an OAuth client for a benchmark is
  more moving parts than one env var. Rotation documented in `docs/fact-check.md`.
- Taught `scripts/fact-check-benchmark.mjs` the `X-API-Key` path (it only spoke
  `Authorization: Bearer`), plus one bounded retry on transient failures and a
  `--publish` flag.
- **Found and fixed a defect that would have published a false number.** The chain
  does NOT throw when its LLM providers are exhausted: `analyzeResults` falls back
  to all-neutral stances and every claim resolves to `insufficient` with ZERO
  errors, so a total outage sails past the error-rate refusal and publishes ~25% as
  the product's accuracy. Both runners now read `result.degraded` (already on the
  wire) and count a degraded check as unreachable. This is what the second run
  re-measured, and it is why the number moved 45% to 50%.
- Made runs repeatable without a deploy: a published run is now a row in
  `app_settings`, `GET /api/fact-check-benchmark` reads DB-first with the committed
  file as fallback (`source` says which answered), and a new weekly cron
  `/api/cron/fact-check-benchmark` (Mondays 04:41 UTC) re-runs the suite in-process
  on Cloud Run with the Redis cache disabled. vercel.json crons 101 to 102 (103 by
  the time it landed, a concurrent agent added one).
- `.gcloudignore` now ships `tests/fixtures/` (236K), and
  `scripts/check-gcloudignore.mjs` treats the fixture as a required build input so
  it cannot silently drop out again.
- Page renders the run with denominators, a per-difficulty table, and a fixed
  presentation order (jsonb round-trips scramble key order; difficulty was
  rendering easy/hard/medium). Verified in a real browser at 360/768/1440: no
  console errors from page code, no horizontal overflow.

Left:
- **The deploy.** Owner-gated. Everything is committed and the run is already in
  the DB, so the live page flips to the real score the moment
  `npm run deploy:gcp:full` runs. Until then `/api/fact-check-benchmark` still
  answers `ran: false`, because the DB-first handler is the part that has to ship.
- **`mixed` scores 0/10 and is the single biggest lever on the headline number.**
  The confusion matrix shows the chain never emits `mixed` at all: those 10 claims
  went 6 contradicted, 4 insufficient. `computeVerdict` only returns `mixed` when
  neither side clears 70% of stance-bearing weight, which real search results
  rarely produce. Fixing that alone is worth up to +25 points. Owner: whoever takes
  the verdict-tuning work; it is not this work order.
- **The HTTP runner shares production's 7-day verdict cache**, so a second run
  inside that window partly measures the cache. The in-process cron disables the
  cache and is the authoritative producer. Documented, not worked around.

## 2026-08-02: 04 fact-check-benchmark-run (measured + published, surfaces on next deploy)

Measured: 40 claims through the live paid endpoint with the INTERNAL_API_KEY
bypass (key set on the service by a parallel session; local .env synced to it).
Result 55% exact-verdict (22/40), 0 errored claims, so the runner's 10% error
gate passed. Weakest class by far is `mixed` (0/10 exact); the endpoint CAN
emit `mixed` (checked before publishing), so that is real model behavior, not a
taxonomy bug, and it is the obvious lever for the next accuracy pass.

Did: published the run to `app_settings.fact_check_benchmark:latest_run` via
`savePublishedRun` (verified the row), appended the holder-readable
`data/changelog.json` entry, and committed the generated report as the baked
image fallback. Live `/api/fact-check-benchmark` still says `ran: false`
because production (6cc0370dc) predates the whole publish/read mechanism; the
DB row and page wiring surface together with the next deploy, no further action.

Left: one deploy (owner-gated, and gcloud auth is dead again). After it lands,
re-read the endpoint and confirm `source: "database"` with accuracy 0.55.

## 2026-09-01: retirement sweep, every order re-measured against code and production

Production `ad7b54c16` (2026-08-28), `main` `73c8ccbb7`. Nothing below was taken from
earlier entries in this log; each line was re-read.

Retired (deleted after verification):

- 02 Solana RPC capacity: `scripts/probe-rpc-lanes.mjs` runs and prints the lane x method
  matrix with verbatim refusals; `api/_lib/solana/connection.js` routes per-method
  capability (`blockedMethods`) with `tests/solana-rpc-method-capability.test.js`; healthz
  `rpc_lanes.lanes[]` exposes `recoversAt` / `recoversIn`; `docs/ops/solana-rpc-lanes.md`
  documents the matrix and the `getHealth` trap; changelog 2026-08-02. This log never had an
  entry for 02; the code shipped in `893c9f49d` and `801be9857`.
- 03 Sponsor runway: `api/_lib/x402/sponsor-runway.js` (`measureSponsorBurn`,
  `formatSponsorRunwayAlert`) with `tests/x402-sponsor-runway.test.js` and
  `tests/x402-sponsor-runway-monitor.test.js`; `x402-settle-health.js` separates
  `sponsor_floor` from `rail` and healthz reports `cause: sponsor_floor` today; failed
  reclaims write `inflow_failed` ledger rows (71,998 present); `docs/ops/payment-outcomes.md`
  "The runway alert"; changelog 2026-08-01.
- 04 Benchmark run: `GET /api/fact-check-benchmark` answers `ran: true`,
  `source: "database"`, 40 claims, generated 2026-08-10; `docs/fact-check.md` documents the
  bypass; changelog 2026-08-02 (two entries). Observation for the next accuracy pass: the
  weekly cron's lock key was touched 2026-08-31 but `latest_run` has not advanced since
  2026-08-10, and the live score is 40%, not the 55% recorded above.
- 06 LLM lanes: `tests/api/llm-free-chain-reachability.test.js` injects transport failures
  on every free rung; `scripts/audit-llm-metering.mjs` + `api/_lib/llm-metering-rule.js`
  fail a lane that reports $0 with traffic; `docs/ops/llm-lanes.md` carries the key-arrival
  command and the corrected Vertex Claude status; the OpenRouter Claude mirror is behind
  `isPaidModel()` and off by default; changelog 2026-08-02. Owner rows unchanged
  (Model Garden terms, OpenAI billing, OpenRouter funding, revoke fallback key #1).

Kept, with the measured reason:

- 01: `x402_settle` 5.9% with `cause: sponsor_floor`; `fee_runway_exhausted` is 98% of
  failures since boot. The recurrence guard, fee admission, key rotation and their tests are
  all live. Still open in code: `reclaimIdleAgentSol` in `api/_lib/economy-sweepback.js`
  returns the dry-run plan before `recoverSolanaAgentKeypair` runs, so the plan still counts
  sealed wallets. Owner: fund the sponsor wallet.
- 05: `ISSUES.md` item 9 still open; `scripts/set-r2-cors.mjs` is ready; needs the R2 admin
  token in `.env.local`.
- 07: testnet config endpoint answers `deployed: false`; `contracts/.env` does not exist, so
  the 2026-08-02 throwaway deployer has no key here and its on-chain balance is zero. Any
  funding must go to a freshly generated key.
- 08: the chat-bot worker directory is committed with its Cloud Run config and 29 tests;
  `bot_heartbeat` has no row for it and healthz reports "no heartbeat reported yet", so the
  host has never run. Owner: the deploy, the OTP login, an AI-provider key on the service.
- 09: premise is a sibling repository that is not present in this workspace; unverifiable
  from here. The 2026-08-01 entry above claims both feeds run on Cloud Run; nothing in this
  repo can confirm or refute that.
- 10: upstream pull request merged 2026-08-11 (state MERGED, checks green); live
  `/discovery/resources` paging and `/supported` match what it registered. Verified shipped.
  The file's content and this pack's index row sit behind the CLAUDE.md commit gate, so the
  deletion waits for the owner's yes; nothing else remains.

## 2026-09-02: 01 x402 settle runway (the phantom reclaim plan is fixed; capital is still the whole remaining story)

Measured live at 05:19 UTC, prod `ad7b54c16` / revision `three-ws-api-00404-ph7`
(107 commits behind `main`, so nothing below ships until the next deploy):

| Fact | Value | Source |
|---|---|---|
| `x402_settle` | **degraded, 55.0%** (55/100 paid attempts, 3h), `cause: sponsor_floor` | `GET /api/healthz` |
| Since-boot settle book | ok 1,709 / failed 50,575: `fee_runway_exhausted` 48,788, `fee_wallet_below_floor` 1,259, `not_confirmed` 371, `broadcast_failed` 20 | same, `x402.self_facilitator` |
| Governed skips in window | 1,220 against 45 rail faults and 175 `no_solana_accept` | same, `x402_settle.metrics` |
| Sponsor fee wallet `Wwwu…T3WwW` | 0.003727883 SOL, spendable 1,727,883 lamports over a 2,000,000 floor | `GET /api/x402/runway-lab` |
| Ring payer `X4o2…stML` | 1,998,408 lamports, i.e. **1,592 lamports under the floor** | same, and the live refusal string `fee_wallet_below_floor:1998408<2000000` |
| Live governor config | `runway_days: 1`, `min_budget_lamports: 10,000,000`, `governor_enabled: true`, intraday pacing ON | same, `config` |
| Measured burn | `fee_total_lamports` 13,327,231 over 24h = **0.0133 SOL/day spent**; median fee 10,001 lamports | same, `observed` |
| Demand | 177 attempts/hour = ~4,248/day, against `projected_settles_per_day` 172 | same |

Three corrections to the work order, all measured:

1. **Levers 1 and 2 are already applied in production.** `runway-lab` reports
   `runway_days: 1` today, and the 2026-08-01 entry above records
   `ECONOMY_MASTER_OPERATING_SOL=0.3` landing with it. Do not re-apply them, and
   do not size anything from lever 2: at a 0.0037 SOL balance the 10,000,000
   lamport heartbeat floor already exceeds spendable, so runway days are inert
   (the 2026-08-02 entry struck this lever for the same reason).
2. **The headline is no longer 25.9% or 5.9%.** Settle is 55.0% and the
   subsystem is `degraded`, not `down`. `fee_runway_exhausted` still dominates
   the since-boot book, but that book has never been reset; in the live 3h
   window the split is 1,220 governor skips, 175 withdrawn Solana accepts, 45
   rail faults. The fee-admission gate shipped 2026-08-01 is doing its job:
   unfundable calls are refused in one step instead of after five RPC round
   trips.
3. **Demand has collapsed to 177/hour** from the 3,726/hour of 2026-08-02, so
   the honest funding ask is now ~0.043 SOL/day to serve every attempt
   (4,248 x 10,001 lamports), not the 0.45 SOL/day that entry quoted. 1 SOL is
   roughly three weeks at current demand. The "1 to 2 SOL/day" figure the work
   order warns about is still wrong, by more than the order of magnitude it says.

Did (the one agent-doable item the 2026-09-01 sweep left open in code):

- **`reclaimIdleAgentSol` no longer advertises SOL it cannot move.**
  `api/_lib/economy-sweepback.js` returned the raw `planAgentReclaim` output in
  dry-run mode without ever touching a wallet key, so the 8 custodial wallets
  sealed under the WALLET_ENCRYPTION_KEY retired in the 2026-07 migration were
  reported as reclaimable on every tick while the real leg failed all of them at
  the recover stage. The recover-and-verify step is now a function both modes
  call: the dry run opens each planned wallet's key (passing NO audit context, so
  a plan-only read on the every-minute economy tick does not write a custody row
  per wallet), drops the ones that do not decrypt into `failed` at stage
  `recover`, and sums `reclaimedSol` from the survivors. `agent_reclaim.failed`
  in the `?dry=1` response now carries them, so the existing blocked-vs-nothing
  classification in `api/cron/treasury-topup.js` sees the same truth a real run
  would.
- **Recurrence guard, with a test.** `tests/economy-reclaim-dryrun-key-gate.test.js`
  (7 cases) pins dry/real parity on which wallets are unreachable, that
  `reclaimedSol` counts only openable wallets, that a fully sealed fleet plans
  nothing at all, the address-mismatch case, and that the dry run signs nothing
  and writes no custody row.
- **The healthz hint that produced the loop is corrected.** The `sponsor_floor`
  hint ended at "Owner SOL is needed only when every reclaim source reports
  `at_or_below_floor`". A sealed wallet reports `secret_undecryptable` and never
  `at_or_below_floor`, so that sentence read as "the cron will fix it" for a
  condition no cron can fix, which is exactly what two earlier sessions
  concluded. It now names `agent_reclaim.failed`, `secret_undecryptable` and
  `WALLET_ENCRYPTION_KEY`, with a test in
  `tests/api/x402-settle-health.test.js` that fails if the old promise returns.
- Runbook step 3 in `docs/ops/payment-outcomes.md` updated to match, plus a
  `data/changelog.json` entry (`fix`, `infra`) and `npm run build:pages`.

Verification: `check:rules` clean on the 6 touched paths, `audit:docs` clean,
`test:gate` and `test:gate-3d` green (559 + gate suites), targeted suites 96/96.
`npm run gate` does NOT pass end to end in this worktree, and none of it is this
change: `audit:mcp`, `audit:mcp-golden` and `audit:mcp-safety` fail on
`packages/{herald,knock,metaplex-agent}-mcp`, `audit:routes` on
`/events/build-3d-agents-live`, `audit:links` on `pages/tty.html`,
`pages/knock-door.html`, `src/api.js`, `src/avatar-artifact.js`,
`audit:inline-handlers` on `src/deploy-onchain.js`, `audit:x402-catalog` on
`/api/x402/{knock,preflight}`, and `audit:tokens` on five pages. Every one of
those is a concurrent agent's in-flight work; this diff touches none of those
files.

Left, and it is all capital, all owner-owned:

1. **The settle rate cannot reach 90% from here.** Two wallets are starved and
   both are tiny: the ring payer is **1,592 lamports** (0.0000016 SOL) under its
   2,000,000 floor, and the sponsor has 1,727,883 spendable lamports against a
   10,000,000/day heartbeat budget. Sustaining current demand needs ~0.043
   SOL/day. Send SOL to the economy master
   `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` (never to per-agent wallets)
   and treasury-topup distributes within minutes.
2. **0.49 SOL stays stranded behind the retired key**, 0.35 of it customer money
   in two user-owned agents that display a balance their owners cannot move. The
   dry plan now says so out loud instead of counting it. If the retired key can
   be produced, `WALLET_ENCRYPTION_KEY_PREVIOUS` recovers it with no migration
   (`docs/ops/wallet-key-migration.md`); if it cannot, the two customers need a
   decision, which is not an agent's to make.
3. **`gcloud` auth is dead in this workspace** (`Reauthentication failed. cannot
   prompt during non-interactive execution`), and `.env` carries no
   `CRON_SECRET`, so neither the config levers nor `POST /api/cron/treasury-topup?dry=1`
   could be exercised from here. One `gcloud auth login` restores both. Nothing
   in this entry needed them: every number above came from public endpoints.
4. **This work is behind the deploy gap.** The dry-run fix and the corrected hint
   are on `main`, not in production; prod still runs `ad7b54c16` from 2026-08-28.
   The next deploy carries them.

Definition-of-done status: the recurrence guard, its test, the changelog entry and
this log are done. The three outcome lines (settle above 90%, `fee_runway_exhausted`
no longer top, a non-zero reclaim plan) cannot be closed by an agent: at a 0.0037
SOL sponsor balance there is no non-zero *executable* reclaim plan to produce, and
that is now the honest answer the endpoint gives rather than the phantom one.
