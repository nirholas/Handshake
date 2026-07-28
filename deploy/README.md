# deploy/

Build and deploy configuration for auxiliary Cloud Run services that run outside the main `three-ws-api` container. Each target has its own directory with the config and a runbook. The main API and frontend deploy is documented in [docs/ops/gcp-production.md](../docs/ops/gcp-production.md) instead.

| Target | Description |
| --- | --- |
| [sniper](sniper/README.md) | Deploys the always-on `agent-sniper` worker to Cloud Run: it holds the live PumpPortal new-mint feed open, scores launches against armed strategies, and in live mode snipes from each agent's own encrypted wallet. |
| [world](world/README.md) | Deploys world.three.ws, a Hyperfy multiplayer 3D world server pinned to an exact upstream commit with local patches; runs as its own Cloud Run service with all state in the `world-three-ws-data` GCS bucket. |
