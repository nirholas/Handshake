# Mission Control: the keyboard-first pump.fun trading terminal

Mission Control is the cockpit of the three.ws trading stack. It fuses the live pump.fun launch firehose with intel scores, Trade Safety Firewall verdicts, and smart-money flow into one keyboard-driven, three-pane terminal, streams your agent's open positions with live PnL, and lets you buy or sell in a single keystroke from your agent's custodial Solana wallet behind the platform's server-side firewall and MEV-protected execution path. Every other trading surface is read-only. This is the one where you pull the trigger.

Page: [/terminal](https://three.ws/terminal)

APIs (all real, all called by the page): `/api/pump/trades-stream` (SSE firehose), `/api/pump/intel`, `/api/pump/safety`, `/api/intel/smart-money`, `/api/pump/coin`, `/api/pump/price-history`, `/api/pump/dex-trades`, `/api/sniper/stream` (SSE positions), `/api/sniper/leaderboard`, `/api/sniper/history`, `/api/sniper/radar`, `/api/agents/:id/solana`, `/api/agents/:id/solana/holdings`, `/api/agents/:id/solana/trade`.

## Why it exists

Early pump.fun trading punishes context-switching. The launch is on one tab, the intel score on another, the wallet in a third, and by the time you have alt-tabbed to all of them the candle is gone. Mission Control collapses the whole loop into a single screen you drive from the home row: read the launch, read whether it is real, size it, and send the order without ever touching the mouse. It sits at the top of the [trading surfaces](./trading-surfaces.md) map. Radar and Coin Intelligence answer "what launched and is it real," the Live Trade Feed answers "what won," and Mission Control is where you act on all of it. It is the only surface that executes.

## How it works

The page mounts `mountMissionControl` from `src/mission-control/index.js` and lays out three panes:

- **Feed (left).** Three switchable sources. `live` is the new-mint and graduation firehose over Server-Sent Events (`/api/pump/trades-stream`). `signals` is the Coin Intelligence Engine's scored feed (`/api/pump/intel?view=feed`), each coin carrying a 0 to 100 `quality_score`, a verdict, and risk flags. `radar` is the pre-launch precursor stream (`/api/sniper/radar`).
- **Focus (center).** The selected coin's identity and market state (`/api/pump/coin`), its candlestick chart (`/api/pump/price-history`, Birdeye with a GeckoTerminal fallback and a last-good-candles degrade), the live trade tape (`/api/pump/dex-trades` polled every 8s for graduated pairs the stream misses), the firewall verdict, and the smart-money read.
- **Positions (right).** Your agent's open positions with streaming unrealized PnL over SSE (`/api/sniper/stream`, DB-polled every 1.5s), spot holdings (`/api/agents/:id/solana/holdings`, refreshed every 30s), and a one-tap quick exit.

Signed out, or signed in without an agent wallet, the cockpit stays fully readable: the feed, chart, security grid, and smart-money read all work, while the trade desk and the Positions pane say exactly what unlocks trading (sign in, or create an agent wallet) and the Positions connection pill reads idle instead of reconnecting. Token art is served through the same-origin `/api/img` proxy because the public IPFS gateways most launches use refuse direct browser requests. The top bar also hosts the language picker: on phones the site-wide floating picker would otherwise cover the Positions tab of the bottom pane switcher.

Each row in the feed is enriched on demand by `enrich.js`, which fans out three cached reads per mint: intel (`/api/pump/intel?mint=`), the Trade Safety Firewall (`/api/pump/safety?mint=&amp;amount=`, which runs an SPL authority audit plus an on-chain simulated buy then sell round-trip and returns `allow` / `warn` / `block`), and smart money (`/api/intel/smart-money?mint=`). Failures cache `null` and mark the field unavailable rather than retry-storming or faking a value.

Every SSE endpoint self-closes about every 90 seconds by design; `realtime.js` treats an `event: close` as normal and fast-reconnects, with exponential backoff only on real errors.

## The keyboard

The keyboard is the point. Shortcuts are suppressed while focus is in an input, textarea, or select, and ignored when a modifier key is held.

| Key | Action |
| --- | --- |
| `j` / down arrow | Next launch in the feed |
| `k` / up arrow | Previous launch |
| `b` | Buy at the active size preset |
| `s` | Sell the entire position |
| `1`-`6` | Pick a buy-size preset |
| `/` | Focus the feed filter box |
| `g` | Jump to the top of the feed |
| `x` | Toggle Express mode (instant vs confirm-first) |
| `?` | Open or close the shortcuts overlay |
| `Esc` | Close overlay, blur input, or clear |

## Filters and saved views

The filter bar (state in `store.js`) narrows the feed by source, free-text query (name, symbol, or mint substring), a minimum-intel floor that cycles through 0 / 40 / 60 / 80, a firewall verdict (`allow` or `warn`; a `block` coin is always hidden when a verdict filter is set), a smart-money-only toggle, a has-socials toggle, and a market-cap band (nano under 10k, micro 10k to 50k, small 50k to 250k, mid 250k and up, in USD). Any filter set can be saved as a named **view**, persisted per user in `localStorage` (`mc:views:v1:<userId>`, up to 24, newest first). Buy-size presets default to 0.1, 0.25, 0.5, and 1 SOL and persist at `mc:presets:v1`.

## Firewall, MEV, and trading from your agent wallet

Trading is the guarded path, and the client checks are only a fast gate: the server is the real authority. `POST /api/agents/:id/solana/trade` is owner-only (session or bearer auth, then agent-ownership verification) and, for a real execute, requires a single-use `x-csrf-token` and an `idempotency_key`. A `{ preview: true }` call returns a live quote, moves no funds, and surfaces any guard that would reject the execute as a warning instead of a rejection. On execute the server runs a fixed enforcement order: fresh quote (a pump.fun mayhem-mode coin is refused here with HTTP 422 `mayhem_blocked`, on preview and execute alike), kill switch, per-trade cap, daily budget, spend-limit enforcement, price-impact breaker, then the Trade Safety Firewall on buys only (`assessTradeSafety`; a `block` returns HTTP 422 `firewall_blocked`; a sell brings SOL inward and skips it), then SOL headroom, then it claims the idempotency slot and submits through the MEV engine (`submitProtected` with `tipMode 'off'`: dynamic compute budget from a real simulation and a Helius priority-fee estimate on a protected single-tx send; the engine's Jito bundle-with-tip route exists but is not used by this endpoint). The agent's key is decrypted only at signing time via `recoverSolanaAgentKeypair`, and every attempt is audit-logged. A retried idempotency key never double-spends; a previously failed key returns 409. The firewall thresholds live in `api/_lib/trade-firewall.js`: block at score 45 and below, warn at 70 and below, with a fatal check (a dead sell leg or no venue) forcing `block` regardless of score.

Express mode (`trade.js`): the first trade always shows a confirm modal; accepting sets a per-agent express flag so later orders execute instantly. `x` toggles it back off.

## Walkthrough

1. Open [/terminal](https://three.ws/terminal). Signed out, the cockpit is fully readable and the trade ticket reads "Sign in to trade."
2. Sign in and select a trading agent. The topbar shows the agent's Solana address and SOL balance (`/api/agents/:id/solana`, polled every 30s).
3. Leave the feed on `live` and watch new mints arrive. Press `j` and `k` to move the selection; each row enriches with its intel score, firewall verdict, and smart-money read.
4. On a coin you like, press `1`-`6` to choose a size preset, glance at the Focus pane's firewall verdict and security cells, then press `b`. The first buy asks you to confirm; accept to arm Express for that agent.
5. Watch the fill and the new position stream into the right pane with live PnL. Press `s` to exit the whole position when you are done.

## Examples

The read surfaces powering the panes are public and IP rate-limited, so you can pull the same data any agent sees:

```bash
# The Signals feed: scored launches from the Coin Intelligence Engine
curl 'https://three.ws/api/pump/intel?view=feed&network=mainnet&limit=20'

# The Trade Safety Firewall verdict for a mint at a 0.05 SOL probe size
curl 'https://three.ws/api/pump/safety?mint=<MINT>&network=mainnet&amount=0.05'

# Who reputable is net-buying a coin
curl 'https://three.ws/api/intel/smart-money?mint=<MINT>&network=mainnet'
```

Stream the same new-mint firehose the Feed pane consumes:

```javascript
const es = new EventSource('https://three.ws/api/pump/trades-stream');
es.addEventListener('mint', (e) => console.log('new launch', JSON.parse(e.data)));
es.addEventListener('graduation', (e) => console.log('graduated', JSON.parse(e.data)));
// The stream self-closes about every 90s; reconnect on 'close'.
```

Pass `?mint=<MINT>` (up to 20, comma separated) to receive that token's `trade`
events instead of the global firehose. A mint that is not a base58 Solana
address is rejected with a `400 invalid_mint` before the stream opens.

Per-token trades come from PumpPortal's `subscribeTokenTrade`, which it gates
behind an API key funded with at least 0.02 SOL (`PUMPPORTAL_API_KEY`). When
that subscription is refused the socket stays open but no trade can ever
arrive, so the server forwards the refusal as a `notice` event. Listen for it
and show a degraded state rather than an idle-looking live tape:

```javascript
const trades = new EventSource('https://three.ws/api/pump/trades-stream?mint=<MINT>');
trades.addEventListener('trade', (e) => console.log('trade', JSON.parse(e.data)));
trades.addEventListener('notice', (e) => {
	// { code: 'upstream_subscription_refused', message, detail, kind, mints }
	console.warn('live trades unavailable', JSON.parse(e.data));
});
```

Settled trades for graduated coins are unaffected: they come from
`/api/pump/dex-trades`, which needs no PumpPortal credential.

## States and limits

- **Auth.** The page runs read-only signed out. Trading, `/api/sniper/history`, and the holdings and trade endpoints require a session or bearer token plus ownership of the agent. Signed out, the ticket links to `/login?next=%2Fterminal`.
- **Rate limits.** The public reads are IP rate-limited (`mcpIp` on the stream and smart-money, `publicIp` on safety, `authedReadIp` on sniper history). The trade endpoint is auth and CSRF gated.
- **Streaming.** All SSE endpoints self-close roughly every 90 seconds and the client fast-reconnects; connection pills surface `live`, `reconnecting`, or `down`.
- **Honest empty and error states.** Enrichment caches `null` on failure and marks the field unavailable. The chart never fabricates candles (it degrades to last-good with a `stale` marker or shows empty). Positions distinguish "stream unreachable" from "no open positions," and the trade tape shows "Waiting for trades..." rather than inventing fills.
- **Refresh cadences.** Balance and holdings 30s, signals and radar 12s, dex-trades 8s, position poll 1.5s.

## Related

- [The trading surfaces: Radar, Mission Control, Live Trade Feed, Watchlist, Coin Intelligence](./trading-surfaces.md)
- [Coin Radar](./radar.md) and [Smart Money Radar](./smart-money.md) feed the same intel into their own surfaces
- [Oracle: the conviction engine](./oracle.md) supplies the fused conviction score
- [Financial controls and custody guardrails](./financial-controls.md) and [custody](./custody.md) document the server-side rails every order runs through
- Pages: [/terminal](https://three.ws/terminal) · [/radar](https://three.ws/radar) · [/trades](https://three.ws/trades) · [/watchlist](https://three.ws/watchlist)
