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
- **Source:** `pages/oracle.html`, `src/oracle.js` (~2400 lines), lazy `src/oracle-graph.js` (3D force graph), `src/oracle-tape.js` (live trade tape in the coin drawer)
- **Entry point:** nav link "Oracle"; direct URL; SEO/share links from `coinShareUrl()`. `/oracle/coin/<mint>` is now a standalone full conviction coin page (server-rendered by `api/oracle-share.js` in the markets-hub style: score dial, pillar bars, chart, launch intelligence), reached from the drawer's "Full page ↗" action.
- **Prerequisites / gates:** Public dashboard for all read views (feed, movers, wallets, edge, proof, agents, activity, graph). The **Agent** (arm) tab requires sign-in + an existing 3D agent with a custodial Solana wallet; Live mode spends real (capped) SOL.
- **Steps (N):**
  1. Arrive on `/oracle` → `boot()` populates category filter, binds tab/seg listeners, reads URL filters (`tier`, `category`, `minScore`, `view`), loads the **feed** view.
  2. System: `GET /api/oracle/feed?...` renders conviction cards (0–100 score, tier pill prime/strong/lean/watch/avoid). If backend not migrated → "Oracle is warming up" honest empty state.
  3. System: opens SSE `EventSource('/api/oracle/action-stream')` — new scored coins stream in live; "Live · fused conviction" / "Reconnecting…" indicator.
  4. (optional) Filter: click `#tierSeg` tier buttons / category select / min-score / sort seg / ★-watchlist-only toggle / breadth-bar tier segments → `syncFilterUrl()` + `loadFeed()` (URL is shareable). A hero "Join the live Telegram feed" button appears when `/api/oracle/stats` reports a configured public signals channel.
  5. (optional) Switch view tab: `movers`, `wallets` (reputation leaderboard), `edge` (tier backtest win-rate), `proof` (resolved wins), `agents` (agent win-rate ledger), `activity` (live agent actions), `graph` (3D force graph, lazy-imports oracle-graph.js).
  6. (optional) Click a coin card → `openDrawer(mint)` → `GET /api/oracle/coin?mint=...` renders the 4-pillar conviction breakdown (who/how/what/move); oracle-tape.js streams that coin's live trades.
  7. (optional) In the drawer: Full page ↗ (`/oracle/coin/<mint>`), pump.fun ↗, GMGN ↗ (via `src/shared/trading-terminals.js`, referral-tagged), solscan ↗, Details ↗ (`/launches/<mint>`), View in 3D ↗ (`/coin3d?mint=`), ☆/★ Watch (writes `ld_watchlist`), Copy mint, Copy link, Share to X; the live Market panel adds GMGN/DexScreener/GeckoTerminal/Birdeye links when available.
  8. (optional, agents view) Follow an agent's signals: expand follow-panel → enter Telegram chat ID → `POST /api/oracle/follow`.
  9. **Arm payoff (gated):** open **Agent** tab → `loadAgentPanel()` → `GET /api/agents`. Pick agent, set Min conviction (Prime/Strong+/Lean+), Size/trade SOL, Max daily SOL, Max open, category filters, optional Telegram chat ID (Send test → server push), toggle Armed + Live/Simulate switches → **Save configuration** → `POST /api/oracle/watch` `{armed, mode, min_score, per_trade_sol, max_daily_sol, max_open, ...}`. Confirmation: "Armed in simulate/live mode. Your agent is watching the stream."
- **Decision points / branches:** view tabs (9); feed warming vs populated vs filtered-empty; drawer coin scored vs "not scored yet"; agent has wallet vs needs creation (`/create/studio`); simulate vs live mode; signed-out → "Sign in and arm an agent".
- **External calls / dependencies:** `/api/oracle/feed`, `/api/oracle/coin`, `/api/oracle/search`, `/api/oracle/movers`, `/api/oracle/categories`, `/api/oracle/backtest`, `/api/oracle/wins`, `/api/oracle/stats` (hero statline + Telegram channel link), `/api/oracle/activity`, `/api/oracle/watch` (GET+POST), `/api/oracle/follow` (GET+POST), `/api/agents`; SSE `/api/oracle/action-stream`; oracle-tape live trade stream in drawer.
- **Success state:** live conviction feed scoring every pump.fun launch in real time; coin drawer with pillar breakdown; armed agent acting on the stream (simulate logs / live spends capped SOL), actions graded into a win-rate ledger.
- **Empty / error states:** "Oracle is warming up" (backend not live); "No launches clear your filters" + Reset; drawer "not scored"; "No ranked agents yet"; SSE auto-reconnects ("Reconnecting…"); `api()` returns `{ok:false}` on timeout (12s abort) and degrades gracefully.
- **Step count:** 3 required (arrive → feed → live stream, all automatic) + ~6 optional read interactions, + a 6-field gated arm flow (steps 8–9).

---

### Agent Activity — `/activity`
- **Source:** `pages/activity.html` (self-contained; inline module, no `src/*` import)
- **Entry point:** nav; "Copy trades →" CTAs link to `/trader/<agent_id>`; linked from oracle activity view.
- **Prerequisites / gates:** None — public live monitor.
- **Steps (N):**
  1. Arrive → inline module sets `API='/api/oracle/activity'`, `STREAM_API='/api/oracle/action-stream'`, loads first page.
  2. System: `GET /api/oracle/activity?...` renders rows (agent, verb closed↑/↓/entered, $symbol, tier pill, sim/live tag, outcome win/loss/flat/open, PnL) + summary KPIs.
  3. System: opens SSE `/api/oracle/action-stream` — new agent actions prepend live.
  4. (optional) Filter by tier chip, mode pill (sim/live), or outcome → re-fetch with `?tier=&mode=&outcome=`.
  5. (optional) Load more (cursor pagination).
  6. (optional) Click "Copy trades →" on a winning/open row → navigate to that agent's trader profile (`/trader/<id>`).
- **Decision points / branches:** filter combinations; win/open rows show Copy CTA, losses don't; stale badge + retry if a background refresh fails while rows are on screen.
- **External calls / dependencies:** `GET /api/oracle/activity`; SSE `/api/oracle/action-stream`.
- **Success state:** real-time trading floor of every agent's Oracle-driven move, outcomes graded, winners copyable.
- **Empty / error states:** empty feed placeholder; stale/reconnect badge with manual retry button on background-refresh failure.
- **Step count:** 2 required (arrive → feed+stream) + ~3 optional (filter, paginate, copy).

---

### Trending — `/trending`
- **Source:** `pages/trending.html` (inline module; imports `/src/shared/agent-wallet-chip.js`)
- **Entry point:** nav "Trending"; footer; share links.
- **Prerequisites / gates:** None — public dashboard.
- **Steps (N):**
  1. Arrive → inline module binds tab buttons (Agents / Coins) + window buttons (24h / 7d / All time), loads default (Agents, 24h).
  2. System: `GET /api/trending?window=24h&limit=10` renders ranked list (agents by real chat activity, with wallet chip; coins by Oracle conviction score).
  3. (optional) Switch tab Agents↔Coins → renders the other ranked list.
  4. (optional) Switch window 24h/7d/All time → re-fetch with new `window`.
  5. (optional) Click a row → deep link to the agent profile or coin/oracle page.
- **Decision points / branches:** Agents vs Coins tab; 3 time windows; per-tab retry button on fetch failure.
- **External calls / dependencies:** `GET /api/trending?window=&limit=10`.
- **Success state:** what's hot right now — top agents and top conviction coins across windows.
- **Empty / error states:** per-tab empty + Retry button (`#agentRetry` / `#coinRetry`).
- **Step count:** 2 required (arrive → list) + ~3 optional (tab, window, drill-in).

---

### Trade Terminal - `/trades`
- **Source:** `pages/trades.html`, `src/trades.js` (controller), `src/trades-detail.js` (deep-dive; imports `src/mission-control/chart.js`, `src/widgets/bonding-curve.js`, `src/trades-bubblemap.js`, `src/trades-tape.js`, `src/trader-format.js`)
- **Entry point:** nav; footer newsletter page link; deep link `?mint=<base58>` (+ `&tab=exits`, `&network=devnet`).
- **Prerequisites / gates:** None; public two-pane pump.fun analytics workstation. Only three.ws data (platform launches + agent exits) feeds the left rail; any mint can be pasted for a deep-dive.
- **Steps (N):**
  1. Arrive → `readUrl()` restores mint/tab/network (network persisted to localStorage `tf_network`); the deep-dive mounts immediately with the URL mint, or $THREE by default (never an empty void).
  2. System: left rail loads the active tab: **Launches** (`GET /api/pump/launches?network=&limit=40`, $THREE pinned at the top) or **Exits** (`GET /api/trades/feed?network=&window=7d&min_pnl_pct=10&limit=40`); refreshes every 30s. Header pulse (`GET /api/pump/helius-stats`, 20s) shows network mint rate, graduations/hour, and SOL price ± 24h change.
  3. System: centre deep-dive (`mountDetail`) paints header + skeleton instantly from the clicked row, then fills progressively from five live endpoints (`/api/pump/launch-detail`, `/api/pump/curve`, `/api/pump/intel`, `/api/pump/smart-money`, `/api/coin/:mint/cohorts`; cohorts only for platform-tracked coins) plus three self-fetching widgets: candlestick chart, bonding-curve ring, live trade tape.
  4. (optional) Switch tab Launches ↔ Exits (`#ttTabs`) → reload rail; URL synced.
  5. (optional) Change network mainnet/devnet (`#ttNetwork`, persisted) → reload rail + remount deep-dive.
  6. (optional) Paste a mint into `#ttSearch` (base58-validated) → drives the deep-dive for that coin.
  7. (optional) Click any rail row → `select(mint)` remounts the deep-dive (re-selecting the mounted coin is a no-op); URL reflects `?mint=` for sharing.
- **Decision points / branches:** Launches vs Exits tab; mainnet vs devnet; platform-tracked coin (cohorts fetched) vs external mint (designed no-data state); each detail section degrades independently to an honest "unavailable" note.
- **External calls / dependencies:** `GET /api/pump/launches`, `GET /api/trades/feed`, `GET /api/pump/helius-stats`, `GET /api/pump/launch-detail`, `GET /api/pump/curve`, `GET /api/pump/intel`, `GET /api/pump/smart-money`, `GET /api/coin/:mint/cohorts`.
- **Success state:** live two-pane terminal: rail of platform launches/exits, deep-dive with chart, bonding curve, holders/cohorts, funder bubblemap, smart money, wallet footprint, trade tape, outcome, agent economics; shareable `?mint=` URL.
- **Empty / error states:** per-tab empty copy ("No launches on this network yet" / "No profitable agent exits in this window yet"); per-section "unavailable" degradation in the deep-dive; pulse failures silent (decorative).
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
  3. System: for each mint mounts a live coin-status card (`mountCoinStatus` → one `/api/pump/coin` fetch/coin), with deterministic mint identicon placeholder behind real pump.fun logo; refreshes every 90s.
  4. System: detects tier upgrades vs `wl_last_tiers` and surfaces changes.
  5. (optional) Toggle alerts (`#wl-alerts`, `wl_alerts_on`).
  6. (optional) Clear list (`#wl-clear`).
  7. (optional) Click a card → the coin's Oracle page (`/oracle/coin/<mint>`).
- **Decision points / branches:** empty list vs populated; tier-upgrade highlighting; alerts on/off; cross-tab storage sync.
- **External calls / dependencies:** `GET /api/pump/coin` (one per watched coin, via coin-status-card).
- **Success state:** private tracked-coin board with live status cards, tier-change detection, deep links back to profiles.
- **Empty / error states:** empty state when no mints saved (tells user to Watch coins elsewhere); invalid mints filtered out; per-card load handled by coin-status widget.
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
  12. (optional) **Revenue**, **Configuration** (save + reconnect + probes), **API Reference** (create/revoke keys).
- **Decision points / branches:** 12 hash-routed tabs; wallet connected vs empty; WS backoff (<8 retry vs ≥8 terminal banner); auth 401 on agents/alerts/keys; PumpKit backend present for Watches/Claims; vanity validation failures; simulate vs server-side alert delivery.
- **External calls / dependencies:** `/api/healthz`, `/api/pump/helius-stats`, `/api/pump/channel-feed`, `/api/pump/trending`, `/api/agents/featured`, `/api/agents` (+CSRF), `/api/wallet/balances`, `/api/pump/scan`, `/api/pump/quote/{buy,sell}`, `/api/alerts/rules` (CRUD), `/api/notifications`, `/api/api-keys` (CRUD), revenue endpoints; `wss://pumpportal.fun/api/data`; Solana RPC via `/api/solana-rpc`; Phantom/MWA wallet; Web Workers for vanity; model-viewer CDN.
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
  3. (optional) Switch tab Feed ↔ Top wallets.
  4. (optional) Watch toggle per coin → `ld_watchlist`.
  5. (optional) Click coin → drawer `GET /api/pump/smart-money?mint=<mint>` (notable wallets, labels) + async `GET /api/oracle/coin?mint=` to enrich with conviction pillars.
  6. (optional) Click wallet → drawer `GET /api/pump/smart-money?wallet=<addr>` (win rate, record, recent coins).
- **Decision points / branches:** Feed vs wallets tab; coin scored vs "not scored"; wallet has record vs none; Oracle enrichment present vs absent.
- **External calls / dependencies:** `GET /api/pump/smart-money` (feed / `?leaderboard=1` / `?mint=` / `?wallet=`), async `GET /api/oracle/coin`. Data sourced from `coin_smart_money` + `wallet_reputation` tables fed by the off-browser sniper engine — no direct browser RPC/WS.
- **Success state:** 60 fresh coins ranked by buyer pedigree; wallet reputation board (smart_money/sniper/dumper/rugger labels); coin + wallet drawers.
- **Empty / error states:** "No proven money on a fresh coin yet"; "No wallets ranked yet"; drawer "Not scored yet" / "No track record yet"; "Couldn't reach the radar" + Retry; stale badge with last-update + "Retry now".
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
- **Empty / error states:** "The engine is warming up"; "No coins match these filters" + Reset; drawer "Not observed yet"; "No labeled winners yet"; "No traders recorded yet"; "Not enough data to train yet"; degraded badge; retry on network failure.
- **Step count:** 2 required (arrive → radar feed) + ~6 optional (search/filters, watch, tabs, inspect coin).

---

### GMGN Smart Money — `/gmgn`
- **Source:** `public/gmgn.html` (pre-built static; ~900 lines); backend `api/agents/gmgn.js`; `vercel.json` rewrite `/gmgn → /gmgn.html`, `/api/agents/gmgn-feed → /api/agents/gmgn?_handler=feed`
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
- **Source:** `pages/constellation.html`, `src/constellation/main.js` (~500 lines), `src/constellation/embedding.js` (PCA/MDS + neighbor lookup)
- **Entry point:** nav / direct URL.
- **Prerequisites / gates:** None — public. WebGL required (fatal overlay if absent, no fallback). IBM Granite (watsonx) optional — without it, tokens place by rank instead of semantic space.
- **Steps (N):**
  1. Arrive → boot WebGLRenderer + Three.js scene (camera, starfield, auto-rotate OrbitControls); fatal overlay if WebGL missing.
  2. System: `GET /api/pump/trending?limit=64` → ≥3 valid tokens placed on a Fibonacci sphere (rank layout), colored by hue; loading overlay dismisses.
  3. System (optional/semantic): `POST /api/watsonx/embed` → 1024-d vectors → PCA to 3 axes → nodes lerp from rank positions into semantic clusters; status "Embedded by IBM Granite · model · 1024d".
  4. (optional) Drag to orbit / scroll to zoom.
  5. (optional) Hover star → glow + tooltip (symbol/name).
  6. (optional) Click star → right detail panel (symbol, name, logo, price, rank, nearest semantic neighbors, Pump.fun/Solscan links).
  7. (optional) **Analysis payoff:** click "Analysis by IBM Granite" → `POST /api/brain/chat {provider:'ibm-granite', system: analyst, messages, maxTokens:400}` (SSE) → streams a live token analysis into the panel; Esc/close to dismiss.
- **Decision points / branches:** WebGL present vs fatal; Granite configured (semantic layout + analysis) vs unconfigured (rank layout, analysis notice); rate-limited; <3 tokens → fatal.
- **External calls / dependencies:** `GET /api/pump/trending?limit=64`; `POST /api/watsonx/embed`; `POST /api/brain/chat` (SSE).
- **Success state:** 64-star galaxy clustered by semantic similarity, hover tooltips, detail panel, and streaming Granite analysis per token.
- **Empty / error states:** WebGL fatal overlay; "No trending tokens right now"; "Semantic layout off — IBM Granite isn't configured… placing by rank"; analysis notices (unconfigured / rate-limited / stream error); trending-fetch failure message.
- **Step count:** 2 required (arrive → galaxy renders) + ~5 optional (orbit/zoom, hover, select, Granite analysis). Live-data exploration + AI analysis.

---

## Notes on sourcing
- All 16 routes located and traced to real source. No missing sources.
- `/gmgn`, `/pumpfun`, `/strategy-lab` are **pre-built static** pages in `public/` (not `pages/`), wired by `vercel.json` rewrites — easy to miss in a `pages/` listing.
- `/coin-intel` (page `api/pump/intel`) and `/radar` (`api/pump/coin-intel`) are two distinct engines despite similar names — do not conflate.
- The leaderboard/activity payoff is the trader profile at `/trader` (`src/trader.js`), reached by drilling into a row — outside this cluster's enumerated routes but noted as the terminal step.
