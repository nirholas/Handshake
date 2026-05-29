# Services

Long-running, standalone three.ws services — processes that hold persistent connections or run continuously, so they do not fit the request/response shape of a Vercel function (`api/`) or a stateless Cloud Run / Cloudflare worker (`workers/`). Each service is its own subdirectory with a `package.json`, an entrypoint, and a `Dockerfile`.

## Services

### `pump-graduations/` — pump.fun graduations indexer
A Node.js service that holds a long-lived Solana WebSocket subscription to the Pump program and detects token "graduations" (bonding-curve -> PumpAMM migration), pushing each event into Upstash Redis. The Vercel side reads the events back from Redis; this service is the only piece that keeps the live WS open.

- `index.js` — the main loop. Subscribes to Pump program logs, matches the `complete` anchor event by its 8-byte discriminator (`COMPLETE_EVENT_DISCRIMINATOR`, matching `@pumpkit/core`), and pushes graduation events into a capped Redis list.
- `carbon-source.js` — a drop-in alternative graduation source backed by a Carbon indexer. Implements the same `start(cb)` / `stop()` contract and emits identical events; selectable at startup via `PUMP_GRADUATIONS_SOURCE`.
- `Dockerfile` — `node:20-alpine`, `npm install --omit=dev`, runs `node index.js`.
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
