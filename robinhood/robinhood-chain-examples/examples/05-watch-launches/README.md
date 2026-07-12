# 05 · Watch launches live

Stream Robinhood Chain memecoin launches to the console. Two launchpads run on
mainnet: **NOXA** (one tx deploys the ERC-20, opens a Uniswap v3 pool, and locks
the LP) and **The Odyssey** (a native-ETH bonding curve that graduates to
Uniswap). The example prints recent launch history, then watches for new ones in
real time. Reads only.

**What it proves:** `getRecentLaunches` (historical log scan, RPC-chunked) and
`watchLaunches` (live poll) decode both launchpads into one `Launch` shape.

## Prerequisites

- Node ≥ 20. No wallet or key. See [example 02](../02-stock-price-sdk) for the
  local `hoodchain` install note.

## Run

```bash
npm install && npm install ../../../robinhood-chain-sdk
npm start        # 20s live window after the history dump
node index.js 0  # stream forever (Ctrl-C to stop)
```

## Expected output

```
Recent launches (scanning back ~1M blocks)…
  noxa    0xdB9B…8296  by 0x7249…374A  blk 6880192  pool 0xFC05…340D
  noxa    0x4C60…285D  by 0x8359…c3A1  blk 6880259  pool 0xbD98…5576
  ...
  noxa    0x955b…6B44  by 0x4Ba0…bdc2  blk 6880646  pool 0xEFD7…6272
  … 4356 launches total in range.

Streaming new launches for 8s…
```

New launches appear as `NEW …` lines with an explorer link the moment they land.
The 1M-block window above held **4,356** launches — mainnet is busy in bursts, so
a short live window may show none (as here); widen the window or run with `0`.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
