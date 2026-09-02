# Pump.fun Trading — The Wedge, the Reframes, and the Net-New Plays

**Status:** strategy delta · **Last updated:** 2026-06-15
**Read this *after* the two master plans — this is the sharpening layer, not a re-pour:**
- [pumpfun-trading.md](roadmap-pumpfun-trading.md): full product surface map, copy-trade fee mechanics, base prompt library, 15 plays, cold-start.
- [pumpfun-trading-arena.md](roadmap-pumpfun-trading-arena.md): Arena-first framing, prompts A to F, the SQL data model, anti-gaming.

> Scope lock (same as the other two): pump.fun trading / deploying / copy-trade economy only.
> The only coin the platform promotes is **$THREE** (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`).
> pump.fun coins traded/launched through the platform are user runtime data, never endorsements.
> All examples below use `$TICKER` / `<mint>` placeholders.

---

## 0. Why this doc exists

The two master plans converge on the same product: a live Arena of AI agents with 3D
faces, verified on-chain track records, one-tap copy-trade, a high-water-mark performance
fee that pays leaders, seasons, shareable cards, and a paper→live cold-start. That product
is correct. This doc does **not** re-argue it.

What both plans under-decide:
1. **The wedge.** Both say "build the Arena." Neither commits to the *single* first
   behavior that drags in the first 1,000 real crypto traders at zero behavior change.
2. **What the moat actually is.** Both lean on "3D avatars = moat." The avatars are the
   *distribution surface*. The moat is something else (§2.1).
3. **Revenue that survives a bear market.** Both are perf-fee-only (15%). Perf fees are
   zero when nobody's winning. We need a second, counter-cyclical rail (§3.4).
4. **The net-new mechanics** that make us un-clonable instead of "Photon with avatars" (§3).

---

## 1. The wedge: *claim your wallet*, don't *deploy an agent*

Both plans treat "Deploy a Trader (paper→live)" as the on-ramp. That's the **expansion**
loop, not the wedge. Asking a degen to author a strategy and grow a paper record is a
multi-day behavior change. It fills the Arena with *our* agents, not *their* attention.

**The wedge is the import.** Every target user already trades pump.fun today — on Photon,
BullX, Trojan, Axiom. Their track record already exists, on-chain, and earns them nothing
beyond clout screenshots they can't prove. So:

> **Paste your wallet → we reconstruct your real pump.fun P&L from the chain → you get a
> verified, narrated, *unfakeable* track record and a 3D trader-card in 30 seconds. Make it
> public, get copied, earn a cut. No new behavior, no deposit, no risk.**

Why this is the wedge and "deploy an agent" is not:

| | Claim-your-wallet (wedge) | Deploy-an-agent (expansion) |
|---|---|---|
| Behavior change | **Zero** — they already traded | High — author + tune a strategy |
| Time to value | 30 seconds (read-only) | Days (build a paper record) |
| Trust ask | None (we hold nothing) | None, but effort-heavy |
| Viral artifact | Instant ("I'm +340% verified, prove me wrong") | Delayed |
| Who it pulls | The *existing* degen crowd, en masse | Builders (smaller pool) |

The claim flow needs **no funded signer and no custody** — it's a read-only chain indexer
plus a narrator (Prompt §4.1). It is the single cheapest, fastest, lowest-risk thing to
ship, and it is the top of every other funnel: a claimed wallet is a leader candidate, a
copy target, a shareable card, and a referral node, all at once.

**Sequencing call:** `claim` ships *before* `deploy`, *before* copy-execution, *before* the
funded-signer decision. Deploy-an-agent and copy-execution layer on top of a board that's
already populated with real humans' real records.

---

## 2. Three reframes that change what we build

### 2.1 The moat is the verified track-record graph + the copy graph — not the avatars
Avatars are the *skin* that makes the thing shareable and fun (keep them — they're the
distribution surface and nobody else has them). But they're cloneable in a weekend. What
compounds and can't be copied:

- **The verified-performance graph:** a cross-wallet, on-chain-attested ledger of *who is
  actually good*, risk-adjusted, with follower-outcome weighting. We become the issuer of
  the credential the whole ecosystem references. (Builds on `solana_attestations`,
  `api/x402/agent-reputation.js`.)
- **The copy graph:** who follows whom, who made whom money. This is a social network with
  a P&L attached to every edge. It's the retention moat and the data moat.

Implication: invest disproportionately in **making the track record portable, provable, and
referenced elsewhere** (a "Trader Passport," §3.1), and in the **follower-outcome metric**
(profit actually delivered to copiers), because that's the number that's hardest to fake and
the one that ranks honestly.

### 2.2 We're a media company that happens to trade
Every trade emits a piece of content: a ticker, a multiple, an avatar reaction, and a
*reason*. The reasoning + the card is not a feature — **it is the acquisition channel.** The
trading is the retention. Reframe the org chart of the product around that:

- The **Clip Director** (Prompt §4.4) turns every notable close into the optimal artifact
  per surface (X / Telegram / the in-app Feed).
- Logged-out browsable Feed is the SEO + share surface. Login is required only to *act*.
- The honest rationale ("entered because curve 68%, 3 fresh-wallet buys, creator has 2 prior
  graduations") is more screenshot-worthy than a green number, because it *teaches* — and
  teaching is what gets followed.

### 2.3 Radical downside-transparency is the brand
The space is wall-to-wall fake-screenshot scammers. The arena plan floats a "rekt cam" as a
nicety. **Make it the brand.** We are *the only leaderboard that shows you the losers* — full
ledger, every stop-out, max drawdown, rug-survival, no cherry-picking. In a market built on
lies, verifiable honesty is the strongest possible wedge for trust, and trust is the entire
copy-trade business. Tagline energy: *"Every trade. Even the bad ones. On-chain or it
didn't happen."*

---

## 3. Net-new mechanics (the outside-the-box layer neither plan has)

Curated to the highest-leverage. Each notes the rails it builds on so it's real, not a wish.

### 3.1 The Trader Passport — a portable, on-chain reputation credential
The track record shouldn't live only on our profile page. Mint it as an **on-chain
attestation the trader owns** — a "Trader Passport" they can carry anywhere, that any other
app can read and verify. We become the *issuer of record* for pump.fun trader reputation.
- *Why it's a moat:* the credential standard is sticky; once other tools reference it, we're
  infrastructure, not an app.
- *Builds on:* `solana_attestations`, `api/_lib/solana-attestations.js`, the reputation
  endpoint. The passport is the verified track record, signed and addressable.

### 3.2 Alpha-drip — latency tiers on a leader's signal (the $THREE sink)
A leader's edge decays in seconds. So sell the *latency*, not just the copy. A leader's own
signal releases to **paid/holder copiers at t+0, free riders at t+N seconds** (leader-set).
This is exactly how paid signal groups already work — except here it's enforced by the
copy-engine and verifiable.
- *Why it matters:* it's a real reason to *hold $THREE* (top tiers = lowest latency) and a
  real product the leader can sell. Counter-cyclical: people pay for speed even in chop.
- *Careful framing (see §5 risk):* this is the leader gating *their own* signal as a
  subscription — not front-running third parties. Disclose it plainly; never imply
  privileged access to *others'* orderflow.
- *Builds on:* holder tiers (`three-tier.js`), the copy-engine fan-out, `charge-three.js`.

### 3.3 Meta-allocator agents — the agent economy trades itself
Both plans mention an "index of top agents" in passing. Make it a first-class agent type: an
agent whose entire strategy is **allocate across the top-N risk-adjusted leaders and
rebalance**. The leaderboard becomes an *input* to strategies, so the system compounds on
itself — better leaders → better meta-agents → more copy demand → more leaders.
- This is the diversified on-ramp for normies who want "just make me money," not a single
  bet (lower variance → higher conversion of the cautious).
- *Builds on:* leaderboard ranking + copy-engine fan-out + the perf-fee split prorated across
  the basket's leaders. Prompt §4.2 is its brain.

### 3.4 The execution vig — revenue that survives a bear market
Perf-fee-only dies when nobody's green. Add a tiny **per-mirrored-trade execution fee** (a
few bps, in $THREE, holder-discounted) on every copy execution, win or lose. It's small
enough to be invisible, robust enough to fund the platform through chop, and it makes
**priority execution for holders** a sellable feature (lower latency, better fills).
- Keep perf-fee as the headline ("you only pay your agent when it wins"); the vig is the
  quiet, counter-cyclical floor.
- *Builds on:* `agent_revenue_events`, split policies in `token/config.js`.

### 3.5 House-bankrolled first trade — kill the funding cliff
The biggest drop-off after "claim your wallet" is "now fund a wallet." Remove it: the
platform fronts a **micro real-money first position** (e.g. $1 of $THREE-denominated size)
on the user's behalf for their first Co-Pilot trade. They keep the upside; the house eats a
capped downside. One real win with zero deposit converts better than any amount of copy.
- Bounded, abuse-modeled (one per verified identity), framed as a welcome — not a faucet.
- *Builds on:* $THREE rewards pool, Co-Pilot sign flow, the first-rug-softener idea in
  trading.md §12.15 (this is its cleaner, scoped sibling).

### 3.6 The persistent 3D trading floor — the retention destination
Spectating in `world.three.ws` (Hyperfy) is a tier-3 nicety in both plans. Promote it: a
**persistent 3D trading floor** where agents trade live, humans walk in, watch the tape,
hear the narration (Edge-TTS), fork a trade from the room, and voice-chat. This is what turns
a tool you check into a place you *hang out* — Twitch-for-degens. The Hyperfy world,
reactive avatars, and SSE trade stream already exist; this is assembly.

### 3.7 Meme-first acquisition hooks — the first action is a meme, not a finance decision
Don't open with "configure your risk parameters." Open with an emotion:
- **"Fade the influencer."** One tap to copy the *inverse* of a provably-bad public wallet.
- **"Copy the whale."** Ride a verified top wallet.
- **"Beat your friend."** Head-to-head a friend's claimed wallet; loser posts the card.

Each is a meme that *happens* to be a trade. The finance is the substrate; the hook is
social. (Fade mode + agent-vs-agent exist as ideas in both plans — this reframes them as the
*front door copy*, not a deep-menu feature.)

### 3.8 B2B: the copy-execution + reputation API ("Plaid for trader reputation")
The consumer app is one business. The bigger one: license the **verified-track-record API +
copy-execution engine** to *other* pump.fun terminals. They get instant trust + a copy
feature; we take a cut of every routed trade and become the reputation layer the category
references. This is a different, larger TAM than the app and neither plan considers it.
- *Builds on:* the same reputation endpoint, the copy-engine, x402 metering for API billing.

---

## 4. Net-new prompts (the ones the two libraries are missing)

The two plans already ship ~14 solid prompts (Core Trader + strategy blocks, Research
Analyst, Narrator, Risk Officer, Copy-Conductor, Sentiment Scout, Onboarding Coach;
arena A–F). These four are the gaps that power the §1–§3 ideas. All run through the
free-first LLM policy (`llmComplete`, never a single provider). $THREE-safe.

### 4.1 Wallet-Import Track-Record Narrator (powers the wedge, §1)
```
You convert a wallet's REAL on-chain pump.fun history into a verified, HONEST track record.
You do not trade. You never invent or round-up a number — every stat must trace to the
provided on-chain trades. If data is missing, say so and lower confidence; never pad.

INPUT: { wallet, trades: [ {mint, side, ts, size_quote, quote_symbol, entry_mcap,
         exit_mcap, realized_pnl_quote, exit_reason} ... ] }  // reconstructed from chain

Produce STRICT JSON:
{
  "wallet": "<wallet>",
  "verified_stats": {
    "closed_trades": <int>, "win_rate_pct": <num>, "realized_pnl_quote": <num>,
    "best_multiple": <num>, "worst_drawdown_pct": <num>, "avg_hold_min": <num>,
    "median_size_quote": <num>, "days_active": <int>, "consistency_score": 0-100
  },
  "style": "sniper" | "swing" | "graduation_hunter" | "contrarian" | "mixed",
  "honest_summary": "2-3 sentences INCLUDING the weaknesses — show a loss, name the risk",
  "card_line": "<=80 chars, true, postable, no hype, no price prediction",
  "copyability": { "copyable": bool, "reasons": ["e.g. too few live trades / dust-only / clean"] },
  "confidence": "low|medium|high"
}
Rules: surface losses on purpose (downside-transparency is the brand). Rank-relevant metric
is risk-adjusted consistency, not raw P&L. Never claim future performance. Reference no token
other than the ones traded or $THREE.
```

### 4.2 Meta-Allocator (the ETF-of-degens brain, §3.3)
```
You allocate a fixed budget across VERIFIED leader agents and rebalance. You do not pick
individual tokens; you pick leaders. You only use the real leaderboard data provided.

INPUT: { budget_quote, risk_profile: "conservative"|"balanced"|"degen",
         leaders: [ {agent_id, win_rate_pct, risk_adjusted_score, max_drawdown_pct,
                     follower_outcome_pnl, capacity_quote, correlation_group} ... ],
         current_allocations: [...] }

Output STRICT JSON:
{ "allocations": [ {agent_id, weight_pct, size_quote, why: "one fact-based line"} ],
  "excluded": [ {agent_id, reason} ],
  "rebalance_rule": "plain-English trigger (e.g. drop a leader if 7d drawdown > X% or
                     correlation to an existing pick is too high)",
  "caution": "one honest risk line" }
Rules: diversify across correlation_groups — never concentrate the basket in one style.
Weight by follower-outcome and risk-adjusted score, NOT raw P&L. Respect each leader's
capacity_quote (don't allocate size that moves their fills). For conservative profiles cap
single-leader weight and max_drawdown. Default to fewer, steadier leaders when uncertain.
```

### 4.3 Alpha-Drip Tiering (the latency-monetization brain, §3.2 — edgier, gate carefully)
```
You decide how a LEADER's OWN trade signal is released across the leader's OWN subscriber
tiers. You are gating the leader's self-produced signal as a subscription product. You are
NOT accessing, delaying, or front-running anyone else's orders — only the leader's own.

INPUT: { trade_signal: {mint, side, size_quote, edge_thesis},
         estimated_edge_halflife_sec, leader_capacity_quote,
         tiers: [ {tier, max_latency_sec, subscriber_count} ... ] }

Output STRICT JSON:
{ "release_schedule": [ {tier, delay_sec, max_copy_size_quote} ],
  "public_delay_sec": <int>,   // when non-subscribers see it (can be "never" for the trade itself, always for the record)
  "disclosure_line": "plain-English: 'subscribers get this signal first; this is the leader's own call, not privileged orderflow'",
  "capacity_note": "how size was split so early tiers don't exhaust the leader's edge/capacity" }
Rules: the full trade MUST always become part of the public on-chain record (no hidden
trades — downside-transparency is non-negotiable). Tiering controls *timing of the copy
signal*, never *whether the trade is disclosed*. Never imply access to third-party orderflow.
If edge_halflife is very short, warn that tiering may not be fair to slower tiers and
recommend equal release instead.
```

### 4.4 Clip Director (the content-engine, §2.2)
```
You turn ONE closed trade into the optimal shareable artifact per surface. You are a
content director, not a trader. Truthful, human, no hype, no price predictions.

INPUT: { agent_name, avatar_style, trade: {symbol, multiple, entry_mcap, exit_mcap,
         hold_min, exit_reason, realized_pnl_quote, quote_symbol},
         copied_by_count, surface: "x"|"telegram"|"feed" }

Output STRICT JSON:
{ "hook": "<=80 chars, the scroll-stopping first line, true",
  "feature_stat": "the single most compelling REAL number to headline",
  "avatar_gesture": "celebrate|shrug|sweat|point|wave",
  "body": "1-2 lines: what happened + why, plain language",
  "cta": "fork-this-trade | copy-the-agent | view-track-record",
  "alt_text": "accessibility description of the card" }
Rules: feature the real number; if the trade was a LOSS, still produce an honest card
(brand = transparency) with a 'live to trade again' tone. Tune length/voice to the surface
(X punchier, Telegram chattier, Feed mid). Reference no token other than the traded one or
$THREE. Always include a verifiable angle (the record is on-chain).
```

---

## 5. The sharpened first two weeks (one wedge, one metric)

Both plans phase "Arena → Profile → Deploy → Copy." Sharper, wedge-first:

1. **Week 1 — Claim + Card + Feed (read-only, zero custody, zero funded signer).**
   - On-chain pump.fun history reconstructor → Wallet-Import Narrator (§4.1) → a verified,
     honest Trader Card. Mint the Trader Passport attestation (§3.1).
   - The logged-out, browsable Feed of claimed cards + the in-house paper agents (cold-start
     from trading.md §13.1) running the real persona prompts against the live PumpPortal feed.
   - Clip Director (§4.4) on every notable close → shareable card with a referral hook.
   - **This is fully shippable now** — it's indexer + LLM + render. No new custody surface.

2. **Week 2 — Co-Pilot + House-bankrolled first trade.**
   - Co-Pilot (suggest → user signs their own wallet) from any card/Feed item — the
     existing `buy-prep → sign → buy-confirm` flow + the trader prompt's structured output.
   - House-bankrolled first position (§3.5) to kill the funding cliff.
   - Still **no delegated custody.** Full auto-copy (session keys moving real follower funds)
     stays the *last* gate, after the funded-signer/custody decision — same call both plans
     make, just stated louder.

**The one metric for this phase:** *number of verified Trader Cards made public, and the
share rate per card.* Not trades, not volume — the wedge is identity + proof + virality.
Copy-volume is a Phase-2 metric and depends on custody being resolved.

---

## 6. Housekeeping: consolidate the two master plans

`roadmap-pumpfun-trading.md` (committed, currently modified) and `roadmap-pumpfun-trading-arena.md`
(untracked draft) are ~80% the same plan written twice. Two competing canonical plans is a
liability — they will drift. Recommendation: **fold the arena draft's unique value (the SQL
data model §8, the verified-capability table §1, prompts A to F) into `roadmap-pumpfun-trading.md` as
the single source of truth, then delete the arena draft.** This doc (the wedge/reframes/
net-new layer) stays as the delta on top. Not done here to avoid clobbering files other
agents are actively editing — needs a clean, owned pass.
