# Task: $three token page upgrade — real bonding curve + live trades

Make the coin page the definitive place to understand $three: real-time price,
real bonding curve, live trade tape, holders, burns — premium and trustworthy.

## Anchor files & data
- Pages: `pages/pump-coin-page.html`, `pages/pump-live.html`, `pages/pumpfun-buy.html` (read all; build the canonical coin page — likely `pump-coin-page.html` — and link the others).
- Data: `api/pump/curve.js` (bonding curve), `api/pump/trades-stream.js` (live tape), `api/pump/helius-stats.js`, `api/pump/dashboard.js`, `api/three-token/[action].js` (`stats`, `burns`, `activity`).
- Client: `src/pump/bonding-curve-chart.js`, `src/components/bonding-curve.js`, `src/pump/pump-swap-quote.js`, `src/pump/dashboard.js`, `src/components/PriceBadge.js`.
- $THREE mint: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`. Reuse the shared data hook from task 14 if present (`src/pump/three-token-data.js`).

## What to build (every widget with loading/empty/error states)
1. **Price header** — live price, 24h change, market cap, holders, total burned. Updates in real time.
2. **Bonding curve chart** — render the REAL curve from `api/pump/curve.js` (reserves/progress to graduation). Show current position on the curve and % to graduation. No mock curve.
3. **Live trade tape** — stream from `api/pump/trades-stream.js`: time, side, size, price, wallet (truncated). Auto-scrolls, reconnects with backoff, shows connection status.
4. **Buy/sell entry** — wire to the real swap path (`src/pump/pump-swap-quote.js` / `swap-jupiter.js` / the `trade` skill). Show a real quote before confirm. If wallet not connected, prompt connect.
5. **Burns + activity** — recent burns and protocol activity feeds.

## Constraints
- 100% real data and real quotes. No fabricated price history — if historical candles aren't available from an endpoint, build/serve them from real trade data, don't fake them.
- Handle stream disconnects and failed quotes as designed states.

## Definition of done
- `npm run dev`: coin page shows live price, real bonding curve, streaming trades, working quote.
- Reconnect + error states work; responsive; zero console errors. `npm run build` clean.
- Run the **completionist** subagent. Report data sources per widget and the swap path used.

> Shares token data plumbing with 13/14/17 — let task 14 land the shared hook first.
