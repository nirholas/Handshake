# Audit 10: event-day readiness runbook (run last, after fixes have shipped)

Everything is fixed and deployed; now make the platform boringly reliable for the traffic spike and give the owner a one-page live-ops position. This prompt both executes the pre-scaling and produces the runbook.

Project `aerial-vehicle-466722-p5`, region `us-central1`. Pre-approved scaling and quota posture: `docs/ops/gcp-credits-plan.md`. Full production runbook: `docs/ops/gcp-production.md`. Config-only `gcloud run services update` changes are pre-approved; use `--update-env-vars` only, never `--set-env-vars`.

## Execute now (day before)

1. **Deploy state.** Confirm the intended final build is live: `curl -s https://three.ws/api/version` matches the release SHA. If a deploy is still pending, run the deploy-preflight agent and stage everything so shipping is one command; the deploy itself stays owner-gated.
2. **Pre-scale.** Raise `min-instances` on `three-ws-api` (and the /play world server if it is a separate service; check `gcloud run services list`) so the first traffic wave never hits a cold start. Confirm max-instances and concurrency leave headroom per the credits plan. Config-only, pre-approved: do it, record old/new values.
3. **Worktree hygiene.** `npm run clean:worktrees` (then `--apply`) so a mid-event hotfix deploy cannot die on a full disk.
4. **Rehearse rollback.** Identify the current and previous Cloud Run revisions and write down the exact one-line traffic-rollback command for each service. Verify the previous revision still exists and is routable.
5. **Monitoring loop.** Set up the recurring production check for event day (the gcp-triage sweep or `npm run logs:errors` + `npm run smoke:prod` on an interval). Confirm alerting actually reaches a human.
6. **Capacity smoke.** Drive a burst of concurrent sessions at /play (Playwright contexts or a load tool) at least 2x the expected peak. Watch p95 latency, error rate, and instance count. Fix or pre-scale whatever bends.
7. **Third-party dependencies.** List every external dependency in the event path (Solana RPC, Pump.fun feed, IPFS gateway for coin images, LLM providers) and verify each has a working failover rung today. Test the failover, not just its existence.

## Produce: the one-page live-ops sheet

Write `docs/event-readiness/LIVE-OPS.md` containing, with zero fluff:

- The event URL (canonical $THREE /play link from `docs/event-readiness/README.md`) and the release SHA that is live.
- Health: the 3 curl commands that prove the site is up.
- Logs: the 2 log commands for fast triage.
- Rollback: the exact per-service revision-rollback command, pre-filled.
- Scale: current min/max instances and the command to raise them further.
- Known failure modes from audits 1-9 that were accepted rather than fixed, and what to do if each one fires.
- Escalation: which subsystem maps to which triage tool (x402-economy-triage, gcp-triage, `scripts/play-mobile-repro.mjs`).

## Report format

Old/new scaling values, capacity smoke numbers, rollback rehearsal result, and the link to LIVE-OPS.md. Anything owner-gated (the final deploy) stated as the single remaining command.
