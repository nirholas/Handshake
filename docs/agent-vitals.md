# Agent vitals: can it act?

Every liveness check three.ws had was correct, and none of them could tell us
that ten of twelve armed trading agents had not attempted an action in weeks.

`agent-vitals` is the answer to the question those checks could not ask: **not
"is it up" but "can it act right now, and if not, what is the one thing to
fix".**

- Engine (framework-agnostic, zero dependencies): [`packages/agent-vitals`](../packages/agent-vitals/README.md)
- three.ws wiring: [`api/_lib/agent-vitals/`](../api/_lib/agent-vitals/)
- Operator CLI: `npm run agent:vitals`
- HTTP: `GET /api/agents/vitals` (ops-gated)

## The failure it was built for

On 2026-08-28 an audit of the autonomous sniper fleet found twelve arms armed,
the worker `Ready:True` at `minScale: 1`, the launch feed streaming, and every
strategy row `enabled = true`. Ten arms had not attempted an entry in weeks.

Three unrelated things were wrong, and none was visible to anything we measured:

1. The deployed worker image predated commit `8f16c071b`, which moved every free
   LLM rung onto models that still exist. The whole chain answered `404`/`410`.
2. The providers behind the surviving rungs were out of credit (`402`) or on a
   GCP billing hold (`403`).
3. Several arm wallets could not fund a single entry.

Liveness measures the process. Acting needs a chain of preconditions the process
knows nothing about. The agents were healthy and structurally unable to work.

## The model

Preconditions are declared as **vitals** with `needs` edges between them, and
actions as **capabilities** that AND over vitals. Attesting the graph returns
the *root* blocker, never a symptom.

```
deploy-fresh ──> cognition ──┐
                             ├──> [enter]
armed, solvency, feed, rpc ──┘

rpc ─────────────────────────────> [exit]
```

Two things fall out of that shape and both matter:

- **`exit` deliberately depends on neither the feed nor a model.** When the
  model chain died, the fleet could still close its open positions. Collapsing
  that into one health bit would have told an operator their risk was stranded
  when it was not.
- **`deploy-fresh` only feeds `cognition` for an arm that actually uses a
  model.** A stale image is a hypothesis about why a model chain died, not by
  itself a reason an agent cannot act. Wiring it as a universal precondition
  reported an arm that had entered a position two minutes earlier, on that very
  image, as definitively unable.

## The vitals

| vital | reads | `down` means |
|---|---|---|
| `armed` | `agent_sniper_strategies` | the owner disabled it or engaged its kill switch |
| `solvency` | live wallet balance via `walletTradeState()` | the wallet cannot fund one entry at the executor's own sizing rule |
| `rpc` | `getSlot` on a Solana RPC | no endpoint is answering, so neither a quote nor a broadcast is possible |
| `feed` | the live pump.fun launch feed | no candidate seen in 30 minutes, an upstream outage rather than a quiet market |
| `deploy-fresh` | Artifact Registry image create time | the running image is over 7 days old and may predate current config |
| `cognition` | a real completion through `api/_lib/llm.js` | every rung of the provider chain failed |

`solvency` asks [`api/_lib/sniper-solvency.js`](../api/_lib/sniper-solvency.js),
which calls the executor's own `resolveEntrySize()`. Re-deriving that threshold
is how a report drifts into calling a wallet tradeable that the executor sits
out, which is the exact bug that module exists to catch.

## Reading the output

```
$ npm run agent:vitals

SHARED READINGS (taken once for the whole fleet)
  RPC        up  slot 442250266
  model      up  ovh answered across 3 configured rung(s)
  feed       newest launch at 2026-08-28 03:26
  image      built 2026-08-11

PER ARM

  Crosshair  [oracle-strict]  CAN ACT
    last entry attempt 2 min ago
    every precondition is up

  Swarm 9  [llm-claude]  CANNOT ACT
    last entry attempt 33 days ago  (STALLED)
    ROOT  deploy-fresh is down: worker image is 17 days old
          fix: gcloud builds submit --config workers/agent-sniper/cloudbuild.yaml ...
    (blocked downstream, not probed: cognition)

  Swarm 7  [rules-classic]  CAN ACT
    last entry attempt 55 days ago  (STALLED)
    every precondition is up: this arm is capable and its entry filters are simply not matching

WORK QUEUE (deduplicated across the fleet, widest blast radius first)
  solvency  blocks 5 arms: Nadirah, Boost Ride, Kimi Judge, Swarm 5, three
    send 0.0437 SOL to D5BGRDsX...rXypu
    ...
  deploy-fresh  blocks 4 arms: Kimi Judge, Swarm 2, Swarm 5, Swarm 9
    gcloud builds submit --config workers/agent-sniper/cloudbuild.yaml ...
```

Three things to notice:

- **CAN ACT + STALLED is the most useful line in the report.** Nothing is broken,
  so the arm's entry filters are the answer. That stops an operator hunting
  infrastructure that is already fine.
- **`(blocked downstream, not probed)`** means exactly that. A vital behind a
  known failure is never probed, because it would spend a timeout to rediscover
  something already known. In the outage that motivated this, that mistake made
  every decision walk ten dead provider rungs, which saturated the decision queue,
  which looked like a third independent fault.
- **The work queue is deduplicated by cause but not by fix.** One stale image is
  one redeploy; five starved wallets are five different transfers to five
  different addresses, so every distinct remedy is printed.

## Unreadable is never failed

A probe that throws, times out, or returns no verdict is `unknown`, and a
capability with an unreadable precondition is `null` (cannot say), not `false`
(cannot act). An unread balance is not a balance of zero, and one flaky RPC call
must not page someone to a healthy fleet.

This propagates through blocks: blocking on an *unreadable* dependency leaves
the capability `unknown`, and only a block tracing back to something genuinely
`down` makes it `unable`.

Concretely, running the CLI without Google credentials reports the image as
`unread` and the LLM arms as `UNKNOWN`, never as broken.

## When the model is wrong

A capability model is a model, and this one has been wrong. Every arm is
therefore checked against the position ledger: if the graph says `unable` and
the arm demonstrably attempted an entry within the last hour, the report prints

```
    CONTRADICTION  attested UNABLE but this arm attempted an entry 2 min ago:
                   the vitals model is wrong, not the arm
```

A health tool that cannot notice it is wrong will be trusted right up until it
matters.

## Commands

```bash
npm run agent:vitals                        # attest the mainnet fleet
node scripts/agent-vitals.mjs --json        # machine-readable
node scripts/agent-vitals.mjs --no-llm      # skip the model probe (it spends a few tokens)
node scripts/agent-vitals.mjs --network devnet
npm run test:agent-vitals                   # the engine's own suite
```

Requires `DATABASE_URL` (in `.env.local`). `SOLANA_RPC_URL` and Google
credentials are optional; without them those probes report `unknown`. The CLI
falls back to the `gcloud` CLI for the image reading when no platform credential
is present, because that reading is the one that closed the case.

## HTTP

`GET /api/agents/vitals?network=mainnet`, gated by `authorizeOps` (admin session
or `x-ops-secret`, never `CRON_SECRET`). The response names wallet addresses,
funding deficits and deploy commands, which is an operator view rather than a
public one.

The model probe sends a real completion, so it is **opt-in over HTTP**: pass
`llm=1`. This is a board an operator leaves polling, and a token spend per poll
is a bill nobody asked for. The CLI defaults the other way, because a human runs
it once. With the probe off, an arm that needs a model reports
`cognition: unknown`, which keeps its capability `unknown` rather than inventing
a pass.

## Related

- [docs/ops/trading-bot-report.md](ops/trading-bot-report.md) counts what the fleet did. This explains why it did not.
- [packages/agent-vitals/README.md](../packages/agent-vitals/README.md) is the engine, usable on any autonomous agent.
- [docs/ops/gcp-production.md](ops/gcp-production.md) is the deploy runbook the remedies point at.
