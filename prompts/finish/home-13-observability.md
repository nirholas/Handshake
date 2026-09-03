# 13. Observability, SLOs, alerting, incident runbook

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Orders
[02](home-02-bridge-runtime.md) and [03](home-03-api-surface.md) must have landed.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**Nothing in this file is a status claim to trust.** Step 0 re-measures.

---

## Step 0: re-derive the current state

```bash
sed -n '1,30p' api/healthz.js
grep -n "export function classify\|export async function gather" api/_lib/ops/subsystem-health.js | head -20
grep -n "^export" api/_lib/alerts.js
node -e "console.log(require('./vercel.json').crons.length)"
curl -s https://three.ws/api/healthz | head -c 400
```

The platform already has a subsystem-health pattern (`api/_lib/ops/subsystem-health.js`, surfaced
by `api/healthz.js` and `api/status.js`) and an alerting path (`sendOpsAlert`). **Extend both.
Do not build a second health endpoint or a second alert channel.**

## What "down" means for this lane, and why it is unusual

Most outages here are not ours. A user's house is offline, their token expired, their internet
dropped. Those are per-tenant conditions that must never page anyone and must always be visible
to that one user. Conversely, "every home went unreachable in the last five minutes" is an
outage, and it looks identical at the level of a single connection.

**The whole design of this order is separating the two.** A per-tenant failure is a UI state; a
correlated failure across tenants is an alert.

## The signals

Add a `home` subsystem to `gatherSubsystemHealth`, classified the way its siblings are:

| Signal | Source | Green | Yellow | Red |
|---|---|---|---|---|
| Connected homes | `runtime.stats()` aggregated | any | n/a | n/a (a count, not a verdict) |
| Handshake success rate, 15 min | `home_connections.last_ok_at` / `last_error_at` | over 95% | 80 to 95% | under 80% |
| Breaker-open homes | runtime | under 2% | 2 to 10% | over 10% |
| Action success rate, 15 min | `home_action_log.outcome` | over 98% | 95 to 98% | under 95% |
| Confirmation expiry rate | `home_confirmations` | under 20% | 20 to 40% | over 40% (the UI is failing people) |
| SSE subscriber leak | `stats().subscribers` versus open streams | flat | growing | growing and unbounded |
| p95 action latency | timing on the act path | under 1.5 s | 1.5 to 4 s | over 4 s |

Every rate is computed **across tenants**, so one offline house cannot move it and a regional
internet event or a bad deploy can.

## The SLOs

Publish these in `docs/home-operations.md` and hold to them:

| SLO | Target | Window | Error budget |
|---|---|---|---|
| Action availability (our side) | 99.5% of actions reach the house or return a designed error | 30 days | 3.6 hours |
| Action latency | p95 under 1.5 s, our leg only, excluding the house | 30 days | |
| State freshness | p95 under 2 s from a device change to the SSE event | 30 days | |
| Confirmation integrity | **100%**, no exceptions, no budget | always | zero |

The last row is not an availability target, it is a correctness invariant: a guarded action
executing without a valid confirmation is a Sev 1 regardless of volume. Say that in the doc.

## Alerting

Route through `sendOpsAlert`. Three alerts, and only three, because an alert nobody acts on
trains people to ignore the channel:

1. **Correlated unreachability**: handshake success under 80% across at least 10 distinct homes
   in 15 minutes. Almost always us (a deploy, an egress change, a DNS problem).
2. **Confirmation integrity violation**: any action with `guarded = true` and `confirmed_by is
   null` and `outcome = 'ok'`. This should be impossible; a single row is an alert.
3. **Subscriber leak**: `stats().subscribers` above the open-stream count by a growing margin
   over three consecutive checks. This is the failure mode that quietly kills instances.

A per-tenant failure never alerts. Ever. It appears in that user's UI and in their action log.

## The incident runbook

Write `docs/home-operations.md` covering, for each of the three alerts and for the four most
likely per-tenant reports:

- The symptom as the reporter describes it.
- The first command to run, with the real `gcloud logging read` filter for this service.
- How to tell "their house" from "us" in under two minutes.
- The rollback path (`docs/ops/gcp-production.md`) and when to use it.
- What to tell the user, in plain language.

Include the correlation query as a copy-pasteable SQL statement: given one user's complaint, is
anyone else affected right now?

## Tasks

| # | Task | Files |
|---|---|---|
| 1 | `classifyHomeHealth` and its gatherer, following the file's existing shape. | `api/_lib/ops/home-health.js`, wired into `api/_lib/ops/subsystem-health.js` |
| 2 | Timing instrumentation on the act path and the SSE path. | `api/_lib/home/runtime.js`, `api/home/**` |
| 3 | The three alerts, with a cron if one is needed (`vercel.json` `crons`, then `scripts/create-gcp-scheduler.mjs` syncs Cloud Scheduler). | as needed |
| 4 | The confirmation-integrity check as both an alert and a test. | `tests/home-integrity.test.js` |
| 5 | `docs/home-operations.md` with the SLOs, the runbook and the correlation query. | as listed |
| 6 | A per-tenant status surface: the user can see their own home's health without asking us. | `src/home/manage.js` |

## Definition of done

- [ ] `curl /api/healthz` returns a `home` subsystem block with real numbers. Paste it.
- [ ] Stopping a single Home Assistant does **not** move the aggregate to red and does **not** alert. Prove both.
- [ ] Simulating correlated failure (block egress, or point ten test homes at a dead address) does turn the subsystem red and does fire alert 1. Paste the alert.
- [ ] Alert 2 fires on a synthetic row inserted directly into `home_action_log` with `guarded = true, confirmed_by = null, outcome = 'ok'`, and the query finds it within the check window. Then delete the synthetic row and say so.
- [ ] The subscriber-leak detector fires on a deliberately leaked subscription and clears when it is released.
- [ ] p95 action latency is measured and reported against the 1.5 s target, from real traffic against a real house.
- [ ] `docs/home-operations.md` exists, is linked from `docs/start-here.md`, and every command in it was run by you and produced output. Paste one of each.
- [ ] The user-facing per-tenant status shows a real reason for a real failure, screenshotted.
- [ ] `npm run check:cron-drift` (if the lane added a cron) passes and the `vercel.json` cron count matches.
- [ ] `npm run check:claude` passes, since the cron count is one of the facts it guards.
- [ ] `npm run audit:docs` clean, `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| No production traffic yet to measure | Generate it against a real local house and say the numbers are pre-launch. A measured local baseline beats an invented production one. Re-measure in order 20. |
| Tempted to alert on a single user's house being down | Do not. It will page you every night and you will stop reading the channel. It is a UI state. |
| The confirmation-integrity check seems paranoid for something "impossible" | Impossible things caused by a refactor are exactly what a zero-budget invariant is for. It costs one query. |
| No `gcloud` access in this container | The log filters still get written and tested where access exists; the CLAUDE.md playbook covers the credential path. State clearly which commands you ran and which you could not. |
| Adding a cron | `vercel.json` is live config: `scripts/create-gcp-scheduler.mjs` reads `crons` to sync Cloud Scheduler, and `npm run check:claude` asserts the count in CLAUDE.md matches. Update both. |

## Report format

1. The healthz block.
2. The single-house-down non-alert proof and the correlated-failure alert.
3. The integrity alert firing, and confirmation that the synthetic row was removed.
4. The leak detector firing and clearing.
5. Measured p95 latency.
6. One command output from each runbook section.
7. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-13-observability.md

Never delete it on a partial.
