# [EXTERNAL SYNDICATION DRAFT] Anatomy of an Autonomous Trading Agent: Gates, Ledgers, and a Firewall That Simulates the Sell Before the Buy

<!--
  Publication routing (owner action required to post externally):
  - Target channels, in order of fit: HackerNoon (crypto-native, we have a
    partnership), AWS Builder Center (we have published there before; frame is
    architecture, not tokens), a dev.to mirror.
  - Do NOT post to the IBM Community group. Verified policy in
    docs/ops/seo-keyword-plan.md: crypto/pump.fun content is off-topic for that
    audience, is exactly the pattern Google's site-reputation-abuse policy
    targets, and would put the IBM partnership at risk. IBM Community stays
    watsonx/Granite tutorials only.
  - Set the canonical URL on the external platform to:
      https://three.ws/blog/first-autonomous-trade
  - This draft is engineering-first: the token is incidental, the architecture
    is the story. Numbers are real and verifiable on-chain.
-->

Autonomous agents that hold money are easy to demo and hard to trust. The demo is an LLM with a wallet key. The trust problem is everything else: how do you let software trade unattended against the most adversarial market on the internet (brand-new token launches, where most assets are designed to steal from you) without it getting drained by the first honeypot it meets?

We run a platform (three.ws) where AI agents own Solana wallets and can be armed to trade autonomously. Last week one of them closed its first unattended position: bought a token that was seconds old, sold 30 minutes later, up 42.38%. The trade itself is a rounding error (0.05 SOL committed). The architecture that produced it is the part worth writing down, including the one thing it got right by luck instead of design.

## The core idea: a chain of deterministic gates, and only one file that signs

The agent does not "decide to trade" in any freeform sense. A trade is the output of a pipeline where every stage can veto and no stage can be skipped:

1. **Event-driven trigger.** A long-lived worker holds the token-launch firehose open over a websocket and evaluates each launch the moment it exists. This is deliberately not a cron job: a periodic tick cannot catch a launch window measured in seconds.
2. **Pure-function entry scoring.** The strategy row (owner-armed policy: market-cap band, socials requirement, creator-history checks, sizing) is evaluated by a side-effect-free scorer that returns `{ pass, score, reasons }`. The `reasons` array is kept for skipped coins too. When your bot mostly does nothing (and a selective one mostly should), the skip log with a reason per rejection is what makes the silence auditable instead of alarming.
3. **Fleet-wide safety bands.** Operator-level clamps that individual strategies can tighten but never loosen, and that fail closed: a coin whose market cap cannot be determined is rejected, never bought blind.
4. **Category exclusions read from the chain.** Some launch types are banned outright. The flag we need is not in the feed, so it is read from the on-chain bonding-curve account, cached per mint.
5. **The trade firewall: simulate the sell before the buy.** This is the load-bearing safety idea. Before broadcasting anything, the executor runs a real on-chain simulation of a buy immediately followed by a sell. A token that cannot be sold back is a honeypot; a round trip with abnormal loss indicates rug mechanics. Either aborts the buy. The scam does not need to be recognized by pattern matching; it is detected by attempting the thing the scam prevents.
6. **A single signing chokepoint.** Exactly one module can decrypt the agent's key (AES-256-GCM at rest, per-record salts) and sign. Every guardrail (budget ceilings, concurrent-position caps, idempotency locks so a mint is bought at most once per strategy) lives at that chokepoint, so no alternate code path can spend.

## The part most trading bots skip: a hash-chained decision ledger

Every trade appends a record to an append-only ledger: the inputs (trigger, firewall verdict and score, price impact, size), a plain-language rationale, a falsifiable prediction ("realized PnL will be positive"), and a mechanically computed confidence. Each entry carries the hash of the previous one, so history cannot be silently rewritten.

The entry for this trade, verbatim as the agent wrote it:

> "Sniped $BITS on a new_mint trigger with 0.05% price impact; firewall verdict allow (score 100). Committed 0.0500 SOL expecting a profitable exit." (confidence: 0.698)

When we wrote the postmortem, nothing had to be reconstructed from logs or memory. The agent's contemporaneous account of its own reasoning, chained to its prior history and adjacent to the real transaction signatures, was the postmortem. If you are building agents that act in the world, this property is worth more than any single win: the system's story of what it did is checkable, line by line, against what actually happened on-chain.

## What the first live trade taught us

The numbers: entry at 02:26:00 UTC with 0.05 SOL and 0.05% price impact, transaction landed in 1.7 seconds; peak +46.5%; exit at 02:56:04 UTC, full position, +42.38% realized. Exits are decided by a pure function with a strict priority ladder: stop-loss, then trailing stop, then take-profit, then timeout.

The honest finding: the exit reason was `timeout`. The owner had armed stops and a 30-minute maximum hold but no take-profit. So when the position spiked to +46.5%, no rule existed to lock it in; the clock expired and the position happened to still be up 42%. The trade won on luck-shaped policy. One unset field was the difference between "we designed this exit" and "the clock saved us", which is why the take-profit lesson is now the first thing our tutorial teaches.

The other honest finding: nine days of silence preceded the trade. Thousands of launches were evaluated and skipped, each with a logged reason. That is the correct behavior for a selective strategy in a market where most new assets are traps, but it means our sample size is exactly one. We are publishing the trade as an existence proof of the pipeline, not as evidence of an edge.

## Where it goes next: models propose, the pipeline disposes

The strategy that made this trade is frozen policy: constants a human set nine days earlier, unable to react to anything. The next phase, currently in progress, puts an LLM strategist above the same execution stack:

- On a cadence, a reasoning model reads live market state (launch cadence, quality-score distributions from the platform's coin-intelligence engine, the agent's own recent ledger outcomes) and emits a strategy adjustment as structured output: the same typed fields a human tunes, never freeform code.
- Adjustments land in the same hash-chained ledger with the model's rationale and a falsifiable prediction, so hand-tuned and model-tuned policies are comparable entry by entry.
- The deterministic layer stays sovereign. The firewall, the fail-closed safety bands, the budget caps, and the signing chokepoint apply to a model-tuned strategy identically. A model can make the policy smarter; it cannot make the system less safe.
- Competing configurations run head to head with real but capped budgets, and their ledgers decide which policy survives. Results get published either way, because the loss postmortems are where the information is.

The design principle generalizes well beyond trading: give the model the steering wheel, never the brakes. Deterministic gates that fail closed, one signing chokepoint, and an append-only reasoning ledger turn "an LLM with a wallet" into a system you can audit, and eventually, trust.

---

*The full engineering breakdown, the live case-study data, and the tutorial for arming an agent are at [three.ws/docs/agent-sniper](https://three.ws/docs/agent-sniper). Original post: [three.ws/blog/first-autonomous-trade](https://three.ws/blog/first-autonomous-trade).*
