# Task: Real-time 3D visualization of $three on-chain activity

Turn the $three trade/holder flow into a live 3D scene holders will want to watch
and share. A "living ecosystem" view, not a table.

## Anchor files
- Trades stream: `api/pump/trades-stream.js`, curve `api/pump/curve.js`, stats `api/pump/helius-stats.js`, dashboard `api/pump/dashboard.js`.
- Token protocol: `api/three-token/[action].js` (`activity`, `burns`, `stats`).
- Existing client plumbing: `src/pump/channel-feed.js`, `src/pump/trade-reactions.js`, `src/pump/dashboard.js`, `src/pump/wallet-monitor.js`.
- $THREE mint: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`.
- Create a new page `pages/pump-visualizer.html` already exists — build into it (check current contents first; replace placeholder content, keep the route wiring in `vite.config.js`).

## What to build
A real-time 3D scene where:
- **Each trade** spawns a visual event — a node/orb flying in, sized by trade value, colored buy/sell, labeled with the (truncated) wallet.
- **Whales** (large trades) get a distinct, bigger, louder treatment (reuse logic/thresholds from `src/pump/pumpkit-whale.js` if present).
- **The bonding curve / price** is represented spatially (e.g. a 3D curve or a central mass that grows with market cap).
- **Burns** trigger a dedicated effect.
- A clean HUD overlays live totals (24h volume, holders, last price) with designed loading/empty/error states.

## Requirements
1. **Real streaming data** — consume `api/pump/trades-stream.js` (SSE/poll as it's implemented; read the endpoint to see). Reconnect with backoff on disconnect; show connection status.
2. **Performance** — pool/recycle objects so a burst of trades doesn't allocate-thrash; cap particle count; 60fps; lazy-load Three.js; cap DPR on mobile.
3. **Empty state** — when there's no recent activity, the scene idles elegantly and says so.
4. **Responsive** + reduced-motion fallback.

## Constraints
- No replayed/fake trades. Only real stream data. If the stream is down, show the reconnecting state.

## Definition of done
- `npm run dev` → `/pump-visualizer`: real trades render in 3D in real time; whales + burns distinct; HUD shows real totals.
- Reconnect works; 60fps under load; responsive; zero console errors.
- `npm run build` clean. Run the **completionist** subagent. Report the architecture + data flow.
