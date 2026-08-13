# Production logs and automated triage on GCP

The `vercel logs` workflow, rebuilt for the Cloud Run fleet. Three tools, all
in `scripts/`, all needing only the already-authenticated gcloud CLI:

| Tool | Job |
|---|---|
| `npm run logs` ([scripts/gcp-logs.mjs](../../scripts/gcp-logs.mjs)) | Read or live-tail logs from any Cloud Run service, vercel-logs style. |
| `npm run triage:gcp` ([scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs)) | Automated monitor: healthz + fleet-wide log sweep + known-signature classification into an action plan. |
| `npm run gpu` ([scripts/gpu-capacity.mjs](../../scripts/gpu-capacity.mjs)) | GPU capacity across every region: grant, holders, headroom, plus cross-region ports and quota requests. Answers the `gpu-quota-starved` finding. |

Agents: the monitor-and-fix loop that sits on top of these is the
`/gcp-triage` skill ([.agents/skills/gcp-triage/SKILL.md](../../.agents/skills/gcp-triage/SKILL.md)).

## Reading logs (`npm run logs`)

```sh
npm run logs                                  # three-ws-api, last hour
npm run logs:tail                             # live tail (the old `vercel logs --follow`)
npm run logs:errors                           # ERROR+ across ALL services, last 6h
npm run logs -- -s model-rig --since 2d       # any service, wider window
npm run logs -- --grep "forge" --warnings     # full-text search WARNING+
npm run logs -- --http 500 --since 6h         # request logs with status >= 500
npm run logs -- --app --errors                # app logs only (hide request logs)
npm run logs -- --services                    # list the Cloud Run fleet
npm run logs -- --json -n 500                 # raw entries for scripts/agents
```

Output is chronological, severity-colored, one line per entry. App logs
render their `textPayload`/`jsonPayload`; request logs render
`status method url latency`. Defaults: service `three-ws-api`, project
`aerial-vehicle-466722-p5`, window `1h`, limit 100 (override with
`--project`, `--region`, `--since`, `-n`).

Two things the raw `gcloud logging read` one-liner in older docs gets wrong,
which this tool handles: structured entries carry `jsonPayload` (a
`textPayload:"term"` filter silently misses them), and request logs carry no
payload at all (severity comes from the HTTP status).

## Automated triage (`npm run triage:gcp`)

```sh
npm run triage:gcp                  # human report, last hour
npm run triage:gcp -- --since 6h    # wider window
npm run triage:gcp -- --json        # machine-readable, what agents consume
npm run triage:gcp:deep             # everything: logs + version, TLS, fleet,
                                    # pages, crons, DB, wallets
```

`--deep` layers nine read-only probes (each wrapping an existing standalone
audit) on top of the log sweep, so one command answers "what's wrong with
three.ws?" across the whole surface instead of only what happened to log.
`--skip <id,id>` drops individual probes.

One run merges three signals:

1. **`/api/healthz`** subsystem roll-up (database, cache, rate limiter,
   Helius, the Solana RPC lane tier, x402 ring, x402 settle rate, forge
   generation, agent index freshness, world, sniper, the OKX chat bot,
   x402 config): the platform self-reports most degradations.
2. **WARNING+ app logs across every service**, fingerprinted (ids, numbers,
   addresses, and URLs collapsed) so repeats group into one finding.
3. **Request logs**: 5xx grouped per route, 429 noted.

Every finding gets a class and a concrete action:

- 🔴 `owner`: money/billing/security; the report carries the exact command,
  only the owner runs it.
- 🟡 `env-action`: config-only Cloud Run change (pre-approved); an agent
  applies it immediately.
- 🟠 `investigate`: unknown signature or 5xx group; an agent root-causes it.
- 🟢 `self-healing`: documented graceful degradation; no action.

Known signatures come from the runbook in
[production-log-triage.md](production-log-triage.md). When a new
expected-degradation signature shows up, add it to `KNOWN_SIGNATURES` in the
script and document it in the runbook; the monitor stops flagging it from
then on.

Exit codes make it schedulable: `0` healthy or noise-only, `1` actionable
findings, `2` usage error (so `npm run triage:gcp || <alert>` works in any
loop).

## Running it continuously

- **Interactive session:** `/loop 1h /gcp-triage` keeps a Claude agent
  sweeping and fixing while you work.
- **Scheduled Claude agent:** schedule `/gcp-triage` as a recurring routine
  from any Claude Code session (`/schedule`).
- **Independent of any agent**, the platform already self-monitors:
  `/api/cron/uptime-check` snapshots healthz every tick and re-pages
  persistent degradations, and [/status](https://three.ws/status) renders the
  live subsystem state with plain-language fixes.

## Related

- [production-log-triage.md](production-log-triage.md): every known log
  signature, root cause, and exact resolution.
- [gcp-production.md](gcp-production.md): full production runbook
  (LB/DNS/TLS/env/rollback).
- [page-audit.md](page-audit.md): the browser-side console sweep
  (`npm run audit:web`), complementary to server logs.
- [gcp-credits-plan.md](gcp-credits-plan.md): the GPU fleet map, quota state,
  and what `npm run gpu` automates.
