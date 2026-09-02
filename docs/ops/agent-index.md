# Agent index: the crawl, its failure classes, and recovery

The agent index is what `/agents` and every agent profile read. Two crawls fill
it, and both are crons:

| Leg | Cron | Period | Cursor table | Code |
|---|---|---|---|---|
| Solana (leads) | `/api/cron/solana-attestations-crawl` | 10 min | `agent_event_cursor` | `api/_lib/solana-agent-events.js` |
| EVM (secondary) | `/api/cron/erc8004-crawl` | 15 min | `erc8004_crawl_cursor` | `erc8004CrawlChain` in `api/cron/[name].js` |

The Solana cron does two things in one tick: the attestation crawl first, then
`solanaEventSweep()`, which is the half that fills `agent_event_cursor`. Its
batch is `SOLANA_SWEEP_BATCH` and its wall-clock budget is `SOL_EVENT_BUDGET_MS`.

The freshness sensor is `api/_lib/ops/index-lag.js`. It reports on
`/api/healthz` and `/status` as `agent_index`, and reads only the cursor tables:
no RPC calls, because asking every chain for its head block on a public status
endpoint is both slow and a good way to get rate-limited.

## The one failure mode both legs share

**Our stored cursor points at history the provider no longer serves.** It is the
same bug on both chains, and it is silent by construction:

- Solana resumes each agent from the newest signature it saw, handed back as
  `getSignaturesForAddress({ until })`. That parameter is resolved against the
  answering node's own history, and the whole call fails with
  `Transaction <sig> not found` when that node does not have it. The lane router
  answers from whichever provider is not cooling and providers disagree about
  retention, so a cursor written by one lane is regularly unreadable by the next.
- EVM resumes at `last_block + 1`. A provider that has pruned that height answers
  `History has been pruned for this block`, and no smaller window fixes it,
  because the data is gone rather than the request being too wide.

In both cases the cursor is only written on the success path, so the next tick
presents the same dead value and gets the same error, forever. Nothing pages:
the crons catch per agent and per chain, so they keep returning 200 while the
directory quietly stops learning anything.

Both legs now recover on their own:
`api/_lib/solana/cursor-recovery.js` drops `until` and re-scans from the head,
and `isPrunedHistoryRejection()` skips the EVM cursor forward to the head. Both
are safe to replay, because every row lands through `on conflict do nothing`.

## Diagnose in three reads

```sh
# 1. What the sensor says, with its metrics.
curl -s https://three.ws/api/healthz \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(JSON.stringify(j.subsystems.subsystems.find(s=>s.name==="agent_index"),null,2))})'

# 2. Solana: group the cursors by error class. Signatures differ per row, so
#    normalize them away or every row looks like its own unique failure.
node --env-file=.env.local -e "import('./api/_lib/db.js').then(async({sql})=>{console.table(await sql\`select regexp_replace(error,'[1-9A-HJ-NP-Za-km-z]{32,}','<sig>','g') as shape, count(*)::int as n from agent_event_cursor where chain='solana' and error is not null group by 1 order by 2 desc limit 10\`);process.exit(0)})"

# 3. EVM: the cursors that have stopped moving, oldest first.
node --env-file=.env.local -e "import('./api/_lib/db.js').then(async({sql})=>{console.table(await sql\`select chain_id, last_block, head_block, blocks_behind, chunk_size, updated_at, left(coalesce(last_error,''),70) as err from erc8004_crawl_cursor order by updated_at asc limit 10\`);process.exit(0)})"
```

Production logs, when `gcloud` is authenticated:

```sh
gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="three-ws-api" textPayload:"solana-attestations-crawl"' \
  --freshness=24h --project aerial-vehicle-466722-p5
```

## Error classes and what each one means

| Class (from the grouped read above) | Meaning | Action |
|---|---|---|
| `failed to get signatures for address: Transaction <sig> not found` | The answering lane cannot resolve the stored cursor. | Self-healing. If a block of agents is already stuck, drain it with the recovery script below instead of waiting a full sweep cycle. |
| `solana rpc 429 @ <host>` | That lane is rate-limited. | Transient. The router cools the lane and retries; see [solana-rpc-lanes.md](solana-rpc-lanes.md) if it persists. |
| `solana rpc provider error -16401 @ <host>` | The lane gates this method behind a paid tier. | Per-method capability routing in `api/_lib/solana/connection.js`. Add the method to that lane's blocked set. |
| `fetch failed (…) @ <host>` | Transport fault on one lane. | Transient. Persistent means the lane is dead: drop it. |
| `agent_ref is not a Solana account key` | A directory row whose ref is not an account. | Never crawlable. It is recorded once rather than retried every tick. |
| EVM `has been pruned` | The provider dropped the blocks the cursor points at. | Self-healing: the crawl resumes at the head and reports the skipped span as `prunedSkip`. That span is a permanent gap; only an archive node can backfill it. |
| EVM `block range` / `response size` / `query returned more than` | The window was too wide. | Self-healing: `backoffChunkSize()` halves it in place and the width is persisted in `chunk_size`. |
| EVM `limit exceeded` | A plan or compute limit, **not** a range ceiling. | Shrinking does not help. Deliberately excluded from `isRangeRejection`. |
| EVM `HTTP 403 from <host>` | The last-resort keyless lane refused us. | Not recoverable in code. The chain needs a lane that answers from a datacenter IP; see the `rpcUrls` note in `api/_lib/erc8004-chains.js`. |

## Recovery: drain a wedged backlog now

```sh
node --env-file=.env.local scripts/heal-agent-event-cursors.mjs            # report by class, writes nothing
node --env-file=.env.local scripts/heal-agent-event-cursors.mjs --apply    # re-crawl every erroring agent
```

The sweep heals the same backlog on its own at one batch per tick; the script
exists so a large backlog drains in one pass rather than over a full cycle. It
is safe to re-run.

## How the sensor scores it

Solana leads, and here that is correctness rather than preference: a user
opening an agent profile reads the Solana index, so a secondary-chain cursor
that is months behind changes nothing they can see.

| Signal | Degraded | Down |
|---|---|---|
| Solana median cursor age | `SOLANA_LAG_DEGRADED_MIN` | `SOLANA_LAG_DOWN_MIN` |
| Solana cursors carrying an error | `SOLANA_ERROR_RATE_DEGRADED` | `SOLANA_ERROR_RATE_DOWN` |
| EVM worst cursor age | `EVM_LAG_DEGRADED_MIN` | `EVM_LAG_DOWN_MIN` |
| EVM worst backlog | `EVM_BLOCKS_BEHIND_DEGRADED` | `EVM_BLOCKS_BEHIND_DOWN` |

Read the numbers from `index-lag.js`; they are exported so nothing has to quote
them. Two rules shape the verdict:

- **An EVM-only fault caps at `degraded`.** Letting a stale secondary cursor
  drive the whole subsystem to `down` reports an outage no user is having, and
  it buries the Solana leg's real state.
- **The Solana error rate is scored, not just the cursor age.** The sweep stamps
  `last_indexed_at` on the failure path too (deliberately, so one unreadable
  account cannot hold the oldest-first queue head forever), which means a wedged
  agent looks exactly as fresh as a healthy one. Age alone cannot see this class.

`indexLagVerdict()` is pure and takes the metrics shape directly, so the
thresholds are exercised on synthetic metrics in `tests/agent-index.test.js`
rather than against a live database.

## Sweep cycle

A queue drained oldest-first sits at half its cycle time, so the median lag is
`sweepCycleMin(agents) / 2`. `sweepCycleMin()` derives the cycle from
`SOLANA_SWEEP_BATCH` and `SOLANA_SWEEP_PERIOD_MIN`, which means a directory that
outgrows its batch shows up as a number on the status surface instead of as an
unexplained median. Raising the batch costs one `getSignaturesForAddress` per
agent per tick; the real ceiling is `SOL_EVENT_BUDGET_MS`, not the constant, and
the sweep reports `truncated: true` when it runs out of budget mid-batch. Check
that flag before raising the batch again.
