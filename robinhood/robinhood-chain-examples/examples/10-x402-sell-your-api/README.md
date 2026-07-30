# 10 · Sell your API

Put a USDG paywall in front of any Robinhood Chain endpoint. The entire paid
route is one `paywall()` middleware from
[`hood402`](https://www.npmjs.com/package/hood402) plus one handler that reads
the chain with `hoodchain`. Everything else in the file is startup wiring and
a self-check that proves the gate is live.

This is the sell side of [example 09](../09-x402-paid-api-call). Run them
together and you have a complete market: an agent discovers a price it can
read, pays it, and gets data back, with no account and no API key anywhere.

**What it proves:** monetizing an endpoint is middleware, not architecture.
Any spec-compliant x402 client can pay this route, and a free route can sit
directly beside a paid one in the same app.

## Prerequisites

- Node ≥ 20.
- **No key needed.** With no settlement credentials the server self-settles
  from a freshly generated gas key that holds nothing: challenges and
  signature verification are fully real, and a paid request stops honestly at
  "insufficient gas wallet" instead of pretending to settle.

## Run

```bash
npm install
npm start                                # boot on testnet, self-check, keep serving
npm start -- --once                      # boot, self-check, exit (what CI runs)
HOOD402_NETWORK=robinhood npm start      # mainnet 4663 instead
HOOD402_PAY_TO=0x... npm start           # your own settlement address
```

## Expected output

```
hood402 paid endpoint - robinhood-testnet (chain 46630)
  paid : GET http://127.0.0.1:8010/v1/quote/:symbol   0.01 USDG
  free : GET http://127.0.0.1:8010/v1/symbols
  payTo: 0xA9b426C23E7dDc33Eb2B2fB69A058f2749F61daC
  settle: self-settle (ephemeral unfunded gas key)
  USDG : 0x7E955252E15c84f5768B83c41a71F9eba181802F
  data : mainnet 4663 Chainlink feeds (reads are free and public)

GET /v1/quote/AAPL with no payment -> HTTP 402
  x402Version   1
  scheme        exact
  network       robinhood-testnet
  asset         0x7E955252E15c84f5768B83c41a71F9eba181802F  (USDG, 6 decimals)
  maxAmount     10000 atomic = 0.01 USDG
  payTo         0xA9b426C23E7dDc33Eb2B2fB69A058f2749F61daC
  description   Robinhood Chain Stock Token quote: Chainlink oracle price, feed, and freshness.

GET /v1/symbols (free) -> HTTP 200, 95 Stock Tokens, no payment required

--once: self-check done, shutting down. Drop the flag to keep serving.
```

## Two ways to settle, both real

Pick one with an environment variable:

| Setting | What happens | Who pays gas |
|---|---|---|
| `FACILITATOR_URL=https://...` | Verify and settle are delegated. This process never holds a key. | The facilitator |
| `FACILITATOR_PRIVATE_KEY=0x...` | This process broadcasts the authorization itself. Needs ETH on the chosen network. | You |
| neither | Self-settle from an ephemeral unfunded key. Challenges and verification are real; settlement stops honestly. | Nobody |

The third row is the default because it makes the example runnable by anyone
in one command while refusing to fake the part it cannot actually do.

## Charging for your own endpoint

Swap the handler and keep the middleware. The price, the asset, and the
settlement address are all arguments:

```js
app.get('/v1/quote/:symbol', paywall({ price: '0.01', payTo: MY_ADDRESS }), handler)
```

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
