# 01 · Read a Stock Token price (viem only)

The "hello chain" baseline. Connect to Robinhood Chain mainnet, read one
tokenized stock's **Chainlink price feed**, print the price — using nothing but
[`viem`](https://viem.sh). No SDK. This is the raw version so you can see
exactly what [`hoodchain`](../02-stock-price-sdk) does for you in three lines.

**What it proves:** the chain is a normal EVM L2 (chain ID `4663`), viem ships
its official chain definition (`import { robinhood } from 'viem/chains'`), and
every Stock Token has a live Chainlink `latestRoundData()` feed.

## Prerequisites

- Node ≥ 20. No wallet, no key, no funds — public RPC reads only.

## Run

```bash
npm install
npm start            # AAPL
node index.js NVDA   # or TSLA, NVDA
```

## Expected output

```
Robinhood Chain (4663) — block 7729451
AAPL token 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9
  Chainlink feed 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0
  price: $315.50  (answer age 39.3h)

Note: Robinhood feeds are already corporate-action adjusted — this is the
total-return token price, not the raw share price. See example 03.
```

(Captured live. Feeds follow US market hours 24/5, so a weekend read shows an
answer that is a day or two old — that is expected, not stale.)

## Why the "already adjusted" note matters

Robinhood's Chainlink feeds return the **total-return token price**, with the
ERC-8056 `uiMultiplier()` corporate-action factor already applied upstream. The
number one bug in third-party trackers is multiplying the feed price by the
multiplier a second time. Don't. [Example 03](../03-portfolio-valuation) shows
the correct math for share-equivalent balances.

## The awkward part (and the fix)

This baseline hard-codes token + feed addresses for a handful of symbols. There
are **95** Stock Tokens. Maintaining that table by hand is exactly the job the
SDK's bundled registry does — see [example 02](../02-stock-price-sdk).

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
