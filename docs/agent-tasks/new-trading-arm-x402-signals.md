# Task: Build a NEW autonomous trading arm that consumes paid x402 signals (do not touch existing arms)

## Status: HOLD until the owner green-lights it in your chat. Read fully, then confirm scope with the owner before writing code.

## Context

three.ws runs an autonomous trading experiment: 11 agents, 8 actively trading strategies ("arms"), real Solana wallets, trading pump.fun launches. Public writeup and live results: https://three.ws/blog/autonomous-trading-experiment. Architecture facts from that page you must honor:

- Arms are modular entry logic plugged into an identical execution stack: shared safety rails, on-chain firewall (simulated buy+sell round trip before execution), exit ladder, per-arm position sizing, daily budgets, concurrency constraints.
- Every decision writes to a hash-chained reasoning ledger. All wallets and receipts are publicly auditable.
- Performance verdict so far: the LLM cohort won only 24% of trades but was net positive (+0.0147 SOL, average winner +52.3%); rules arms won 30% but net negative. Win rate is a vanity metric; net PnL and average-winner size are what count.
- A self-improving optimizer tunes parameters every 6 hours within hard bounds.

## The hard rule

Do NOT modify, retune, pause, or rewire ANY existing arm, their wallets, their budgets, or shared execution code paths in a way that changes existing behavior. You are ADDING one new arm. If a shared-stack change is unavoidable, it must be provably behavior-neutral for existing arms (show the diff and the reasoning in your report) and kept minimal.

## The new arm: "paid-intel"

Entry logic that buys its signals through the platform's own x402 rails with real USDC micro-payments before every decision. This is the point: proving paid agent-to-agent data flows produce trading decisions.

1. Signal sources: the existing paid endpoints already served by the platform, at minimum `Pump Launch Monitor: Recent Launches`, `Pump.fun Volume Anomaly Oracle`, and `Crypto Intel: Pump.fun Trending Score Feed` (find their handlers under `api/x402/`). Each cycle: pay, fetch, decide. Log the payment tx signature IN the reasoning ledger entry alongside the decision so every trade is traceable to the paid signals that caused it.
2. Entry rule (starting point, optimizer may tune within bounds): require agreement of at least two paid signals (e.g. launch appears in recent-launches with quality fields passing, AND anomaly oracle flags positive-side volume anomaly). The blog's lesson is that selective, high-conviction entries with big winners beat high-frequency small winners; bias the arm toward fewer, better entries.
3. Budget: smallest existing per-arm daily budget in the fleet, halved, for the first 76-hour window. Position sizing at the fleet minimum. This arm must be cheap to be wrong.
4. Benchmarks it must beat to graduate (measured over its first 76 hours, same grading as the blog): net PnL > +0.0147 SOL equivalent per equal budget (beat the current best cohort), zero firewall violations, zero premature-sell audit failures, and 100% of ledger entries carrying valid x402 tx signatures.
5. If x402 signal purchase fails (endpoint down, wallet dry), the arm SKIPS the cycle and logs why. It never falls back to fetching the same data unpaid; that would defeat the experiment.

## Spend gate

Funding a new wallet and every real trade are on-chain spend actions. Wire everything, then present the owner: new wallet address, requested SOL/USDC funding amounts, daily budget, and get an explicit yes before the first funding transfer. The arm's autonomous trading after funding follows the fleet's existing approval model.

## Constraints

- Solana only. Real payments, real trades, no mocks anywhere.
- CLAUDE.md rules apply, including: never use em-dash or en-dash characters anywhere; changelog entry when the arm goes live; docs update (`docs/agent-sniper.md` or the blog data page, follow existing patterns).

## Done means

Arm implemented and wired into the fleet infrastructure but NOT funded/trading until the owner's explicit yes; dry verification that it produces decisions from real paid signals (payments settled, tx sigs in ledger); report includes the funding request table and the graduation benchmarks above.
