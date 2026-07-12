# 07 · Live price webpage (client-side, no backend)

A single `index.html` that shows **live Chainlink prices for 11 Stock Tokens**,
read entirely in the browser via JSON-RPC `eth_call` against the public
Robinhood Chain RPC. No backend, no build step, no API key, **no dependencies**
— which is exactly why it runs on GitHub Pages and is embedded, running, in this
repo's [docs gallery](../../docs/index.html).

**What it proves:** read-only chain calls work straight from a static page.
Prices tick every 15s with up/down flash, per-card answer age, and designed
loading / error / empty states.

## Prerequisites

- A browser. Node ≥ 20 only if you want the convenience `npm start` server.

## Run

```bash
npm start                 # → http://localhost:8007  (zero-dep node:http server)
# — or just —
open index.html           # the page is fully self-contained
```

## What you see

A responsive grid of price cards:

| Symbol | Price | Age |
| ------ | ------ | ------ |
| AAPL | $315.50 | updated 1.6d ago |
| TSLA | $407.82 | updated 1.6d ago |
| NVDA | $210.19 | updated 1.8d ago |
| … | … | … |

(Live values captured from the RPC while building — all 11 feeds returned real
prices: AAPL 315.50, TSLA 407.82, NVDA 210.19, MSFT 384.69, AMZN 245.57, GOOGL
356.72, META 670.67, AMD 558.21, COIN 159.43, PLTR 126.56, SPCX 145.72.)

The status pill reads `live · chain 4663 · 11/11 feeds · every 15s` when
healthy, and flips to a red `RPC unreachable — retrying` state if every read
fails. The 15s answer ages reflect the 24/5 feed schedule (weekend reads are a
day or two old — expected, not a bug).

## How it works (the whole trick)

`latestRoundData()` has selector `0xfeaf968c` and returns five 32-byte words;
the price is word #1 (`int256`, 8 decimals) and the timestamp is word #3. The
page hard-codes the 11 feed addresses from the `hoodchain` registry and decodes
the answer with three lines of `BigInt` math — no ABI library needed.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
