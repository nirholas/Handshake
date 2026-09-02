# Agent index: the crawl, its failure classes, and recovery

The agent index is what `/agents` and every agent profile read. Two crawls fill
it, and both are crons:

| Leg | Cron | Period | Cursor table | Code |
|---|---|---|---|---|
| Solana (leads) | `/api/cron/solana-attestations-crawl` | 10 min | `agent_event_cursor` | `api/_lib/solana-agent-events.js` |
| EVM (secondary) | `/api/cron/erc8004-crawl` | 15 min | `erc8004_crawl_cursor` | `erc8004CrawlChain` in `api/cron/[name].js` |

The Solana cron does two things in one tick: the attestation crawl first, then
`sweepAgentEvents()`, which is the half that fills `agent_event_cursor`. Its
batch, its worker pool and its wall-clock budget are `SOLANA_SWEEP_BATCH`,
`SOLANA_SWEEP_CONCURRENCY` and `SOLANA_SWEEP_BUDGET_MS`, all three exported from
`api/_lib/solana-agent-events.js` beside the crawl they bound, because the
freshness sensor derives the index's cycle time from those same constants.

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
  because the data is gone rather than the request being too wide. A keyless node
  that serves recent blocks and answers older ones with
  `Archive requests require a personal token` has drawn the same wall behind a
  paywall, so `isPrunedHistoryRejection()` treats both as retention.

In both cases the cursor is only written on the success path, so the next tick
presents the same dead value and gets the same error, forever. Nothing pages:
the crons catch per agent and per chain, so they keep returning 200 while the
directory quietly stops learning anything.

Both legs now recover on their own:
`api/_lib/solana/cursor-recovery.js` drops `until` and re-scans from the head,
and `isPrunedHistoryRejection()` skips the EVM cursor forward to the head. Both
are safe to replay, because every row lands through `on conflict do nothing`.

Two things had to change before the EVM half could actually fire. `erc8004RpcCall`
now reads the JSON-RPC body **before** the HTTP status, because the providers that
gate archive ranges answer with a real error message under a 403 and throwing on
the status alone reduced it to `HTTP 403 from <host>`, which no predicate can
classify. And it now surfaces a retention diagnosis from **any** lane rather than
whichever error the LAST lane happened to return: on 2026-09-02 one chain's first
lane said plainly that the blocks were pruned while its final lane answered a
generic `limit exceeded`, the crawl saw only the second, and the chain sat stale
for eight days.

Skipping the wall closes the backlog, which is exactly why the skipped span is
banked on the cursor rather than only reported in the cron response: the moment
the cursor reaches the head the chain reports zero blocks behind and reads as
healthy. `erc8004_crawl_cursor.history_gap_blocks` accumulates every block the
crawl gave up on, `history_gap_to` names where the newest skip resumed, and
`history_gap_at` when. The sensor reports the total (`evm.historyGapChains`,
`evm.historyGapBlocks`) and deliberately never scores it: the gap is history that
is already lost, and scoring it would pin the subsystem red over something no
tick can fix. Only an archive provider for that chain can backfill it.

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
| EVM `has been pruned` / `Archive requests require a personal token` | The provider will not serve the blocks the cursor points at, whether it dropped them or paywalled them. | Self-healing: the crawl resumes at the head, reports the skipped span as `prunedSkip`, and banks it in `history_gap_blocks`. That span is a permanent gap; only an archive node can backfill it. |
| EVM `block range` / `response size` / `query returned more than` | The window was too wide. | Self-healing: `backoffChunkSize()` halves it in place and the width is persisted in `chunk_size`. |
| EVM `limit exceeded` | A plan or compute limit, **not** a range ceiling. | Shrinking does not help. Deliberately excluded from `isRangeRejection`. |
| EVM `HTTP 403 from <host>` | A lane refused us with no readable JSON-RPC body. | The body is read first now, so a bare status here means the lane returned nothing to classify. The chain needs a lane that answers from a datacenter IP; see the `rpcUrls` note in `api/_lib/erc8004-chains.js`. |

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
| EVM permanent history gap | reported only | reported only |

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
`sweepCycleMin(agents) / 2`, and the OLDEST agent waits a whole cycle. Both
numbers matter: a cycle longer than `SOLANA_LAG_DEGRADED_MIN` means part of the
directory is always stale by the sensor's own definition, even when the median
looks fine. `sweepCycleMin()` derives the cycle from `SOLANA_SWEEP_BATCH` and
`SOLANA_SWEEP_PERIOD_MIN`, so a directory that outgrows its batch shows up as a
number on the status surface instead of as an unexplained median.

The batch, not the budget, was the cap. Measured against the live lane router on
2026-09-02, one agent costs about 370 ms end to end, so a 120-second budget
drains roughly 320 agents serially and far more through the worker pool, while
the sweep was taking 120 per tick and leaving three quarters of its tick idle.
The 1,604-agent directory therefore cycled in 140 minutes against a 90-minute
threshold. Re-sizing it is a two-constant decision:

```
sweepCycleMin = ceil(agents / SOLANA_SWEEP_BATCH) * SOLANA_SWEEP_PERIOD_MIN
```

Keep that at or under `SOLANA_LAG_DEGRADED_MIN` with headroom for the directory
to grow, and keep `SOLANA_SWEEP_BATCH * 0.37s / SOLANA_SWEEP_CONCURRENCY` well
inside `SOLANA_SWEEP_BUDGET_MS`. `tests/agent-index.test.js` asserts both the
cycle and the concurrency ceiling, so an over-large batch fails the suite rather
than quietly truncating in production.

Concurrency is deliberately small. Every agent is one `getSignaturesForAddress`
plus its transaction reads, so the sweep spends nearly all its wall clock waiting
on the RPC and a small pool converts that into throughput; a wide fan-out earns
429s from the shared lanes faster than it earns signatures, and those show up
immediately in the sensor's error rate. The sweep reports `truncated: true` when
the budget runs out mid-batch, which is the signal that the batch has finally
outgrown the budget and the sensor's cycle number has become optimistic. Check
that flag before raising the batch again.
