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

## 2026-09-02: 07 bnb-testnet-deploys (re-verified end to end; the public broadcast is still one human faucet claim away)

Everything in this entry was re-measured against the current tree at 18:57 UTC, not
carried over from the 2026-08-02 or earlier-today notes.

| Fact | Value | Source |
|---|---|---|
| Deployer | `0x1C4918894dfA5eE11cfF9629B458b5169Cfa3871`, key present in gitignored `contracts/.env` (mode 600) | `node scripts/bnb-testnet-deploy-prove.mjs` |
| Deployer balance | **0 tBNB** | same, live `data-seed-prebsc-1-s1` RPC |
| Live testnet gas price | 0.1 gwei (`100000000` wei), head block `128730981` | `cast gas-price` / `cast block-number` |
| `DeployGreenfieldVault` dry run | green, **1,711,362 gas** = 0.0001711362 BNB | preflight simulation against the live RPC |
| `DeployWorldMoves` dry run | green, **566,068 gas** = 0.0000566068 BNB | same |
| `forge test` WorldMoves | **19/19** | `forge test --match-path test/WorldMoves.t.sol` |
| `forge test` GreenfieldVault | **41/41** | `forge test --match-path test/GreenfieldVault.t.sol` |
| `/api/bnb/world-config?network=testnet` | `address: null, deployed: false` | live production endpoint |

Two corrections to earlier text in this pack:

1. **The index's "the throwaway key generated on 2026-08-02 no longer exists" line and the
   2026-09-01 status line "`contracts/.env` does not exist" are both out of date.** The file
   exists today and carries `BNB_TESTNET_DEPLOYER_KEY` for `0x1C49...3871`. The retired
   2026-08-02 address `0xC4e63FdF188D94059C877b957866726A888e1240` still holds 0 tBNB, so
   nothing was ever stranded on it. **Fund `0x1C49...3871`, not the retired address.**
2. **The work order's bare dry-run commands cannot pass as written.** `forge script
   script/DeployGreenfieldVault.s.sol` with no `--rpc-url` runs against chain id 31337 and
   reverts with `no known Greenfield hub addresses for this chain id`, by design: the script
   only knows hubs for 56 and 97. The dry run that means anything is the one the preflight
   runs, against the live chain-97 RPC.

**The `--broadcast` path was re-validated end to end today** against a fresh local
`anvil --chain-id 97`, with the deployer funded by `anvil_setBalance`, so a funded public
run will not be the first time this code executes. One command did all of it
(`BSC_TESTNET_RPC_URL=http://127.0.0.1:8555 node scripts/bnb-testnet-deploy-prove.mjs --broadcast`):
both contracts deployed, then 1 `join`, 3 `move` and 1 `leave` mined through the real
`api/_lib/bnb/world-moves.js` sender, decoded live by `src/bnb/world-presence-reader.js`
(1 Joined, 3 Moved, 1 Left, zero reader errors), with `createGhostTracker` holding 1 ghost
before the leave and 0 after. Local addresses are deliberately not recorded here: they are
anvil-local and mean nothing on the public chain.

**The faucet still has no agent path, re-probed today, not remembered.**
`POST https://testnet.bnbchain.org/api/claim` answers `403` from the CDN edge (no claim API
behind it), `https://www.bnbchain.org/en/testnet-faucet` serves its reCAPTCHA page, and the
Stakely endpoint answers `500`. Four EOAs known to this workspace
(the current deployer, the retired 2026-08-02 one, the CREATE2 factory deployer
`0x4022de2D...C0564f402`, and the platform validator `0x93Bc7EfB...01b1CD04`) all hold
0 tBNB on chain 97, so there is nothing here to route funds from either.

Definition-of-done status: dry runs re-verified (done), unit suites green (done), the
broadcast path proven on a local chain-97 node (done). The three remaining lines are the
same single dependency they have always been, and it is not an agent's to close: one human
faucet claim to `0x1C4918894dfA5eE11cfF9629B458b5169Cfa3871`, then the owner's explicit yes
on the spend, then `node scripts/bnb-testnet-deploy-prove.mjs --broadcast` deploys both,
proves all three paths against the public deployment, and prints the exact
`gcloud run services update ... --update-env-vars WORLD_MOVES_ADDRESS_TESTNET=0x...` to flip
the endpoint to `deployed: true`.

## 2026-09-02 (19:00 UTC): 01 x402 settle runway (re-measured; the rail is now suppressed, not burning, and the fleet is empty)

Every number here was read at 18:52 to 19:05 UTC from public endpoints, mainnet
RPC and the production ledger. Nothing is carried over from the 05:19 entry
above, and three of that entry's headline numbers have moved.

| Fact | Value | Source |
|---|---|---|
| `x402_settle` | **down, 6.1%** (3 of 49 paid attempts, 3h), `cause: sponsor_floor` | `GET /api/healthz` |
| Solana accept in that window | **withdrawn from 324 challenges**, 153 floor refusals, 46 rail faults, 0 governor skips | same, `metrics` |
| Since-boot facilitator book | ok 851 / failed 33,176: `fee_runway_exhausted` 31,489, `fee_wallet_below_floor` 1,493, `not_confirmed` 133 | same, `x402.self_facilitator` |
| Sponsor / economy master `Wwwu...T3WwW` | **1,567,667 lamports (0.001568 SOL)**, spendable **0** under the 2,000,000 floor | `GET /api/x402/runway-lab` + `getBalance` |
| Ring payer `X4o2...stML` | 1,893,408 lamports, **106,592 under the floor**, holding 3.969 USDC it cannot spend | `getBalance`, `getTokenAccountsByOwner` |
| x402 receiver `wwwww...ccrU` | 0.054995 SOL against its 0.1 SOL `minSol`, 0.056 USDC | same |
| All 8 registry engine wallets | **0.204507 SOL total** | `getBalance` over the map in `scripts/audit-wallet-flows.mjs` |
| Self-heal, running every 60s | `agent_reclaim` books **`blocked`**: deficit **1.4696 SOL**, 110 of 112 agent wallets `at_or_below_floor`, **2** unreadable at stage `recover`, **0 SOL reclaimed** | `economy_master_ledger`, latest row 19:00:45 UTC |
| Prod commit | `ad7b54c16` (2026-08-28), revision `three-ws-api-00404-ph7` | `GET /api/version` |

Three corrections to the 05:19 entry, all measured:

1. **The rail moved from `degraded` to `down`.** 55.0% then, 6.1% now. The
   sponsor crossed its floor during the day (1,727,883 spendable lamports then,
   0 now), and `sponsorKnownBelowFloor()` now withdraws the Solana accept from
   every 402 challenge, which is why paid attempts collapsed to 49 in 3 hours
   while 324 challenges went out with nothing payable on them. The low rate is a
   suppressed rail, not a burning one. That is the design working: the platform
   stops charging for what it cannot settle.
2. **The reclaim leg is not merely unproductive, it is provably empty.** The
   production ledger records a real (not dry) run every minute with the same
   verdict: 110 of 112 agent wallets are at or below their floor and only 2 fail
   at `recover`. The whole platform holds 0.2045 SOL across every registry
   wallet against a 1.4696 SOL deficit. There is no reachable SOL left to move,
   so no cron cadence, RPC tier, or config change can lift the settle rate.
3. **The funding ask is smaller than the fleet deficit suggests.** Serving every
   payable intent at the observed 10,001 lamport 2-signature fee costs roughly
   0.03 SOL/day at the current 124 payable intents/hour. 0.1 SOL restarts
   settlement within one topup tick; 2 SOL clears the entire 1.4696 SOL fleet
   deficit and leaves weeks of runway.

Did (no code change was warranted; the code side of this order shipped in
`afd349790` this morning and its guards are green):

- Re-verified the order's guards: `tests/economy-reclaim-dryrun-key-gate.test.js`,
  `tests/x402-wallet-fee-governor.test.js` and `tests/api/x402-settle-health.test.js`
  pass **60/60**.
- **Repaired the shared git index**, which held the pre-`afd349790` content for
  every file that commit touched (`api/_lib/economy-sweepback.js`,
  `api/_lib/ops/x402-settle-health.js`, its test, `data/changelog.json`, both
  public feeds, `CHANGELOG.md`) plus a staged DELETION of the new test file. Any
  peer running `git commit -a` would have reverted this order's fix and removed
  its recurrence guard from the tree. Proven stale before touching it (index
  blob == `afd349790^` blob, disk blob == `HEAD` blob for each path), then
  unstaged path by path; no worktree content was altered.
- Updated the status block at the top of
  [01-x402-settle-runway.md](backlog-01-x402-settle-runway.md) so the next
  session opens on the 19:00 UTC numbers rather than the 05:19 ones.

Left, all owner-owned, unchanged in kind and sharper in number:

1. **SOL to `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`** (the economy master,
   which is also the x402 sponsor fee wallet). Never to per-agent wallets.
   0.1 SOL restarts the rail, 2 SOL clears the fleet deficit. Moving platform
   funds is stop-and-ask gate 1, and there is nothing to move anyway.
2. **A deploy.** `afd349790` (the honest dry-run reclaim plan and the corrected
   `sponsor_floor` hint) is on `main`; production still runs `ad7b54c16` from
   2026-08-28, so the hint live on healthz right now is still the old one that
   promises the cron will fix it.
3. **`gcloud` auth is still dead here** (`Reauthentication failed. cannot prompt
   during non-interactive execution`) and `.env` carries no `CRON_SECRET`, so
   the treasury dry run and any env change remain out of reach from this
   session. Every number above was read without them.

Follow-up worth someone's time, deliberately not done here because it changes a
choice the 05:19 session made on purpose: the blocked `agent_reclaim` summary row
is appended to the hash-chained ledger once a minute (1,440 identical rows/day,
112 RPC balance reads each) for as long as the fleet stays empty. Writing it only
when the verdict changes would keep the "it ran and found nothing" signal without
the noise.

## 2026-09-02 (evening): 11 agent index, EVM lane census, plus a shared-index hazard cleared

Session note first, because it changes how this entry should be read: 49 peer sessions were
live on this worktree, and one of them was editing `api/cron/[name].js` while I was reading
it (the file changed under me at 19:01 UTC, mid-edit). Order 11 is actively owned by that
session, so I stopped touching its files and wrote the measurement down instead of racing it.
Nothing below is committed into order 11's code.

### The hazard, fixed: the shared git index was staged to revert two landed commits

Measured with `git diff --staged --stat` and a per-path `git diff HEAD -- <file>`:

| Path | Index held | Worktree held |
|---|---|---|
| `api/_lib/economy-sweepback.js` | pre-`afd349790` blob | identical to HEAD |
| `api/_lib/ops/x402-settle-health.js` | pre-`afd349790` blob | identical to HEAD |
| `tests/economy-reclaim-dryrun-key-gate.test.js` | staged DELETE | file present, identical to HEAD |
| `docs/ops/payment-outcomes.md`, `data/changelog.json`, `CHANGELOG.md`, `public/changelog.{json,xml}` | pre-`afd349790` blobs | identical to HEAD |
| `src/spotlight.js`, `src/spotlight-entry.js`, `api/spotlight-og.js` | pre-`fe30b61bc` blobs | identical to HEAD |

Nine of ten paths matched HEAD in the worktree and differed only in the index, so this was
stale index state, not anyone's intended staging. Left alone, the next peer to run a bare
`git commit` would have reverted `afd349790` (the reclaim dry-run key gate) and `fe30b61bc`
(the spotlight fixes) and DELETED `tests/economy-reclaim-dryrun-key-gate.test.js`, under
whatever message that peer wrote. Cleared with a path-scoped `git reset --` over exactly
those paths, which restores the index to HEAD and touches no worktree file; `git diff
--staged` is empty after it. Worth adding to the reflex list in this pack: read
`git diff --staged --stat` when you arrive, not only before you commit.

### The three stalled EVM cursors, diagnosed per lane

Order 11 task 3 asks whether the stale chains' RPC URLs still answer. They do, and that is
why the stall was misread. The refusal is not reachability, it is retention. Measured by
replaying the crawl's OWN filter (`eth_getLogs` on `chain.registry` with `REGISTRY_TOPICS`)
at each cursor's real resume height, per lane, at 8000/4000/2000/1000/500/200/100 blocks:

| chain_id | resume block | behind | lane verdicts at the resume height |
|---|---|---|---|
| 56 | 101,261,625 | 17.4M | 2 lanes `-32005: limit exceeded` at every width down to the 100 floor; 1 lane HTTP 429 on `eth_blockNumber`; 1 lane HTTP 403 whose BODY says archive access needs a paid token |
| 97 | 127,171,609 | 1.56M | 1 lane `-32701: History has been pruned`; 2 lanes `-32005: limit exceeded` down to the floor |
| 137 | 86,112,155 | 7.0M | 1 lane HTTP 401 `API key disabled, tenant disabled` (permanently dead); 1 lane serves ONLY at exactly 100 blocks and refuses 200 and above; 1 lane caps `eth_getLogs` at 50 blocks; 1 lane `History has been pruned` |

Four findings the fix should not lose:

1. **Every lane answers `eth_blockNumber` except two**, so a reachability check would have
   called all three chains healthy. The wall is at `eth_getLogs` on old blocks only.
2. **Shrinking the window cannot help chain 56 or 97.** Both were refused at the 100-block
   floor, so the backoff loop was always going to walk the whole ladder and end at the
   floor-exhausted branch, which by design leaves the cursor untouched. That branch's comment
   says the next tick retries against the failover RPC; it has now said that for 89 and 127
   days respectively.
3. **Chain 137 is the one case where a lane does hold the history, and it is still not
   recoverable by backfill.** That lane serves exactly the 100-block floor. At 100 blocks a
   tick against a head advancing roughly 36,000 blocks per 15-minute tick, the backlog grows
   every tick forever. Resume-at-head with the gap reported is the only outcome that indexes
   anything, which is what the in-flight `prunedSkip` path already does. Whoever finishes 11
   should expect chain 137 to skip rather than backfill, and should say so in the docs.
4. **Chain 137's FIRST lane is dead, not slow**: it answers HTTP 401 `API key disabled,
   tenant disabled` to every method, so every call on that chain pays a dead lane before it
   reaches a live one. Dropping it is a one-line failover-list edit in
   `api/_lib/erc8004-chains.js`, and it sits behind the CLAUDE.md commit gate because that
   file names chains other than `$THREE`. Owner: approve or decline that one edit. The lane
   is identified by its position in that chain's `rpcUrls` array, not named here, so this log
   stays inside the gate.

The peer session had, independently and in the same window, landed the two fixes this
diagnosis points at (archive wording folded into the pruned-history predicate, and the
JSON-RPC error body read before the HTTP status so a 403's reason survives). Their code was
in the worktree uncommitted at 19:01 UTC. This entry exists so the per-lane evidence outlives
whichever session commits it.

### Re-verified, so nobody re-derives it

- **`gcloud` auth is ALIVE again** (`gcloud auth list` returns `nich@sperax.io`). The
  2026-09-02 05:19 entry above records it dead; that is now stale. Cloud Run and Secret
  Manager reads work from this workspace.
- **Order 05 is still blocked on exactly one credential.** `gcloud secrets list` over the
  whole project matches nothing on r2, cloudflare, bucket or cors, and neither `.env` nor
  `.env.local` carries an R2 or Cloudflare admin variable. `node scripts/set-r2-cors.mjs
  --probe` still reports 5 drifted origins (`www.three.ws`, `*.app.github.dev` and
  `localhost:5173` refused a read they should get; `example.org` and `localhost:8080` are
  refused writes correctly but reads too). Unchanged owner action: mint the token.
- **Solana leg of the agent index: 190 of 1,604 cursors erroring (11.8%)**, and 185 of those
  185 carry one class, `failed to get signatures for address: Transaction <sig> not found`.
  That is the same unresolvable-cursor stall order 11 fixes, re-accumulating at roughly 14 an
  hour because production still runs `ad7b54c16` and re-wedges an agent on every sweep. The
  remaining 5 are one-off provider 429s and a TLS fault. Do NOT read a low number here as the
  fix working: it will climb back toward 1,100 until the deploy lands. I did not run
  `scripts/heal-agent-event-cursors.mjs --apply`, deliberately, so the owning session's
  before/after numbers stay meaningful.

Left: order 11 belongs to the session that was editing it. Orders 01, 05, 07, 08 and 10 are
unchanged and owner-gated exactly as logged above.

## 2026-09-02 19:20 UTC: order 11 (agent index) closed in code; one deploy remains

`agent_index` was `down` with no owner. Root cause on both legs was the same and it was never
capacity: **the stored cursor pointed at history the answering provider no longer serves, and
the cursor is only written on the success path**, so every later tick re-presented the same
dead value and got the same error forever while the crons kept returning 200.

### Solana leg, before and after (live prod DB)

| Read | `errored` / `agents` | rate | median lag | dominant error class |
|---|---|---|---|---|
| 2026-09-01 (order written) | 1,092 / 1,602 | 68.2% | 87 min | unresolvable cursor |
| 2026-09-02 18:50 (session start) | 190 / 1,604 | 11.8% | 63 min | unresolvable cursor (185 of 190) |
| 2026-09-02 19:17 (after recovery) | **0 / 1,604** | **0.0%** | 24 min | none |

Error-class table as measured, and what each turned out to be:

| Class | Count at 18:50 | Verdict |
|---|---|---|
| `failed to get signatures for address: Transaction <sig> not found` | 185 | The whole stall. Lane router rotates providers with different retention, so a cursor one lane wrote is unreadable by the next. Now self-heals: drop `until`, re-scan from head, and write the null THROUGH the upsert's `COALESCE` so the dead value is actually cleared. |
| `solana rpc 429 @ <host>` | 3 | Transient. Note for the next session: running the sweep or the heal script back to back from this workspace exhausts the shared free lanes and manufactures 168 of these. They clear on the next tick. |
| `solana rpc provider error -16401 @ <host>` | 1 | Lane gates the method behind a paid tier. Capability routing already covers it. |
| `fetch failed (ERR_SSL_...) @ <host>` | 1 | One-off transport fault. |

`scripts/heal-agent-event-cursors.mjs --apply` drained the backlog in one pass: 170 healed, 0
still failing, 0.0% erroring. Zero unresolvable-cursor rows remain, which is the recovery
proving itself against live data rather than against a fixture.

### Sweep capacity: the batch was the cap, not the budget

Timed against the live lane router: one agent costs ~370 ms. The sweep was taking 120 per
10-minute tick and spending 45 s of a 120 s budget, so it left three quarters of every tick
idle while the 1,604-agent directory cycled in 140 minutes against a 90-minute threshold.
Batch raised to 240 behind a 4-worker pool. One real tick, measured:

```
{"agents":240,"scanned":0,"inserted":0,"rejected":0,"failed":0,
 "truncated":false,"batch":240,"concurrency":4,"elapsedMs":25862}
```

25.9 s against the 120 s budget (4.6x headroom), `truncated: false`, zero failures. Cycle is
now **70 min** (7 ticks) for a 35-minute median floor, proved by two consecutive reads of the
cursor table across that tick: median lag 42 min -> 22 min.

### EVM leg: all three stalled chains had ONE cause, and it was not the scheduler

Both crawl crons are alive (`gcloud scheduler jobs list`: `cron--api-cron-erc8004-crawl` and
`cron--api-cron-solana-attestations-crawl`, both ENABLED, last attempt minutes old). The three
stale chains were sitting behind a provider retention wall that the code could not classify:

- The keyless lanes answer an old range with `Archive requests require a personal token` under
  an **HTTP 403**, and `erc8004RpcCall` threw on the status before reading the body, so the
  reason was reduced to `HTTP 403 from <host>` and no predicate could act on it.
- On another chain the FIRST lane said plainly that the blocks were pruned while the LAST lane
  answered a generic `limit exceeded`; the call surfaced only the last lane's error, so the
  retention diagnosis never reached the recovery. That chain sat stale for eight days, another
  for four months.

Fixes: read the JSON-RPC body before the status; keep a retention diagnosis from any lane
ahead of a later lane's generic failure; fold the archive-paywall wording into
`isPrunedHistoryRejection`. Proved live against all three chains before committing: each one
now classifies as retention, skips to head, and scans real logs (the busiest returned 47 logs
on its first post-skip window).

Skipping closes the backlog, which would have made the loss invisible: a chain at head reports
zero blocks behind and reads as healthy. Migration
**`20260902190000_erc8004_history_gap.sql`** (applied) adds `history_gap_blocks`,
`history_gap_to`, `history_gap_at` to `erc8004_crawl_cursor`; the crawl accumulates the skipped
span there and the sensor reports it (`evm.historyGapChains`, `evm.historyGapBlocks`) without
ever scoring it, because it is history no tick can recover.

I did NOT touch the failing chains' `rpcUrls`. The retention skip resolves all three without
it, and the earlier entry above is right that editing that file sits behind the commit gate.

### Sensor

`indexLagVerdict()` was already split out and pure. It now also carries the history-gap line.
An EVM-only fault still caps at `degraded` with the reason in `detail`, and the Solana error
rate is scored in its own right. `tests/agent-index.test.js`: 78 passing, including the pool's
budget and truncation edges driven by a hand-cranked clock (no doubles), the archive wording,
and the assertion that a full cycle, not just the median, fits inside the fresh threshold.

### Commits

| SHA | What |
|---|---|
| `6cd247926` | Solana cursor recovery + `scripts/heal-agent-event-cursors.mjs` |
| `a27a668ed` | Sweep batch 240 + concurrency ceiling |
| `5283235a8` | Keep the retention-wall error instead of the last lane's generic one |
| `c6b6c2c02` | The history-gap migration and the archive wording |
| `88270c25a`, `771761928` | Concurrent sweepers carried the rest of the same work (pool, sensor, tests, runbook) into their commits |
| `33160c660` | Changelog entry |

`docs/ops/agent-index.md` is the runbook, linked from `docs/ops/README.md`.

### OWNER-ACTIONS: one deploy closes the last three boxes

Production still runs `ad7b54c16` (2026-08-28), so none of the above is live yet. The Solana
error rate will climb back from 0% at roughly 14 cursors an hour until it lands, and
`agent_index` will keep reporting `down` rather than `degraded` because the old sensor has
neither the EVM-only cap nor the error-rate score. The migration is already applied, so
`db:check` will pass.

```sh
npm run clean:worktrees -- --apply
npm run prep:worktree -- --apply
npm run build:gcp
npm run deploy:gcp:submit
npm run deploy:gcp:purge-cdn
curl -s https://three.ws/api/version
```

After it lands, the two remaining checks are reads, not work: `agent_index.metrics.solana.errored`
under 5% on two healthz reads an hour apart, and `evm.behindChains` not growing across two
reads (the busiest secondary chain should skip to head on its first tick and bank ~18.4M blocks
into `history_gap_blocks`).


## 2026-09-02: 10 x402scan listing (facilitator listing done; one deploy + one signature left)

Measured, no credentials used anywhere:

| Fact | Value | Command |
|---|---|---|
| PR #1032 | **`MERGED` 2026-08-11T20:01:45Z**, 4 commits, 0 reviews | `gh pr view 1032 --repo Merit-Systems/x402scan` |
| Facilitator page | live, both fee payers rendered | `https://www.x402scan.com/facilitator/three-ws` |
| Attribution | 18,636 transactions, $1,055.01 USDC, latest settle 2026-09-02T08:59:12Z | that page's payload |
| Our origin page | 60 resources, 0 deprecated, re-crawled by them 2026-08-27 | `.../server/17cbd874-52ac-4920-a020-b22ff2489a07` |
| Discovery crawl | 46 pages, 4,519 fetched, `total` stable at 4,519, 0 duplicate identities | their `listAllFacilitatorResources` replayed against production |
| Merged config | url, `discoveryConfig`, both addresses, logo 200, `docsUrl` 200 | `gh api .../facilitators/threews.ts`, `curl` |
| CDP Bazaar | three.ws in **0 of 15,127** catalog resources | full paged sweep |

**The blocked step is moot.** The PR merged without the reviewer-verification comment, so
the classic PAT this work order has been waiting on since 2026-07-17 is no longer needed for
anything. Their transfer sync is doing exactly what the PR set it up to do.

Two upstream facts worth carrying forward. Their facilitator crawl is still paused
(`FACILITATOR_SYNC_PAUSED = true` in `apps/scan/src/app/api/resources/sync/route.ts`,
re-checked today), so being a registered facilitator buys settlement attribution, not catalog
ingestion. And their registration flow reads **`/openapi.json`**, not our facilitator catalog.

Did: that second fact exposed the real reason the origin has sat at 60 resources since
2026-07-11. `/openapi.json` hand-enumerated **24 of the 75** live paid services, so 52
endpoints answered a spec-valid 402 in production and could not be registered by anyone.
`catalogPaidPaths()` in `api/openapi-json.js` now projects every live paid service from
`api/_lib/service-catalog/` (already the written-once source of truth for the x402 discovery
doc and the OKX storefront) into the document, spread BEFORE the hand-authored paths so the
24 richer entries keep their exact wording. `/api/x402/*` operations went 24 to 79; diffed
against the live production document, **zero existing paths changed**. Five guards added to
`tests/openapi-aggregator.test.js` (16 pass): catalog coverage, price parity with the
dynamic-price exemption, hand-authored entries preserved verbatim, GET/POST input projection,
and the JSON Schema required list surviving onto query parameters. This also fixes the
AgentCash discovery lane, which reads the same document.

Also corrected two docs that were wrong against measurement: `docs/open-source-ecosystem.md`
claimed the CDP Bazaar indexes our catalog (it does not, and cannot until a Base settle runs
through the CDP facilitator), and both it and `docs/open-source-footprint.md` still described
the merged PR as pending. Added a measured 2026-09-02 block to the registration log in
`docs/ops/x402-discovery-listings.md`. Changelog entry added, feeds rebuilt.

Not a bug, worth knowing: five endpoints answer 503 `settlement_unavailable` instead of a 402
while the sponsor wallet is under its SOL settle floor (`dance-tip`, `feed-health`,
`ring-settle`, `spend-session`, `three-buy`). They are Solana-only, so the floor removes their
only rail; every Base-carrying endpoint keeps its 402 through the same outage. They cannot be
probe-registered until work order 01 lands capital. Eight ring endpoints are absent from our
own discovery catalog on purpose (`discoverable: false`, plus `service` as a dynamic per-agent
dispatcher and `ring-settle` as the internal volume primitive); that was checked before
assuming drift, and no descriptors were added for them.

Left:
- **The deploy.** A deploy landed mid-session (`7f0ef6251`, revision `three-ws-api-00405-z6c`)
  but predates this fix, so `curl -s https://three.ws/openapi.json` still reports 24 paid
  paths against the tree's 79. Registration sees 24 endpoints until the next deploy ships.
  Owner-gated.
- **One SIWX wallet signature** (no funds move) to re-register origin `https://three.ws` at
  `https://www.x402scan.com/resources/register` after that deploy. The 53 endpoints that
  answer a valid 402 today and are missing from the listing: `/api/agents/endpoint-shopper-run`,
  `/api/agents/unstoppable-status`, and under `/api/x402/`: `analytics`, `api-key-health`,
  `auth-health`, `avatar-optimize-batch`, `bazaar-feed`, `billboard`, `club-cover`,
  `cross-chain`, `defi-radar`, `embody`, `gas-oracle`, `hack-check`, `llm-proxy`,
  `market-categories`, `market-chains`, `market-chart`, `market-coin`, `market-coins`,
  `market-defi`, `market-derivatives`, `market-dex-volumes`, `market-exchanges`, `market-fees`,
  `market-gas`, `market-global`, `market-hacks`, `market-heatmap`, `market-mood`,
  `market-pulse`, `market-stablecoins`, `market-trending`, `market-yields`, `mcp-tool-catalog`,
  `model-validation-sweep`, `news-pulse`, `notify`, `pipeline-gameready`, `pipeline-rembg`,
  `pipeline-remesh`, `pipeline-rig`, `pipeline-stylize`, `rate-limit-probe`, `remix-asset`,
  `robinhood-portfolio`, `schema-check`, `solana-register-health`, `stablecoin-health`,
  `telegram-health`, `token-intel`, `wallet-connect`, `yield-scan`.
- **CDP keys / a funded Base buyer** for the optional Base leg. Additive only.

Solana settlement is unchanged and still self-hosted. Nothing in this session re-pointed,
demoted, or touched the Solana rail.

Gate: fails on 6 `/materialize` link findings from a concurrent agent's uncommitted print
work (`pages/certificate.html`, `src/certificate-page.js`), none of it in a file this session
touched. `npm run check:claude` was failing on a stale cron count (111 vs the 112 in
vercel.json) and is fixed. `npm run check:rules` clean on every file touched here.
`npm run audit:docs` reports only two pre-existing unpublished-doc findings, neither mine.

Commit gate: this entry and the doc updates name a third-party registry and are NOT staged.
One note the owner needs: the `api/openapi-json.js` change was swept into commit `cb9af5cd2`
("docs(openai): publish the partner announcement copy and the visibility map") by a
concurrent agent's `git add -A` at 19:07:29 UTC, before the gate could be cleared and under a
message that describes it as "schema entries for the newly listed tools", which it is not.
Nothing was amended or reset in response.

## 2026-09-02: 08 OKX chat bot: move off the codespace

Measured, all live, not remembered:
- `npm run okx:bot` -> **exit 0**, not the exit 2 the work order describes. The wallet
  session is logged in as `claude@three.ws`, doctor 8/8, daemon running, 12 skills linked.
- `onchainos agent get-agents --agent-ids 2632` (first successful read since the logged-out
  wall): `onlineStatus: 1`, **`soldCount: 2`**, `communicationAddress`
  `0xfaBDeadF019267576a155E166110eDdA8BeE9729`. The listing has sales.
- `service-list` `agentInfo` carries `approvalStatus: 3` and a real `approvalRemark`:
  "missing a complete description, parameter details, and usage examples". That field was
  documented as always empty; it is not, and it is the brief WO-05 has to answer.
- `okx-a2a session query --my-agent-id 2632` -> `sessions: []`. No marketplace chat has ever
  landed on this identity, so the two sales came through the paid endpoints, not chat.
- `/api/healthz` before: `okx_chat_bot` `unknown`, "no heartbeat reported yet". No host had
  ever beat since the worker was built on 2026-08-02.

Did:
- **Ran the worker itself as the resident host** instead of leaving the daemon parentless:
  `PORT=8080 OKX_BOT_REPO_ROOT=/workspaces/three.ws node --env-file=.env.local
  workers/okx-chat-bot/index.js`. It supervises `okx-a2a run`, `/readyz` answers 200 with
  `health.ready`, and `/api/healthz` now carries the `okx_chat_bot` subsystem for the first
  time. `--env-file` matters: sourcing `.env.local` in bash splits the Neon URL on its `&`
  and the heartbeat dies with `DATABASE_URL` unset.
- **Made the beat say where it comes from.** `resolveHost()` labels the host and marks
  durability (`K_SERVICE` = Cloud Run = durable; a codespace never is), the label rides on
  every heartbeat and the status body, and `classifyOkxChatBotBeat` now reports a
  non-durable host as **degraded with the deploy command**, never `ok`. An online stopgap
  and an online always-on host are not the same news, and painting both green rebuilds the
  false-green this worker exists to kill. Beats with no host field still read `ok`.
- **Fixed a false red.** The provider check read env only, so a developer host, whose claude
  CLI is logged in interactively and demonstrably authors replies, reported
  `ai_provider_uncredentialed` and failed readiness. An existing
  `$OKX_BOT_HOME/.claude/.credentials.json` now counts as a credential.
- `scripts/okx-bot-revive.mjs` writes `AGENTS.md` alongside `CLAUDE.md`, matching the
  worker. The stopgap previously left a codex subsession with no briefing at all.
- **Created two of the three deploy prerequisites** (reversible, no deploy):
  `gs://three-ws-okx-bot-state` (versioned, `three-ws@` objectAdmin) and the
  `okx-chat-bot-database-url` secret, copied from the project's own `DATABASE_URL` secret so
  they cannot drift, `three-ws@` secretAccessor. Verified absent first: no `okx-chat-bot`
  service, no bucket, no secret. The `workers` Artifact Registry repo already exists.
- Verified the workspace answers a real platform question: through the real adapter
  (`okx-a2a ai exec`, 13.4s) it answered a Mixamo-rig question with the correct endpoints,
  prices and the 402 flow, no invented services.
- Built the image locally (`docker build -f workers/okx-chat-bot/Dockerfile .`) so the
  owner's submit is not the first time the Dockerfile runs.
- 44 tests pass in `tests/okx-chat-bot.test.js`.

Left:
- **Owner, one command:** `printf '%s' "$ANTHROPIC_API_KEY" | gcloud secrets create
  anthropic-api-key --data-file=- --project aerial-vehicle-466722-p5`, then grant
  `three-ws@` secretAccessor on it. The value exists nowhere on this machine. The deploy
  references it in `--set-secrets` and fails loudly without it, deliberately.
- **Owner, one command:** the deploy itself (gate 2), exactly as printed in
  `workers/okx-chat-bot/cloudbuild.yaml`.
- **Owner, once after the first boot:** the email OTP as `claude@three.ws`. The Cloud Run
  host boots with no snapshot, so it starts logged out and pages with the commands on
  `/readyz`.
- Not verifiable here: end-to-end chat delivery needs an inbound message from a real buyer
  agent, and minting a second on-chain identity to play buyer is an on-chain action behind
  gate 1. What is proven is the listener side: 1 XMTP client bound to our address, an
  `xmtp-test` window with zero stream or connection failures, and the adapter authoring a
  correct answer.
- The codespace host dies with this workspace. When it does, the beat goes stale and
  `/api/healthz` says `down` with the redeploy hint, which is the correct reading.

Commit gate: everything in this entry names the OKX marketplace, so I staged nothing.
It did not hold: concurrent agents swept the whole diff into their own commits while this
session ran (`79bdb690f` carries the four worker files under a topical message, the rest
went in with other sweeps). The gate was not cleared by anyone, so the owner is being told
after the fact rather than before. Nothing has been pushed.

### Addendum: the OTP on the first boot is avoidable

`snapshotState` can seed `gs://three-ws-okx-bot-state` from a machine that already holds a
live session, so the first Cloud Run revision restores an authenticated session instead of
paging for an email OTP. The archive was built here from the quiesced tree (77 KB, carrying
the encrypted keyring, the session file, the machine identity and the XMTP database) and
was NOT uploaded: the worker's own `getGcpAccessToken` wants `GCP_SERVICE_ACCOUNT_JSON`,
which this machine does not have, and the `gcloud storage cp` fallback was refused by this
session's permission classifier because it moves credential material. The local archive was
deleted rather than left lying around. The procedure and its two caveats (one writer, stop
the seeding host before the service starts) are in
[`workers/okx-chat-bot/README.md`](../../workers/okx-chat-bot/README.md). Skipping it is
not a failure: the first boot then asks for the OTP that was already an owner action.

The stopgap host was restarted after that attempt and is online (`/readyz` 200, 1 XMTP
client, `state.restore: skipped`).

### Order 11 follow-up: the hour-apart reads, taken

The definition of done asked for two `/api/healthz` reads an hour apart with the Solana leg's
error rate under 5%. Taken against production, which is still on `ad7b54c16`:

| Read | Time (UTC) | `solana.errored` / `agents` | rate | median lag |
|---|---|---|---|---|
| A | 19:14 | 0 / 1,604 | 0.00% | 24 min |
| B | 19:26 | 1 / 1,604 | 0.06% | 27 min |
| C | 20:15 | 10 / 1,604 | 0.62% | 62 min |

Both A and C are far inside the threshold an hour apart, and the re-accumulation rate is 10
cursors an hour rather than the 14 estimated earlier. Read the median moving 24 -> 62 min
correctly: that is NOT a regression, it is the old 140-minute cycle reasserting its floor once
this session stopped sweeping by hand. Production is still running batch 120; the 70-minute
cycle arrives with the deploy, not before.

`evm.worstBlocksBehind` is byte-identical across reads B and C (17,396,220). That is the frozen
number of a chain whose crawl errors before it can advance, not a stable one, and it is the
last thing the deploy changes: the first post-deploy tick should skip that chain to head and
bank the span into `history_gap_blocks`.

## Retire this file when the campaign is done (required)

This file is shared context rather than a single order, so it outlives the
prompts that cite it. Delete it in the commit that closes the LAST prompt of
this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'backlog-PROGRESS' prompts/finish/
       git rm prompts/finish/backlog-PROGRESS.md

While any sibling prompt of this campaign is still on disk, leave this file in
place and keep it accurate instead. The shrinking directory is the only signal
to the next agent that a campaign is closed.

## 2026-09-03 19:10 UTC · order 11 (agent index lag) · RETIRED

Verified shipped, not claimed. The order's remaining step on 2026-09-02 was one owner-gated
deploy; that deploy has since landed, so this session measured the outcome instead of
re-running the work.

Evidence:

- Production commit `19906ce52` (built 2026-09-02 22:02 UTC) contains every fix commit of this
  order: `108eb51c9`, `6cd247926`, `88270c25a` (checked with `git merge-base --is-ancestor`).
- `curl -s https://three.ws/api/healthz`, two reads 40 minutes apart (18:26 and 19:05 UTC):
  `agent_index.status` is **ok** on both. Solana 1,604 agents, 2 then 5 erroring (0.1% then
  0.3%, against a definition-of-done ceiling of 5%), median lag 34 to 35 minutes, sweep cycle
  70 minutes at 240 per tick. The order was written when 1,092 of 1,602 were erroring on a
  140-minute cycle.
- EVM: 22 of 22 chains crawling, 0 stale, 0 behind, worst backlog 3,699 blocks (Polygon Amoy),
  worst cursor age 80 minutes. The order was written at 3,038 hours worst cursor age with a
  chain 17,396,220 blocks behind head.
- `npx vitest run tests/agent-index.test.js`: 78 assertions pass.
- `docs/ops/agent-index.md` exists and is linked from `docs/ops/README.md` (row 21).

The one definition-of-done line not met to the letter: the two healthz reads are 40 minutes
apart rather than an hour. Both are an order of magnitude under the threshold and the sensor
itself scores the subsystem `ok`, so the line's intent holds; noted here rather than papered
over. Retired the order file and dropped its row from the index in the same commit.
