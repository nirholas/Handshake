# Crypto Trading & Analytics

UX Flow Atlas — Cluster 07. Read/monitor dashboards plus the interactive trading surfaces
that sit on the pump.fun + Oracle + sniper data engines. Every route traced to real source.

Routing convention in this repo: `/foo` is served from `pages/foo.html` (Vite multi-page input)
or a pre-built `public/foo.html` (static), wired by `vercel.json` rewrites. Client logic is the
inline `<script type="module">` and/or imported `src/*.js` modules. Watchlist state is a single
shared `localStorage` key `ld_watchlist` used by oracle, radar, watchlist, smart-money,
coin-intel, pump-visualizer and pump-live: adding a coin on any surface shows up on `/watchlist`.

---

### Oracle — `/oracle`
- **Source:** `pages/oracle.html`, `src/oracle.js` (~2500 lines), lazy `src/oracle-graph.js` (3D force graph), `src/oracle-tape.js` (live trade tape in the coin drawer)
- **Entry point:** nav link "Oracle"; direct URL; SEO/share links from `coinShareUrl()`. `/oracle/coin/<mint>` is now a standalone full conviction coin page (server-rendered by `api/oracle-share.js` in the markets-hub style: score dial, pillar bars, chart, launch intelligence), reached from the drawer's "Full page ↗" action. The server-rendered hero also carries the score's measured odds (what share of calls in that band won, against the random-launch base rate, read from `conviction-calibration.json` via `hitRateFor`) and a "Since the call" strip (peak multiple, graduated / rugged / still live, market cap now) joined from `pump_coin_outcomes`, so the first paint and the share preview never show an unqualified 100/prime on a coin the market has already resolved; the share description gets a "since:" clause for the same reason. Coin identity falls back to DexScreener when pump.fun does not answer, coin art is proxied through `/api/img`, and the route is GET-only.
- **Prerequisites / gates:** Public dashboard for all read views (feed, movers, wallets, edge, proof, agents, activity, graph). The **Agent** (arm) tab requires sign-in + an existing 3D agent with a custodial Solana wallet; Live mode spends real (capped) SOL.
- **Steps (N):**
  1. Arrive on `/oracle` → `boot()` populates category filter, binds tab/seg listeners, reads URL filters (`tier`, `category`, `minScore`, `view`), loads the **feed** view.
  2. System: `GET /api/oracle/feed?...` renders conviction cards (0 to 100 score, tier pill prime/strong/lean/watch/avoid). Each card's "Oracle's take" quotes the coin's own evidence (up to two reason clauses served with the feed, each with its lift over the base rate; the pillar template survives only for rows cached before reasons shipped), an odds chip states what that score band has actually returned ("N% held 2x+", shown once the band has 100+ resolved coins), and an outcome chip (graduated ✓ / rugged ✕ / peak Nx) lands once the market resolves the coin. If backend not migrated → "Oracle is warming up" honest empty state.
  3. System: opens SSE `EventSource('/api/oracle/action-stream')` — new scored coins stream in live; "Live · fused conviction" / "Reconnecting…" indicator.
  4. (optional) Filter: click `#tierSeg` tier buttons / category select / min-score / sort seg / ★-watchlist-only toggle / breadth-bar tier segments → `syncFilterUrl()` + `loadFeed()` (URL is shareable). A hero "Join the live Telegram feed" button appears when `/api/oracle/stats` reports a configured public signals channel.
  5. (optional) Switch view tab: `movers`, `wallets` (reputation leaderboard), `edge` (tier backtest win-rate; the hero names the specific bands that invert the ladder instead of claiming calibration, states the fitted event's own hit rate (a 3x run or graduation) beside the stricter clean-win rate, and each calibration row shows "claims N%" next to the realized bar, with "n/a" for an unmeasured band), `proof` (resolved wins), `agents` (agent win-rate ledger), `activity` (live agent actions), `graph` (3D force graph, lazy-imports oracle-graph.js).
  6. (optional) Click a coin card → `openDrawer(mint)` → `GET /api/oracle/coin?mint=...` renders the 4-pillar conviction breakdown (who/how/what/move); oracle-tape.js streams that coin's live trades.
  7. (optional) In the drawer: Full page ↗ (`/oracle/coin/<mint>`), pump.fun ↗, GMGN ↗ (via `src/shared/trading-terminals.js`, referral-tagged), solscan ↗, Details ↗ (`/launches/<mint>`), View in 3D ↗ (`/coin3d?mint=`), ☆/★ Watch (writes `ld_watchlist`), Copy mint, Copy link, Share to X; the live Market panel adds GMGN/DexScreener/GeckoTerminal/Birdeye links when available.
  8. (optional, agents view) Follow an agent's signals: expand follow-panel → enter Telegram chat ID → `POST /api/oracle/follow`.
  9. **Arm payoff (gated):** open **Agent** tab → `loadAgentPanel()` → `GET /api/agents`. Pick agent, set Min conviction (Prime/Strong+/Lean+), Size/trade SOL, Max daily SOL, Max open, category filters, optional Telegram chat ID (Send test → server push), toggle Armed + Live/Simulate switches → **Save configuration** → `POST /api/oracle/watch` `{armed, mode, min_score, per_trade_sol, max_daily_sol, max_open, ...}`. Confirmation: "Armed in simulate/live mode. Your agent is watching the stream." Arming live is judged on the raw request, not the clamped values: a `per_trade_sol` below 0.001 SOL or a `max_daily_sol` below `per_trade_sol` answers 400 before any real-money loop starts (simulate keeps the forgiving clamps), and the GET side rejects a non-uuid `agent_id` with 400.
- **Decision points / branches:** view tabs (9); feed warming vs populated vs filtered-empty; drawer coin scored vs "not scored yet"; agent has wallet vs needs creation (`/create/studio`); simulate vs live mode; signed-out → "Sign in and arm an agent".
- **External calls / dependencies:** `/api/oracle/feed`, `/api/oracle/coin`, `/api/oracle/search`, `/api/oracle/movers`, `/api/oracle/categories`, `/api/oracle/backtest`, `/api/oracle/wins`, `/api/oracle/stats` (hero statline + Telegram channel link), `/api/oracle/activity`, `/api/oracle/watch` (GET+POST), `/api/oracle/follow` (GET+POST), `/api/agents`; SSE `/api/oracle/action-stream`; oracle-tape live trade stream in drawer.
- **Success state:** live conviction feed scoring every pump.fun launch in real time; coin drawer with pillar breakdown; armed agent acting on the stream (simulate logs / live spends capped SOL), actions graded into a win-rate ledger.
- **Empty / error states:** "Oracle is warming up" (backend not live); "No launches clear your filters" + Reset; drawer "not scored"; "No ranked agents yet"; SSE auto-reconnects ("Reconnecting…"); `api()` returns `{ok:false}` on timeout (12s abort) and degrades gracefully; during a database outage the oracle endpoints (stats, feed, coin, activity, backtest, categories, follow, batch) answer 503 with Retry-After instead of a confident empty record, so the page shows its warming/retry state rather than "0 scored, 0 armed".
- **Step count:** 3 required (arrive → feed → live stream, all automatic) + ~6 optional read interactions, + a 6-field gated arm flow (steps 8–9).

---

### Agent Activity — `/activity`
- **Source:** `pages/activity.html` (self-contained; inline module, no `src/*` import)
- **Entry point:** nav; "Copy trades →" CTAs link to `/trader/<agent_id>`; linked from oracle activity view.
- **Prerequisites / gates:** None — public live monitor.
- **Steps (N):**
  1. Arrive → inline module sets `API='/api/oracle/activity'`, `STREAM_API='/api/oracle/action-stream'`, loads first page.
  2. System: `GET /api/oracle/activity?...` renders rows (agent, verb closed↑/↓/entered, $symbol, tier pill, sim/live tag, outcome win/loss/flat/open, PnL) + summary KPIs. The KPIs merge `/api/oracle/stats` with the 7-day rollup; a value the API does not carry prints "n/a" (never a dash or a fake zero), PnL (7d) stays "n/a" until a settled action carries a realized figure, and the win-rate tile is coloured against the market's own base rate rather than a fixed 50%.
  3. System: opens SSE `/api/oracle/action-stream` — new agent actions prepend live.
  4. (optional) Filter by tier chip, mode pill (sim/live), or outcome → re-fetch with `?tier=&mode=&outcome=`.
  5. (optional) Load more (cursor pagination).
  6. (optional) Click "Copy trades →" on a winning/open row → navigate to that agent's trader profile (`/trader/<id>`).
- **Decision points / branches:** filter combinations; win/open rows show Copy CTA, losses don't; stale badge + retry if a background refresh fails while rows are on screen.
- **External calls / dependencies:** `GET /api/oracle/activity`; SSE `/api/oracle/action-stream`.
- **Success state:** real-time trading floor of every agent's Oracle-driven move, outcomes graded, winners copyable.
- **Empty / error states:** empty feed placeholder; stale/reconnect badge with manual retry button on background-refresh failure; a stats outage renders the KPI tiles as "n/a" instead of leaving the skeleton shimmering.
- **Step count:** 2 required (arrive → feed+stream) + ~3 optional (filter, paginate, copy).

---

### Trending — `/trending`
- **Source:** `pages/trending.html` (inline module; imports `/src/shared/agent-wallet-chip.js`)
- **Entry point:** nav "Trending"; footer; share links.
- **Prerequisites / gates:** None — public dashboard.
- **Steps (N):**
  1. Arrive → inline module binds tab buttons (Agents / Trusted / Coins; arrow keys move between them) + window buttons (24h / 7d / All time), honors a `?tab=` deep link and keeps it in the address bar with `pushState`, loads default (Agents, 24h).
  2. System: `GET /api/trending?window=24h&limit=10` renders ranked list (agents by real chat activity, with wallet chip; coins by Oracle conviction score among coins scored inside the selected window, or every retained coin for All time, with ties broken by momentum and smart-wallet count so the board does not reshuffle on reload).
  3. (optional) Switch tab Agents / Trusted / Coins → renders the other ranked list; Trusted reads `GET /api/reputation/leaderboard?limit=25`, an all-time wallet-trust score, so the window control hides on that tab.
  4. (optional) Switch window 24h/7d/All time → re-fetch with new `window`; the legends and the coin empty state name the window.
  5. (optional) Click a row → `/agents/<id>` for an agent, `/oracle/coin/<mint>` for a coin, `/agents/<id>/wallet#reputation` for a trusted row. The whole row is the link, so the wallet chip renders without its Tip button and popover (tipping lives on the agent page).
- **Decision points / branches:** Agents / Trusted / Coins tab; 3 time windows; per-tab retry button on fetch failure.
- **External calls / dependencies:** `GET /api/trending?window=&limit=10`; `GET /api/reputation/leaderboard?limit=25` (Trusted tab).
- **Success state:** what's hot right now — top agents and top conviction coins across windows.
- **Empty / error states:** per-tab designed empty copy that names the window ("No agent chats in this window yet.", "No coins scored in the last 24 hours.") with a widen-the-window hint and a `/create` or `/oracle` link; per-tab error + Retry button (`#agentRetry` / `#coinRetry`). Server side, an unparseable `limit` falls back to 10 (max 20) instead of failing both rankings into a fake "nothing trending", and a ranking that does fail is logged before it degrades to empty.
- **Step count:** 2 required (arrive → list) + ~3 optional (tab, window, drill-in).

---

### Trade Terminal - `/trades`
- **Source:** `pages/trades.html`, `src/trades.js` (controller), `src/trades-detail.js` (deep-dive; imports `src/mission-control/chart.js`, `src/widgets/bonding-curve.js`, `src/trades-bubblemap.js`, `src/trades-tape.js`, `src/trader-format.js`)
- **Entry point:** nav; footer newsletter page link; deep link `?mint=<base58>` (+ `&tab=exits`, `&network=devnet`).
- **Prerequisites / gates:** None; public two-pane pump.fun analytics workstation. Only three.ws data (platform launches + agent exits) feeds the left rail; any mint can be pasted for a deep-dive.
- **Steps (N):**
  1. Arrive → `readUrl()` restores mint/tab/network (network persisted to localStorage `tf_network`); the deep-dive mounts immediately with the URL mint, or $THREE by default (never an empty void).
  2. System: left rail loads the active tab: **Launches** (`GET /api/pump/launches?network=&limit=40`, $THREE pinned at the top) or **Exits** (`GET /api/trades/feed?network=&window=7d&min_pnl_pct=10&limit=40`); refreshes every 30s. Header pulse (`GET /api/pump/helius-stats`, 20s) shows network mint rate, graduations/hour, and SOL price ± 24h change.
  3. System: centre deep-dive (`mountDetail`) paints header + skeleton instantly from the clicked row, then fills progressively from five live endpoints (`/api/pump/launch-detail`, `/api/pump/curve`, `/api/pump/intel`, `/api/pump/smart-money`, `/api/coin/:mint/cohorts`; cohorts only for platform-tracked coins) plus three self-fetching widgets: candlestick chart, bonding-curve ring, live trade tape. A row clicked in the Exits tab carries its trade with it, so an "Agent exit" card (realized PnL, exit multiple, hold time, entry/exit SOL, exit reason, entry/exit tx links, the agent's `/agents/<id>` link and "Copy trader →" to `/trader/<id>`) paints with the shell, no second round-trip. The price strip reads a migrated coin as Graduated even when the curve account is closed, and swaps the SOL cell for a "Price source" cell (Jupiter / pump.fun curve) once there is no curve price to quote.
  4. (optional) Switch tab Launches ↔ Exits (`#ttTabs`) → reload rail; URL synced.
  5. (optional) Change network mainnet/devnet (`#ttNetwork`, persisted) → reload rail + remount deep-dive.
  6. (optional) Paste a mint into `#ttSearch` (base58-validated) → drives the deep-dive for that coin.
  7. (optional) Click any rail row → `select(mint)` remounts the deep-dive (re-selecting the mounted coin is a no-op); URL reflects `?mint=` for sharing.
- **Decision points / branches:** Launches vs Exits tab; mainnet vs devnet; platform-tracked coin (cohorts fetched) vs external mint (designed no-data state); each detail lane (curve / detail / intel / smart) degrades independently: a lane that threw says "Could not load this section. The request to three.ws failed." with its own ↻ Retry that reruns only that lane, while a coin the first-seconds indexer never observed gets designed not-indexed cards pointing at `/oracle/coin/<mint>`, Bubblemaps and Solscan instead of being blamed for an outage.
- **External calls / dependencies:** `GET /api/pump/launches`, `GET /api/trades/feed`, `GET /api/pump/helius-stats`, `GET /api/pump/launch-detail`, `GET /api/pump/curve`, `GET /api/pump/intel`, `GET /api/pump/smart-money`, `GET /api/coin/:mint/cohorts`.
- **Success state:** live two-pane terminal: rail of platform launches/exits, deep-dive with chart, bonding curve, holders/cohorts, funder bubblemap, smart money, wallet footprint, trade tape, outcome, agent economics; shareable `?mint=` URL.
- **Empty / error states:** per-tab empty copy that stays visible under the pinned $THREE row ("No launches indexed on this network yet." / "No agent exit cleared the +10% bar in the last 7 days." with a "Browse launches" action; on devnet both offer "Switch to mainnet"); feed load failure ("Could not load the launch feed." / "Could not load the agent exit feed." + Retry) only on a cold load, since a failed 30s refresh leaves the rows already on screen alone; per-lane retryable failure and not-indexed states in the deep-dive; the trade tape says "Live trades are unavailable for this coin right now. Showing settled trades only." and drops its live lamp when PumpPortal refuses the subscription; pulse failures silent (decorative).
- **Step count:** 3 required (arrive → rail + deep-dive) + ~4 optional (tab, network, search, row select).

---

### Trader Leaderboard — `/leaderboard`
- **Source:** `pages/leaderboard.html`, `src/leaderboard.js` (imports `src/trader-format.js`, `src/shared/agent-wallet-chip.js`)
- **Entry point:** nav "Leaderboard"; footer.
- **Prerequisites / gates:** None — public ranked board.
- **Steps (N):**
  1. Arrive → `readUrl()` hydrates state (network/window/sort/verified), live-refreshing every 20s.
  2. System: `GET /api/sniper/leaderboard?network=&window=&sort=&verified=` renders ranked rows (agent name + verified badge, wallet chip, unique coins, copiers count); top 3 styled.
  3. (optional) Window: 24h/7d/30d/all (`#lb-window`) → URL + reload.
  4. (optional) Network: mainnet/devnet (`#lb-network`).
  5. (optional) Sort: score/pnl/winrate/roi (`#lb-sort` select).
  6. (optional) "Verified only" checkbox (`#lb-verified`).
  7. (optional) Click a row → trader profile (`src/trader.js`, `/trader/<agent_id>`) with full track record, equity curve, proof tab with on-chain tx, copy-trading panel, shareable PnL card.
- **Decision points / branches:** 4 windows × sort × network × verified; stale/reconnecting badge when a background refresh fails with a board already on screen.
- **External calls / dependencies:** `GET /api/sniper/leaderboard`; row payoff `GET /api/sniper/trader` (on trader page).
- **Success state:** shareable ranked board; every number deep-links to its on-chain transaction via the trader profile.
- **Empty / error states:** "No agent has closed a sniper position in this window…" with guidance (widen window / disable verified); `#lb-retry` button on load failure; stale badge.
- **Step count:** 2 required (arrive → board) + ~5 optional (filters, sort, drill to trader).

---

### Coin Radar — `/radar`
- **Source:** `pages/radar.html`, `src/radar.js` (imports `src/shared/log.js`, mounted via `mountRadar`)
- **Entry point:** nav; share links.
- **Prerequisites / gates:** None — public dashboard.
- **Steps (N):**
  1. Arrive → `mountRadar()` reads URL (`category`, `minQuality`), builds toolbar, polls every 12s.
  2. System: `GET /api/pump/coin-intel?...` renders coins observed in first ~90s of trading — classified, risk-scored ("organic, or a bundle/rug?"). Unmeasured signals render "not measured", never 0.
  3. (optional) Filter by category chips (meme/ai/tech/…) → URL + reload.
  4. (optional) Min-quality slider → reload on change.
  5. (optional) Watch toggle per coin → `ld_watchlist`.
  6. (optional) Click a coin card → detail drawer → `GET /api/pump/coin-intel?mint=<mint>&wallets=1` (single-coin wallet breakdown). Each mainnet card's "Full intel →" action and the drawer's "Open full page" link go straight to the coin's full intelligence page at `/oracle/coin/<mint>`; devnet coins have no page, so their button keeps opening the drawer.
- **Decision points / branches:** category × quality filters; risk-flag pills (bundle_launch, dev_dumped, single_whale, low_diversity, fresh_wallet_swarm, sell_pressure, sniped) with danger/warn tones; drawer open/closed.
- **External calls / dependencies:** `GET /api/pump/coin-intel` (list) and `?mint=&wallets=1` (detail); `/api/img` for logos.
- **Success state:** live launch-intelligence feed; every number traces to an observed on-chain trade.
- **Empty / error states:** "not measured" for null signals; empty/loosen-filters guidance; image fallback to seeded identicon.
- **Step count:** 1 required (arrive → live feed) + ~5 optional (filters, watch, inspect).

---

### Watchlist — `/watchlist`
- **Source:** `pages/watchlist.html`, `src/watchlist.js` (imports `src/pump/coin-status-card.js`)
- **Entry point:** nav; closes the loop from any "Watch" button across the platform (writes `ld_watchlist`).
- **Prerequisites / gates:** None — device-local, private, no account. Synced across tabs via `storage` event.
- **Steps (N):**
  1. (prerequisite) On any coin surface (oracle/radar/trades/launches/etc.) click ☆ Watch → mint stored in `ld_watchlist`.
  2. Arrive on `/watchlist` → `readList()` reads + validates mints (base58 32–44).
  3. System: for each mint mounts a live coin-status card (`mountCoinStatus` → one `/api/pump/coin` fetch/coin), with deterministic mint identicon placeholder behind real pump.fun logo; refreshes every 90s. A parallel `GET /api/oracle/batch?mints=` sweep (chunks of 20) paints a conviction badge per card; a mint the Oracle answered for but has not scored gets an "unrated" badge linking to `/oracle/coin/<mint>`, and a chunk that failed leaves its cards' badges untouched rather than calling them unscored.
  4. System: detects tier upgrades vs `wl_last_tiers` and surfaces changes. The summary tiles (market cap, 24h volume, graduated, average conviction) aggregate only the coins that actually report each figure, with a hover note giving the coverage ("Combined across 3 of 5 watched coins"), and the tier bar carries a muted "not scored yet" segment for the remainder so the distribution never implies an opinion the Oracle has not given.
  5. (optional) Toggle alerts (`#wl-alerts`, `wl_alerts_on`).
  6. (optional) Clear list (`#wl-clear`).
  7. (optional) Click a card → the coin's Oracle page (`/oracle/coin/<mint>`).
- **Decision points / branches:** empty list vs populated; tier-upgrade highlighting; alerts on/off; cross-tab storage sync.
- **External calls / dependencies:** `GET /api/pump/coin` (one per watched coin, via coin-status-card); `GET /api/oracle/batch?mints=&network=mainnet` (conviction badges, chunks of 20).
- **Success state:** private tracked-coin board with live status cards, tier-change detection, deep links back to profiles.
- **Empty / error states:** empty state when no mints saved (tells user to Watch coins elsewhere); invalid mints filtered out; per-card load handled by coin-status widget; a summary tile shows the no-value dash rather than a fabricated $0 when no coin reports the figure, and the tier bar reads "Awaiting Oracle scores" or "Oracle unreachable" when nothing is scored.
- **Step count:** 1 required to view (arrive) — payoff depends on the prerequisite Watch action elsewhere; + ~3 optional (alerts, clear, drill-in).

---

### Pump Dashboard (Token Cockpit) — `/pump-dashboard`
- **Source:** `pages/pump-dashboard.html` (large inline module, ~5000 lines); imports `src/solana/vanity/grinder.js`, `src/solana/vanity/validation.js`, `src/shared/state-kit.js`; uses `src/wallet.js`
- **Entry point:** nav; "Open Token Cockpit →" from `/dashboard/tokens`; `/autopilot`; sitemap; deep link `?agent=<id>` auto-opens the Default Agent panel; `#hash` deep-links any tab.
- **Prerequisites / gates:** Public — no auth/$THREE gate for the core dashboard. Wallet connect is **optional** (unlocks Wallet snapshot). Server-backed tabs (Agents, Alert rules, API keys) return 401 → sign-in prompts. Watches/Claims tabs require a custom PumpKit backend.
- **Steps (N):**
  1. Arrive → `DOMContentLoaded` bootstrap restores config from localStorage (api/ws/rpc/key), resolves `?agent=`/`#hash`, binds nav + controls.
  2. System: `connectApi()` polls `GET /api/healthz` (15s) → status dot; `connectWebSocket()` opens `wss://pumpportal.fun/api/data`, subscribes `subscribeNewToken` + `subscribeMigration` (exponential backoff, 8-attempt cap → manual Reconnect banner).
  3. System: preloads `GET /api/pump/channel-feed?limit=40`, `GET /api/pump/helius-stats` (30s), `GET /api/agents/featured`, `GET /api/pump/trending?limit=25` ($THREE pinned first), config probes, uptime ticker.
  4. (optional) Connect wallet → `wallet:changed` → `POST /api/wallet/balances` renders SOL + top-10 holdings.
  5. (optional) Default tab: inspect monitor stat cards, featured agent, network health, market chart (`chart:tokenChange` → fetch candles), high-conviction Oracle panel, live-feed preview.
  6. (optional) **Live Feed** tab: pause + filter (Launches/Trades/Whales/Graduations/Claims) the rAF-batched WS feed.
  7. (optional) **Token Scanner**: enter mint → scan for risk/honeypot.
  8. (optional) **Quote Engine**: buy/sell quote forms.
  9. (optional) **Alerts**: build a rule (type/scope/threshold/agent + in-app/webhook/Telegram delivery + cooldown) → `POST /api/alerts/rules`; list/toggle/edit/delete; live firing against feed; history from `GET /api/notifications`.
  10. (optional) **Vanity Generator payoff:** enter prefix/suffix → `validatePattern()` (base58, ≤6 chars) → `grindVanity()` spawns up to 8 Web Workers (WASM) → progress (tries/rate/eta) → match → reveal/copy/download keypair JSON (secret never leaves browser).
  11. (optional) **Default Agent**: embed `/agent-embed.html` iframe, speak/gesture via postMessage; manage custom agents (`GET /api/agents`, delete with CSRF).
  12. (optional) **Configuration** (save + reconnect + probes), **API Reference** (create/revoke keys). The Revenue tab and its reporting endpoints were retired from this page on 2026-08-25.
- **Decision points / branches:** 11 hash-routed tabs (dashboard, feed, watches, claims, alerts, scanner, quoting, vanity, animations, config, api); wallet connected vs empty; WS backoff (<8 retry vs ≥8 terminal banner); auth 401 on agents/alerts/keys; PumpKit backend present for Watches/Claims; vanity validation failures; simulate vs server-side alert delivery.
- **External calls / dependencies:** `/api/healthz`, `/api/pump/helius-stats`, `/api/pump/channel-feed`, `/api/pump/trending`, `/api/agents/featured`, `/api/agents` (+CSRF), `/api/wallet/balances`, `/api/pump/scan`, `/api/pump/quote/{buy,sell}`, `/api/alerts/rules` (CRUD), `/api/notifications`, `/api/api-keys` (CRUD); `wss://pumpportal.fun/api/data`; Solana RPC via `/api/solana-rpc`; Phantom/MWA wallet; Web Workers for vanity; model-viewer CDN.
- **Success state:** green API/WS/SOL chips, populated panels, live feed streaming, optional wallet snapshot, working alerts, vanity address found with copy/download.
- **Empty / error states:** featured-agent retry; WS "Realtime feed stopped" + Reconnect after 8 fails; channel-feed retry (downgrades to WS); RPC error chip auto-clears 8s; sign-in prompts on 401; vanity validation toasts; designed empty states for wallet/agents/alerts/feed (state-kit).
- **Step count:** 3 required (arrive → API/WS connect → panels populate) + ~9 optional tab/interaction flows (vanity grind and alert-rule build are the headline interactive payoffs).

---

### Strategy Lab — `/strategy-lab`
- **Source:** `public/strategy-lab.html` (pre-built static; ~720 lines, text-only UI, no 3D); `vercel.json` rewrite `/strategy-lab → /strategy-lab.html`
- **Entry point:** nav / direct URL; `data/pages.json` + changelog entry.
- **Prerequisites / gates:** Validate + Backtest + Simulate run are **public** (read-only MCP, real on-chain data, no signing). **Live run** requires sign-in, an agent with a provisioned Solana wallet, balance ≥ 0.02 SOL, and an explicit confirmation dialog. Network toggle mainnet/devnet.
- **Steps (N):**
  1. Arrive → spec editor + results/portfolio panels render; `GET /api/agents` populates agent dropdown if signed in; pick network.
  2. (optional) Select agent → `onAgentChange()` → `GET /api/agents/{id}/solana?network=` shows wallet address + balance; provision via `POST` if none; low-balance warning < 0.02 SOL.
  3. Load a preset (Momentum / Snipe / Mean-revert) **or** hand-edit the JSON spec (`scan`, `filters`, `entry`, `exit`, `caps`).
  4. **Validate** → `POST /api/pump/strategy-validate` → "Valid — N filters, M exit rules" or red issues list.
  5. (optional) **Backtest** → `POST /api/pump/strategy-backtest` (real on-chain data, no auth) → metrics grid (PnL, ROI, win rate, trades, max drawdown, SOL deployed) + per-trade table.
  6. **Run** → `POST /api/pump/strategy-run` `{durationSec, mode:'simulate'|'live', network, agentId?}` → SSE stream of start/log/enter/exit/skip/done events into the live activity log.
  7. (optional) **Stop** (`activeRun.abort()` → "■ stopped").
  8. (optional) **Portfolio** panel auto-loads on agent select → `GET /api/pump/portfolio?agentId=&network=` (holdings, cost basis, unrealized PnL); **Close All** → `POST /api/pump/strategy-close-all` market-sells everything.
- **Decision points / branches:** preset vs custom spec; Validate→Backtest→Run pipeline; simulate (public) vs live (gated, signs real tx); mainnet vs devnet; portfolio empty vs holdings; balance/auth gates on live.
- **External calls / dependencies:** `/api/agents`, `/api/agents/{id}/solana` (GET+POST), `/api/pump/strategy-validate`, `/api/pump/strategy-backtest`, `/api/pump/strategy-run` (SSE), `/api/pump/portfolio`, `/api/pump/strategy-close-all`; backend MCP → Solana RPC + pump.fun indexer; agent hot wallet signs in live mode.
- **Success state:** spec validates clean; backtest returns trade history + ROI; run executes entries/exits with live-streaming log; portfolio reflects on-chain holdings; positions closable any time.
- **Empty / error states:** "select agent" / "No Solana wallet"; "Invalid — N errors" issues panel; backtest error; low-balance warning; "no token holdings"; "■ stopped"; errors surfaced with `error_description`.
- **Step count:** 4 required (arrive → spec → Validate → Run, simulate path) + ~4 optional (backtest, portfolio, close-all, live mode). Most interactive route in the cluster.

---

### Smart Money Radar — `/smart-money`
- **Source:** `pages/smart-money.html` (self-contained inline module); backend `api/pump/smart-money.js`
- **Entry point:** nav; share links.
- **Prerequisites / gates:** None — public, IP rate-limited only; CORS `*`.
- **Steps (N):**
  1. Arrive → inline module reads `ld_watchlist`, renders 6 skeletons, calls `refresh()`; auto-refresh every 20s (pauses when tab hidden).
  2. System: `GET /api/pump/smart-money?limit=60` (feed: coins ranked by smart_money_score, proven-wallet count, smart buy volume) + parallel `?leaderboard=1&limit=60` (top wallets by reputation).
  3. (optional) Switch view: Feed ("Smart money is buying", with On radar / Graduated / All filters) / Top wallets / Watchlist; the Watchlist view looks up each `ld_watchlist` mint with `?mint=`.
  4. (optional) Watch toggle per coin → `ld_watchlist`.
  5. (optional) Click coin → drawer `GET /api/pump/smart-money?mint=<mint>` (notable wallets, labels) + async `GET /api/oracle/coin?mint=` to enrich with conviction pillars.
  6. (optional) Click wallet → drawer `GET /api/pump/smart-money?wallet=<addr>` (win rate, record, recent coins).
- **Decision points / branches:** Feed vs wallets tab; coin scored vs "not scored"; wallet has record vs none; Oracle enrichment present vs absent.
- **External calls / dependencies:** `GET /api/pump/smart-money` (feed / `?leaderboard=1` / `?mint=` / `?wallet=`), async `GET /api/oracle/coin`. Data sourced from `coin_smart_money` + `wallet_reputation` tables fed by the off-browser sniper engine — no direct browser RPC/WS.
- **Success state:** 60 fresh coins ranked by buyer pedigree; wallet reputation board (smart_money/sniper/dumper/rugger labels); coin + wallet drawers.
- **Empty / error states:** "No proven money on a fresh coin yet"; "No wallets ranked yet"; drawer "Not scored yet" / "No track record yet"; "Couldn't reach the radar" + Retry; stale badge with last-update + "Retry now". A cold failure (nothing cached yet) paints "Couldn't reach the radar" with Retry on both the feed and the Top wallets view and says whether the API answered a status or was unreachable from the browser; the drawers show the explanatory "Not scored yet" (with a pump.fun link) / "No track record yet" (with a Solscan link) only when the radar answered, and offer Retry when it did not; on the Watchlist view a coin the radar could not be reached for reads "Couldn't load this one" with Retry rather than "Not on the radar yet", and if every lookup was unreachable one message covers the whole list.
- **Step count:** 1 required (arrive → feed) + ~5 optional (tab, watch, inspect coin/wallet).

---

### Coin Intelligence — `/coin-intel`
- **Source:** `pages/coin-intel.html` (self-contained inline module); backend `api/pump/intel.js`
- **Entry point:** nav; share links. (Distinct from `/api/pump/coin-intel` used by `/radar`.)
- **Prerequisites / gates:** None — public, IP rate-limited; CORS `*`.
- **Steps (N):**
  1. Arrive → inline module reads `ld_watchlist`, renders category chips + 6 skeletons; `loadStats()` (`?view=learning`) + `loadRadar()`; auto-refresh 15s.
  2. System: `GET /api/pump/intel?view=feed&limit=60` renders cards (quality score ring 0–100, verdict pill strong/watch/caution/avoid, organic-vs-bundle bar, risk flags, narrative).
  3. (optional) Toolbar filters: search (220ms debounce), category chips, verdict dropdown, quality dropdown → `loadRadar()`.
  4. (optional) Watch toggle per coin → `ld_watchlist`.
  5. (optional) Switch tab: Radar / Leaderboard (`?view=leaderboard`) / Smart-Money Traders (`?view=traders`) / What it learned (`?view=learning`, signal weights + outcome distribution + coverage).
  6. (optional) Click coin → drawer `GET /api/pump/intel?mint=<mint>` (full signals + outcome + top wallets classified + funder clusters/bubble-map) + async `GET /api/oracle/coin?mint=` conviction enrichment.
- **Decision points / branches:** 4 tabs; filter combinations; coin observed vs "not observed"; labeled winners vs none; ≥50 labeled coins for trained weights vs baseline; Oracle enrichment present vs absent.
- **External calls / dependencies:** `GET /api/pump/intel` (`view=feed|leaderboard|traders|learning`, `?mint=`), async `GET /api/oracle/coin`. Data from `pump_coin_intel`, `pump_coin_outcomes`, `pump_coin_wallets`, `pump_intel_weights` (off-browser engine). No direct browser RPC/WS.
- **Success state:** live classified-coin radar with verdicts + risk flags; leaderboard of best coins + confirmed winners (ATH multiple); cross-coin trader board; "what it learned" signal-weight transparency; per-coin bubble-map drawer.
- **Empty / error states:** "The engine is warming up"; "No coins match these filters" + Reset; drawer "Not observed yet"; "No labeled winners yet"; "No traders recorded yet"; "Not enough data to train yet"; degraded badge; retry on network failure. The leaderboard's own empty state reads "Nothing scored in the last 24 hours" (the radar's "loosen your filters" copy no longer appears on a tab with no filters); every failed tab (radar, both leaderboard rails, traders, all three learning panels, the drawer) carries its own Retry, and the header stat tiles fall back to dashes beside the amber degraded pulse rather than disappearing.
- **Step count:** 2 required (arrive → radar feed) + ~6 optional (search/filters, watch, tabs, inspect coin).

---

### GMGN Smart Money — `/gmgn`
- **Source:** `public/gmgn.html` (pre-built static; ~900 lines); backend `api/agents/gmgn.js`; `vercel.json` rewrite `/gmgn → /gmgn.html`, `/api/agents/gmgn-feed → /api/agents/gmgn?_handler=feed`
- **Two read lanes on one backend:** `GET /api/agents/gmgn-feed` streams SSE (what this page uses); `GET /api/agents/gmgn` returns the same board as one JSON response for callers that cannot hold a stream open (server-side fetches, agent tool calls, curl). Both accept `chain`, `interval`, and `minSmartBuys`; the JSON lane also accepts `limit` (1-50, default 25) and answers `{ data: { chain, interval, min_smart_buys, source, count, items } }` with the same normalized item shape the `smart_entry` events carry.
- **Entry point:** nav / direct URL.
- **Prerequisites / gates:** None — public live feed. Narration needs browser Web Speech API; "My agents" avatar tab needs auth.
- **Steps (N):**
  1. Arrive → 3D agent (CZ default) loads into `<model-viewer>` (auto-rotate); params parsed (chain=sol, interval=1h, minSmartBuys=2, narrate, avatar, mood).
  2. System: SSE `EventSource('/api/agents/gmgn-feed?chain=sol&interval=1h&minSmartBuys=2')` → `hello` event (status pill "Live · SOL · 1h"), last 10 events replayed (dimmed), then `smart_entry` events stream live.
  3. System per event: render card (symbol, market cap, smart-buy delta, price change), trigger agent animation by delta/new flag, optional TTS narration, increment stats, "↑ N new" jump button if scrolled.
  4. (optional) Change chain (sol/eth/base/bsc), interval (1m–24h), minSmartBuys; mood (chill/normal/hype); narration toggle.
  5. (optional) Avatar picker modal → `GET /api/avatars/public` + `GET /api/avatars` → "Use this avatar" swaps model.
  6. (optional) **Apply** (`#ctl-reconnect`) → `connect()` closes old EventSource, opens new with updated params.
  7. (optional) $THREE spotlight tile updates when smart-money activity hits CA `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`.
- **Decision points / branches:** chain/interval/minSmartBuys filters; narration on/off; mood; default vs community vs my-agents avatar tabs; manual vs auto reconnect.
- **External calls / dependencies:** SSE `/api/agents/gmgn-feed` (upstream GMGN.ai feed via `connectGmgnFeed`); `/api/avatars/public`, `/api/avatars`; model-viewer CDN.
- **Success state:** green live dot; smart-money entries stream with animated, optionally-speaking agent; stats tick; instant reconnect on filter change.
- **Empty / error states:** "Connecting…" (yellow); "Waiting for events…"; "Error — retrying…" with 4–5s backoff auto-reconnect; "Session ended — reconnecting…"; avatar load error recoverable via re-pick.
- **Step count:** 2 required (arrive → SSE feed) + ~5 optional (filters, mood, avatar, reconnect). Mostly a live monitor with reactive avatar.

---

### Pump.fun Live Agent — `/pumpfun`
- **Source:** `public/pumpfun.html` (pre-built static; ~2000 lines); backend `api/agents/pumpfun.js`; `vercel.json` rewrites `/pumpfun → /pumpfun.html`, `/api/agents/pumpfun-feed → /api/agents/pumpfun?_handler=feed`, `…pumpfun-metadata → ?_handler=metadata`
- **Entry point:** nav / direct URL; `?asset=<pubkey>` binds a specific agent.
- **Prerequisites / gates:** Public for the live feed. Binding an agent / viewing its wallet needs auth (`GET /api/agents`). Provisioning a wallet is a `POST`.
- **Steps (N):**
  1. Arrive → 3D agent (CZ default) renders; params parsed (asset, mint, kind=all/mint/graduation/claims, tier, mcMin/mcMax, minBuy, whale, narrate, mood, avatar).
  2. (optional) `GET /api/agents` → pick agent → `onAgentChange()` → `GET /api/agents/{id}/solana?network=mainnet` shows wallet/balance; provision via `POST` if none.
  3. System: SSE `/api/agents/pumpfun-feed?...` (withCredentials) → `hello`, replay buffer (~30 events dimmed), then `evt` events (mint/trade/graduation/claim) stream live; agent animates + optionally narrates per configured emotion/TTS map.
  4. System: first-time fee-claims sidebar refreshes from `GET /api/pump/first-claims?limit=50&sinceMinutes=1440`.
  5. (optional) Filters: asset, mint search, event kind, min tier (notable+/influencer+/mega), MC range, min buy SOL, whale threshold.
  6. (optional) Config modal: map emotions→animations and actions→TTS templates (stored in localStorage); narration/announce-mints/mood toggles.
  7. (optional) Share/copy filter-encoded link.
- **Decision points / branches:** public feed vs agent-bound (enriches via `?_handler=metadata`); event-kind/tier/MC/whale filters; narration + emotion config; provisioned wallet vs none.
- **External calls / dependencies:** SSE `/api/agents/pumpfun-feed` (upstream Helius webhooks), `/api/agents`, `/api/agents/{id}/solana` (GET+POST), `/api/pump/first-claims`, `/api/agents/{id}/pumpfun/metadata`, avatars endpoints; model-viewer CDN.
- **Success state:** live launch/trade/graduation/claim feed with reacting, narrating 3D agent; first-claims sidebar; accurate wallet info.
- **Empty / error states:** "Waiting for events…"; quiet/no-events feed dot; "No Solana wallet on this agent" + provision; upstream error soft-degrades to empty `{items:[]}`; reconnect cycle.
- **Step count:** 1 required (arrive → live feed) + ~6 optional (agent bind, filters, emotion config, share). Live monitor + reactive agent (+ optional agent-management).

---

### Pump Visualizer (3D) — `/pump-visualizer`
- **Source:** `pages/pump-visualizer.html` (inline Three.js module: OrbitControls + EffectComposer/UnrealBloom); `vercel.json` rewrite `/pump-visualizer → /pump-visualizer.html`
- **Entry point:** nav / direct URL.
- **Prerequisites / gates:** None — public. WebGL required; degrades to DOM list fallback if unavailable.
- **Steps (N):**
  1. Arrive → theme/nav boot; WebGL capability check → build Three.js scene (camera fly-in, starfield, bloom, auto-rotating OrbitControls).
  2. System: `GET /api/pump/trending?limit=50&rich=1` (+ `GET /api/pump/helius-stats` for SOL→USD) renders top-50 tokens as spheres on a Fibonacci sphere, sized by log market cap, colored by tier, with lazy artwork via `/api/img`; staggered pop-in.
  3. System: reveals mode tabs (Feed/Migrations/Trending), search, sort buttons, top-20 legend, color key, hint.
  4. (optional) Drag to orbit / scroll to zoom (OrbitControls).
  5. (optional) Search (`/` hotkey) → filter legend + dim non-matching spheres; sort by Mcap/Streams/Replies/New; refresh (`R`).
  6. (optional) Feed/Migrations mode → SSE `/api/agents/pumpfun-feed?kind=mint|graduation` adds spheres live (capped 60).
  7. (optional) Hover sphere (tooltip), click → detail panel (`selectToken`), legend click → camera tween + panel.
  8. (optional) In detail panel: Watch (`ld_watchlist`), Oracle badge (`GET /api/oracle/coin?mint=`), Buy (lazy `src/game/coin-buy.js` on-chain trade modal); double-click sphere → `/coin3d?mint=`.
- **Decision points / branches:** WebGL present vs list fallback; Feed/Migrations/Trending mode; search/sort; Oracle enrichment optional; Buy is the real interactive (on-chain) action.
- **External calls / dependencies:** `GET /api/pump/trending`, `/api/pump/recent-graduations`, `/api/pump/helius-stats`, `/api/img`, `GET /api/oracle/coin`; optional SSE `/api/agents/pumpfun-feed` (server-side PumpPortal WS bridge) for Feed/Migrations live mode.
- **Success state:** 50 glowing spheres in an auto-rotating galaxy, sized/colored by market cap, with detail panel, search/sort, and on-chain Buy.
- **Empty / error states:** WebGL warning banner + DOM list fallback; "Could not load trending tokens" + Retry; image canvas fallback; Oracle badge silently empty if down.
- **Step count:** 2 required (arrive → spheres render) + ~6 optional (orbit, search/sort, mode, inspect, Buy/Watch). Live-monitor + interaction hybrid.

---

### Pump Live Feed (3D Agent) — `/pump-live`
- **Source:** `pages/pump-live.html` (inline module + imports `src/viewer.js`, Three.js); `vercel.json` rewrite `/pump-live → /pump-live.html`
- **Entry point:** nav; footer.
- **Prerequisites / gates:** None — public live monitor. 3D agent is optional (feed works without WebGL/GLB).
- **Steps (N):**
  1. Arrive → feed module starts immediately (does NOT wait on Three.js); skeleton cards; viewer.js + GLB load in parallel.
  2. System: `GET /api/pump/helius-stats` for SOL price (caps shown in SOL until USD lands, then rehydrated).
  3. System: connect `wss://pumpportal.fun/api/data`, send `subscribeNewToken` → "● Live"; each `create` event → render token card (image via `/api/img?meta=`, MC, links, empty Oracle slot), prepend (cap 100), update stats, dispatch `pumplive:token`.
  4. System: every 30s batch `GET /api/oracle/batch?mints=...` (chunks ≤20, bounded retries with backoff) → conviction badges on cards; "🔮 Prime scored" counter.
  5. (optional) 3D agent loads `robotexpressive.glb`, plays Idle, waves on each `pumplive:token`.
  6. (optional) Pause button (queues events); conviction filter All/Strong+/Prime (hides cards); Watch toggle (`ld_watchlist`); click card → `/coin3d?mint=` or external links.
- **Decision points / branches:** WebGL/GLB present vs feed-only; paused vs streaming; conviction filter level; Oracle up vs down (badges empty).
- **External calls / dependencies:** `wss://pumpportal.fun/api/data`; `GET /api/pump/helius-stats`; `GET /api/oracle/batch`; `GET /api/img`; `robotexpressive.glb`.
- **Success state:** live launches stream as cards, stats tick, agent waves per launch, Oracle conviction badges enrich after ~30s, filterable.
- **Empty / error states:** "Waiting for new launches…"; WS backoff 2s→60s, terminal error panel + Reconnect after 8 fails; SOL-price hint until USD lands; image seeded placeholder; agent load failure suppressed (feed unaffected).
- **Step count:** 1 required (arrive → live feed) + ~4 optional (pause, filter, watch, drill-in). Pure live monitor + reactive avatar.

---

### Constellation — `/constellation`
- **Source:** `pages/constellation.html`, `src/constellation/main.js` (~790 lines), `src/constellation/embedding.js` (PCA/MDS + neighbor lookup)
- **Entry point:** nav / direct URL.
- **Prerequisites / gates:** The galaxy, its live stats and its semantic layout are public; the per-star Granite analysis needs a signed-in account (it runs on the platform's own model keys), so `GET /api/auth/me` is resolved once at boot and a signed-out visitor gets a sign-in / create-account notice in the panel instead of a doomed request. WebGL required (fatal overlay if absent, no fallback). IBM Granite (watsonx) optional: without it, tokens place by rank instead of semantic space.
- **Steps (N):**
  1. Arrive → boot WebGLRenderer + Three.js scene (camera, starfield, auto-rotate OrbitControls); fatal overlay if WebGL missing.
  2. System: `GET /api/pump/trending?limit=64` → ≥3 valid tokens placed on a Fibonacci sphere (rank layout), colored by hue; loading overlay dismisses.
  3. System (optional/semantic): `POST /api/watsonx/embed` → 1024-d vectors → PCA to 3 axes → nodes lerp from rank positions into semantic clusters; the status names the model that actually produced the vectors: "Embedded by IBM Granite · model · 1024d", or a "Semantic layout live · <fallback embedder>" line when the embed endpoint fell through its failover chain, never a Granite credit for another model's output.
  4. (optional) Drag to orbit / scroll to zoom.
  5. (optional) Hover star → glow + tooltip (symbol/name). The canvas is focusable: arrow keys walk the stars in trending-rank order with the tooltip following, Home/End jump to the ends, and Enter/Space opens the focused star. Picking tolerates a near miss (22px, 34px on a coarse pointer; a tap gets 46/60px and is judged on movement, not hold time) so the visible glow is the target.
  6. (optional) Click star → right detail panel (symbol, name, logo, market cap, price when the feed carries one, rank, nearest semantic neighbors once vectors land, Pump.fun/Solscan links); the panel is `inert` while closed and hands focus back to the canvas after a keyboard open.
  7. (optional) **Analysis payoff:** selecting a star fires `POST /api/brain/chat {provider:'ibm-granite', system: analyst, messages, maxTokens:400}` (SSE) → streams a live token analysis into the panel; Esc/close to dismiss. The byline names what actually answered: the `meta` event's model label, or after a `fallback` event "Analysis by <route>" with a meta line saying Granite could not serve the request.
- **Decision points / branches:** WebGL present vs fatal; signed in (analysis streams) vs signed out (sign-in notice); Granite configured (semantic layout + analysis) vs unconfigured (rank layout, analysis notice) vs served by a fallback (labelled as such); rate-limited; <3 tokens → fatal.
- **External calls / dependencies:** `GET /api/pump/trending?limit=64`; `GET /api/auth/me`; `POST /api/watsonx/embed`; `POST /api/brain/chat` (SSE).
- **Success state:** 64-star galaxy clustered by semantic similarity, hover tooltips, detail panel, and streaming Granite analysis per token.
- **Empty / error states:** WebGL fatal overlay; a feed failure ("Couldn't load live tokens.", naming the pump.fun trending feed) and "No trending tokens right now." both carry a "Try again" button that rebuilds the galaxy (disposing the previous nodes' materials); a semantic-layout-off status when IBM watsonx is not configured (stars placed by trending rank); analysis notices (sign in required / unconfigured / rate-limited / every route refused / stream error), each telling the visitor to pick the star again to retry.
- **Step count:** 2 required (arrive → galaxy renders) + ~5 optional (orbit/zoom, hover, select, Granite analysis). Live-data exploration + AI analysis.

---

### Sniper Experiments: `/sniper/experiments`
- **Source:** `pages/sniper-experiments.html` (shell only), `src/sniper-experiments.js` (imports `src/shared/coin-format.js`), `src/sniper-experiments.css`; backend `api/sniper/experiments.js`
- **Entry point:** `/play/arena` (the page's own breadcrumb points back to "Sniper Arena"); the trading hub rail (`src/trading-hub.js`); sitemap; direct URL.
- **Prerequisites / gates:** None. Public read-only scoreboard, mainnet only, real on-chain fills only (no simulated rows in the main record).
- **Steps (N):**
  1. Arrive → `renderControls()` paints the window switch (24h / 7 days / 30 days / All time, default `7d`), then `refresh()` runs immediately and every 30s. The timer is cleared on `visibilitychange` when the tab hides and restarted on return.
  2. System: `GET /api/sniper/experiments?network=mainnet&window=<key>` fills three regions: summary tiles (`#xp-summary`), the strategy comparison table (`#xp-board`), and the LLM judgment ledger (`#xp-judgment`).
  3. System: summary tiles read armed vs paused count, closed trades + open now, fleet realized P&L for the window, fleet SOL on hand across wallets, best arm, moon bags riding (count + SOL at last quote, deliberately excluded from realized P&L), earned-autonomy split (earned / probation / standard), and the master funding wallet with its balance.
  4. System: one board row per armed strategy: label + autonomy-tier badge, agent link (`/a/<agent_id>`), decision-mode badge (`rules`, or `LLM · <model>`), wallet chip linking to Solscan with a low-balance warning under 0.02 SOL, reasoning-ledger link, entry conditions with per-trade SOL and the exit shape (stop loss, trailing stop, max hold, ladder multiple + moon-bag percentage or "no ladder"), record (`W · L`, open count, moon bags, and a separate paper line for simulate-mode fills), win rate, realized SOL, ROI, average trade, average hold, last trade.
  5. System: a stalled arm gets a loud explanation instead of a bare zero: `stallLine()` renders "not trading" for a blocking condition and "idle" for an arm that simply has not qualified yet, with every other blocking reason listed beneath the headline so fixing the first does not just reveal the second later.
  6. System: the judgment ledger scores each LLM judge on its own verdicts (buy rate, average confidence, buy precision against what the coin did an hour later, missed winners among its skips, average latency).
  7. (optional) Click a window button → re-render controls + refetch that window.
  8. (optional) Click an agent, its wallet, or its ledger link to leave for the agent profile, Solscan, or the decision-by-decision reasoning ledger.
- **Decision points / branches:** 4 windows; rules arm vs LLM-judged arm; enabled vs paused (row dimmed); blocking stall vs idle vs healthy; autonomy tier standard (badge hidden) vs probation / trusted / autonomous; arm with a wallet vs "no wallet"; paper record present vs live only; judgment ledger present vs hidden entirely when no LLM verdicts exist.
- **External calls / dependencies:** `GET /api/sniper/experiments?network=&window=` (single endpoint; no browser RPC or WebSocket).
- **Success state:** a live A/B board answering which entry conditions actually make money, every fill signed by the agent's own wallet and traceable to Solscan and to its reasoning ledger.
- **Empty / error states:** "No strategies armed on this network yet" pointing at `/arm`; "no fills" / "waiting on fills" per arm; "awaiting outcomes" for an unscored LLM judge; "Couldn't load the scoreboard" with the failing message and automatic retry on the next 30s tick.
- **Step count:** 2 required (arrive → board) + ~2 optional (window switch, drill into agent/wallet/ledger).

---

### Alpha Co-pilot: `/alpha-copilot`
- **Source:** `pages/alpha-copilot.html`, `src/alpha-copilot.js` (~680 lines; imports `src/shared/agent-3d.js`, `src/agent-solana-wallet.js`, `src/ui-juice.js`)
- **Entry point:** `/genesis`; sitemap; direct URL. Deep links: `?agent=<uuid or profile URL>` picks the agent, `?mint=<mint>` also fires the read on arrival.
- **Prerequisites / gates:** Reading is public: `resolveInitialAgent()` falls back through `?agent=` → last agent in `localStorage` (`ac_last_agent`) → `GET /api/agents/me` → `GET /api/agents/featured`, so the page always opens live. The **Act** payoff is owner-only and server-gated: the read response carries `gate.can_act`, and a non-owner sees the reason instead of the button. Voice needs TTS (server) or the browser Web Speech API.
- **Steps (N):**
  1. Arrive → `init()` caches DOM, wires the act drawer (Escape and backdrop close it), and starts the agent gallery and the initial-agent resolution in parallel.
  2. System: `loadAgent(id)` → `GET /api/agents/:id` names the co-pilot and labels it "Your alpha co-pilot" for the owner or "Alpha co-pilot · public read" for everyone else; the `<agent-3d>` avatar mounts from `agentAvatarGlb()`.
  3. System: `loadCandidates()` → `GET /api/agents/:id/alpha/candidates?network=mainnet` renders the live pump.fun launch rail behind 4 skeleton cards, counts up the launch total, and marks one "top pick" ranked by real smart-money + quality signals with a penalty for a sybil-dominated funder graph.
  4. **Read payoff:** click a launch (or arrive with `?mint=`) → `POST /api/agents/:id/alpha/read {mint, network}` → thinking state, then a verdict (Snipe / Watch / Pass), a conviction bar that fills from 0, the spoken line, "What could go wrong" risks, and the eight grounded signal rows (liquidity, market cap, age, buy impact at 0.1 SOL, curve filled, quality, smart money + wallet count, organic), with the rows the agent actually cited highlighted.
  5. System: the avatar speaks the verdict: `POST /api/tts/eleven` (with `agentId`, so an owner-cloned voice is served on the owner's saved ElevenLabs key) when the agent has a voice, else `POST /api/tts/speak`, else the browser `speechSynthesis` fallback. If the server's hallucination guard replaced a figure, the panel says so and points at the signals as ground truth.
  6. (optional) Owner extras in the read: the wallet line shows balance, per-trade limit, daily budget, and a paused flag.
  7. (optional) **Act payoff (owner, gated):** click "Act: buy ◎N" → drawer opens (focus moves inside and returns to the trigger on close) → `previewAgentTrade()` fetches a fresh live quote (you pay / expected tokens / price impact, plus any warning) → **Confirm buy** → `executeAgentTrade()` posts through the guarded agent wallet path (spend limits and firewall re-checked at submit, written to the custody audit) → done state with the Solscan tx, the new wallet balance, and a link to the custody trail.
  8. (optional) Replay the last spoken line; refresh the launch rail; paste a different agent ID or profile URL; pick another agent from the public gallery.
- **Decision points / branches:** owner vs public read (act button vs gate message); `gate.can_act` true vs blocked with a reason; agent resolved from URL / storage / session / featured vs none at all (the gallery becomes the call to action, and only if the gallery is empty does the ID row open); ElevenLabs voice vs server TTS vs browser speech; hallucination guard triggered vs clean; reduced motion (bars and counters land at their final values).
- **External calls / dependencies:** `GET /api/agents/:id`, `GET /api/agents/me`, `GET /api/agents/featured`, `GET /api/agents/public?sort=popular&limit=12`, `GET /api/agents/:id/alpha/candidates`, `POST /api/agents/:id/alpha/read`, `POST /api/tts/eleven`, `POST /api/tts/speak`; `previewAgentTrade` / `executeAgentTrade` (`POST /api/agents/:id/solana/trade`) for the act path.
- **Success state:** a named 3D agent reads a real launch aloud in character, shows the live signals behind the call, and the owner can act on it through the same guarded, audited wallet path the conversational copilot uses. The narrator itself never moves funds.
- **Empty / error states:** "No live launches on the feed this second" with "Check again"; "Live feed hiccup" with Retry; read failure with "Try again"; "Couldn't fetch a live quote"; trade errors rendered above the confirm button with the button re-enabled; no-agent fallback copy on the avatar placeholder. The launches column never renders as an empty box: before an agent is on stage it reads "Pick a co-pilot above and the live launches it can read land here." (or the ID-entry variant when the gallery is empty), and an agent that fails to load clears the previous one off the stage rather than leaving its launch cards wired to nothing.
- **Step count:** 3 required (arrive → agent + launch rail → read) + ~5 optional, including the owner-gated buy (steps 7 to 8).

---

## Notes on sourcing
- All 18 routes located and traced to real source. No missing sources.
- The 2026-07 market-data family (`/markets` and its news, digest, archive, trending and Robinhood sub-pages, plus `/coins`, `/heatmap`, `/screener`, `/exchanges`, `/derivatives`, `/stablecoins`, `/dex-volumes`, `/chains`, `/yields`, `/fees`, `/hacks`, `/converter`, `/compare`) runs on CoinGecko, DeFiLlama and the news ingest rather than on the pump.fun + Oracle + sniper engines, so it is out of this cluster's scope and not yet covered by any cluster.
- `/gmgn`, `/pumpfun`, `/strategy-lab` are **pre-built static** pages in `public/` (not `pages/`), wired by `vercel.json` rewrites — easy to miss in a `pages/` listing.
- `/coin-intel` (page `api/pump/intel`) and `/radar` (`api/pump/coin-intel`) are two distinct engines despite similar names — do not conflate.
- The leaderboard/activity payoff is the trader profile at `/trader` (`src/trader.js`), reached by drilling into a row — outside this cluster's enumerated routes but noted as the terminal step.
