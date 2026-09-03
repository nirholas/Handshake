# 14. Reliability and the scale envelope

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Orders
[02](home-02-bridge-runtime.md), [03](home-03-api-surface.md) and
[13](home-13-observability.md) must have landed.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**Measure, then state. Never assume a number.**

---

## Step 0: re-derive the current state

```bash
node -e "import('./api/_lib/home/runtime.js').then(m=>console.log(Object.keys(m)))"
gcloud run services describe three-ws-api --region us-central1 --format=yaml 2>/dev/null | grep -A5 -i "resources\|concurrency\|scal" | head -30
cat docs/ops/gcp-credits-plan.md | head -40
curl -s https://three.ws/api/healthz | head -c 300
```

## The envelope, measured at three volumes

Fill this table with **measured** numbers and publish it in `docs/home-operations.md`. Every cell
that says "assumed" is an unfinished line.

| Volume | Connections per instance | Heap | p95 action | Behaviour |
|---|---|---|---|---|
| 10 homes | | | | everything inline, nothing to tune |
| 1,000 homes | | | | |
| 100,000 homes | | | | |

Measure the first two for real. For the third, measure the per-connection cost precisely and
extrapolate honestly, naming the extrapolation and its assumptions. A measured unit cost plus a
stated model is engineering; a guessed total is not.

The unit costs that matter, each measured:

- Heap per idle connection, and per connection for a large house (500+ entities).
- CPU per state burst of 100 entity updates.
- Socket count and file-descriptor headroom per instance.
- SSE stream cost per subscriber, separate from connection cost.
- Cold-start time to first connected home on a fresh instance.

## Backpressure and degradation, in order

The system must degrade in latency and features, never in correctness and never in safety. Write
the ladder down and implement it:

1. Under the per-instance cap: normal.
2. At the cap: new acquisitions get a short-lived unpooled connection. Slower, correct.
3. Under DB pressure: reads serve from the in-memory graph; writes still go through, because a
   write is somebody pressing a button.
4. Under severe load: SSE stream admission is limited before action admission is. **A user who
   asks to unlock a door gets served before a user who is watching a dashboard.**
5. Beyond that: `503` with `retry-after` and a designed UI state. Never a silent hang, never a
   half-applied action.

**The gate never degrades.** No load condition may cause a guarded action to skip a confirmation.
If shedding load would require weakening the gate, shed the action instead and say so.

## Chaos: the seven failures, each run for real

| # | Failure | Injected how | Must |
|---|---|---|---|
| 1 | House goes offline mid-session | stop the container | stale not empty, recovers on restart with no reload |
| 2 | House flaps (up, down, up) every 5 s for 2 minutes | a loop against the container | the breaker damps it; no alert storm; no socket leak |
| 3 | Token revoked while connected | delete the token in Home Assistant | connection moves to `auth_failed` with the real reason; the user is told to reconnect |
| 4 | Our instance recycled mid-stream | `docker restart` the API, or SIGTERM the process | streams reconnect client-side; sockets closed cleanly on the house's side |
| 5 | Database unavailable | point `DATABASE_URL` at a dead host | reads degrade to the in-memory graph, writes fail with a designed error, no crash loop |
| 6 | Slow house (2 s per response) | a latency shim in front of the container | timeouts bound it; one slow house does not slow others; prove isolation |
| 7 | 500-entity house with a 10-per-second update rate | the demo integration plus a generator | frame budget held in the UI, coalescing works, heap flat |

Failure 6 is the one that finds shared-resource bugs. Run it with a second, fast house connected
and prove the fast one is unaffected.

## Cloud Run configuration

Read `docs/ops/gcp-production.md` and `docs/ops/gcp-credits-plan.md` before changing anything.
CLAUDE.md pre-approves config-only `gcloud run services update` changes; a deploy is still
owner-gated.

Decide and justify, with the measured number behind each:

- Concurrency per instance (the current value, and whether long-lived SSE streams change it).
- Memory limit, from the measured heap plus headroom.
- Whether this lane needs a `minScale` above zero, and the honest cost of saying yes. Default is
  no: the pool is a cache, cold starts are sub-second, and paying to keep sockets warm is a
  decision that needs a measured latency complaint behind it.
- CPU throttling behaviour with an idle SSE stream open, which is the setting most likely to be
  wrong for this workload. Test it, do not reason about it.

## Tasks

| # | Task |
|---|---|
| 1 | A load harness that opens N real connections against N real Home Assistant containers (or one instance with N tokens, stated either way). `scripts/home-load.mjs`. |
| 2 | Measure every unit cost above. Record the raw output in `tasks/home/` as evidence, the way `tasks/sim-readiness/` does. |
| 3 | Implement the backpressure ladder. |
| 4 | Run all seven chaos scenarios and fix what they break. |
| 5 | Decide and apply the Cloud Run configuration, with the justification. |
| 6 | Publish the envelope table in `docs/home-operations.md`. |

## Definition of done

- [ ] The envelope table has measured numbers for 10 and 1,000 homes and a stated extrapolation for 100,000. No cell says "assumed".
- [ ] Every unit cost measured, with the raw evidence file committed under `tasks/home/`.
- [ ] All seven chaos scenarios run, with a transcript each, and every failure they exposed fixed.
- [ ] Scenario 6 proves isolation: the fast house's p95 is unchanged with a slow house connected. Paste both numbers.
- [ ] The backpressure ladder is implemented and each rung is demonstrated, including that action admission survives longer than stream admission.
- [ ] A load test proves the gate never degrades: guarded actions under saturation still require confirmation. Assert it.
- [ ] The Cloud Run configuration decision is written down with its measured justification, including the CPU-throttling test result.
- [ ] `npx vitest run --root .` shows no new failures.
- [ ] `npm run audit:docs` clean, `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| Cannot run 1,000 Home Assistant containers | You do not need to. Measure the per-connection cost precisely with 10 to 50 real ones, then drive the pool with a protocol-level load generator for the connection count. State exactly which part was real and which was generated. |
| The 100,000 number needs a distributed design | Then say so, with the measured point where the single-instance model breaks and what the next architecture is. An honest ceiling with a named successor beats a fabricated capacity. |
| Tempted to raise `minScale` to fix a cold start | Measure the cold start first. Sub-second is fine and free. Credits are approved for quality, but paying to hide a problem you have not measured is not quality. |
| A chaos scenario reveals a bug in `packages/home-bridge` | Fix it there, add a test there, and per the CLAUDE.md open-source rule, upstream anything that belongs to `home-assistant-js-websocket`. |
| The load harness would hammer a third party | It must only ever point at your own containers. Never load-test somebody's house. |

## Report format

1. The completed envelope table with its evidence file path.
2. Every unit cost with how it was measured.
3. Seven chaos transcripts and every fix made.
4. The isolation numbers from scenario 6.
5. The backpressure demonstration, rung by rung.
6. The Cloud Run decision and its justification.
7. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-14-reliability-scale.md

Never delete it on a partial.
