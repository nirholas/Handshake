# Services

Long-running, standalone three.ws services: processes that hold persistent connections or run continuously, so they do not fit the request/response shape of a Vercel function (`api/`) or a stateless Cloud Run / Cloudflare worker (`workers/`). Each service is its own subdirectory with a `package.json` and an entrypoint, plus a `Dockerfile` when it is meant to be deployed as a container.

## Services

| Service | What it is | Deployed as |
| --- | --- | --- |
| [`pump-graduations/`](pump-graduations) | pump.fun graduations indexer, detailed below | Container (`Dockerfile`) |
| [`agent-screen-caster/`](agent-screen-caster) | Gives an agent a live, watchable screen from a real Playwright session. See its [README](agent-screen-caster/README.md) | Container (`Dockerfile`) |
| [`liquidation-collector/`](liquidation-collector) | Aggregates public futures liquidation feeds into a rolling REST snapshot. See its [README](liquidation-collector/README.md) | Cloud Run (`liquidation-collector`) |
| [`fleet-console/`](fleet-console) | Health console for an open-source fleet: probes what every repository of a GitHub owner claims and scores what it finds. HTTP dashboard, CLI, and MCP server. See its [README](fleet-console/README.md) | Not deployed, by design: run it from a terminal, a cron job, or next to an agent |

### `pump-graduations/` — pump.fun graduations indexer
A Node.js service that holds a long-lived Solana WebSocket subscription to the Pump program and detects token "graduations" (bonding-curve -> PumpAMM migration), pushing each event into Upstash Redis. `api/_lib/pumpfun-mcp.js` reads the list as its fallback graduation feed, behind the WS-fed `pumpfun_graduations` Postgres table.

- `index.js`: process entrypoint. Wires a source to Redis and exports the record-building, push, and handler functions so the core path is testable without a subscription.
- `graduation-event.js`: the `CompleteEvent` 8-byte discriminator (`sha256("event:CompleteEvent")[..8]`, matching `@pumpkit/core`), the event decoder, and the bounded signature dedupe. Shared by both sources.
- `token-info.js`: enrichment: canonical PumpSwap pool address derived from the mint, plus the mint's name/symbol read from its Token-2022 metadata extension or Metaplex metadata account.
- `carbon-source.js`: a drop-in alternative graduation source. Subscribes to the same Pump program logs and decodes with the same `graduation-event.js` functions, behind the `start(cb)` / `stop()` contract; selectable at startup via `PUMP_GRADUATIONS_SOURCE`.
- `Dockerfile`: `node:20-alpine`, `npm ci --omit=dev` off the committed lockfile, runs `node index.js`.
- `package.json` — `npm start` runs the indexer.

Environment (see `index.js` for the full list): `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `GRADUATIONS_LIST_KEY` (default `pf:graduations`), `GRADUATIONS_MAX_LEN` (default `500`), `PUMP_GRADUATIONS_SOURCE` (`legacy` default, or `carbon`).

Run locally:

```
cd pump-graduations
npm install
npm start
```

Or as a container:

```
docker build -t pump-graduations services/pump-graduations
docker run --env-file .env pump-graduations
```
