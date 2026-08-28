# Trading bot status report

`npm run bots:report` prints the live state of every autonomous trading bot on
the platform in one pass: what is armed, what it has traded, what it made or
lost, and what its wallet actually holds on-chain right now.

It also answers the question the raw counts hide: **why** a bot is not trading.
An armed bot with a dry wallet, a halted bot, and a healthy idle bot all look
identical in a trade count, so every bot carries a posture, a solvency verdict,
and a stall flag.

It is read-only. It never signs, funds, closes, or sweeps anything.

```bash
npm run bots:report                                  # human-readable report
node scripts/trading-bot-report.mjs --json           # machine-readable
node scripts/trading-bot-report.mjs --no-chain       # DB only, skip the RPC reads
node scripts/trading-bot-report.mjs --all            # include bots that never traded
```

## What it covers

Two independent runtimes drive autonomous trading, and the report shows both:

1. **Pump.fun snipers** (`agent_sniper_strategies` + `agent_sniper_positions`),
   swept by `/api/cron/sniper-*`. This is where essentially all real trading
   volume lives.
2. **Strategy Object runtime** (`agent_strategy_equips` +
   `agent_strategy_positions`), swept every 2 minutes by
   `/api/cron/strategy-fanout`. A strategy is bound ("equipped") to an agent and
   fires against the same pump.fun launch feed. Equips answer to the per-owner
   `strategy_kill_switch` table, shown as `KILLED` in that section.

## What each field means

| Field | Source | Meaning |
|---|---|---|
| `ARMED` / `off` / `KILLED` | `enabled`, `kill_switch` | Posture. While killed, exits still mark to market but no entry can fire. **The two runtimes have separate kill switches and they are not interchangeable**: a sniper arm answers only to its own `agent_sniper_strategies.kill_switch` column, while the per-owner `strategy_kill_switch` table is read exclusively by `engagedKillOwners()` in `api/_lib/agent-strategy-runtime.js` and governs Strategy Object equips. Joining the owner table onto sniper arms reports an arm as halted while the executor keeps trading it. |
| `STALLED` | `max(opened_at)` | Armed, not halted, and has not *attempted* an entry in 7 days. Every trigger here is wired to feeds that produce candidates daily, so silence this long is a fault, not quiet markets. This is the flag that distinguishes "working and waiting" from "armed and dead". |
| `STARVED` / `SHRUNK` | `walletTradeState()` | Whether the wallet can fund its configured entry size. Decided by `api/_lib/sniper-solvency.js`, which calls `resolveEntrySize()`, **the same sizing rule the executor uses to place or skip a real entry**. Never re-derive these thresholds here: a local copy drifts into calling a wallet tradeable that the executor sits out, which is the exact bug that module was written to catch. `SHRUNK` means it still trades, just below the configured size. |
| `trigger` | `trigger` | What wakes the bot: `new_mint`, `oracle_crossing`, `graduation_ride`, `intel_confirmed`. |
| `closed` / `open` / `failed` | `agent_sniper_positions.status` | A `failed` row is an entry that never landed, not a losing trade. The dominant reason is `SIM_FAILED`: `estimateComputeUnits()` in `api/_lib/execution-engine.js` runs a real `simulateTransaction` before broadcast and throws when it reverts. That path never broadcasts, so a `SIM_FAILED` costs **one RPC call and zero lamports**, not gas. Each candidate mint is attempted once, so a high count is filter friction, not a retry loop. |
| `realized PnL` | `realized_pnl_lamports` | Sum over every position the bot has ever held, in SOL. |
| `deployed` | `entry_quote_lamports` | Total SOL that has ever gone through an entry, so PnL reads against the capital that actually worked. |
| `open positions … marked` | `last_value_lamports` | The last quote the sweep took for still-open positions. Marked, not realized. |
| `auto-funded … live` | `sniper_funding_events` where `mode = 'live'` | Real SOL the auto-funder moved into the bot's wallet. |
| `… simulated` | `sniper_funding_events` where `mode <> 'live'` | Paper funding from a simulate-posture run. **No money moved.** Reported separately because it dwarfs the live figure and would otherwise read as real capital. |
| `wallet … live` | Solana RPC `getBalance` | Spot SOL balance of the wallet the bot last traded from. |
| `holding … token bag(s)` | RPC `getTokenAccountsByOwner` + Jupiter price | Every non-zero SPL balance the wallet still holds, valued at the Jupiter lite price API (the same source `api/_lib/balances.js` uses). Mints Jupiter cannot price count as $0 rather than being guessed at. |

A bot's wallet is resolved from its most recent position row, so a bot that has
never executed a trade reports "none yet" instead of a wrong address.

## Fleet solvency

The report closes with a fleet verdict from `summarizeFleetSolvency()`: how many
armed wallets can still place an entry, the SOL needed to lift every starved
wallet back to its own refill target, and the funding master's balance.

`masterCanCover` is the line that matters operationally. It separates "the
auto-funder will heal this on its next tick" from "a human has to move SOL". The
master balance is read through `masterBalanceSol()`, which needs the launcher
signer (`LAUNCHER_MASTER_SECRET_KEY_B64`); where that is absent the report says
`unread` and `masterCanCover` stays null. An unread balance is never treated as
zero, for the same reason `summarizeFleetSolvency` skips unread wallet balances:
an RPC blip must not report a healthy fleet as starved.

## Environment

- `DATABASE_URL` (from `.env.local`) is required.
- `SOLANA_RPC_URL` is optional. Without it the script uses the public mainnet
  endpoint, which rate-limits a burst of wallet reads; the script backs off and
  retries up to five times, so a full sweep takes about a minute. Point it at
  the production Helius endpoint for a fast run.
- SOL/USD comes from `api/_lib/sol-price.js`, the platform's nine-source
  failover chain, so the dollar columns are spot. If every source is down it
  falls back to the last price stamped into `sniper_trade_analytics`.

## Related

- [gcp-production.md](gcp-production.md) - the production runbook the crons run under.
- [solana-rpc-lanes.md](solana-rpc-lanes.md) - which RPC endpoint to point `SOLANA_RPC_URL` at.
- `scripts/trading-experiment-setup.mjs` - arms one agent with a concrete sniper strategy.
