# The trading hub

The autonomous trading system on three.ws grew to roughly twenty pages. Each one
was good on its own and none of them was a front door: you could only reach the
arena, the experiments board, or the smart-money radar if you already knew the
URL. The trading hub is that front door.

Page: [/trading](https://three.ws/trading)

It answers three questions in order, which is the order people actually ask them:

1. **Is the fleet working right now?** Live vitals, read straight off the running
   worker.
2. **Is it any good?** The agent scoreboard, realized profit and loss only.
3. **Where do I go next?** Every trading surface and every doc, in one map.

## What the page shows

### Fleet vitals

Six tiles, all from `GET /api/sniper/status`, refreshed every 30 seconds:

| Tile | Meaning |
|---|---|
| **Mode** | `Live` means real funds and real broadcasts. `Simulate` means real quotes with no broadcast and zero spend. |
| **Strategies armed** | How many independent agents are armed. Each has its own wallet, rules, and budget. |
| **Open positions** | Held right now. These are not counted as profit anywhere on the page. |
| **Launch feed** | Whether the worker is receiving launches, and when the last one arrived. |
| **Funded to date** | Total SOL moved from the funding wallet into agent wallets, plus when the last top-up happened. |
| **Uptime** | How long the current worker process has been running. |

**Why the feed is reported separately from the process.** A worker can be
beating steadily while its launch feed has gone quiet. On a naive check that
looks identical to healthy, and it means the fleet is seeing nothing and will
therefore trade nothing. The hub calls a silent feed out as its own state rather
than folding it into one green light. The same reasoning applies to uptime: a
process that has been running for many days is running whatever code it booted
with, which is not necessarily the code in the repository.

### Agent scoreboard

From `GET /api/sniper/leaderboard`. One row per agent that has closed at least
one trade, showing realized SOL, return on investment, win rate, and a sparkline
of its cumulative result.

The rule that matters: **only closed trades count.** An open position is never
shown as profit, no matter how far up it is. An agent that is armed but has not
finished a round trip shows nothing rather than a flattering unrealized number.
When no agent has closed a trade in the window, the section says so and links to
the experiments board so you can see what each strategy is waiting for.

### How a trade happens

A static explainer of the five gates every entry passes through: signal, score,
firewall, sizing, and the laddered exit. This mirrors the real order enforced in
the worker. The important property is that a gate which cannot prove a coin is
safe blocks the trade rather than guessing: the firewall simulates a real buy and
sell round trip on-chain before anything is broadcast, and a sell that reverts
means the coin cannot be exited, so the trade never happens.

### Every trading surface, and Learn the system

Two directories covering the product surfaces (arena, Exit Lab, experiments,
leaderboard, trade feed, smart money, radar, copy trading, strategy lab,
autopilot, vaults, coin intelligence, trader card) and the documentation (agent
sniper, the arming tutorial, the exit-policy tutorial, the risk policy, the risk
acknowledgment, custody, earned autonomy, the market-making copilot, and
strategy objects).

These live as data in [`src/trading-hub-data.js`](../src/trading-hub-data.js)
rather than as inline markup, so the set is enumerable and a test can assert
every link resolves. A renamed page fails the test instead of quietly becoming a
dead card.

## Where the numbers come from

```bash
# Fleet vitals
curl -s https://three.ws/api/sniper/status | jq '{mode, strategies, openPositions, feedLive, bootAt}'

# The scoreboard, all time, ranked by score
curl -s 'https://three.ws/api/sniper/leaderboard?window=all&sort=score' \
  | jq '.leaderboard[] | {rank, agent_name, closed, wins, realized_pnl_sol, roi_pct}'
```

Both endpoints are public and read-only. The page calls nothing else, holds no
credentials, and writes nothing.

## Design notes

- **No seeded or sample data.** Every number is fetched. When an endpoint fails,
  the page renders an error state that says the data is unavailable and keeps
  retrying, rather than showing a stale or invented figure. A dash is used for a
  value that is genuinely unknown, never a zero.
- **Polling pauses when the tab is hidden** and resumes on focus, so a
  backgrounded tab does not keep hitting the API for numbers nobody is reading.
- **The sparkline refuses to lie.** With fewer than two data points it renders
  nothing at all instead of a flat line that would imply a result the data does
  not contain.
- **Reduced motion is honored.** The pulsing status dot, the loading shimmer, and
  the card lift are all disabled under `prefers-reduced-motion`.

## Related

- [Agent Sniper](./agent-sniper.md), what the autonomous trader is and how it is wired
- [The 10 SOL experiment](./trading-experiment.md), the full risk policy
- [Risk acknowledgment](./risk-acknowledgment.md), read before arming real funds
- [Custody model](./custody.md), how an agent holds its own keys
- [Earned autonomy](./sniper-autonomy.md), how an agent earns more freedom
- [Trading Copilot](./trading-copilot.md), the fair-launch market maker
- Tutorial: [Arm an autonomous sniper](./tutorials/arm-an-agent-sniper.md)
