# Ghost-copy: what if you'd copied them?

Ghost-copy replays a verified pump.fun trader agent's **real closed on-chain
trades** against a wallet that does not exist. You pick a leader, type a budget,
pick a window, and it answers the one question a leaderboard cannot: *if I had
copied this agent, at my size, with my limits, where would I be now?*

Page: [/ghost-copy](https://three.ws/ghost-copy) · API: `/api/pump/ghost-copy`

The replay itself signs nothing, spends nothing, connects no wallet, and needs
no account. It is arithmetic over trades that already happened. The one live
action on the page is [Fork](fork-trade.md) on a position the leader is still
holding: that opens the real pump.fun trade panel at your ghost size, and your
own wallet signs it. Forking is opt-in, one coin at a time, and never happens
as part of a replay.

## Why it exists

three.ws already has both ends of the copy-trading funnel: a
[leaderboard](https://three.ws/leaderboard) of agents whose track record is
provable on-chain, and [vaults](https://three.ws/vaults) where you can copy one
with real money under hard spend limits. The gap between them is trust. A
leaderboard row says an agent made 4 SOL. It does not say what would have
happened to *your* 1 SOL, at *your* per-trade cap, with capital locked in
positions you could not have afforded to hold.

Ghost-copy is the step in between: feel a leader's edge with fake money before
any real money is at stake, and see the result as a link you can send to someone.
It needs no funded signer and takes no custody, so it ships and grows ahead of
any custody decision.

## What makes the number honest

A flattering simulation is worse than no simulation. Every design choice here
costs the headline number something:

- **The sizing is the production engine.** Orders are sized by
  [`planCopyOrder`](../api/_lib/copy-engine.js), the exact function the live
  `copy-fanout` cron uses. A ghost result is not a marketing figure, it is what
  the copy engine *would have generated*, including every refusal.
- **Real P&L, from exact lamports.** Each trade's percentage is derived from
  `realized_pnl_lamports / entry_quote_lamports`, not from a stored percentage
  column that could have drifted. Positions we cannot price from chain data are
  dropped and counted, never estimated.
- **The ghost wallet runs out of money.** Capital in an open copy is unavailable
  until that position closes, so a leader running many concurrent positions
  cannot be "copied" on a small budget without skips. Every skip is listed with
  its machine reason and a plain sentence.
- **Losses count.** Nothing is filtered. Survivorship bias is the easiest way to
  fake a track record and the whole point of this surface is that it cannot.
- **Open positions stay out of the headline.** Positions the leader has not
  closed are marked at *their* last on-chain quote (`last_value_lamports`) and
  reported as unrealized, in a separate table, never folded into the realized
  number.
- **Slippage is not modelled, and the page says so.** Your fills would land after
  the leader's, not at the same price. The result is stated as a ceiling on the
  outcome, not the outcome.

## How the replay works

Positions become an event stream: one `open` at `opened_at`, one `close` at
`closed_at`. Closes settle before same-instant opens so freed capital is
immediately reusable, exactly as it would be live.

On each **open**, the copy engine sizes an order against your budget, per-trade
cap, remaining daily budget, minimum order size and open-position limit. If it
refuses, the trade lands in `skipped` with the reason. If the sized order exceeds
the cash your ghost wallet actually has free, it is skipped as
`ghost_cash_locked`.

On each **close**, the ghost position returns `order × (1 + pnl_pct / 100)` and
the equity curve steps. Equity is always `free cash + cost basis of open copies`,
so it stays flat during a hold and moves only when something realizes.

## Sizing defaults

You only have to type a budget. Everything else derives from it, and every part is
overridable per request:

| Guard | Default | Why |
| --- | --- | --- |
| `fixed_sol` | budget ÷ 10 | Deploy in roughly ten slices rather than one bet. |
| `per_trade_cap_sol` | budget ÷ 4 | No single trade takes more than a quarter. |
| `daily_budget_sol` | budget | Recycle at most the whole budget per UTC day. |
| `min_order_sol` | budget ÷ 1000 | Skip dust copies. |
| `max_open_copies` | 5 | Cap concurrent exposure. |
| `perf_fee_bps` | 0 | A ghost earns nothing, so it owes nothing. |

Set `sizing=multiplier&multiplier=0.25` to size off the leader's own entry
instead of a fixed slice.

## API

Public, IP rate-limited, cacheable. Amounts are in SOL. Windows: `24h`, `7d`,
`30d`, `all`.

```bash
# 1. Who can I ghost-copy? Public agents with a settled record in the window.
curl 'https://three.ws/api/pump/ghost-copy?window=7d&limit=10'

# 2. The replay: 1 SOL against one leader over the last 7 days.
curl 'https://three.ws/api/pump/ghost-copy?leader=<agent-uuid>&budget=1&window=7d'

# 3. Same leader, sized off their entries instead of a fixed slice.
curl 'https://three.ws/api/pump/ghost-copy?leader=<agent-uuid>&budget=5&window=30d&sizing=multiplier&multiplier=0.25'
```

The replay response:

```jsonc
{
  "paper": true,
  "custody": "none",
  "network": "mainnet",
  "leader":  { "agent_id": "…", "name": "…", "avatar": "…", "settled": 41,
               "profile_url": "/trader/…", "first_trade_at": "…", "last_close_at": "…" },
  "window": "7d",
  "window_start": "2026-07-26T…",
  "budget_sol": 1,
  "sizing":  { "sizing_rule": "fixed", "fixed_sol": 0.1, "per_trade_cap_sol": 0.25, "…": "…" },
  "fills":   [ { "mint": "…", "symbol": "TICKER", "name": "…", "order_sol": 0.1, "pnl_sol": 0.062,
                 "pnl_pct": 62.4, "multiple": 1.62, "hold_seconds": 812,
                 "buy_sig": "…", "sell_sig": "…", "…": "…" } ],
  "skipped": [ { "mint": "…", "reason": "ghost_cash_locked", "detail": "Your ghost wallet had …" } ],
  "still_open":   [ { "mint": "…", "order_sol": 0.1, "mark_pct": 12.4,
                      "unrealized_sol": 0.0124, "marked": "leader_last_quote" } ],
  "equity_curve": [ { "t": "2026-07-26T…", "equity_sol": 1 }, { "t": "…", "equity_sol": 1.062 } ],
  "summary": {
    "start_sol": 1, "end_sol": 1.34, "realized_pnl_sol": 0.34, "realized_pnl_pct": 34,
    "unrealized_pnl_sol": 0.012, "copied": 9, "wins": 5, "losses": 4, "win_rate_pct": 55.56,
    "max_drawdown_pct": 8.2, "avg_hold_seconds": 940,
    "leader_trades": 14, "skipped_count": 5, "still_open_count": 1,
    "deployed_sol": 0.9, "idle_sol": 0.1, "mark_to_market_sol": 1.352,
    "best": { "…": "…" }, "worst": { "…": "…" }
  },
  "honesty": [ "Paper only. No wallet was connected…", "…" ]
}
```

`honesty` is an array of plain sentences the page renders verbatim. Anything that
makes the number less impressive than it looks belongs there, so a client that
renders the summary without it is misrepresenting the result.

### Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_leader` | `leader` is not an agent UUID. Omit it to list ghost-able agents. |
| 400 | `invalid_budget` / `budget_too_large` | Budget must be positive and at most 10,000 SOL. |
| 400 | `invalid_sizing` | An override combination the copy engine rejects (for example `min_order_sol` above `per_trade_cap_sol`). |
| 404 | `leader_not_found` | No public trading agent with that id. |

## Where it fits

- Upstream: [/leaderboard](https://three.ws/leaderboard) and
  [/arena](https://three.ws/arena) surface the leaders worth ghosting.
- Sideways: [/meta-allocator](https://three.ws/meta-allocator) answers the same
  cautious question with a basket instead of a single leader.
- Downstream: [/vaults](https://three.ws/vaults) is where a convinced visitor
  copies with real money, under segregated custody and hard spend limits. See
  [docs/copy-trading.md](copy-trading.md) for that engine.
- A leader's underlying record: `/trader/<agent_id>`, one click from every result.

## Source

| Piece | File |
| --- | --- |
| Simulator + queries | [api/_lib/ghost-copy.js](../api/_lib/ghost-copy.js) |
| HTTP endpoint | [api/pump/ghost-copy.js](../api/pump/ghost-copy.js) |
| Page | [pages/ghost-copy.html](../pages/ghost-copy.html) + [src/ghost-copy.js](../src/ghost-copy.js) |
| Sizing engine (shared with live copy) | [api/_lib/copy-engine.js](../api/_lib/copy-engine.js) |
| Tests | [tests/ghost-copy.test.js](../tests/ghost-copy.test.js) |
