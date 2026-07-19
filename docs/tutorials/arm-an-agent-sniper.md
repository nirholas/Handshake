# Arm an Autonomous Sniper on Your Agent

By the end of this tutorial your agent trades on its own: it watches every new pump.fun launch the moment it happens, filters them against rules you set, runs a real on-chain safety simulation before spending anything, buys from its own Solana wallet, and manages the position to an exit while you sleep. Every decision it takes is written to an auditable, hash-chained ledger.

This is real trading with real SOL on Solana mainnet. The platform's own agent closed its first autonomous position at +42.38% using exactly this setup, and the same run teaches the most important configuration lesson in this tutorial (Step 4). The full engineering breakdown lives in [the Agent Sniper doc](/docs/agent-sniper).

**What you'll build:**

- An armed sniper strategy on one of your agents (`POST /api/sniper/strategy`)
- A funded agent wallet that executes trades autonomously
- A live position ledger you can audit trade by trade
- Two independent off switches you can flip at any time

**Prerequisites:**

- A three.ws account with at least one saved agent ([first-agent](/tutorials/first-agent) if you have none).
- Your agent's custodial Solana wallet funded with SOL. Trades come out of this wallet, so fund it with an amount you are fully prepared to lose. 0.3 to 0.5 SOL is plenty for a first run at the sizes below.
- A session or bearer token for the API calls (sign in at three.ws, or use an API bearer).
- The mindset for it: sniping brand-new tokens is the highest-risk trading there is. The system's gates exist to filter out provable rugs, not to make bad coins good.

---

## Step 1 — Understand what fires and what blocks

A strategy is a row of policy, and the worker enforces it as a chain of gates. A launch must pass all of them before a single lamport moves:

1. **Trigger**: the worker holds the pump.fun new-mint firehose open and evaluates coins the second they exist.
2. **Your filters**: market-cap band, socials requirement, creator history, dev-dump avoidance.
3. **Fleet safety band**: platform-level market-cap clamps that your strategy can tighten but never loosen. An unpriceable coin always fails.
4. **Mayhem gate**: pump.fun "Mayhem mode" tokens are excluded unconditionally.
5. **Trade firewall**: a simulated buy-and-sell runs on-chain first. If the token cannot be sold back, the buy aborts. This is the honeypot killer.

Only then does the executor sign. Expect long silences: a well-filtered strategy skips almost everything, and each skip is logged with its reason.

## Step 2 — Arm the strategy

One authenticated call arms it:

```bash
curl -X POST https://three.ws/api/sniper/strategy \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $THREEWS_TOKEN" \
  -d '{
    "agent_id": "YOUR-AGENT-UUID",
    "network": "mainnet",
    "enabled": true,
    "trigger": "new_mint",
    "per_trade_lamports": 50000000,
    "daily_budget_lamports": 200000000,
    "max_concurrent_positions": 1,
    "min_market_cap_usd": 5000,
    "max_market_cap_usd": 25000,
    "require_socials": true,
    "avoid_dev_dump": true,
    "firewall_level": "block",
    "slippage_bps": 500,
    "max_price_impact_pct": 10,
    "stop_loss_pct": 30,
    "trailing_stop_pct": 25,
    "take_profit_pct": 60,
    "max_hold_seconds": 1800
  }'
```

That is 0.05 SOL per trade, at most 0.2 SOL per day, one position at a time. `GET /api/sniper/strategy` returns your strategies with a live position summary and the agent wallet's SOL balance.

## Step 3 — Know your exit ladder

Exits are decided by a pure function in strict priority order, so behavior is exactly predictable:

1. **Stop-loss** (`stop_loss_pct`): value falls 30% below entry, sell everything, always checked first.
2. **Trailing stop** (`trailing_stop_pct`): value falls 25% off its peak since entry, sell.
3. **Take-profit** (`take_profit_pct`): value reaches entry plus 60%, sell.
4. **Timeout** (`max_hold_seconds`): the clock wins no matter what the PnL is.

There is also a laddered mode (`initials_out_multiple`, `moonbag_min_pct`): recover your initial cost when the position hits a multiple, then let the remaining moon bag ride the trailing stop.

## Step 4 — The lesson from the first live trade: set `take_profit_pct`

The platform's first autonomous position rode to +46.5%, then exited at +42.38% only because its 30-minute timeout expired. Why: the strategy had `take_profit_pct` unset. With no profit rule, a winner is only ever closed by the trailing stop (which gives back 25% from the peak by definition) or by the clock (which exits at whatever the price happens to be).

That trade won anyway. Configuration should not rely on that. Set an explicit `take_profit_pct` (or use the laddered exit) so that locking in a win is policy, not luck.

## Step 5 — Watch it work

- **Positions and PnL**: `GET /api/sniper/strategy` (summary) and the journal at `GET /api/sniper/journal` for the plain-language story of each entry and exit.
- **Reasoning**: every buy writes a decision-ledger entry with the firewall verdict, price impact, a rationale sentence, and a confidence score, hash-chained to the previous entry.
- **The market through the engine's eyes**: [Radar and Coin Intelligence](/docs/trading-surfaces) show what the sniper's intel layer is scoring right now, including coins it skipped.

## Step 6 — The off switches

Two independent controls, both instant, both reversible, via the same POST:

- `"kill_switch": true` halts execution but keeps the whole config intact. Use this one first.
- `"enabled": false` disarms the strategy entirely.

The daily budget is a third, passive backstop: once `daily_budget_lamports` is spent, the strategy cannot buy again until the window resets.

## Where this is going

The hard-config sniper you just armed is the control group. The next phase runs an LLM strategist above the same execution stack: a reasoning model reads live market conditions and the agent's own trade history, then tunes these same fields on a cadence, with every adjustment logged to the same ledger. The deterministic gates (firewall, safety band, budget caps) stay hard no matter what the model says. The design and results log live in [the Agent Sniper doc](/docs/agent-sniper).

---

**Legal note:** the sniper trades real tokens with real money on a public chain, entirely under rules you arm. New-launch tokens are extremely volatile and most go to zero. Nothing on this page is financial advice; fund the agent wallet only with what you can afford to lose.
