# Feature 15: live activity ticker and hype moments

A live world should feel alive even when you just stand there. The market already drives world FX (`market-reactor.js`) and the chart jumbotron streams real trades; what is missing is a human-readable pulse: who joined, who bought, what just happened. Build the ticker and the hype moments on top of the feeds we already have.

## Where the code lives

- Market-to-world FX: `src/game/market-reactor.js`; trade feeds: `src/game/chart-screen.js` (`/api/pump/coin-trades`, `/api/robinhood/coin-trades` for hoodchain worlds)
- Player joins/leaves: the Colyseus room state in `src/game/community-net.js` (the HUD online count already consumes it)
- In-world purchases worth celebrating: cosmetics buys, wheel wins, x402 payments (`agent-commerce.js`, `x402-jumbotron.js`)
- HUD layer + toast precedent: `src/game/coincommunities-ui.js`, styles in `src/game/coincommunities.css`

## What to build

1. **The ticker.** A compact, low-key activity feed (bottom corner opposite chat, collapsible, off by default on small screens) streaming real events: player joined, buy of size X, wheel win, cosmetic purchase, quest completion if Feature 13 landed. Real data only; if a feed is quiet the ticker is quiet. Cap the DOM (virtualize or prune old rows) so an hours-long session never leaks nodes.
2. **Hype moments.** Threshold-based celebrations sourced from the real trade feed: a genuinely large buy for this coin triggers a short world moment (jumbotron flash, sound if unmuted, brief FX through the existing market-reactor hooks). Tune thresholds per-coin from recent trade sizes, not a hardcoded dollar number, so small coins get moments too. Strict cooldown so a volatile minute cannot strobe the world.
3. **Privacy and abuse.** Wallet addresses truncated, player names as rendered in nameplates only, no external links from ticker rows, and coin metadata treated as untrusted display text (it never becomes markup or instructions).
4. **Performance envelope.** Zero per-frame cost when nothing is happening; the ticker must respect the frame governor and never touch layout during the render loop.

## Verify

- On `npm run dev` against the live trade feed for the $THREE mint: rows appear on real trades, a simulated large-trade payload (dev-only injection through the same code path, removed before commit is not required if it is a proper debug hook gated off in production) triggers exactly one hype moment with cooldown honored.
- Two-browser join/leave shows in the ticker. DOM node count stays bounded after 15 minutes.
- `npm test` green; add a unit test for the threshold tuner.

## Report format

Files shipped, the threshold logic in two sentences, measured DOM/node behavior over a soak, and the `data/changelog.json` entry.
