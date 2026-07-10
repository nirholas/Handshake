# 12 · Orders

> Set-and-forget limit, stop, trailing, DCA, TWAP, and signal-driven orders that fire automatically from your agent's own wallet — on live on-chain data, inside your guardrails.

*One of the 23 abilities of the [Agent Wallet](../chapters/10-the-agent-wallet.md) — the money layer of a three.ws agent.*

## What it does

The Orders tab gives your agent wallet the order tooling pump.fun never had: six order types you arm once and walk away from. Set a limit buy at a target market cap, a stop-loss, a trailing stop that follows the high, a recurring DCA schedule, a TWAP that slices one big order to cut price impact, or a conditional trigger built from real signals — "buy when the smart-money score is over 60 and market cap is under $40k," or "sell if the dev dumps." Before you arm anything, a one-click preview shows the live price, whether the order would fire right now, and a rug/honeypot firewall verdict. Open orders stream their status live, every fill comes with a plain-language reason and an explorer-linked receipt, and pause, resume, or cancel is one click and instant.

## How it works

Orders are validated against a closed, no-code condition language (a fixed set of real signals and operators — never arbitrary expressions) and stored server-side; the exact same validation and trigger-evaluation functions run in both the API and the execution worker so the rules can never drift. A long-lived worker sweeps all active orders every ~10 seconds, re-quoting each token directly off the live pump.fun bonding curve (automatically switching to the AMM pool once a coin graduates), and pulling smart-money scores from the reputation graph, dev-dump flags from coin intelligence, and USD conversion from a live SOL price. When a trigger matches, the order fires through the exact same audited trade pipeline as a manual trade — rug/honeypot firewall (a real simulated buy-then-sell round trip plus a token-authority audit), per-trade cap, rolling daily budget, kill switch, and custody ledger with idempotency keys — so the worker adds no new way to move funds, it only decides when to call the one audited path. The tab itself streams order status to the browser over a live server-sent event feed and diffs updates in without disturbing the form you're typing in.

## Every feature

- Six order types selectable from an icon card grid: Limit, Stop, Trailing, DCA, TWAP, Conditional — each with a one-line explainer
- Buy / Sell side toggle that reshapes the sizing fields
- Three trigger metrics: price (SOL per token), market cap (SOL), market cap (USD)
- Limit orders: buy at-or-below a target, sell at-or-above it
- Stop orders: stop-loss sell when a level is breached downward, breakout buy when it breaks upward
- Trailing orders: sell after a % drop from the tracked high-water mark, or buy after a % bounce from the tracked low (trail 0.1–99%)
- DCA: recurring buys or sells with interval presets (5 min, 15 min, 30 min, 1 hour, 6 hours, 1 day) and 1–1000 slices
- TWAP: one large order auto-split into 2–1000 equal slices on an interval, per-slice size derived from the total (SOL for buys, % of holding for sells)
- Conditional order builder: fire when ALL or ANY of up to 8 clauses are true
- Seven real condition signals: price (SOL), market cap (SOL), market cap (USD), price change since order created (%), smart-money score (0–100), dev-has-dumped (yes/no), graduated-to-AMM (yes/no)
- Comparison operators per clause: >, ≥, <, ≤, =, ≠ for numbers; is-true / is-false for yes/no signals — the operator set adapts to the signal you pick
- Add / remove condition clauses inline (the builder never lets you delete the last clause)
- Buy sizing in SOL per fill; sell sizing as a % of the current holding (100% resolves to sell-everything)
- Max slippage control, 1–5000 basis points
- Optional expiry date/time — an unfilled order auto-expires
- Preview before arming: a plain-English readback of exactly what the order will do
- Preview shows the live current metric value, with a graduated-to-AMM tag when relevant
- Preview shows a would-fire indicator: '⚡ Would fire immediately' vs '⏳ Waiting — the trigger isn't met yet'
- Preview flags signals with no live data yet — with the guarantee the order won't fire until that data exists
- Preview runs the rug/honeypot firewall on buys and shows the allow / warn / block verdict with plain-language reasons
- Hero stat row: active orders, filled orders, lifetime fills, live wallet SOL balance
- Live status streaming with a pulsing 'live' badge; list updates arrive without re-rendering the form you're editing
- Frozen-wallet banner: warns that orders won't fire until you unfreeze under Limits
- Kill-switch banner: warns that orders are held while discretionary trading is paused
- Open-orders list with status pills: active, partial, firing, paused, filled, cancelled, expired, error
- Per-order plain-language readback on every card (e.g. 'Stop-loss: sell 100% of the holding of $X if it falls to $25,000 mcap')
- Per-order live footer: current price, fill count, SOL filled, and the last error if one occurred
- DCA/TWAP progress bar showing filled slices out of total
- Pause / Resume any open order without losing fill progress (resume restores 'partial' if it already has fills)
- Per-order instant Cancel
- Cancel-all button with a confirmation dialog — an orders kill switch that reports how many were cancelled
- Fills drill-down per order: status, trigger reason, SOL amount, price impact %, and an explorer-linked on-chain receipt for every real fill
- History section of the last 30 completed orders
- Mainnet / devnet aware — every call follows the hub's network switch
- Editable orders: target price, trail %, slippage, and expiry can be patched on an unfilled order (type/side/token are immutable by design)
- Designed empty state, skeleton loading, and an error state with a Retry button
- Token mint field pre-hinted with $THREE

## Guardrails & safety

Owner-only end to end: the tab only renders for the agent's owner, and every server route re-verifies ownership — a visitor can never read or touch orders. All writes are CSRF-protected and rate-limited. Conditions are a closed vocabulary — a fixed set of real signals and operators, max 8 clauses, no arbitrary code. Inputs are validated and clamped server-side (slippage 1–5000 bps, sell 0–100%, trail 0–100%, max 1000 slices, minimum intervals). Orders never fire on missing data — an unreadable price or absent signal means hold, never a guess. Every fill executes through the same audited pipeline as a manual trade: rug/honeypot firewall (a real simulated buy→sell round trip plus token-authority audit; a coin you can buy but not sell is blocked, not flagged), per-trade SOL cap, rolling 24h budget, wallet freeze, and the trading kill switch — an order can never exceed the leash. Terminal failures (rug verdict, graduated buy) halt the order instead of retrying forever; transient blocks retry. Each agent's fills are serialized so two orders can't double-spend the same budget, idempotency keys make retries safe, and every fill lands in the custody audit ledger. Cancel is instant and idempotent; cancel-all requires an explicit confirmation. The worker defaults to simulate mode, refuses to run live without a real RPC endpoint, and has its own global emergency stop.

## Screenshot-worthy (shot list)

- The conditional builder: compose 'buy when smart-money score ≥ 60 AND market cap < $40k' — or 'sell if the dev dumps' — from dropdowns, and read it back in one plain-English sentence
- The pre-arm preview: live price, an '⚡ Would fire immediately' vs '⏳ Waiting' verdict, and the rug/honeypot firewall's allow/warn/block ruling — all before a single lamport moves
- Open orders updating live under a pulsing 'live' badge, with per-fill receipts linking straight to the on-chain transaction

## API surface

- `GET /api/agents/:id/orders — list orders + summary + live SOL balance + frozen/kill-switch state`
- `GET /api/agents/:id/orders/schema — order types, trigger metrics, and the closed signal/operator vocabulary that drives the condition builder`
- `POST /api/agents/:id/orders — create a validated order`
- `POST /api/agents/:id/orders/preview — validate + live preview: current metric value, would-fire-now, firewall verdict, spend limits`
- `POST /api/agents/:id/orders/cancel-all — cancel every active order`
- `GET /api/agents/:id/orders/stream — SSE live order status (~3s ticks, 40s windows with auto-reconnect)`
- `GET /api/agents/:id/orders/:orderId — one order + its fills`
- `PUT /api/agents/:id/orders/:orderId — edit price/trail/slippage/expiry or pause/resume`
- `DELETE /api/agents/:id/orders/:orderId — instant cancel`
