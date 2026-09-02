# Ops runbooks

Operator-only documentation for running three.ws in production. This directory (like `docs/security/` and `docs/internal/`) is deliberately excluded from the public site build: the `copy-static-docs` plugin in `vite.config.js` and `scripts/combine-docs.mjs` both skip it, so nothing here ships to `dist/` or `docs/ALL.md`. Keep it that way: these files name the GCP project, service accounts, and env-var gates.

Start with [gcp-production.md](gcp-production.md); it is the complete operational record. The rest are focused runbooks:

| Runbook | What it covers |
|---|---|
| [gcp-production.md](gcp-production.md) | The production platform end to end: Cloud Run services, LB/DNS/TLS, env, deploy, rollback, recovery. |
| [gcp-credits-plan.md](gcp-credits-plan.md) | Standing map of the ~$100k GCP credit spend: fleet, quota, pre-approved scaling, what to do next without asking. |
| [gcp-credits.md](gcp-credits.md) | The Vertex AI and GCP footprint runbook backing the credits plan. |
| [gcp-model-workers.md](gcp-model-workers.md) | Self-hosted GPU generation lanes on Cloud Run: workers, weights, deploys. |
| [livepeer-federation.md](livepeer-federation.md) | Phase 4 compute federation: the Livepeer text-to-image adapter, the measured gateway state, and the recommendation on whether to expand. |
| [gcp-logs.md](gcp-logs.md) | Production log reading and automated triage tools for the Cloud Run fleet. |
| [production-log-triage.md](production-log-triage.md) | Known error/warning signature map: what each recurring log signature means and the fix. |
| [forge-error-triage.md](forge-error-triage.md) | `npm run forge:errors`: which 3D generation failures actually recur, ranked by class and lane over a real window. |
| [cron-auth.md](cron-auth.md) | The two locks on `/api/cron/*`: the handler gate, the edge gate, and the header trap that makes attaching Cloud Scheduler OIDC take the whole fleet down if done naively. |
| [payment-outcomes.md](payment-outcomes.md) | The payment-outcome board (`GET /api/ops/payment-outcomes`): verify-reject, settle-fail, replay, and sponsor-runway signals and how to read them in an incident. |
| [agent-index.md](agent-index.md) | The agent index crawls end to end: the cursor stall both chain legs share, the error-class table, the recovery script, and how the freshness sensor scores each leg. |
| [solana-rpc-lanes.md](solana-rpc-lanes.md) | The Solana RPC tier end to end: one-sweep diagnosis, per-lane method capability, what must rotate vs fail, config traps, recovery. |
| [llm-lanes.md](llm-lanes.md) | The LLM provider chain end to end: which rungs serve, why the paid ones are dead, how spend is metered, the one-command Claude rollout, and per-lane probes. |
| [page-audit.md](page-audit.md) | `scripts/page-audit.mjs`: authed Chromium sweep of every public page, console-error gated. |
| [swarm-100-audit.md](swarm-100-audit.md) | Reconciles the `prompts/swarm-100/` self-deleting work-order ledger against git history and measures every still-open order. |
| [avatar-asset-orphans.md](avatar-asset-orphans.md) | Avatar rows whose model or thumbnail is gone from the bucket: why they happened, how to find and repair them. |
| [avatar-reconstruction-capacity.md](avatar-reconstruction-capacity.md) | The photo-to-avatar lane sized to the 10k avatars/day launch target: measured numbers, the autoscaler-blindness trap, and the applied config. |
| [db-retention.md](db-retention.md) | Keeping the Neon Postgres branch under its storage cap: what grows, what gets pruned. |
| [redis.md](redis.md) | Upstash Redis quota, burn rate, and which limiters are distributed vs local. |
| [runtime-flags.md](runtime-flags.md) | DB-backed feature flags that flip platform behavior without a redeploy. |
| [x402-discovery-listings.md](x402-discovery-listings.md) | Getting paid endpoints listed and ranked on x402scan, the Bazaar, and other directories. |
| [seo-keyword-plan.md](seo-keyword-plan.md) | Verified keyword landscape and content calendar (snapshot dated 2026-07-17). |
| [wallet-key-migration.md](wallet-key-migration.md) | Incident record: stranded pool-agent wallets after the WALLET_ENCRYPTION_KEY migration. |
| [stranded-wallets.md](stranded-wallets.md) | The standing owner decision on custodial wallets sealed by that rotation: measured list, why recovery is impossible, what crediting or writing off the customer balances costs, and the commands for each. |
| [forge-multiview-migration-handoff.md](forge-multiview-migration-handoff.md) | Historical hand-off for the forge multi-view migrations (June 2026); superseded by gcp-production.md. |
| [examples-repo-export.md](examples-repo-export.md) | How the public `three-ws/examples` satellite repo is assembled and published from this monorepo. |

Related, also private: the security review records in [../security/](../security/) ([SECURITY_AUDIT.md](../security/SECURITY_AUDIT.md), [SECURITY_REMEDIATION.md](../security/SECURITY_REMEDIATION.md), [review-2026-06-24.md](../security/review-2026-06-24.md)), all point-in-time records preserved as written.
