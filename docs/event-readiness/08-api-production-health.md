# Audit 8: production API and infrastructure health

Everything server-side must be verifiably healthy before the event: Cloud Run, crons, database, the x402 economy, and the failover chains. Use the gcp-triage skill if available; otherwise follow this checklist directly.

Project `aerial-vehicle-466722-p5`, region `us-central1`, service `three-ws-api`. If `gcloud` is not on PATH: `export PATH="$HOME/google-cloud-sdk/bin:$PATH"`. Full runbook: `docs/ops/gcp-production.md`.

## What to check and fix

1. **Liveness.** `curl -s https://three.ws/api/version` (live SHA + revision; confirm it is the commit you expect) and the healthz endpoint. `npm run smoke:prod` for the page layer.
2. **Error logs, last 24h.** `npm run logs:errors`, and for depth: `gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="three-ws-api" severity>=ERROR' --freshness=24h`. Every recurring error gets root-caused and fixed or explicitly accepted with a reason. "It has always logged that" is not a reason.
3. **Crons.** `npm run audit:cron-liveness` and `npm run check:cron-drift`. All Cloud Scheduler jobs (synced from vercel.json's crons array) firing and succeeding; pay attention to `/api/cron/changelog-push` since we will ship changelog entries before the event.
4. **Database.** `npm run db:status` (read only; NEVER run `db:migrate` casually, it applies immediately with no dry run). Pending migrations at event time are a deploy-gate failure waiting to happen: resolve them deliberately today. Check `forge_creations` for elevated generation error rates.
5. **Generation lanes and LLM chain.** Exercise one real generation per public lane (text-to-3D at minimum) end to end on production. A lane with a broken primary must be proven to fail over, not assumed to.
6. **x402 economy.** If any settle failures or stalls appear in logs, run the x402-economy-triage agent before concluding anything about wallet balances; settle-floor starvation and capital dispersion look identical from outside. Also `npm run check:relayer-balances` and `npm run audit:service-wallets`.
7. **Rate limits and abuse posture.** The event link will be public. Confirm the obvious abuse surfaces (chat, generation endpoints, auth) have rate limiting that will not also throttle legitimate burst traffic from one venue IP/NAT. If venue NAT would trip an IP-based limit, raise or key it differently now.
8. **TLS/DNS/CDN.** Certificate validity, and confirm the CDN serves current content (a stale edge after the last deploy shows phantom failures; the purge command is `npm run deploy:gcp:purge-cdn`).

## Verify

Each numbered item ends in a binary state: healthy, or fixed-and-now-healthy, or a named owner-level decision with exactly what remains.

## Report format

Solana-first status summary, then the 8 items with their binary states, then log evidence links/queries for anything you fixed.
