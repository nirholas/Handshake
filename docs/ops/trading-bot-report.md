# Trading bot status report

`npm run bots:report` prints the live state of every autonomous trading bot on
the platform in one pass: what is armed, what it has traded, what it made or
lost, and what its wallet actually holds on-chain right now.

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
   fires against the same pump.fun launch feed.

## What each field means

| Field | Source | Meaning |
|---|---|---|
| `ARMED` / `off` / `KILLED` | `enabled`, `kill_switch` | Posture. `KILLED` means the owner's global kill switch is engaged, so exits still mark to market but no entry can fire. |
| `trigger` | `trigger` | What wakes the bot: `new_mint`, `oracle_crossing`, `graduation_ride`, `intel_confirmed`. |
| `closed` / `open` / `failed` | `agent_sniper_positions.status` | A `failed` row is an entry that never landed (most commonly `SIM_FAILED`, the pre-flight simulation rejecting the buy), not a losing trade. Failures cost gas, never principal. |
| `realized PnL` | `realized_pnl_lamports` | Sum over every position the bot has ever held, in SOL. |
| `deployed` | `entry_quote_lamports` | Total SOL that has ever gone through an entry, so PnL reads against the capital that actually worked. |
| `open positions … marked` | `last_value_lamports` | The last quote the sweep took for still-open positions. Marked, not realized. |
| `auto-funded … live` | `sniper_funding_events` where `mode = 'live'` | Real SOL the auto-funder moved into the bot's wallet. |
| `… simulated` | `sniper_funding_events` where `mode <> 'live'` | Paper funding from a simulate-posture run. **No money moved.** Reported separately because it dwarfs the live figure and would otherwise read as real capital. |
| `wallet … live` | Solana RPC `getBalance` | Spot SOL balance of the wallet the bot last traded from. |
| `holding … token bag(s)` | RPC `getTokenAccountsByOwner` + Jupiter price | Every non-zero SPL balance the wallet still holds, valued at the Jupiter lite price API (the same source `api/_lib/balances.js` uses). Mints Jupiter cannot price count as $0 rather than being guessed at. |

A bot's wallet is resolved from its most recent position row, so a bot that has
never executed a trade reports "none yet" instead of a wrong address.

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
