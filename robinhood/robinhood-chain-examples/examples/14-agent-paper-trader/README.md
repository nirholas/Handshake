# 14 · Agent paper trader

A minimal momentum strategy loop: poll real Chainlink prices via `hoodchain`,
simulate buys on a dip and sells on a bounce against a virtual USDG balance.
**No wallet, no real funds, no on-chain transaction** — every fill is logged
and tracked in memory only ("paper mode").

**What it proves:** the read surface (`getQuote`) is enough to wire a strategy
loop end to end; swapping in real execution later (`executeSwap`, from example
04) is a few lines, not a rewrite.

## Prerequisites

- Node ≥ 20. No wallet, no key, no funds — this never sends a transaction.

## Run

```bash
npm install && npm install ../../../robinhood-chain-sdk
npm start           # 60s session, polls every 15s
node index.js 0     # run until Ctrl-C
```

## Expected output

```
[03:26:45] Paper trading AAPL, TSLA, NVDA — starting book $10000.00 USDG (simulated).
[03:26:45] Strategy: buy on 0.10% dip, sell on 0.10% gain. No real funds, no on-chain tx.

--- session summary ---
fills: 0
cash (USDG): $10000.00
open positions (at entry price): $0.00
estimated total: $10000.00 (started at $10000.00)
```

Captured live, over a real 35-second session. **Zero fills is the honest
result**, not a bug: Robinhood's stock Chainlink feeds update on real market
moves (often on the order of minutes to hours between ticks, per example 01's
"answer age"), so a 15-second polling window rarely straddles two different
answers. Widen the window (`node index.js 0` and leave it running through a
trading session) to see real `BUY`/`SELL` lines print as the feed actually
moves — the strategy logic itself fires correctly whenever `price` changes
between polls, it's the market that was quiet during the capture above.

## The awkward part (and the fix)

The mission for this example was "a minimal `hood-traders` strategy in paper
mode" — but **`hood-traders` doesn't exist yet** (see the root README's SDK
feedback: it's a Wave-2 sibling that hasn't been built). This example is
therefore hand-rolled directly on `hoodchain`'s `getQuote`. It's designed so a
future `hood-traders` package slots in as the strategy object without touching
the polling/logging scaffold around it.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
