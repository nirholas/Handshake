# @three-ws/liquidation-collector

Standalone Node service that subscribes to the **public** futures liquidation
WebSocket streams of Binance, Bybit, and OKX, classifies each liquidation by
USD size, keeps a rolling 4-hour in-memory window, and serves an aggregate
REST snapshot.

It feeds the "liquidations pulse" strip on [three.ws/coins](https://three.ws/coins)
via the proxy endpoint [`api/coin/liquidations.js`](../../api/coin/liquidations.js).

Originally ported from a battle-tested SperaxOS collector, then hardened:
per-topic Bybit subscribe acks (the retired `liquidation.{SYMBOL}` topic used
to fail silently), OKX contract-size conversion (the raw `sz` field counts
contracts, not coins), a Binance geo-restriction probe, and per-lane health
reporting on `/health`. Parsing and aggregate math live in
[`src/collector.js`](src/collector.js) as pure functions covered by
[`tests/liquidation-collector.test.js`](../../tests/liquidation-collector.test.js)
at the repo root (run with `npx vitest run tests/liquidation-collector.test.js`).

## Why a separate service

This process holds three long-lived WebSocket connections open indefinitely.
That is fundamentally incompatible with Vercel/serverless functions (which are
short-lived, request-scoped invocations) — it **cannot** be deployed as a
Vercel function. It must run on an always-on Node host: a small VM, a Cloud
Run service with `min-instances >= 1` and no request timeout, a Fly.io app, a
Railway/Render worker, etc. Point `LIQUIDATION_COLLECTOR_URL` (set on the main
three.ws deployment) at wherever it ends up.

## Run it

```sh
cd services/liquidation-collector
npm install
npm start
# or, for local iteration with auto-restart on save:
npm run dev
```

No API keys or credentials are required — all three streams are public.
Liquidations on majors (BTC, ETH, SOL, …) typically start arriving within a
minute or two of connecting.

## Env vars

| Var    | Default | Description                                  |
| ------ | ------- | --------------------------------------------- |
| `PORT` | `3033`  | HTTP port the REST API listens on             |

## HTTP surface

### `GET /health`

Reports the cache size plus per-lane stream health, because a silently dead
lane is this service's main failure mode: an open socket proves nothing about
delivery, so each lane exposes its state and event counters.

```json
{
	"ok": true,
	"cached": 1234,
	"uptime": 5821.4,
	"okxContracts": 446,
	"streams": {
		"Binance": { "state": "restricted", "events": 0, "lastEventAt": null, "note": "Binance blocks this host region (HTTP 451); host the collector outside a restricted region to enable this lane" },
		"Bybit": { "state": "connected", "events": 87, "lastEventAt": 1786611799168, "note": "" },
		"OKX": { "state": "connected", "events": 402, "lastEventAt": 1786611800234, "note": "" }
	}
}
```

- `state` is one of `starting`, `connecting`, `connected`, `reconnecting`, `degraded` (Bybit rejected one or more subscribe topics), `error`, or `restricted` (Binance answers HTTP 451 to this host region; the probe rechecks hourly and the lane lights up with no code change once the service is hosted outside a restricted region. US-hosted deployments, including Cloud Run `us-central1`, run with Bybit + OKX only).
- `okxContracts` is the number of OKX swap contract specifications loaded; OKX liquidations for unknown instruments are dropped rather than sized by guesswork, because `sz` counts contracts (one BTC-USDT-SWAP contract is 0.01 BTC), not coins.

### `GET /liquidations`

Returns the 50 most recent liquidations (across the tracked symbol list) plus
aggregate stats over the rolling 4-hour window.

```json
{
	"liquidations": [
		{
			"exchange": "Binance",
			"price": 61234.5,
			"qty": 0.42,
			"severity": "LARGE",
			"side": "LONG",
			"symbol": "BTC",
			"time": 1735689600000,
			"value": 257184.89
		}
	],
	"summary": {
		"dominantSide": "LONG PAIN",
		"largeCount": 12,
		"longCount": 340,
		"longValue": 8123456.12,
		"megaCount": 1,
		"shortCount": 190,
		"shortValue": 2456789.01,
		"totalCount": 530,
		"totalValue": 10580245.13
	},
	"symbolStats": [
		{ "count": 210, "longValue": 5123456.0, "shortValue": 890123.0, "symbol": "BTC" }
	],
	"timestamp": "2026-07-08T12:00:00.000Z"
}
```

- `severity` buckets: `SMALL` (< $10k), `MEDIUM` (< $100k), `LARGE` (< $1M), `MEGA` (>= $1M).
- `side` is the side that got liquidated: a forced-sell of a long is `LONG`, a forced-buy-back of a short is `SHORT`.
- `summary.dominantSide` is `LONG PAIN` when long liquidations exceed short liquidations by 1.5x, `SHORT SQUEEZE` for the inverse, `BALANCED` otherwise.

## Tracked symbols

BTC, ETH, SOL, DOGE, XRP, ARB, OP, AVAX, LINK, BNB, SUI, WIF, PEPE, BONK, INJ, TIA, APT, NEAR.

## Deploy note

Not a Vercel function (see above). Production runs it as the Cloud Run
service `liquidation-collector` (project `aerial-vehicle-466722-p5`, region
`us-central1`, `min-instances=1`, unthrottled CPU) with the main deployment's
`LIQUIDATION_COLLECTOR_URL` pointed at it; any always-on Node host works the
same way. The service reconnects each exchange stream automatically on
disconnect (5s backoff) and exits cleanly on process signals delivered by the
host platform.
