# pump-graduations

Standalone Node service that watches the Pump program on Solana for token
graduations (bonding-curve to PumpAMM migrations) and pushes each event into
Upstash Redis. The main three.ws deployment reads the events back from Redis;
this service is the only piece of the platform that holds the long-lived
Solana WebSocket, which is why it runs as an always-on process instead of an
`api/` function (see [services/README.md](../README.md)).

## How detection works

The Pump program emits a `complete` Anchor event when a token graduates. The
service subscribes to program logs for
`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, scans each `Program data:` line,
and matches the event by its fixed 8-byte discriminator
(`sha256("event:CompleteEvent")[..8]`, the same bytes `@pumpkit/core` uses).
Matched events are decoded from the CompleteEvent layout
(`user(32) mint(32) bondingCurve(32) timestamp(i64)`), deduplicated by
signature, enriched with a best-effort transaction lookup, and pushed.

Two interchangeable sources emit identical events, selected at startup by
`PUMP_GRADUATIONS_SOURCE`:

- `legacy` (default): the `conn.onLogs` subscription inside [index.js](./index.js).
- `carbon`: [carbon-source.js](./carbon-source.js), a drop-in class with a `start(onGraduation)` / `stop()` contract. Its `logSubscriber` constructor option exists only so tests can inject a mock stream.

## Redis contract

Each graduation is JSON
(`{ signature, mint, tokenName, tokenSymbol, poolAddress, timestamp }`) and is:

- `LPUSH`ed onto the list at `GRADUATIONS_LIST_KEY` (default `pf:graduations`), trimmed to `GRADUATIONS_MAX_LEN` (default 500), and
- `PUBLISH`ed on the `<list key>:pub` channel for live subscribers.

## Run it

```bash
cd services/pump-graduations
npm install

SOLANA_RPC_URL=<https rpc> SOLANA_WS_URL=<wss endpoint> \
UPSTASH_REDIS_REST_URL=<url> UPSTASH_REDIS_REST_TOKEN=<token> \
npm start
# [pump-graduations] starting; program=6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P source=legacy
```

As a container:

```bash
docker build -t pump-graduations services/pump-graduations
docker run --env-file .env pump-graduations
```

## Env vars

| Var | Default | Description |
|---|---|---|
| `SOLANA_RPC_URL` | (required) | HTTPS JSON-RPC endpoint (Helius or any provider). |
| `SOLANA_WS_URL` | (required) | WSS endpoint for the log subscription. |
| `UPSTASH_REDIS_REST_URL` | (required) | Upstash Redis REST URL. |
| `UPSTASH_REDIS_REST_TOKEN` | (required) | Upstash Redis REST token. |
| `GRADUATIONS_LIST_KEY` | `pf:graduations` | Redis list key (pub channel is `<key>:pub`). |
| `GRADUATIONS_MAX_LEN` | `500` | Max list length after trim. |
| `PUMP_GRADUATIONS_SOURCE` | `legacy` | Event source: `legacy` or `carbon`. |

## Files

- [index.js](./index.js): main loop, event parsing, enrichment, Redis push.
- [carbon-source.js](./carbon-source.js): alternative graduation source, same event shape.
- [Dockerfile](./Dockerfile): `node:20-alpine`, `npm install --omit=dev`, `node index.js`.
