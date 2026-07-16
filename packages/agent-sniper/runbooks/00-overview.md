# Throwaway sniper fleet → recorded content — runbook index

Goal: fund **33 throwaway Solana wallets** with **3 SOL total** (~0.09 SOL each), run
the **pump.fun sniper** across them making **tiny 0.002 SOL buys**, and **record the
whole thing** (funding → fan-out → arming → live trades) as content on the three.ws
UI with Playwright.

There are three cuts. Each is a **self-contained runbook** — hand any one to an agent
(or run it yourself) in this repo. They differ by how the 33 agents surface on camera
and what access they need.

| # | Cut | What the camera sees | Extra access beyond 3 SOL + RPC | Runnable from a clean box? |
|---|-----|----------------------|--------------------------------|----------------------------|
| [01](01-onchain-truth.md) | **On-chain truth** | Our own sniper console (33 agents deciding + buying), Solscan proof of the real wallets, three.ws `/theater` `/trades` as branded b-roll | none | **Yes** |
| [02](02-platform-native.md) | **Platform-native** | The 33 as real three.ws agents starring in `/theater` + `/play/arena` with 3D avatars | Platform DB, `WALLET_ENCRYPTION_KEY`, master funding secret, the DB-coupled worker | No — needs platform secrets |
| [03](03-agent-screen-caster.md) | **Agent-Screen caster** | A live "agent screen" at `/agent-screen` — viewers watch an agent do the funding, setup, and trade-watching in real time | A real agent you own + its API key (`agents:write`); three.ws prod already has the Redis bridge | Partly — needs an agent + key |

## Shared facts (all cuts)

- **Repo:** `/workspaces/three.ws`. **Package:** `packages/agent-sniper`.
- **Two tools** (both built, verified):
  - `scripts/fleet.js` — `gen | plan | balance | fund | run | sweep`. Does the real on-chain work. Keys live at `~/.three-ws-fleet/keys.json` (chmod 600, outside the repo).
  - `scripts/reel.js` — Playwright recorder. Films a `SCENE_FILE` of scenes to one `.webm` + per-scene screenshots, with a self-narrating caption bar. `CAST=1` also broadcasts each frame to a three.ws agent screen (cut 03).
- **Two inputs every live cut needs from you:**
  1. **3 SOL** sent to the fleet funder wallet (printed by `fleet.js gen`/`plan`).
  2. A **mainnet RPC URL** (Helius/Triton/Quicknode). Live mode **refuses a public RPC** — it 429s under the new-mint firehose. Pass `--rpc <url>` or set `SOLANA_RPC_URL` / `HELIUS_API_KEY`.

## Economics & safety (all cuts)

- 3 SOL ÷ 33 = **~0.091 SOL/wallet**. Each wallet keeps ~0.012 SOL fee headroom (engine guard) + ~0.002 SOL rent per open position → **~0.075 SOL working capital**, a handful of concurrent positions each.
- **Per trade: 0.002 SOL. Daily budget: 0.02 SOL/agent** (10 snipes/day/agent max). Mandatory stop-loss 30%.
- The engine throttles the whole fleet to **10 buys/min** (`SNIPER_MAX_GLOBAL_BUYS_PER_MIN`) — burst protection. Tune if you want each archetype exercised more evenly.
- 33 agents read the same feed, so they pile into the same coins within seconds — expected for *learning*, and financially you should assume most of the 3 SOL is tuition. That's the point.

## One-time environment setup (clean box)

```bash
cd /workspaces/three.ws/packages/agent-sniper
npm install --no-workspaces --no-audit --no-fund        # sniper deps
npm install --no-workspaces --no-audit --no-fund playwright@^1.45 express@^5
npx playwright install chromium
sudo npx playwright install-deps chromium               # or apt the libs below
# if install-deps is unavailable:
# sudo apt-get install -y --no-install-recommends libatk1.0-0 libatk-bridge2.0-0 \
#   libcups2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
#   libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libnss3 libnspr4 libdrm2 libxshmfence1
```

## Live tracking — Telegram feed (recommended)

The fleet posts a message on **every buy and sell** (agent, archetype, symbol, size,
PnL, Solscan tx link) plus a **portfolio summary every 15 min**, to a Telegram chat or
channel. Push-based, on your phone, and a public channel is instantly shareable.

Setup:
1. Create a bot with [@BotFather](https://t.me/BotFather) → get the **bot token**.
2. Create a channel (e.g. "three.ws sniper fleet"), add the bot as an **admin**.
3. Use the channel's `@handle` (public channels) or numeric id (`-100…`) as the chat id.
4. Run the fleet with the tracker on:
   ```bash
   TELEGRAM_BOT_TOKEN=<token> TELEGRAM_CHAT_ID=@yourchannel \
     node scripts/fleet.js run --rpc "$RPC" --mode live --serve --yes
   ```
   (or pass `--telegram-token` / `--telegram-chat`). Tracker code: `scripts/telegram.js`.

Other ways to watch (complementary, not either/or):
- **Local console** — `--serve` already exposes a live dashboard (positions, PnL, activity)
  at `http://localhost:8787/`. Great to watch or record; localhost unless you tunnel it.
- **Public web page** — deploy that same console (`packages/agent-sniper` `serve` face) to
  Vercel/Cloud Run for a shareable URL. Heavier; do it if you want a public site.
- **three.ws pages** — the fleet only shows *natively* on `/theater` `/play/arena` via
  Cut 02 (platform agents). Otherwise those pages are platform-wide, not this fleet.
- **On-chain** — every wallet is trackable directly on Solscan; `fleet.js balance` prints
  all 33 + the funder any time.

## Cleanup (all cuts) — recover leftover SOL

```bash
node scripts/fleet.js sweep --rpc <url> --to <YOUR_WALLET> --yes
```
Sweeps every agent + the funder back to one address (leaves only the tx fee). Do this
when you're done learning; the throwaway keys can then be discarded.

## Deliverable

Each cut produces: one `.webm` screen recording + per-scene PNG stills + a `manifest.json`
in the `OUT` dir. Post-process with the repo's `@ffmpeg` deps (trim, add music, export MP4).

> **$THREE note:** these tools trade whatever mint the live feed supplies at runtime
> (the coin-agnostic plumbing exception). `$THREE` stays the promoted coin. If you edit
> any scene caption or fixture to name another crypto project, that falls under the
> commit gate — get owner approval before committing it.
