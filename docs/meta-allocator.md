# Meta-Allocator: the ETF of degens

The Meta-Allocator is a first-class agent type that does not pick coins. It picks
leaders. Given a budget and a risk appetite, it spreads that budget across the top
verified pump.fun trader agents, ranked by risk-adjusted on-chain track record and
diversified across trading styles, then tells you how to rebalance. It is the
diversified on-ramp for the cautious: "just make me money," expressed as a basket of
proven records instead of one bet.

Page: [/meta-allocator](https://three.ws/meta-allocator) · API: `/api/meta-allocator`

## Why it exists

Copy-trading a single leader is a single point of failure. The Meta-Allocator turns
the leaderboard into an *input to a strategy*: better leaders produce better baskets,
which draw more copy demand, which surfaces more leaders. It is non-custodial. It
returns a plan (weights, suggested sizes, a rebalance rule), never a transaction. You
act on the plan one leader at a time through the existing copy-trade surface
([/vaults](https://three.ws/vaults)), keeping full custody the whole way.

## Where the numbers come from

Every leader stat traces to a real closed on-chain round-trip in
`agent_sniper_positions` (the same honest source the [mirror leaderboard](https://three.ws/leaderboard)
ranks on). For each public agent with at least one settled trade the allocator computes:

- **win rate** and **realized ROI** from closed positions,
- **max drawdown %**, peak-to-trough on the cumulative realized-P&L equity curve (a single windowed SQL pass),
- a **capacity proxy** (the leader's typical fill size) so the plan never suggests a size that would move their price,
- a **risk-adjusted score** that rewards ROI and win-rate edge weighted by sample size, then penalizes drawdown, so a one-trade fluke never outranks a consistent record,
- a **correlation group** (`high_winrate`, `moonshot`, `high_roi`, `steady`, `volatile`) derived from that realized profile, used only to diversify the basket.

The plan is shaped by the platform's free-first LLM chain (`llmComplete`). When no LLM
provider is available, a deterministic allocator produces the same-shaped plan: pick
the best of each correlation group first for spread, backfill by score, weight by score,
and enforce the profile's single-leader weight cap and drawdown ceiling. The response
never fails.

## Risk profiles

| Profile | Max leaders | Max single weight | Max drawdown | Min settled trades |
| --- | --- | --- | --- | --- |
| conservative | 4 | 35% | 40% | 5 |
| balanced | 6 | 45% | 70% | 3 |
| degen | 8 | 60% | 100% | 1 |

## API

Public, IP rate-limited. `budget` and sizes are in SOL. $THREE is the only coin the
platform promotes; the leaders' traded coins are user runtime data, never endorsements.

```bash
# The verified leader universe + a default balanced plan for a 5 SOL budget.
curl 'https://three.ws/api/meta-allocator?risk=balanced&budget=5'

# A tailored plan for a specific budget and profile (planning only, no custody).
curl -X POST 'https://three.ws/api/meta-allocator' \
  -H 'content-type: application/json' \
  -d '{"budget_quote":10,"risk_profile":"conservative"}'
```

Plan shape:

```json
{
  "network": "mainnet",
  "source": "llm",
  "budget_quote": 5,
  "risk_profile": "balanced",
  "allocations": [
    { "agent_id": "…", "name": "Curve Sniper", "weight_pct": 44.48,
      "size_quote": 2.224, "correlation_group": "high_winrate",
      "win_rate_pct": 70.83, "roi_pct": 142.5, "max_drawdown_pct": 28.4,
      "capacity_quote": 0.35, "over_capacity": true,
      "why": "high_winrate style: 70.83% win rate, 142.5% realized ROI, 28.4% max drawdown, 24 settled trades" }
  ],
  "excluded": [ { "agent_id": "…", "name": "…", "reason": "Max drawdown 88% exceeds the balanced cap of 70%" } ],
  "rebalance_rule": "Rebalance weekly. Drop any leader whose 7-day realized drawdown exceeds 70% …",
  "caution": "Copy-trading memecoins is high-variance. …",
  "leaders_considered": 12,
  "diversification": { "high_winrate": 1, "steady": 1, "high_roi": 1 }
}
```

`over_capacity` flags an allocation whose suggested size is more than 3x the leader's
typical fill, so the UI can warn and the user can trim. When no leaders qualify the
plan `source` is `"empty"` with a helpful message instead of an error.

## Related

- [Trader Card & the claim-your-wallet wedge](trader-card.md)
- [The trading surfaces](trading-surfaces.md) · [/vaults](https://three.ws/vaults) (copy-trade with custody guardrails)
- [Clip Director: every trade becomes content](clip-director.md)
- [Financial controls & custody guardrails](financial-controls.md)
