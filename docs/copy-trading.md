# Copy Trading

Copy trading on three.ws lets one wallet follow another wallet's real trades. There are two separate engines behind that sentence, they have different risk profiles, and it matters which one you are using:

| Engine | Where | Who signs the trade | What happens when the leader trades |
| --- | --- | --- | --- |
| **Agent mirror** (custodial) | [/mirror](https://three.ws/mirror) | The platform signs from **your agent's own custodial Solana wallet** | A real buy or sell is built, broadcast, and confirmed on-chain, inside your agent's spend policy |
| **Copier subscriptions** (non-custodial) | [/dashboard/copy](https://three.ws/dashboard/copy) | **You do**, from your own wallet | A sized, safety-checked *intent* is recorded for you to act on. Nothing is signed for you |

Both are Solana-native. Both run on `mainnet` and `devnet`. Neither is a paper-trading mode: neither engine has a simulation layer or a synthetic fill anywhere in it. Read [Simulated versus executed](#simulated-versus-executed) before you enable anything.

If you want to feel a leader's edge before committing money, that is a *separate* surface: [Ghost-copy](./ghost-copy.md) replays a leader's real closed trades against a wallet that does not exist. It never touches either engine below and never produces an intent.

A leader can also price *when* each copier is shown their signal: [alpha-drip](./alpha-drip.md) releases the copy intent to higher $THREE tiers first and everyone else after a delay the leader sets. It is off unless a leader turns it on, it delays the reveal and never the record, and the copier is shown the seat they get before they subscribe.

Related reading: [Smart Money Radar](./smart-money.md) for the first-party wallet reputation graph, [the trading surfaces](./trading-surfaces.md) for the screeners and the trading cockpit these leaders trade from, [agent wallets](./agent-wallets.md) for the custody and spend-policy model, and [signal marketplace](./signals.md) for the paid-feed variant that reuses the same guarded executor.

---

## Simulated versus executed

State this to yourself before you touch a control:

- **The agent mirror executes with real funds.** When a leader agent's trade confirms on-chain, `api/_lib/agent-mirror.js` quotes the pump curve or AMM, recovers your agent's key, builds real instructions, and broadcasts them through the MEV-aware execution engine. The resulting signature is a real Solana transaction. There is no dry-run flag, no shadow mode, and no "test" sizing.
- **Copier subscriptions never execute.** `api/cron/copy-fanout.js` writes a row into `copy_executions` with a planned size and a reason. That is the whole action. You open the intent, trade from your own wallet, and then tell the platform what you did by POSTing `{ action: 'acted', tx_signature }`. Marking an intent `acted` records history. It moves no funds, and the platform never holds your keys on this path.
- **Ghost-copy is explicitly paper, and lives outside both engines.** [/ghost-copy](https://three.ws/ghost-copy) replays a leader's already-closed on-chain round-trips against a hypothetical budget. It shares the sizing function (`planCopyOrder`) with the copier path so the numbers are comparable, but it writes nothing, signs nothing, produces no intent, and cannot be enabled. Every response is labelled `paper: true` and carries an `honesty` block. See [ghost-copy](./ghost-copy.md).
- **The leaderboard and track records are computed from real fills only.** `api/_lib/mirror-stats.js` and `api/mirror/leaderboard.js` read closed sniper round-trips (`agent_sniper_positions`) and the confirmed custody trade ledger (`agent_custody_events`). An agent with no history returns zeros and nulls, not a placeholder number. Losing agents appear with their losses.
- **The only thing that is estimated anywhere** is copy profit attribution for performance fees: a copier's realized profit on one copy is `planned_sol * (leader_realized_pnl_pct / 100)`, that is, your committed size at the leader's realized return. That is a stated basis, not a measured fill of your own transaction, and it is documented in `api/_lib/copy-earnings.js`.

Money-moving actions are yours to confirm. Nothing on these pages spends without either (a) an explicit agent-level opt-in with a spend policy, in the mirror case, or (b) you personally signing, in the copier case.

---

## The leaderboard: finding a leader

`/mirror` opens on **Discover leaders**, a performance-weighted ranking served by `GET /api/mirror/leaderboard`. Public, no key, cached at the edge for 60 seconds (`max-age=30, s-maxage=60`), IP rate-limited.

### Parameters

| Param | Values | Default |
| --- | --- | --- |
| `network` | `mainnet`, `devnet` | `mainnet` |
| `sort` | `score`, `pnl`, `followers`, `volume`, `winrate` | `score` |
| `limit` | 1 to 50 | 25 |
| `settled_min` | 0 to 1000 | 0 |

### Who is eligible

An agent appears if it is public (`is_public <> false`), not deleted, and has **either** at least one closed sniper position **or** at least one confirmed discretionary trade on that network. An agent that only trades discretionarily still ranks, with volume and no realized P&L. The candidate scan is capped at 500 rows before scoring.

`settled_min` narrows that to agents with at least that many **closed** round-trips, before the ranking is windowed by `limit`. Ask for it when your surface cannot use an agent without a realized track record. [The Clip Director](clip-director.md) is the case in point: it mints a card from a closed trade, so an agent with none is useless to it. Filtering client side instead is a trap, and it bit us: the composite score does not correlate with having settled trades, so the only eligible agent ranked below the caller's window and the page reported that nobody had ever closed a trade.

```bash
# Only agents with a realized track record, best composite score first
curl -s 'https://three.ws/api/mirror/leaderboard?settled_min=1&limit=50'
```

### The weighting, exactly as coded

```
sample  = min(1, settled / 8)                 # sample-size damping
score   = round(
              (roi_pct  != null ? roi_pct * sample            : 0)   # realized ROI, damped
            + (win_rate != null ? (win_rate - 50) * 0.5 * sample : 0) # edge over a coin flip, damped
            + min(20, followers * 2)                                  # follower trust, capped at +20
            + min(10, volume_sol)                                     # activity, capped at +10
          )
```

Where the inputs come from:

- `settled` = count of closed sniper positions. `wins` = those with `realized_pnl_lamports > 0`.
- `win_rate` = `wins / settled * 100`, null when `settled` is 0.
- `pnl_sol` = summed realized P&L in SOL. `roi_pct` = `pnl_sol / summed entry SOL * 100`, null when nothing was entered.
- `volume_sol` = summed `amount_lamports` of confirmed `category = 'trade'` custody events where `asset = 'SOL'` (buy-side volume).
- `followers` / `active_followers` = rows in `agent_mirror_follows` for that leader, and those with `enabled = true`.

The consequences are deliberate. A one-trade fluke is damped to one eighth of its ROI contribution, so it cannot outrank a consistent trader. A 50 percent win rate contributes nothing. Followers can add at most 20 points, so popularity cannot manufacture a track record. Sorting by any field other than `score` ignores the composite entirely and orders on that raw field.

```bash
# Top leaders by composite score
curl -s 'https://three.ws/api/mirror/leaderboard?limit=5'

# Honest P&L order, including the losers at the bottom
curl -s 'https://three.ws/api/mirror/leaderboard?sort=pnl&limit=25'

# Devnet board
curl -s 'https://three.ws/api/mirror/leaderboard?network=devnet&sort=winrate'
```

Response shape:

```json
{
  "data": {
    "network": "mainnet",
    "sort": "score",
    "settled_min": 0,
    "leaders": [
      {
        "rank": 1,
        "agent_id": "00000000-0000-0000-0000-000000000000",
        "name": "Example Trader",
        "avatar": null,
        "settled": 8,
        "wins": 4,
        "win_rate": 50,
        "pnl_sol": 0.1725,
        "roi_pct": 10.2,
        "trades": 0,
        "volume_sol": 0,
        "followers": 0,
        "active_followers": 0,
        "last_trade_at": null,
        "score": 10
      }
    ]
  }
}
```

For one leader's full record (drawdown, best and worst trade, USD volume) call the per-agent route instead, which is also public:

```bash
curl -s 'https://three.ws/api/agents/<AGENT_ID>/mirror/track-record'
curl -s 'https://three.ws/api/agents/<AGENT_ID>/mirror/followers'
```

`track-record` adds `realized.max_drawdown_sol` (peak to trough over the cumulative realized-P&L curve), `realized.best_pct` / `worst_pct`, `volume.usd`, and a `total` that spans both sources so "no track record yet" is expressed as `total: 0` rather than invented numbers.

---

## How following works (the agent mirror)

The mirror is a graph of **follow edges**: one of your agents (the follower) mirrors one public agent (the leader). Edges live in `agent_mirror_follows` and are managed under `/api/agents/:id/mirror`, where `:id` is **your follower agent**. All write routes are owner-only and CSRF-protected for cookie sessions; bearer tokens are accepted for agent clients.

| Route | Method | Access |
| --- | --- | --- |
| `/api/agents/:id/mirror` | GET | Owner. Follows, recent fills, follower counts, kill-switch state |
| `/api/agents/:id/mirror` | POST | Owner. Create or update a follow edge |
| `/api/agents/:id/mirror/unfollow` | POST | Owner. Delete an edge |
| `/api/agents/:id/mirror/kill` | POST | Owner. Toggle the agent-wide kill switch |
| `/api/agents/:id/mirror/sync` | POST | Owner. Process pending leader trades now |
| `/api/agents/:id/mirror/fills` | GET | Owner. Recent mirror fills |
| `/api/agents/:id/mirror/followers` | GET | **Public** |
| `/api/agents/:id/mirror/track-record` | GET | **Public** |

### Creating a follow

```bash
curl -s -X POST 'https://three.ws/api/agents/<FOLLOWER_AGENT_ID>/mirror' \
  -H 'authorization: Bearer <AGENT_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{
    "leader_agent_id": "<LEADER_AGENT_ID>",
    "network": "mainnet",
    "sizing_mode": "proportional",
    "proportion_pct": 25,
    "max_per_trade_sol": 0.25,
    "daily_budget_sol": 1.0,
    "min_leader_sol": 0.05,
    "copy_sells": true,
    "mint_denylist": []
  }'
```

Validated by `normalizeFollowInput` in `api/_lib/mirror-engine.js`:

| Field | Meaning |
| --- | --- |
| `sizing_mode` | `fixed`, `proportional` (default), or `pct_balance` |
| `fixed_sol` | SOL per mirrored buy, when `sizing_mode: fixed`. Must be greater than 0 |
| `proportion_pct` | Percent of the leader's buy size. Defaults to 100, meaning 1:1 |
| `pct_balance` | Percent of the follower wallet's spendable SOL, 0 to 100 |
| `max_per_trade_sol` | Per-follow per-trade cap. Optional, must be greater than 0 |
| `daily_budget_sol` | Per-follow rolling 24 hour budget. Optional, stacks *under* the agent's own daily budget |
| `min_leader_sol` | Ignore leader buys smaller than this |
| `copy_sells` | Mirror exits. Defaults to true |
| `mint_allowlist` / `mint_denylist` | Up to 100 base58 mints each. The denylist wins, and both apply to buys and sells |
| `enabled` | Pause without deleting. Defaults to true |

Refusals that protect you: a leader that is private returns `403 leader_private`, an agent cannot mirror itself (`400 cannot_follow_self`), and a reciprocal edge is blocked with `409 circular_follow` so two agents cannot feed each other forever.

**A new follow never backfills.** On create, the cursor `last_leader_event_id` is set to the leader's newest existing trade event, so only trades made *after* you follow are ever mirrored.

### What happens when the leader trades

`api/cron/mirror-fanout.js` runs every 2 minutes (see the `crons` array in `vercel.json`). It selects enabled edges whose follower is not killed and whose leader has a confirmed trade newer than the edge cursor **within the last 20 minutes**, up to 120 edges per run, and processes at most 15 leader events per edge. The owner's "Sync now" button runs the same `syncFollow` path.

Detection reads the leader's confirmed custody ledger (`agent_custody_events`, `category = 'trade'`, `status = 'confirmed'`), so every mirror traces to a real leader signature, mint, and size.

Then `planMirror` (pure, unit-tested in `tests/mirror-engine.test.js`) decides:

1. Kill switch on, or edge paused, stop.
2. Mint denylisted, or not on a non-empty allowlist, stop.
3. Sell side: if `copy_sells` is true, mirror the exit. Size is taken at execution from the follower's real on-chain token balance (it sells the full holding), and `no_holding` is recorded if there is nothing to sell.
4. Buy side: apply `min_leader_sol`, size by the rule, clamp to `max_per_trade_sol`, clamp to the remaining `daily_budget_sol`, clamp to the wallet balance less a 0.004 SOL fee headroom, and reject anything under the 0.0005 SOL dust floor.

The sized order then goes through `runFollowerTrade`, which is the same guard sequence the discretionary trade endpoint and the sniper use, in this order: agent kill switch, per-trade cap, rolling daily budget, the natural-language spend policy (`meta.policy_rules`), price-impact breaker, rug and honeypot firewall (a `block` verdict refuses the mirror), on-chain SOL headroom, then an idempotency claim in the custody ledger before anything is signed. Slippage is capped at 300 bps. Every mirrored trade lands in `agent_custody_events` with `reason: 'mirror'` and a `meta.mirror` reference naming the leader and the leader's event.

Nothing double-spends: the custody idempotency key `mirror:<follow_id>:<leader_event_id>:<side>` and the unique index on `agent_mirror_fills (follow_id, leader_event_id, side)` both dedupe, so a retried cron or an overlapping manual sync replays instead of re-buying.

Each attempt writes exactly one `agent_mirror_fills` row with status `executed`, `skipped`, `failed`, or `unconfirmed`, plus a machine reason. The UI renders those reasons through `SKIP_LABELS`, for example `Over per-trade cap`, `Blocked by safety firewall`, `Wallet underfunded`, `Daily budget used up`.

### Stopping

```bash
# Halt every mirror for this agent, instantly
curl -s -X POST 'https://three.ws/api/agents/<FOLLOWER_AGENT_ID>/mirror/kill' \
  -H 'authorization: Bearer <AGENT_TOKEN>' \
  -H 'content-type: application/json' -d '{"killed": true}'

# Or drop one edge
curl -s -X POST 'https://three.ws/api/agents/<FOLLOWER_AGENT_ID>/mirror/unfollow' \
  -H 'authorization: Bearer <AGENT_TOKEN>' \
  -H 'content-type: application/json' -d '{"leader_agent_id": "<LEADER_AGENT_ID>"}'
```

The kill switch is stored as `meta.mirror_killed` on the agent and is read in three places: the cron's candidate query, the engine's first check, and the sync endpoint (which returns `409 mirror_killed`). Setting it stops new mirrors immediately. It does not sell what you already hold.

---

## The non-custodial copier: subscriptions, intents, earnings

This is the path where you keep your keys. It is managed from [/dashboard/copy](https://three.ws/dashboard/copy) and from the copy panel mounted on a trader profile.

### `/api/copy/subscriptions`

Auth required (session cookie or bearer). Cookie-session writes additionally require a CSRF token.

| Method | Behavior |
| --- | --- |
| `GET` | Your follow list, with leader name and avatar, plus per-subscription `pending_count` and `acted_count` |
| `POST` | Create or update a subscription (upsert keyed on copier, leader, network) |
| `POST` with only `{ id, status }` | Pause, resume, or stop (`active`, `paused`, `stopped`) |
| `DELETE ?id=<uuid>` | Soft stop. Status becomes `stopped`, history is kept |

```bash
curl -s -X POST 'https://three.ws/api/copy/subscriptions' \
  -H 'authorization: Bearer <API_TOKEN>' -H 'content-type: application/json' \
  -d '{
    "leader_agent_id": "<LEADER_AGENT_ID>",
    "copier_wallet": "<WALLET_ADDRESS>",
    "network": "mainnet",
    "sizing_rule": "multiplier",
    "multiplier": 0.5,
    "per_trade_cap_sol": 0.2,
    "min_order_sol": 0.01,
    "daily_budget_sol": 1.0,
    "max_open_copies": 5,
    "mcap_floor_usd": 15000,
    "require_safety_pass": true,
    "min_oracle_score": 60,
    "perf_fee_bps": 1000
  }'
```

Validated by `normalizeSubscriptionInput` in `api/_lib/copy-engine.js`. `per_trade_cap_sol` and `daily_budget_sol` are both mandatory and must be greater than 0, `min_order_sol` cannot exceed the cap, `pct_balance` must be within 0 to 100, `min_oracle_score` within 0 to 100, and `perf_fee_bps` within 0 to 3000 (30 percent). `max_open_copies` defaults to 5 and is clamped to 1 to 100. `copy_sells` defaults to true, `require_safety_pass` defaults to false. `telegram_chat_id`, if set, must be a numeric Telegram chat id and turns on push alerts for new intents. Only public leaders can be copied. We store your wallet address and your rules, never a key.

### How intents are recorded

`api/cron/copy-fanout.js` runs every 2 minutes and fans out from two real leader sources: the sniper engine's executed positions (`agent_sniper_positions`) and the Oracle conviction agent's live buys (`oracle_watch_actions`), each within an 8 minute recency window.

For every (leader event, subscription) pair it calls `planCopyOrder`, the pure engine in `api/_lib/copy-engine.js` (tested in `tests/copy-engine.test.js`):

- **Safety gate on entries only.** A honeypot flag is fatal. Market cap is checked against your floor and ceiling. A dev holding 30 percent or more of supply is refused as `dev_heavy`. Liquidity under 1000 USD is refused as `low_liquidity`. A known Oracle conviction score below your `min_oracle_score` is refused. If coin context could not be fetched at all, the result depends on your `require_safety_pass` flag: with it on, the copy is skipped as `safety_unknown`. Coin context is best-effort from the public pump.fun coin endpoint (market cap) merged with the stored Oracle score.
- **Open-copy cap.** More pending intents than `max_open_copies`, skipped.
- **Sizing.** `fixed` uses `fixed_sol`, `multiplier` scales the leader's entry, `pct_balance` takes a percentage of your balance. The result is clamped to `per_trade_cap_sol`, then to the remaining `daily_budget_sol` (today's `pending` plus `acted` buy sizes), and rejected if it falls under `min_order_sol`.
- **Exits.** A sell fans out with `order_sol: 0` and reason `mirror_exit`, and only to copiers who actually acted on the matching buy. Oracle sells are not modelled, because that engine has no explicit exit event.

Either way a row lands in `copy_executions`: `status = 'pending'` for a real intent, or `status = 'skipped'` carrying the machine reason so the dashboard can explain exactly why a copy did not fire. Idempotency comes from partial unique indexes on `(subscription_id, leader_position_id, direction)` and `(subscription_id, leader_oracle_action_id, direction)`, so re-running the cron never duplicates an intent.

Pending intents carry `expires_at`, 30 minutes after creation by default. They are expired lazily on read, so your inbox never offers an actionable copy for a coin that has long since moved.

### `/api/copy/executions`

Auth required. CSRF for cookie-session writes.

```bash
# The inbox
curl -s 'https://three.ws/api/copy/executions?status=pending' -H 'authorization: Bearer <API_TOKEN>'

# Full history, newest first
curl -s 'https://three.ws/api/copy/executions?status=all&limit=40' -H 'authorization: Bearer <API_TOKEN>'

# Record that you executed it from your own wallet
curl -s -X POST 'https://three.ws/api/copy/executions' \
  -H 'authorization: Bearer <API_TOKEN>' -H 'content-type: application/json' \
  -d '{"id": "<EXECUTION_ID>", "action": "acted", "tx_signature": "<SIGNATURE>"}'

# Or dismiss it
curl -s -X POST 'https://three.ws/api/copy/executions' \
  -H 'authorization: Bearer <API_TOKEN>' -H 'content-type: application/json' \
  -d '{"id": "<EXECUTION_ID>", "action": "dismissed"}'
```

`status` accepts `pending` (the default), `acted`, `dismissed`, `skipped`, `expired`, or `all`. `limit` is 1 to 100, default 50. Only a `pending` intent can be actioned; anything else returns `409 not_actionable`. `tx_signature` is optional, kept for your records, and truncated to 128 characters.

### `/api/copy/earnings`

One route, two modes.

```bash
# PUBLIC: a leader's aggregate copy earnings (social proof, no copier identity)
curl -s 'https://three.ws/api/copy/earnings?agent_id=<LEADER_AGENT_ID>&network=mainnet'

# AUTHED: what you currently owe across the leaders you copy
curl -s 'https://three.ws/api/copy/earnings' -H 'authorization: Bearer <API_TOKEN>'
```

The public aggregate returns `copiers`, `accrued_fee_sol`, and `copier_profit_sol`, cached for 30 to 60 seconds. It never exposes an individual copier.

The authed view returns `total_fee_owed_sol` plus one item per subscription with `cumulative_profit_sol`, `closed_copies`, `billable_profit_sol`, `fee_sol`, and `new_high_water_mark_sol`. Subscriptions with nothing to show are omitted.

The math (`api/_lib/copy-earnings.js`, tested in `tests/copy-earnings.test.js`):

```
cumulative_profit = sum over your acted BUY copies whose leader position has CLOSED of
                    planned_sol * (leader_realized_pnl_pct / 100)

billable          = max(0, cumulative_profit - high_water_mark)
fee               = billable * (perf_fee_bps / 10000)
new_high_water    = max(high_water_mark, cumulative_profit)
```

Losing copies lower the cumulative, and the high-water mark only ever ratchets up, so a drawdown followed by a recovery is never billed twice. A fee is settled in `$THREE` through `POST /api/copy/settle-fee`, which issues a quote, verifies the on-chain split under the `copy_performance_fee` policy (leader 80 percent, treasury 15 percent, holders 5 percent), and ratchets the high-water mark. That is a spend: confirm the recipient and amount before signing.

Settling is a two-call flow and the two calls are bound to each other. `POST /api/copy/settle-fee { subscription_id }` returns the quote for what you owe on that subscription; `POST /api/copy/settle-fee { quoteToken, tx_signature }` settles it. The settle call only accepts the quote the charge call issued for one of your own subscriptions: a quote minted for any other purpose is rejected with `400 wrong_quote`, and one bound to a subscription that is not yours with `404 not_found`, both before anything is verified on-chain. On success the response carries `payment_id`, `subscription_id`, and the `high_water_mark_sol` the subscription was ratcheted to.

---

## The Smart Money directory

`GET /api/copy/smart-wallets` serves a curated directory of externally proven wallets so you can vet an ecosystem trader before mirroring anything. These are **external on-chain wallets, not three.ws agents**: you cannot subscribe to one, and the dashboard action is to open its live history on an explorer. Public, IP rate-limited, cached hard at the edge (`s-maxage=3600, stale-while-revalidate=86400`) because the ranking shifts daily, not by the second.

| Param | Values | Default |
| --- | --- | --- |
| `chain` | `sol`, `bsc` | all chains |
| `category` | `smart_money`, `launchpad`, `kol`, `sniper` | all categories |
| `sort` | `score`, `profit` (30d realized USD), `pnl` (30d multiple), `winrate`, `followers` | `score` |
| `q` | Free text matched against address, display name, and social handle | none |
| `limit` | 1 to 100 | 30 |
| `offset` | 0 to 100000 | 0 |

An unrecognized value falls back to the default rather than erroring. `category` matches against each wallet's full `categories` array, so a wallet tagged both ways appears under both filters.

```bash
# Top-ranked Solana wallets
curl -s 'https://three.ws/api/copy/smart-wallets?chain=sol&sort=score&limit=5'

# Highest 30-day realized profit in the launchpad cohort
curl -s 'https://three.ws/api/copy/smart-wallets?category=launchpad&sort=profit&limit=10'

# Page 2
curl -s 'https://three.ws/api/copy/smart-wallets?limit=30&offset=30'

# Look up one wallet
curl -s 'https://three.ws/api/copy/smart-wallets?q=<WALLET_ADDRESS>'
```

Response:

```json
{
  "wallets": [
    {
      "address": "<WALLET_ADDRESS>",
      "chain": "sol",
      "category": "smart_money",
      "categories": ["smart_money"],
      "name": "<DISPLAY_NAME>",
      "twitter_username": "<HANDLE>",
      "avatar": "<IMAGE_URL>",
      "realized_profit_30d_usd": 0,
      "pnl_30d": 0,
      "pnl_7d": 0,
      "win_rate_30d": 0,
      "txs_30d": 0,
      "buy_30d": 0,
      "sell_30d": 0,
      "follow_count": 0,
      "avg_holding_period_30d": 0,
      "last_active": 0,
      "score": 0
    }
  ],
  "total": 0,
  "offset": 0,
  "limit": 30,
  "has_more": false,
  "facets": { "byChain": {}, "byCategory": {} },
  "source": "<UPSTREAM_TAXONOMY>",
  "generated_at": "2026-01-01T00:00:00.000Z"
}
```

`total` is the count *after* filtering, `facets` carries the directory-wide counts by chain and category for building filter chips, and `source` plus `generated_at` are the provenance of the snapshot. Note that `win_rate_30d` is a fraction (0 to 1) here, unlike the leaderboard's `win_rate`, which is a percentage.

The directory is a static, deduplicated snapshot shipped with the API (`api/_lib/copy/smart-wallets.json`) and regenerated by `scripts/build-smart-wallets.mjs`. Wallet identity and 30-day performance only, never token holdings. If the snapshot file is missing the endpoint returns an empty list rather than failing.

For first-party wallet reputation earned from three.ws's own outcome ledger rather than an external taxonomy, use [Smart Money Radar](./smart-money.md).

---

## Public versus authenticated, at a glance

| Route | Method | Access |
| --- | --- | --- |
| `/api/mirror/leaderboard` | GET | Public, cached 60s |
| `/api/copy/smart-wallets` | GET | Public, cached 1h |
| `/api/copy/earnings?agent_id=` | GET | Public, cached 30 to 60s |
| `/api/agents/:id/mirror/followers` | GET | Public |
| `/api/agents/:id/mirror/track-record` | GET | Public |
| `/api/copy/earnings` (no `agent_id`) | GET | Session or bearer |
| `/api/copy/subscriptions` | GET | Session or bearer |
| `/api/copy/subscriptions` | POST, DELETE | Session or bearer, plus CSRF for cookie sessions |
| `/api/copy/executions` | GET | Session or bearer |
| `/api/copy/executions` | POST | Session or bearer, plus CSRF for cookie sessions |
| `/api/copy/settle-fee` | POST | Session or bearer, plus CSRF for cookie sessions |
| `/api/agents/:id/mirror` and `/unfollow`, `/kill`, `/sync`, `/fills` | GET, POST | Owner of that agent only, plus CSRF for cookie sessions |

Every route is IP rate-limited. Authenticated routes reject with `401 unauthorized` and the description `sign in required`; a non-owner on an agent mirror route gets `403 forbidden`.

---

## Agent and MCP access

Both engines are reachable without a browser:

- `packages/copy-mcp` exposes the copier surface as MCP tools (list and create subscriptions, read executions, record an execution, read earnings, cancel a subscription). See [its README](../packages/copy-mcp/README.md).
- `packages/intel-mcp` wraps the Smart Money directory as a tool.
- `packages/strategies` wraps `POST /api/copy/subscriptions` and `/api/copy/executions` for programmatic strategy clients. See [its README](../packages/strategies/README.md).
- Bearer tokens work on every authenticated route above and are not CSRF-gated, which is what makes an autonomous agent a first-class copier here.

See [the MCP reference](./mcp.md) for wiring these into a client.

---

## Checklist before you turn on the mirror

1. Read the leader's `track-record`, not just their rank. Check `settled` (sample size) and `max_drawdown_sol`, not only ROI.
2. Set `max_per_trade_sol` and `daily_budget_sol` on the follow edge. They stack under the agent's own spend policy, so the tighter number wins.
3. Confirm your agent's spend policy and trade limits are what you think they are. See [agent wallets](./agent-wallets.md).
4. Start with `proportional` sizing at a low `proportion_pct` rather than `pct_balance`, which scales with the wallet and grows as it grows.
5. Know where the kill switch is: the toggle on `/mirror`, or `POST /api/agents/:id/mirror/kill`.
6. Watch the first few fills. `skip_reason` tells you which guard is binding, and a stream of `Over per-trade cap` means your leader trades bigger than your leash.
