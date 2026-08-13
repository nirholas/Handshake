# pump-graduations

Standalone Node service that watches the Pump program on Solana for token
graduations (bonding-curve to PumpAMM migrations) and pushes each event into
Upstash Redis. It runs as an always-on process instead of an `api/` function
because it holds a long-lived Solana WebSocket (see
[services/README.md](../README.md)).

Who reads the list: `api/_lib/pumpfun-mcp.js` serves the `graduations` MCP tool
from the WS-fed `pumpfun_graduations` Postgres table first and falls back to
this service's `pf:graduations` Redis list when that read comes back empty. So
the Redis list is the platform's backup graduation feed, not its primary one,
and the service is independently useful as a self-hosted feed: point any
consumer at the list key or subscribe to the pub channel below.

## How detection works

The Pump program emits a `complete` Anchor event when a token graduates. The
service subscribes to program logs for
`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, scans each `Program data:` line,
and matches the event by its fixed 8-byte discriminator
(`sha256("event:CompleteEvent")[..8]`, the same bytes `@pumpkit/core` uses).
Matched events are decoded from the CompleteEvent layout
(`user(32) mint(32) bondingCurve(32) timestamp(i64)`), deduplicated by
signature, enriched, and pushed.

Enrichment reads chain state; it never mines the graduation transaction. The
`complete` event fires when the bonding curve fills, and the PumpSwap pool is
created in a later migration transaction, so the graduation tx cannot supply
the pool address. Instead [token-info.js](./token-info.js):

- derives the canonical PumpSwap pool address from the mint (the same PDA
  `canonicalPumpPoolPda` in `@pump-fun/pump-swap-sdk` returns, without pulling
  that SDK's Anchor tree into this image), and
- reads the mint's name and symbol with one `getAccountInfo`, decoding the
  Token-2022 inline TokenMetadata extension and falling back to the mint's
  Metaplex metadata account for pre-Token-2022 launches. A failed metadata read
  yields nulls rather than dropping the graduation.

Two interchangeable sources emit identical events, selected at startup by
`PUMP_GRADUATIONS_SOURCE`:

- `legacy` (default): the `conn.onLogs` subscription inside [index.js](./index.js).
- `carbon`: [carbon-source.js](./carbon-source.js), a drop-in class with a `start(onGraduation)` / `stop()` contract. It subscribes to the same Pump program logs and decodes with the same [graduation-event.js](./graduation-event.js) functions, so the two sources can never drift apart on layout or dedupe. Its `logSubscriber` constructor option exists only so tests can inject a stream.

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
# [pump-graduations] starting; program=6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P source=legacy list=pf:graduations
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

- [index.js](./index.js): process entrypoint. Wires a source to Redis; exports `buildGraduationRecord`, `pushGraduation` and `createGraduationHandler` so the core path can be exercised without opening a subscription.
- [graduation-event.js](./graduation-event.js): `CompleteEvent` discriminator, decoding, candidate-entry filter, and the bounded `SeenSignatures` dedupe. Shared by both sources.
- [token-info.js](./token-info.js): pool-address derivation and mint name/symbol reads.
- [carbon-source.js](./carbon-source.js): alternative graduation source, same event shape.
- [Dockerfile](./Dockerfile): `node:20-alpine`, `npm ci --omit=dev` off the committed lockfile, `node index.js`.

## Tests

Both suites run from the repo root with the platform's vitest config:

```bash
npx vitest run tests/pump-graduations.test.js tests/carbon-graduations.test.js
```

[tests/pump-graduations.test.js](../../tests/pump-graduations.test.js) covers the
core path end to end (log line to Redis record, including the dedupe and the
metadata decoders); [tests/carbon-graduations.test.js](../../tests/carbon-graduations.test.js)
covers the carbon source's emitted event shape.
