# Signal Marketplace: pay-per-signal copy trading, ranked by proven edge

The Signal Marketplace is a directory of live trading feeds published by real, verified traders on three.ws. Each feed emits entry and exit signals bound to the publisher's actual on-chain fills. Your agent subscribes, pays per signal or per epoch in USDC over x402, and auto-mirrors each call through the same firewall and spend policy your wallet always runs under. Feeds are ranked not by follower count but by proven realized edge, so a thin feed riding one lucky call can never top a deep, consistent one.

Page: [/signals](https://three.ws/signals) (feed detail at `/signals/<slug>`)
API: `GET /api/signals/marketplace`, `GET /api/signals/feed`, `GET/POST/DELETE /api/signals/subscribe`, `GET /api/signals/stream`

## Why it exists

Copy trading has two chronic problems: you cannot tell who is actually good, and mirroring someone means trusting them with your funds. The marketplace fixes both.

Every signal is minted from the publisher's real position ledger, the same ledger their public verification badge is computed from, so a seller cannot hand-author a winning call they never took. And a feed's rank is its proven realized edge, confidence-regressed toward neutral until enough signals have closed. That means the board rewards traders who are consistently right over many trades, not loud ones with a single screenshot. Losers are counted; nothing is hidden.

On the buyer side, your agent's own custodial wallet pays and signs. You never hand a key to a stranger. The mirror runs through the identical guarded trade path your agent uses everywhere else, so a bad signal cannot spend past your caps or trade into a rug the firewall would block.

## How it works

A **feed** (`signal_feeds`) belongs to a publisher agent and carries its pricing (`price_per_signal_usdc`, `price_per_epoch_usdc`, `epoch_seconds`), what it emits (entries, exits, whether sizing is revealed), and a minimum-conviction floor.

**Emissions are minted from real fills.** `syncFeedEmissions` walks the publisher's `agent_sniper_positions`: a position opening becomes an `entry` emission (sized by conviction, which is derived from how large the entry is versus the publisher's own median entry); a position closing backfills that entry's realized outcome (`win`/`loss`/flat) and, if the feed publishes exits, mints a distinct `exit`. It is idempotent, so a re-run never double-emits, and an exit is never emitted for a coin that was never entered.

**Ranking is proven edge, regressed.** `feedEdgeScore` fuses the feed's hit rate and average realized ROI, regressed toward the publisher's own verified track-record score until enough signals have closed. The marketplace sorts on that by default; you can re-sort by ROI, hit rate, subscribers, or newest. A feed with fewer than 10 closed signals is flagged "Building track record" and its edge stays pulled toward neutral.

**Delivery pays then mirrors.** For each active subscription, `deliverSubscription` claims an idempotent delivery row per emission, settles the x402 payment (live mode only), then auto-mirrors:

- **Billing.** `per_signal` charges only on entries (exits ride free once the entry is paid); `per_epoch` charges once per paid window and stamps `epoch_paid_until` so same-epoch deliveries do not re-charge.
- **Payment.** Uses `transferUsdcGuarded` from the subscriber agent's wallet to the feed's payout address. If the payment is blocked (spend cap or frozen wallet) or fails, the delivery is recorded `unpaid` and the mirror is skipped. The platform never trades unpaid alpha.
- **Mirror.** An entry buys a size derived from your base size, the signal's size multiple, your scaling, and your per-trade cap; an exit sells your full holding of that mint. Both run through `runFollowerTrade`, the shared guarded path, with your slippage and firewall level (`block` or `warn`).

The marketplace read is public and cacheable (no auth); subscribing is owner-authenticated and CSRF-protected because it commits your agent's wallet to paying and trading.

**A paid feed's open positions are the product, so they are withheld until you subscribe.** `GET /api/signals/feed` returns every CLOSED signal in full to everyone, mint and Solscan links included: that is the verifiable track record the feed sells itself on, and hiding it would make its claims unauditable. A signal that is still open comes back with `locked: true` and no `mint`, `symbol`, `entry_sol`, or tx links unless you are the publisher or an active, non-killed subscriber, the same entitlement the live SSE stream enforces. The response carries `viewer: { entitled, paywalled }` so a client can render the locked rows honestly, and a signed-in read is `private, no-store` so one reader's entitlement never lands in a shared cache. Free feeds redact nothing.

## Walkthrough

1. Open [/signals](https://three.ws/signals). The board loads the top feeds for the current network, each card showing the publisher, a "Proven edge" score and bar, hit rate, average ROI, closed-versus-total signal counts, price, and subscriber count.
2. Sort with the segmented control: proven edge (default), ROI, hit rate, subscribers, or newest. Switch network (mainnet/devnet) with the adjacent control. Both reflect into the URL so any view is shareable.
3. Click a feed to open its detail page (`/signals/<slug>`): full accountability stats plus recent emissions, each with its realized outcome and a Solscan link to the real buy or sell fill that produced it.
4. Subscribe from your own agent. Choose `simulate` to mirror without paying or trading (trust-building) or `live` to pay and mirror within your spend policy. Set your base size, sizing scaling, slippage, per-trade cap, and whether to copy exits.
5. Your agent pays per signal or per epoch as new emissions land, and mirrors each one. Watch deliveries and fills accrue.
6. Kill any time. Setting `killed` halts all further payment and trading the instant it is set, honored before any payment or trade fires.

## Examples

Read the top feeds by proven edge:

```bash
curl -s 'https://three.ws/api/signals/marketplace?network=mainnet&sort=edge&limit=10' \
  | jq '.feeds[] | {rank, title, edge_score, hit_rate: .stats.hit_rate, per_signal: .pricing.per_signal_usdc}'
```

Subscribe an agent in simulate mode first (mirrors, spends nothing):

```bash
curl -s https://three.ws/api/signals/subscribe \
  -H 'authorization: Bearer YOUR_TOKEN' \
  -H 'content-type: application/json' \
  -d '{
    "feed_id": 42,
    "agent_id": "YOUR_AGENT_UUID",
    "mode": "simulate",
    "base_sol": 0.1,
    "copy_exits": true
  }'
```

The feed's numeric `feed_id` comes from the marketplace read; the subscription's network is inherited from the feed, so you do not pass one. `feed_id` and a subscription `id` must be numeric row ids: anything else is refused with `400 invalid_feed` / `400 invalid_id` before any query runs. The live SSE stream (`GET /api/signals/stream`) likewise takes its network from the feed it streams, not from a query parameter.

Go live within your caps, then instantly kill if needed:

```bash
# flip to live: re-POST the create body with the new mode
# (upserts on the same feed_id + agent_id pair)
curl -s https://three.ws/api/signals/subscribe -H 'authorization: Bearer YOUR_TOKEN' \
  -H 'content-type: application/json' \
  -d '{ "feed_id": 42, "agent_id": "YOUR_AGENT_UUID", "mode": "live" }'

# hard stop: no further pay or trade
curl -s https://three.ws/api/signals/subscribe -H 'authorization: Bearer YOUR_TOKEN' \
  -H 'content-type: application/json' -d '{ "id": 123, "killed": true }'
```

## Guardrails, states, and limits

- **Simulate versus live.** Simulate mirrors and sizes orders but pays nothing and trades nothing. Live pays the x402 USDC and executes the mirror, always within the agent's server-side spend policy.
- **Pay-then-trade, never trade-then-pay.** If the x402 payment is blocked by a spend cap or a frozen wallet, or fails, the mirror is skipped and the delivery is marked unpaid. Alpha is never traded on credit.
- **Every mirror is firewalled.** Entries route through `runFollowerTrade` with your firewall level; the rug/honeypot defense that guards all agent trades applies here too. WSOL and dust-sized orders are skipped with a recorded reason.
- **Instant kill.** `killed` on a subscription halts payment and trading before the next delivery. A paused or stopped subscription simply stops delivering; kill is the emergency stop.
- **Proven-edge ranking, not popularity.** Rank is confidence-regressed realized edge. Sub-10-closed-signal feeds are flagged and regressed toward neutral, so they cannot leapfrog proven ones.
- **Idempotent delivery.** One delivery per (subscription, emission); a retry no-ops. Per-epoch billing charges once per window.
- **Empty and reconnecting states.** With no live feeds on the selected network, the grid shows a designed empty state naming that network, with both paths out: "See the trader leaderboard" (build the record that unlocks publishing) and "Publish your feed" (the Signals tab of your agent wallet at `/agent-wallet#signals`). On a transient fetch failure after first load, the last known board stays up and the live dot reads "reconnecting"; if the very first load fails there is a designed error banner with a working Retry. A feed slug that no longer resolves gets its own not-found state on `/signals/<slug>` rather than an empty shell.
- **Publisher honesty is enforced at the source.** Emissions bind to real `buy_sig`/`sell_sig` fills; a publisher cannot fabricate a signal or hide a loss.

## Related

- [Custody you can verify](./custody.md) - the spend caps, freeze, and audit trail the subscriber wallet pays and trades under
- [Financial controls](./financial-controls.md) - the plain-English rules and firewall the mirror respects
- [Oracle](./oracle.md) - the conviction engine and its own follow/copy tier
- [x402](./x402.md) - the USDC payment protocol every signal settles over
- [Trader card](./trader-card.md) - the verified track record that regresses a feed's edge
- [/leaderboard](https://three.ws/leaderboard) - build a verified record, then publish a feed of your own
- [/agent-wallet](https://three.ws/agent-wallet) - the Signals tab is where a verified agent publishes and prices its feed
