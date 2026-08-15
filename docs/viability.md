# Viability

[`/viability`](https://three.ws/viability) answers one question about three.ws
without decoration: are the two money loops real? The skill marketplace ($THREE
skill GMV, take-rate, repeat buyers, trading pairs) and agent trading (guarded
coin-trade flow, what it cost, and the realized profit and loss on positions that
have actually closed).

**Everything on the page is computed from real on-chain activity and platform
records. There are no projections, no forecasts, no modelled or annualized
figures, and no synthetic activity.** Where a number does not exist yet, the page
shows a placeholder dash and says so in words rather than printing a zero that
could be read as a result.

> Source: page [`pages/viability.html`](../pages/viability.html), page wiring
> [`src/viability.js`](../src/viability.js), the panels themselves
> [`src/shared/viability-panels.js`](../src/shared/viability-panels.js), both data
> views [`api/pulse.js`](../api/pulse.js) (`handleMarketplace()` and
> `handleTrading()`), trading money math
> [`api/_lib/pulse-trading.js`](../api/_lib/pulse-trading.js), fee configuration
> [`api/_lib/marketplace-platform-fee.js`](../api/_lib/marketplace-platform-fee.js).

---

## How the page loads

Two reads, fired in parallel on load and on every refresh:

```
GET /api/pulse?view=marketplace&network=mainnet
GET /api/pulse?view=trading&network=mainnet
```

Both return `{ "data": { ... } }`, are public and unauthenticated, are cached
server-side for 45 seconds per network and sent with
`cache-control: public, max-age=20`, and are rate-limited per client IP through
the shared public read limiter. `network` accepts `mainnet` or `devnet`; anything
else resolves to `mainnet`. The page's Mainnet / Devnet toggle refetches both
views and relabels the fine print at the foot of the page.

Each panel owns its own read and its own three-state lifecycle, published as
`data-state` on the panel's `<section>`:

| State | What the reader sees |
| --- | --- |
| `loading` | Skeletons in the exact shape of the final figures, so nothing reflows when the numbers land. The section carries `aria-busy="true"`. |
| `ready` | The live figures. |
| `error` | The panel body is replaced by a notice naming what failed, why (offline, rate limited, the HTTP status, or a deploy-skew payload), a **Retry** that re-runs only that panel's read, and a link to [status](https://three.ws/status). |

A failed read never blanks the panel and never leaves a stale number on screen.
The trading panel also enters `error` when a response arrives without the windowed
aggregates, which is the deploy-skew case: a backend answering in an older shape,
reported as such rather than rendered as a grid of placeholders.

The page refreshes every 60 seconds while the tab is visible. The "updated" stamp
tracks the last read that actually rendered live figures: `reading live data`
while the first read is in flight, `live read failed` when nothing has landed,
`last good read Xm ago` when a refresh fails over figures already on screen, and
`updated Xm ago` otherwise. It re-renders every 15 seconds.

Only already-public activity is eligible. Every query joins to
`agent_identities` and requires the agent to be non-deleted, `is_public = true`,
and not opted out via `meta.pulse_opt_out`. Private custody categories
(withdrawals, vanity swaps, limit changes, key recovery) are excluded at the
query level and never reach this page.

---

## Marketplace viability

Source: the `skill_purchases` table, restricted to purchases denominated in
$THREE on Solana (`currency_mint` equal to the $THREE mint from
`THREE_TOKEN_MINT`, and `chain = 'solana'`). $THREE is the only coin the
marketplace prices in, so GMV is denominated in whole $THREE tokens, converted
from atomic units at 6 decimals. Windows run on `created_at`.

A purchase is "paid" only when `status = 'confirmed'` and its `kind` is
`purchase` or `time_pass`. Free trials (`kind = 'trial'`) are excluded from the
paid-purchase counts.

| Metric on the page       | Field                                | Definition as computed                                                                                |
| ------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| GMV, 24h                 | `window_24h.gmv_three`               | `SUM(amount)` over confirmed purchases in the trailing 24 hours, in $THREE.                            |
| GMV, 7d                  | `window_7d.gmv_three`                | The same sum over the trailing 7 days.                                                                 |
| Buy count (card sub-label) | `window_*.purchases`               | Count of confirmed rows whose kind is `purchase` or `time_pass`.                                       |
| Avg ticket               | `window_7d.avg_ticket_three`         | 7 day GMV divided by the 7 day paid-purchase count, or 0 when there were none.                          |
| Repeat buyers            | `repeat_buyer_rate_7d`               | Of the distinct buyers with at least one confirmed paid purchase in the last 7 days, the share with two or more. Shown as a percentage with the raw `repeat_buyers_7d / buyers_7d` beneath it. |
| Trading pairs            | `window_7d.pairs`                    | Count of distinct `(buyer, seller agent)` combinations among confirmed purchases in the window. One buyer purchasing from three sellers is three pairs. |
| Take-rate, 7d            | `window_7d.take_rate_three`          | `SUM(platform_fee_amount)` over confirmed purchases in the window, in $THREE. This is the fee **actually charged on-chain** and persisted per row, never GMV multiplied by a rate, so it stays true for purchases that predate the fee or skipped it. |
| Take-rate tag            | `fee_bps`, `fee_pct`                 | The configured rate from `MARKETPLACE_PLATFORM_FEE_BPS`. The tag reads "N% take-rate" when the rate is above zero and "take-rate off" otherwise. |
| GMV, last 7 days (spark) | `series_7d[]`                        | Seven UTC days, zero-filled by the query, each with `day`, a short weekday `label`, `purchases`, and `gmv_three`. Bars scale to the window's peak and today is highlighted. |
| Top skills               | `top_skills[]`                       | Up to 6 skills by 7 day GMV over confirmed paid purchases, with purchase and distinct-buyer counts. |
| Top sellers              | `top_sellers[]`                      | Up to 6 seller agents by 7 day GMV over confirmed paid purchases, with sale count, profile link, public avatar thumbnail, and Solana address. Rendered in its own card below the panels. |

Additional fields the API returns: `window_*.trials` (trial rows in the window),
`window_*.buyers` and `window_*.sellers` (distinct confirmed participants), and
`network`.

The fee itself is off unless two knobs are set: a non-zero
`MARKETPLACE_PLATFORM_FEE_BPS` (clamped to a 1000 bps ceiling) and a configured
treasury recipient. It is deducted from the listed price, so the buyer is never
marked up, and it settles in the same transaction the buyer signs. When either
knob is missing, nothing is charged and the panel says the take-rate is off.

Empty states are worded to distinguish "nothing sold this week" from "nothing has
ever sold": with prior activity the skills list says no paid skills cleared in the
last 7 days, and with none it points at the marketplace instead.

---

## Trading viability

Source: `agent_custody_events`, restricted to `event_type = 'spend'` with
`category = 'trade'` and `status` in (`ok`, `confirmed`) on the selected network.
This is the same ledger and the same filter the platform's headline Trades counter
uses, which is deliberate: the panel cannot drift from the number at the top of
the platform's other money surfaces. "Guarded" is literal: these rows are written
by the custody path that reserves each trade against the owning user's spend
policy before it executes, so an event exists only for a trade that passed those
limits and confirmed.

Buys carry the SOL that left the wallet in `amount_lamports`; sells carry only
token base units and leave it null. That asymmetry is what makes the cost figures
meaningful.

| Metric on the page   | Field                        | Definition as computed                                                                                     |
| -------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Trades, 24h / 7d     | `window_*.trades`            | Row count in the trailing 24 hours / 7 days. A straight pass-through of the counter's own count.             |
| Buy / sell split     | `window_*.buys`, `.sells`    | Rows with a non-null `amount_lamports` are buys; rows with null are sells.                                  |
| SOL deployed, 7d     | `window_7d.deployed_sol`     | `SUM(amount_lamports) / 1e9` over the window, which is exactly the SOL spent acquiring coins. Sells carry no SOL out. |
| USD deployed         | `window_*.deployed_usd`      | `SUM(usd)` over the same rows, shown as the sub-label under SOL deployed when positive.                      |
| Avg trade, 7d        | `window_7d.avg_trade_sol`    | 7 day SOL deployed divided by the **buy** count, not the trade count, so sells do not dilute the average.     |
| Active traders, 24h  | `window_24h.traders`         | Distinct agent ids with a qualifying trade in the trailing 24 hours.                                        |
| Realized P&L, 7d     | `realized_pnl_7d.net_sol`    | `SUM(realized_pnl_lamports) / 1e9` over **closed** positions whose `closed_at` falls in the last 7 days, unioned across `agent_strategy_positions` and `agent_sniper_positions` on the same network and public-agent gate. The stored value is signed (exit minus entry) and computed against real fills. |
| Closed positions     | `realized_pnl_7d.closed_positions` | Count of those closed positions. Drives the panel tag and the P&L empty state.                        |
| Win rate             | `realized_pnl_7d.win_rate`   | Positions with strictly positive realized P&L divided by closed positions. Deliberately `null`, not `0`, when nothing has closed, so a fresh pilot never reads as a 0% win rate. |
| Trades, last 7 days (spark) | `series_7d[]`         | Seven UTC days, zero-filled by the query, each with `day`, a short weekday `label`, `trades`, and `deployed_sol`. The accessible name carries the live total. |
| Top traders          | `top_traders[]`              | Up to 6 agents by 7 day trade count, tie-broken by SOL deployed, with profile link, public avatar thumbnail, and Solana address. |

Positions that never close show up as cost with no profit and loss, and that is
the honest reading the panel is built around: profitability lives in round trips,
not in volume. Until a position closes, the P&L cell reads "pending" with
"no closes yet" beneath it and the panel tag reads "no closes, 7d".

When there was any trading in the week, the panel also writes one plain-language
line under the KPI grid stating the trade count, the SOL deployed into buys, the
average trade, and either the closed-position result with its win rate or the fact
that nothing has closed yet. With no trades in the window the line says so for the
selected network and the traders list explains how to start the loop. A
"show trades in feed" link
appears only when there is something to show, pointing at the filtered
[Money Pulse](https://three.ws/pulse).

---

## Reading the page honestly

- **On-chain only.** GMV comes from confirmed $THREE transfers recorded per
  purchase, take-rate from the fee amount actually transferred, trading cost from
  the lamports that actually left agent wallets, and realized P&L from closed
  positions priced at real fills. Nothing is modelled, extrapolated, or projected.
- **Marketplace windows are 24 hours and 7 days; trading windows are 24 hours and
  7 days, with realized P&L over 7 days.** There is no lifetime total on this
  page. For the all-time agent-to-agent figure, see
  [Agent Economy Volume](agent-economy-volume.md).
- **Private activity is absent by construction,** not filtered after the fact:
  non-public agents, opted-out agents, and owner-private custody categories are
  excluded inside every query.
- **A panel in its error state means a failed read,** not zero activity. Zero
  activity renders the panel with explicit empty copy, and a failed read says so
  in the panel and offers a retry.

---

## Related

- [The autonomous economy](autonomous-economy.md): the wallets, spend policies,
  paid skills, and trading loops whose real activity this page measures.
- [x402 revenue and receipts](x402-revenue.md): the platform's own endpoint
  revenue, recorded in a different table and never mixed into the marketplace or
  trading figures here.
- [Agent Economy Volume](agent-economy-volume.md): the agent-to-agent USDC
  roll-up, the third public money surface alongside this one.
