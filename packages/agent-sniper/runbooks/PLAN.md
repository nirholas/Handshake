# 33 AI Agents · Live pump.fun Trading on three.ws · Recorded for Social

**Status:** planning (documentation-first, per owner). **Owner:** three.ws.
**Started:** 2026-07-03. **Log:** [LOG.md](LOG.md) (append-only, update every step).

---

## 1. Objective

Stand up **33 autonomous 3D AI agents** on three.ws, fund them from one wallet,
and have them trade **real pump.fun launches** with tiny size — while we **record
video of every step** (funding fan-out → each agent's UI → live trades) as
social-media content. The story is: *a swarm of AI agents, each with a face and a
wallet, hunting the market live on three.ws.*

Success = a clean set of recordings showing (a) the distribution to 33 wallets,
(b) each agent visibly trading through the three.ws UI, and (c) the intelligence
behind each decision — plus a complete written log of the process.

## 2. Principles / hard rules

- **No pump.fun Mayhem tokens.** Only normal launches. Enforced on-chain via
  `isMayhemMode` (see [src/mayhem-filter.js](../src/mayhem-filter.js));
  verified working 2026-07-03. See memory `no-mayhem-pumpfun-tokens`.
- **$THREE is the promoted coin.** Agents trade arbitrary runtime mints (the
  coin-agnostic exception); no other coin is *promoted*. Commit gate applies to any
  non-$THREE reference in committed files.
- **Real data, real APIs, no mocks.** Every trade, wallet, and datapoint is real.
- **Record everything.** If a step isn't recorded, it didn't happen (for this project).
- **Small size, learning-first.** Assume the trading budget is tuition; the deliverable
  is the *content and the process*, not P&L.

## 3. The 33 agents

Each agent = a real three.ws `agent_identities` row with:
- **A rigged 3D avatar** — from Avaturn or the three.ws gallery, must be rigged so it
  animates (idle/emote) in `/agent-screen`, `/theater`, `/play/arena`. Avatar links via
  `agent_identities.avatar_id → avatars.model_url` (a mannequin fallback if unrigged).
- **A vanity Solana wallet** — all 33 share a recognizable prefix (e.g. a themed 3–4 char
  base58 prefix) so they're identifiable on-chain and on camera. Grind vanity keypairs,
  then import each into its agent identity (server encrypts at rest).
- **A distinct trading persona** — one of the strategy archetypes (scalp/runner/degen/
  strict/patient/momentum) so the swarm explores the parameter space, not 33 clones.

## 4. Intelligence layer — how each agent decides what to buy

Agents are **data-driven**, not blind new-mint snipers. Signals, in priority order:

1. **Oracle** — three.ws's own conviction/oracle scoring (`/api/oracle/*`, the sniper's
   `oracleGate`/intel path). Gates and ranks candidates. *Also the seam where the
   Mayhem filter lives.*
2. **Tracked / smart-money wallets** — buys by known smart-money / KOL wallets as a
   signal (the repo already surfaces smart-money; wire it as a scorer input).
3. **Cultural / narrative signal** — what's trending *now*: new memes, cultural moments,
   social velocity. Sourced from free APIs + social/vibe feeds.
4. **Free-API market data** — price/liquidity/holders/creator-history (Helius, pump.fun
   feed, on-chain reads). Already available to the engine.
5. **LLM reasoning (Fable)** — an Anthropic-API layer (owner will fund) using **Fable 5
   (`claude-fable-5`)** to synthesize the above into a buy/skip call and a one-line
   rationale per candidate — narrative judgement the numeric scorers can't make.
   *Model/cost to be finalized against the `claude-api` reference before building.*

Each buy decision records **which signals fired** so the recording can show *why* an
agent bought (great for the video: "bought because smart-money X aped + trending
narrative Y + Fable conviction 0.8").

> Design note: the standalone `@three-ws/agent-sniper` engine exposes `scorer`, `guards`,
> `Hooks.oracleGate`, `Hooks.assessSafety`, and `recordDecision` — these are the seams
> for wiring oracle + smart-money + Fable without forking the loop. The platform sniper
> (`workers/agent-sniper`) already has intel/oracle/firewall sub-engines to reuse.

## 5. Funding

- **Funder:** `niChP…Keevy` (owner-funded; we hold its key). No launcher-master keypair
  provided, so we fund **directly from the funder** → 33 vanity wallets (`fleet.js fund`).
- Budget: small per wallet; keep ~0.012 SOL/wallet fee headroom + ~0.002 SOL rent/position.
- Every disbursement tx is recorded on camera (terminal + Solscan).

## 6. Execution via the REAL three.ws UI (owner directive — non-negotiable)

Everything is done by driving a browser (Playwright/Chromium) **as a human on three.ws**,
recorded. If any step can't be done in the UI, STOP and tell the owner before doing it
differently. **Confirmed UI click-path (verified in source 2026-07-03):**

| Step | Route | What the human does | Verdict |
|---|---|---|---|
| Sign in / register | `/login`, `/register` | email+password (or Privy OTP / wallet). No email-verify gate. | ✅ UI |
| Create agent + rigged avatar | `/create-agent` | wizard → pick avatar from **starter gallery / my avatars / upload GLB** → `POST /api/agents` | ✅ UI (⚠️ no Avaturn picker — gallery only) |
| View the agent's Solana wallet | `/agent/{id}/edit` → Wallet panel | see address, balances, Copy, **Fund (QR deposit)** | ✅ UI (view/deposit only) |
| Arm the sniper | **`/dashboard/sniper`** | per-agent editor: trigger, per-trade SOL, daily budget, stop-loss (req), TP, trailing, slippage, Jito → **"Arm strategy"** button → `POST /api/sniper/strategy` | ✅ UI (use THIS, not `/oracle/arm`, not agent-edit "Alpha Hunt" which is broken) |
| Watch it trade | `/agent-screen?agentId=`, `/dashboard/sniper`, `/terminal` | live positions/PnL, 3D avatar, treasury cockpit | ✅ UI |
| Manual per-coin buy (optional) | `/terminal` | select agent → click a launch → **Buy** (SOL presets, live quote) → `POST /api/agents/:id/solana/trade` | ✅ UI |

**"Sniping" is set up in the UI, executed by the platform.** A human arms the sniper at
`/dashboard/sniper`; three.ws then buys autonomously. That IS the human-on-three.ws flow.
(If the owner wants literal per-coin manual clicking instead, `/terminal` supports it —
but that's a different, slower video.)

### ⚠️ Where the UI can't match the plan (flagged, owner to decide)

- **Vanity wallets — NOT UI-doable.** three.ws auto-generates a *random* wallet per agent;
  there's no import-keypair button. Vanity requires importing keys outside the UI
  (breaks "UI-only"). **Decision:** random UI wallets, or allow a non-UI key-import step.
- **Funding fan-out — NOT a three.ws UI action.** Sending SOL to the 33 addresses is an
  on-chain transfer from the `niChP` funder (external wallet), not a three.ws click. We
  record it (terminal + Solscan) but it happens outside the product UI.
- **Account** — need a three.ws login. Register a fresh account in-UI, or use the owner's.

## 7. Recording plan (the deliverable)

Recorder: [scripts/reel.js](../scripts/reel.js) (Playwright video + stills + caption bar;
`CAST=1` also broadcasts to a live agent-screen). What we capture, per phase:

- **Distribution:** the `fleet.js fund` run (terminal) + Solscan showing 33 wallets receive
  SOL from the funder.
- **Per-agent trading:** each agent's `/agent-screen` (or arena/theater/terminal) as its
  buys/sells land — with the decision rationale on screen.
- **The swarm:** `/play/arena` and `/theater` with all 33 as 3D avatars reacting to wins.
- **Intelligence:** overlay/caption the signals behind each buy.

Output per run: `.webm` + per-scene PNG + `manifest.json`, assembled with `@ffmpeg`.

## 8. Live tracking (ops, not the video)

Telegram feed ([scripts/telegram.js](../scripts/telegram.js)) — per-trade buy/sell + 15-min
summary; plus the local console (`fleet.js run --serve`, `:8787`). See
[00-overview.md](00-overview.md#live-tracking--telegram-feed-recommended).

## 9. Credentials inventory

| Secret | Have? | Use |
|---|---|---|
| `DATABASE_URL` (Neon) | ✅ | provision the 33 platform agents (Cut 02) |
| `SOLANA_RPC_URL` / `HELIUS_API_KEY` | ✅ | live RPC for trading + funding |
| Funder key (`niChP…`, base58) | ✅ | sign the fan-out |
| `WALLET_ENCRYPTION_KEY` / `JWT_SECRET` (64-byte) | ✅ (likely) | encrypt/decrypt agent wallets; **verify** by decrypting a known agent |
| Anthropic API key (Fable) | ⏳ owner will provide | LLM decision layer |
| three.ws API key / session (`agents:write`) | ❌ | needed to import wallets / drive agent-screen via API |
| Launcher-master keypair | ❌ (none) | not needed — fund from funder directly |

All stored in `~/.three-ws-fleet/env` (chmod 600, outside the repo).

## 10. Phases (each ends with recorded footage + a LOG entry)

0. **Docs & setup** *(this)* — PLAN + LOG, secrets secured, tooling built & verified.
1. **Avatars** — pick/verify 33 rigged 3D avatars (Avaturn/gallery).
2. **Vanity wallets** — grind 33 vanity keypairs (shared prefix); back up the keyfile.
3. **Provision** — create 33 `agent_identities` (public, avatar-linked), import vanity
   wallets, arm strategies. *Verify WALLET_ENCRYPTION_KEY decrypts one first.*
4. **Fund** — niChP → 33, **recorded**.
5. **Intelligence** — wire oracle + smart-money + cultural + Fable decision layer.
6. **Trade live** — run the engine (mayhem filter ON), agents trade, **recorded per agent**.
7. **Assemble** — cut the social video; publish the log.
8. **Sweep & rotate** — recover SOL; rotate the shared secrets.

## 11. Risks & open decisions

- **⚠️ Decision:** trading-UI approach **(A) autonomous+agent-screen vs (B) scripted manual**
  (§6). Recommended A. *Blocks Phase 4/6.*
- **Production DB writes** — we're writing to the live Neon DB. Prefer a staging clone if
  one exists; otherwise namespace agents (e.g. "Scout NN") and soft-delete on cleanup.
- **Shared secrets in chat** — DB password, keys, and RPC were pasted in chat. **Rotate all
  of them after this exercise.**
- **Shared worktree** — other agents edit `node_modules`/files here; do clean installs and
  stage explicit paths only.
- **Vanity grind time** — grows exponentially with prefix length; keep the prefix short
  (≤4 base58 chars) or it stalls Phase 2.
- **Fable model/cost** — finalize model + budget against the `claude-api` reference before
  Phase 5; keep per-decision token use small (short candidate context).

## 12. Verified so far (see LOG for detail)

`fleet.js` (fund/run/sweep + `--serve` console), `reel.js` (record + `--cast`),
`telegram.js` (live feed), `mayhem-filter.js` (Mayhem exclusion — **verified on live
mints**). 33 throwaway wallets already generated (pre-vanity). Screenshots of the live
three.ws UI captured. Secrets secured.
