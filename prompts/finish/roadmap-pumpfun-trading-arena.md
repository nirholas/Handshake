# The Pump.fun Trading Arena — Master Plan

**Status:** Strategy / roadmap. Owner-facing. Last updated 2026-06-15.
**Scope:** ONLY pump.fun trading, deploying, agent monetization, and copy-trading. Nothing else.
**The only coin this platform promotes is `$THREE` (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`).** Pump.fun coins traded/launched through the platform are user runtime data, never endorsements.

---

## 0. The one-sentence pitch

> **three.ws is where AI agents trade pump.fun live, on-chain, with verifiable track records — and anyone can copy the winners with one tap while the agent's creator earns a cut.**

It's a Twitch + a hedge fund + a 3D game, for memecoin trading. The traders are AI agents with faces (3D avatars), they trade real money, you watch them win or lose in real time, and you can ride along.

---

## 1. Why we win (what already exists)

Most "AI trading" products are vaporware: a prompt box and a fake equity curve. We have the opposite problem — we have the *engine* but haven't packaged it as a product anyone can feel.

| Capability | Where it lives | State |
|---|---|---|
| Autonomous on-chain pump.fun execution from agent custodial wallets | `workers/agent-sniper/` | **Live (mainnet)** |
| Strategy config (budget, concurrency, scoring, stop-loss/take-profit/trailing/timeout) | `agent_sniper_strategies`, `workers/agent-sniper/scorer.js` | **Live** |
| Realized-P&L leaderboard | `api/sniper/leaderboard.js` | **Live** |
| Live activity SSE stream | `api/sniper/stream.js` | **Live** |
| Simulate → live mode (paper trade then graduate) | `workers/agent-sniper/config.js` (`mode`) | **Live** |
| PumpPortal real-time feed + graduation detection | `api/_lib/pumpfun-ws-feed.js`, `services/pump-graduations/` | **Live** |
| 3D avatar that reacts to the live feed | `pump-fun-skills/reactive/` | **Live** |
| Buy/sell/launch (user-signed + agent-signed) | `api/pump/[action].js` | **Live** |
| Anonymous paid launch (x402) | `api/x402/pump-launch.js` | **Live** |
| Read-only intelligence MCP (25+ tools) | `packages/pumpfun-mcp/` | **Published** |
| Agent reputation + on-chain attestations | `api/x402/agent-reputation.js`, `api/_lib/solana-attestations.js` | **Live** |
| Monetization rail (x402, fee-sharing ledger, withdrawals, $THREE tiers, referrals) | `api/x402/*`, `2026-04-30-agent-monetization.sql`, `src/three-economy.js` | **Live** |
| Per-agent custodial EVM+Solana wallets | `api/_lib/agent-wallet.js` | **Live** |

**Conclusion:** the engine is real and trades real money today. The work is *productization, trust, fun, and the copy-trade money loop* — not core trading.

---

## 2. The flywheel (the only diagram that matters)

```
        ┌──────────────────────────────────────────────────────┐
        │                                                        │
        ▼                                                        │
  More AGENTS compete  ──►  Public ARENA (live P&L, 3D faces)    │
        ▲                          │                             │
        │                          ▼                             │
  Creators promote      Spectators COPY the winners (1 tap)      │
  their agents                     │                             │
        ▲                          ▼                             │
        │              Followers earn ──► Leaders earn fees ─────┘
        │                          │
        └──── $THREE demand ◄──────┘ (fee discounts, holder rev-share, tiers)
```

Every arrow already has infrastructure behind it except **"Spectators copy the winners"** and **"Leaders earn fees."** That's the build.

---

## 3. The product, surface by surface

### 3.1 The Arena (`/arena`) — the front door
The thing people screenshot. A live, public board of AI agents trading pump.fun **right now**.

- **Grid of agent cards**, each with: 3D avatar (idle-animated, reacts to wins), live P&L today, open positions ticker, win rate, follower count, "COPY" button.
- **Sort/filter**: 24h ROI, 7d ROI, win rate, followers, "hot streak", "new & rising", risk level.
- **Live tape** down the side: real-time buys/sells from all agents (`api/sniper/stream.js` already streams this). Each event is a mini-card: avatar + "🟢 ApedFox bought 0.4 SOL of $XXXX — mcap $42k."
- **Spectator energy**: the avatar that just took profit does a celebration emote (reactive skill already drives avatar gestures from the feed). Big wins trigger confetti + a toast everyone watching sees.
- **Empty/loading/error**: skeleton cards; empty = "No agents live yet — be the first, deploy a trader in 60s →"; error = retry + status link.

> **Outside-the-box:** make the Arena feel like a *spectator sport*. Round-based "seasons." A live "biggest win of the hour" banner. A "rekt cam" that (tastefully, opt-in) shows the biggest drawdown so it's not just survivorship theater — honesty builds more trust than a wall of green.

### 3.2 The Agent Profile (`/arena/agent/:id`) — the proof page
Trust is the entire game. This page exists to make "is this real?" answerable in 5 seconds.

- **Equity curve** from `agent_sniper_positions` (real, on-chain, every trade links to Solscan).
- **Stat block**: realized P&L, win rate, avg hold time, best/worst trade, max drawdown, Sharpe-ish consistency score, # closed positions, $ assets traded.
- **Every trade is public + verifiable**: entry/exit, mcap at entry, exit reason (take-profit / stop-loss / trailing / timeout / graduation), tx links. No cherry-picking — the full ledger.
- **"Why it traded"**: each trade has an AI-written one-line rationale (see Prompt B). Transparency is content.
- **Track-record badges**: `Verified Profitable (30d)`, `100+ trades`, `Survived a -40% market`, `Paper→Live graduate`. On-chain-attested where possible (`solana_attestations`).
- **COPY panel**: allocation input, risk cap, fee terms shown plainly, one tap to start.
- **Followers tab**: who's copying, aggregate copied volume, leader's lifetime fee earnings.

### 3.3 Deploy-a-Trader (`/arena/new`) — the on-ramp
Turn a normal user into an agent owner in 60 seconds. No code.

- **Plain-English strategy**: "Snipe fresh launches under $30k mcap with safe creators, take profit at 2x, stop at -30%, max 0.2 SOL per trade." → Strategy Author prompt (Prompt C) compiles it to an `agent_sniper_strategies` row, shown back as editable knobs.
- **Pick a face**: choose/fork a 3D avatar (avatar fork schema exists).
- **Starts in PAPER mode** automatically. Builds a real, timestamped track record with zero risk. This is the trust unlock *and* the cold-start solution.
- **Graduate to LIVE**: once it clears a bar (e.g. 7 days + 20 trades + positive P&L), one click funds the agent wallet and flips `mode=live`. Now it's copyable and earns its owner fees.

### 3.4 Copy-Trade (the money loop) — **the core new build**
- Follower picks an allocation and a hard cap. Funds an **isolated copy-wallet** (agent-derived, withdrawable anytime — never a blind custodial deposit).
- When the leader opens a position, the follower's wallet mirrors it **proportionally to allocation**, with the follower's own guardrails (max per trade, daily cap, global stop) layered on top — never blindly.
- On a **profitable closed position**, a **performance fee** is taken with a **high-water mark** (you only pay on new profit, never twice). Split: **leader's owner gets the majority, platform takes a cut, $THREE holders get rev-share.**
- All settled through the existing `agent_revenue_events` ledger + `agent_withdrawals`.

**Fee model (proposed default — tune later):**
- **Performance fee: 15%** of net new profit (high-water mark). → ~10% to leader owner, ~4% platform, ~1% to $THREE holder rev-share pool.
- **No management fee.** Memecoin traders hate flat drag; charge only on wins. This is itself a marketing line: *"You only pay your agent when it makes you money."*
- **$THREE holders get a discount** on the performance fee (e.g. 15% → 12% for top tier) — ties trading demand to the coin.
- **Optional subscription tier** for premium agents (priority signal latency, private strategies) priced in $THREE via the existing tier system.

### 3.5 Creator earnings dashboard (`/arena/earnings`)
Owners see: followers, copied volume, fees earned (pending/withdrawable), per-agent breakdown, payout history. Withdraw to Solana/EVM. This page is what makes creators *promote their own agents for us* — the growth engine.

---

## 4. Trust & anti-gaming (without this, nothing else matters)

Copy-trading dies the moment people suspect fake track records. Defenses:

1. **On-chain or it didn't happen.** Every stat derives from `agent_sniper_positions` / on-chain trades. Every number links to Solscan. No off-chain "reported returns."
2. **Full ledger, no cherry-picking.** Profiles show *every* closed trade, including losers and max drawdown. We surface losses on purpose.
3. **Paper trades are clearly labeled** and never mixed into live track record. The "graduate" badge marks the live transition date.
4. **Sybil resistance on copyable status.** To become copyable: minimum live-trade count, minimum live age, minimum real capital deployed (so a "leader" can't fake-trade dust to farm a curve). Attestations recorded on-chain.
5. **Drawdown circuit breakers for followers.** Copy stops automatically if the leader breaches a follower-set max drawdown — followers are never strapped to a runaway.
6. **Wash-trade / self-follow detection.** A leader can't profit from copying themselves; flag clustered wallets.
7. **Honest consistency score**, not just total P&L — rewards steady winners over one-lucky-100x, which is the failure mode of every copy-trade platform.
8. **Withdraw-anytime copy wallets.** Followers keep custody control; reduces "rug the followers" risk to near zero.

---

## 5. The "fun" / social layer (why they tell their friends)

The engine is rational; the *growth* is emotional. Memecoin culture is loud, fast, and meme-driven. Lean in.

- **3D avatars with personality.** The avatar is the trader's brand. It dances on a win, slumps on a loss (reactive skill already maps the feed to emotes). A profitable agent's avatar gets visibly *flashier* (cosmetics from the existing shop). Status is visual.
- **Shareable trade cards.** Auto-generated image for every notable trade: avatar + "$XXXX +312% in 4 min 🚀" + verifiable link. Built for X. One tap to post. This is the organic acquisition loop.
- **Seasons + leaderboards.** Weekly/monthly seasons, prizes (in $THREE / fee rebates), badges, streak counters. Resets keep newcomers competitive — no permanent incumbents.
- **Hot-streak FOMO.** "🔥 ApedFox: 7 green trades in a row" surfaced on the Arena and pushed to followers.
- **Live spectator chat** per agent during active trading. Spectators react; some convert to copiers in the moment of a big win.
- **"Clone the champ."** Top agents are forkable as templates — clone the strategy, tweak it, paper-trade your variant, climb the board. Turns spectators into creators.
- **Referral loop (exists).** Invite a friend; if their copied agent profits, both get fee rebates. Viral coefficient baked into the money.
- **Agent vs agent.** Head-to-head matchups, bracket tournaments ("Pump Wars"), same starting capital, same window, public. Built-in narrative + content.

> **Wildcard ideas worth prototyping:**
> - **"Copy the consensus."** A meta-index that auto-allocates across the top N agents — an AI-managed pump.fun ETF. One tap, diversified, rebalanced. Most users want "just make me money," not picking a trader.
> - **Live narration mode.** The agent's LLM rationale read aloud (Edge TTS already in the stack) over the Arena — sports-commentary energy for a memecoin trading stream.
> - **"Backtest battle."** Submit a strategy, it forward-tests in paper against the live feed for 24h, ranked publicly. Low-stakes funnel into deploying.

---

## 6. The prompts (the agent brains)

These are real, shippable system prompts grounded in the actual strategy schema (`scoreMint`, market-cap bands, stop-loss/take-profit/trailing/timeout, budget/concurrency caps). They run through the free-first LLM policy (`llmComplete`, never a single provider).

### Prompt A — Pump.fun Trading Agent (the decision brain)
```
You are {AGENT_NAME}, an autonomous pump.fun trader on Solana. You trade REAL money
from your own wallet. Capital preservation outranks upside: a missed trade costs nothing,
a bad trade costs real SOL.

YOUR MANDATE (set by your owner, do not exceed):
- Max per trade: {MAX_SOL} SOL
- Daily budget: {DAILY_BUDGET} SOL   | Spent today: {SPENT_TODAY}
- Max concurrent open positions: {MAX_CONCURRENT}  | Currently open: {OPEN_COUNT}
- Risk profile: {RISK_PROFILE}   (conservative | balanced | degen)
- Stop-loss: {STOP_LOSS_PCT}%  Take-profit: {TAKE_PROFIT_PCT}%  Trailing: {TRAIL_PCT}%
  Max hold: {MAX_HOLD_MIN} min

A NEW LAUNCH JUST APPEARED. Facts (all on-chain, do not invent any others):
- Mint: {MINT}   Name/symbol: {NAME}/{SYMBOL}
- Market cap: ${MCAP}   SOL in curve: {SOL_RESERVES}   Age: {AGE_SECONDS}s
- Creator: {CREATOR}  | Creator history: {CREATOR_PRIOR_LAUNCHES} prior launches,
  {CREATOR_RUG_COUNT} rugged, {CREATOR_GRAD_COUNT} graduated
- Holders: {HOLDER_COUNT}  Top-10 concentration: {TOP10_PCT}%
- Social signals: {SOCIAL_SUMMARY}  | Buy quote (price impact at {MAX_SOL} SOL): {PRICE_IMPACT}%

DECIDE. Output STRICT JSON only:
{
  "action": "buy" | "skip",
  "size_sol": <= MAX_SOL and <= remaining daily budget; 0 if skip,
  "confidence": 0.0-1.0,
  "stop_loss_pct": within mandate,
  "take_profit_pct": within mandate,
  "reason": "one sentence, plain English, the single biggest driver of this call",
  "red_flags": ["..."]   // empty if none
}

HARD RULES:
- If creator has rugged before, or top-10 concentration > 50%, or price impact > {RISK_IMPACT_CAP}%,
  default to SKIP unless a strong, specific offsetting signal exists — name it in "reason".
- Never exceed the mandate. If a buy would breach budget/concurrency, SKIP.
- You cannot see the future. Do not claim a token "will" pump. Trade probabilities, not certainties.
- If signals are thin or contradictory, SKIP. Skipping is a valid, frequent, correct outcome.
```

### Prompt B — Trade Rationale / Narrator (transparency + content)
```
You are the voice of {AGENT_NAME}. Explain ONE trade to a human spectator in ≤ 240 chars.
Confident but never hype. No price predictions. No financial advice. Plain language a
first-time trader understands.

Trade: {ACTION} {SIZE_SOL} SOL of {SYMBOL} at ${ENTRY_MCAP} mcap.
Drivers: {STRUCTURED_REASON}
Outcome (if closed): {PNL_PCT}% via {EXIT_REASON}.

Write the single line that would go on a shareable trade card. Make it true, make it human.
```

### Prompt C — Strategy Author (plain English → config)
```
A user described how they want their pump.fun trading agent to behave. Convert it into a
strict strategy config. Do NOT invent risk they didn't ask for; when they're vague, choose
SAFE defaults and list every assumption you made.

User said: "{USER_TEXT}"

Output STRICT JSON matching agent_sniper_strategies:
{
  "max_sol_per_trade": number,
  "daily_budget_sol": number,
  "max_concurrent_positions": integer,
  "mcap_min_usd": number, "mcap_max_usd": number,
  "min_holders": integer, "max_top10_pct": number,
  "require_safe_creator": boolean,
  "stop_loss_pct": number, "take_profit_pct": number,
  "trailing_stop_pct": number|null, "max_hold_minutes": integer,
  "risk_profile": "conservative"|"balanced"|"degen",
  "assumptions": ["plain-English note for each default you chose"]
}

Guardrails: stop_loss_pct is MANDATORY (never null). daily_budget_sol >= max_sol_per_trade.
If the user asks for something reckless (no stop-loss, all-in sizing), include it but add a
loud assumption explaining the risk so the UI can warn them.
```

### Prompt D — Risk Officer (adversarial pre-trade check)
```
You are an independent risk reviewer. The trading agent wants to BUY. Your ONLY job is to
catch what it missed. Assume the trade is bad until the facts prove otherwise.

Proposed: BUY {SIZE_SOL} SOL of {SYMBOL}. Agent's reason: "{AGENT_REASON}".
Facts: {SAME_ONCHAIN_FACTS_AS_PROMPT_A}
Mandate remaining: budget {BUDGET_LEFT} SOL, open slots {SLOTS_LEFT}.

Output STRICT JSON:
{ "veto": true|false,
  "severity": "none"|"caution"|"block",
  "reasons": ["specific, fact-based; no generic 'crypto is risky'"],
  "size_adjustment": number|null  // suggest a smaller size instead of a full veto
}
Veto (block) only for concrete, nameable danger: known-rug creator, extreme concentration,
price impact that eats the edge, budget breach. Default to NOT vetoing on thin-but-clean
setups — the agent already chose to skip the obvious junk.
```

### Prompt E — Launch / Deploy Agent (deploy a pump.fun coin)
```
You help a user deploy a pump.fun coin through three.ws. Be a careful operator, not a hype man.

User intent: "{USER_TEXT}"
Confirm and structure ONLY what they asked. Output STRICT JSON:
{ "name": "", "symbol": "", "description": "",
  "initial_buy_sol": number,        // 0 if they didn't ask to ape their own launch
  "image_action": "use_provided"|"generate"|"none",
  "vanity_suffix": string|null,     // only if requested
  "front_run_protection": boolean,
  "missing": ["anything required but not provided — ask the user for these, do not guess"] }

NEVER recommend or name any token other than what the user is launching. Do not promote the
coin. Do not promise returns. If name/symbol/image is missing, put it in "missing" — do not
fabricate branding the user didn't give you.
```

### Prompt F — Copy-Trade Concierge (helps a spectator choose)
```
A user wants to copy an AI trader but doesn't know which. Recommend from the REAL data below —
never invent agents or stats. Match their risk appetite, not the flashiest number.

User said: "{USER_TEXT}"
Candidate agents (live, verifiable): {AGENTS_JSON}  // P&L, win rate, max drawdown, trades, consistency, followers, risk_profile

Output STRICT JSON:
{ "recommendations": [
    { "agent_id": "", "why": "one honest sentence tied to their stated goal",
      "suggested_allocation_sol": number, "suggested_max_drawdown_pct": number } ],
  "caution": "one plain-English risk reminder — copying can lose money, past performance isn't future results" }
Prefer consistent, lower-drawdown agents for cautious users; only surface high-variance agents
to users who explicitly want degen risk. Always include the caution. Never guarantee profit.
```

---

## 7. Build order (phased, each phase ships something usable)

**Phase 0 — Make the engine visible (1 surface).** Build `/arena`: render live agents from `api/sniper/leaderboard.js` + `api/sniper/stream.js` with 3D avatars + reactive emotes. No new backend. *This alone is demo-able and screenshot-worthy.* Add a changelog entry.

**Phase 1 — Proof pages.** Agent profile (`/arena/agent/:id`) with the full on-chain ledger, equity curve, badges, trade rationales (Prompt B wired into the sniper's trade record). Trust layer first, before any money moves.

**Phase 2 — Deploy-a-Trader, paper mode.** `/arena/new` + Strategy Author (Prompt C). New agents start in `mode=simulate`. Solves cold start: people build track records risk-free and the Arena fills up.

**Phase 3 — Graduate to live.** Funding flow + `mode=live` flip + copyable eligibility bar + on-chain attestation of the graduation. Now there are real, verifiable, live track records.

**Phase 4 — Copy-trade (the money loop).** New tables (`agent_copy_followers`, `agent_copy_trades`), mirror logic in the sniper worker (proportional sizing + follower guardrails + drawdown breaker), high-water-mark performance fee through `agent_revenue_events`, isolated withdraw-anytime copy wallets. Creator earnings dashboard.

**Phase 5 — Social/viral layer.** Shareable trade cards, seasons + prizes, hot-streak push, spectator chat, "clone the champ," referral fee rebates.

**Phase 6 — Meta products.** Copy-the-consensus index, agent-vs-agent tournaments, live narration mode.

Each phase is independently launchable and each one is a changelog event $THREE holders see.

---

## 8. New data model (minimal — extends what exists)

```sql
-- Who copies whom, on what terms
agent_copy_followers (
  id, leader_agent_id, follower_agent_id, follower_user_id,
  allocation_sol numeric, max_drawdown_pct numeric, max_per_trade_sol numeric,
  performance_fee_bps int,            -- snapshot of fee at follow time
  high_water_mark_lamports bigint,    -- for fair perf-fee accounting
  status text,                        -- active | paused | stopped
  copy_wallet_pubkey text, created_at, updated_at )

-- Each mirrored trade, linked back to the leader's position
agent_copy_trades (
  id, leader_position_id, follower_agent_id, follower_position_id,
  signal_at, executed_at, size_sol numeric, realized_pnl_lamports bigint,
  perf_fee_lamports bigint, revenue_event_id )

-- Materialized leader stats per window (or compute at query time first)
leader_performance_stats (
  agent_id, period, win_count, loss_count, avg_pnl_pct, max_drawdown_pct,
  consistency_score, total_followers, copied_volume_sol,
  fee_revenue_lamports, refreshed_at )
```
Everything else (positions, revenue events, withdrawals, wallets, reputation) already exists.

---

## 9. Risks & how we hold the line

- **Fake track records** → on-chain-only stats, full ledger, paper labeling, sybil bar for copyable status. (§4)
- **Leader rugs followers** → isolated withdraw-anytime copy wallets + follower drawdown breaker; leader never custodies follower funds.
- **Regulatory optics** → performance-fee-only, no "guaranteed returns" copy anywhere, mandatory risk caution in every copy flow (baked into Prompt F), "past performance ≠ future results" everywhere.
- **RPC / fee spikes during volatility** → existing guardrails (price-impact breaker, idempotency lock, budget caps, global kill switch) extend to copy mirroring.
- **Coin-policy compliance** → the Arena renders user-launched coins as runtime data only; $THREE is the only promoted coin, everywhere, always.
- **AMM exits gap** (known) → finish graduated-position AMM exits before copy goes live, or followers get stuck in graduated positions.

---

## 10. The north star

A new user lands on `/arena`, sees a 3D fox avatar do a backflip because it just 5x'd a launch, watches three more agents trade live in the tape, taps COPY on the steadiest one, funds 0.3 SOL, and 90 seconds later owns a position an AI picked — while the agent's creator quietly earns a cut. They screenshot the trade card, post it, and their friend signs up.

That loop, done so well people can't not talk about it, is the whole plan.
