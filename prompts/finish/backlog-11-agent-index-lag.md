# 11. Agent index: bring the on-chain crawl back from `down`

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/backlog-11-agent-index-lag.md`". Read
[00-INDEX.md](backlog-00-INDEX.md) and `CLAUDE.md` first.

Written 2026-09-01 because `curl -s https://three.ws/api/healthz` reported `agent_index`
**down** and no work order, issue, or owner row owned it. Measured that day: Solana median
lag 87 minutes across 1,602 agents with **1,092 erroring** on a 140-minute sweep cycle at
120 per tick; EVM worst cursor age 3,038 hours across 22 configured chains, 3 stale, 1
behind head by 17,396,220 blocks (the chain is named in `metrics.evm.worstChainName`), and
the sensor's own hint: a backlog that keeps rising means the RPC is rejecting ranges
(`erc8004_crawl_cursor.last_error`) or the cron is cut short by its budget.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. Delete this file when the
   definition of done is verified and log the outcome in [PROGRESS.md](backlog-PROGRESS.md).
2. Solana first: the Solana crawl serves the agent profiles users actually open. Fix its
   error rate before touching any EVM cursor.
3. Config-only `gcloud run services update --update-env-vars` and Cloud Scheduler edits are
   pre-approved; never `--set-env-vars`. No funds move in this order.
4. Hard rules: no mocks, explicit-path commits, no em-dash characters,
   `npm run check:rules -- --paths <files you touched>` before every commit.
5. This order names no crypto project other than `$THREE`; keep it that way in the files you
   commit (chain names belong in runtime data, not in the diff).

## Step 0: re-derive the state

```bash
curl -s https://three.ws/api/healthz | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(JSON.stringify(j.subsystems.subsystems.find(s=>s.name==="agent_index"),null,2))})'
node --env-file=.env.local -e "import('./api/_lib/db.js').then(async({sql})=>{console.log(await sql\`select last_error, count(*) from agent_event_cursor where last_error is not null group by 1 order by 2 desc limit 10\`);console.log(await sql\`select chain_id, last_indexed_block, updated_at, last_error from erc8004_crawl_cursor order by updated_at asc limit 10\`);process.exit(0)})"
grep -n '"path": "/api/cron/solana-agents-crawl"\|"path": "/api/cron/erc8004-crawl"' -A2 vercel.json
```

The sensor is `api/_lib/ops/index-lag.js` (`gatherIndexLagHealth`); the crawls are
`api/cron/solana-agents-crawl.js` and `api/cron/erc8004-crawl.js`, with batch and period
constants in `api/_lib/solana-agent-events.js` and the chain table in
`api/_lib/erc8004-chains.js`. Production logs, once `gcloud` is alive:
`gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="three-ws-api" textPayload:"solana-agents-crawl"' --freshness=24h --project aerial-vehicle-466722-p5`.

## Tasks

1. **Classify the 1,092 Solana errors** from `agent_event_cursor.last_error` (if the column
   does not carry the reason, add it in a new migration under `api/_lib/migrations/` and
   record it from the crawl). Expect three classes: RPC refusals from a lane that blocks a
   call shape (`api/_lib/solana/connection.js` already routes per-method capability; make
   the crawl use it), accounts that no longer exist (retire them from the sweep instead of
   erroring every cycle), and genuine transient failures (retry with backoff, and stop
   counting a retried success as an error).
2. **Size the Solana sweep to its budget.** 1,602 agents at 120 per tick is a 140-minute
   cycle; the sensor's `down` threshold is in `index-lag.js`. Either raise the batch inside
   the cron's time budget or split the sweep across two scheduler slots; prove the new cycle
   time from two consecutive `last_indexed_at` reads.
3. **EVM cursors.** For the one chain behind head, read `last_error`; if the RPC rejects the
   block range, shrink the window per attempt and persist the shrink so it does not reset
   every tick. For the three stale chains, confirm the scheduler job still runs (needs
   `gcloud`; if auth is dead, revive it per the CLAUDE.md playbook) and that their RPC URLs
   still answer `eth_blockNumber`.
4. **Make the sensor tell the truth.** `agent_index` should report `degraded`, not `down`,
   while Solana is fresh and only EVM cursors lag; users never see EVM lag on a Solana
   profile. Adjust the status logic in `index-lag.js` with a unit test on synthetic metrics.
5. **Docs.** Add the crawl cycle, the error classes and the recovery commands to
   `docs/ops/` next to the existing runbooks (there is no agent-index runbook yet; create
   `docs/ops/agent-index.md` and link it from `docs/ops/README.md`), plus a
   `data/changelog.json` entry with tag `fix` if any user-visible profile data was stale.

## Definition of done

- [ ] `agent_index.metrics.solana.errored` under 5% of `agents` on two healthz reads an hour apart.
- [ ] Solana `sweepCycleMin` at or under the sensor's fresh threshold, read from the sensor.
- [ ] No EVM chain reports `behindChains` growing across two reads; stale chains either crawl again or are removed from `erc8004-chains.js` with the reason in the commit.
- [ ] `agent_index.status` is `ok` or, if only EVM lags, `degraded` with the reason in `detail`.
- [ ] New tests pass; `npm test` green; `check:rules` exits 0 on touched files.
- [ ] `docs/ops/agent-index.md` exists and is linked; PROGRESS.md entry written.

## Never blocked

| Blocker | Resolution (act, do not ask) |
|---|---|
| `DATABASE_URL` missing | It is in `.env.local`; run node with `--env-file=.env.local`. |
| `gcloud` auth dead | Revive it in-session per the CLAUDE.md playbook. If it cannot be revived, finish every code task, write the exact scheduler and log commands into PROGRESS.md, and add one OWNER-ACTIONS row for the read. |
| A paid RPC lane is in cooldown | The lane router exposes `recoversIn`; route the crawl through the router rather than a fixed URL, and let it wait. |
| The chain behind head is one this repo treats as secondary | Solana first still applies: finish tasks 1, 2 and 4 before 3, and never let the EVM leg reframe the Solana work. |

## Report format

Before/after `agent_index` metrics with timestamps, the error-class table with counts, the
migration name if one was added, the files changed, and the commit SHAs. No trailing
questions.
