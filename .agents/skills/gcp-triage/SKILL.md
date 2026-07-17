---
name: gcp-triage
description: Monitor three.ws production on Google Cloud Run and fix what the sweep finds. Use when the user asks to check production, diagnose an outage or error, "what's wrong with three.ws", read production logs, or run the monitoring loop. Runs the triage monitor (healthz + all-service log sweep + known-signature classification), then applies the fixes each class allows.
when_to_use: Production health checks, log diagnosis, error triage, and the recurring monitor-and-fix loop. For a raw log view only, `npm run logs` is enough without this skill.
license: MIT
metadata:
  category: ops/production
  cross-platform-safe: false
  pack: three-ws-ops
---

# GCP production triage: monitor, classify, fix

The `vercel logs` era is over; production is 20 Cloud Run services in project
`aerial-vehicle-466722-p5` (region `us-central1`). This skill is the loop an
agent runs to answer "is production healthy?" and to act on what it finds.
gcloud is already authenticated in this workspace.

## Step 1: run the monitor

```sh
npm run triage:gcp -- --json --since 1h   # agents: always --json
```

It merges three signals and classifies every distinct problem signature:

1. `https://three.ws/api/healthz`: the platform's own subsystem roll-up
   (database, cache, Helius, x402 ring, world, sniper).
2. A WARNING+ log sweep across **every** Cloud Run service, fingerprinted so
   repeats group into one finding.
3. HTTP request logs: 5xx groups per route, 429s.

Exit 0 = healthy or self-healing noise only. Exit 1 = `findings[]` contains
actionable items. Each finding carries `class`, `count`, `services`,
`sample`, and a concrete `action`.

## Step 2: act per class, in this order

| class | what it means | what you do |
|---|---|---|
| `owner` | money / billing / security credential | Do NOT act. Put the exact command from [docs/ops/production-log-triage.md](../../../docs/ops/production-log-triage.md) in your report. |
| `env-action` | fix is a config-only Cloud Run env/resource change | Apply it now. Config-only `gcloud run services update` is pre-approved (CLAUDE.md). ALWAYS `--update-env-vars` (merges); NEVER `--set-env-vars` (replaces the whole set). |
| `investigate` | unknown signature or 5xx group | Root-cause it (Step 3). Fix the code, add tests, commit locally. Deploys need owner approval, so prepare the one-command ship and say so in the report. |
| `self-healing` | documented graceful degradation | No action. Only escalate if the same finding persists across several runs (compare `firstSeen`, it should not span many hours). |

## Step 3: root-causing an `investigate` finding

- **Read the exact logs** with the reader CLI (`vercel logs` equivalent):
  ```sh
  npm run logs -- -s <service> --errors --since 6h        # errors, one service
  npm run logs -- -s <service> --app --warnings           # app logs only
  npm run logs -- --all --grep "<term>" --since 1d        # search the fleet
  npm run logs:tail                                       # live tail three-ws-api
  ```
- **5xx with no matching app-level error** means the handler itself returned
  5xx (upstream dependency reply), not a crash. Read the handler in `api/` for
  what makes it return that status, and check which upstream it wraps.
- **Generation failures**: the `forge_creations` table carries per-generation
  backend/status/error/prompt (`DATABASE_URL` from the Cloud Run service env).
- **Crash signatures** (`Uncaught signal`, OOM, `no available instance`):
  check the revision, memory, and instance ceilings via
  `gcloud run services describe <service> --region us-central1`.
- **Rollback and LB/DNS/TLS runbook**: [docs/ops/gcp-production.md](../../../docs/ops/gcp-production.md).

## Step 4: close the loop

- Fixed something in code? Commit locally with explicit paths (never
  `git add -A`). Do not push or deploy without owner approval; leave the ship
  as one command in the report.
- Found a NEW signature that is expected degradation (a fallback firing
  correctly)? Add it to `KNOWN_SIGNATURES` in
  [scripts/gcp-triage.mjs](../../../scripts/gcp-triage.mjs) AND document it in
  [docs/ops/production-log-triage.md](../../../docs/ops/production-log-triage.md),
  so the monitor never flags it as `investigate` again. That is how this
  system learns.
- Healthz unreachable? That is an outage: check `three-ws-api` revisions
  (`gcloud run revisions list --service three-ws-api --region us-central1`)
  and the load balancer per the production runbook before anything else.

## Report format

Lead with the verdict (healthy / degraded / outage). Then: what you fixed,
what you committed, what needs the owner (exact commands), and what is
self-healing noise. Solana-facing findings first.
