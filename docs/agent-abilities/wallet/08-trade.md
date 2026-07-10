# 08 · Trade

> Your agent's wallet is a full trading desk — paste any pump.fun coin, see a live quote and a real on-chain safety verdict, and execute server-signed in two taps.

*One of the 23 abilities of the [Agent Wallet](../chapters/10-the-agent-wallet.md) — the money layer of a three.ws agent.*

## What it does

The Trade tab lets an agent's owner buy and sell any pump.fun coin directly from the agent's own funded wallet. Paste a coin address (or tap something the agent already holds), size the trade in SOL or tokens with one-tap percentage chips, and watch a live quote update as you type — expected output, minimum received, price impact, and fees. Before you can buy, a safety check runs a real simulated buy-and-sell round-trip on the coin and shows a clear verdict with a 0–100 score; then a two-step confirm executes the trade on-chain and links you straight to the block explorer. Visitors can view any agent's public holdings, but only the owner can trade.

## How it works

Every keystroke triggers a debounced preview call that prices the trade server-side — bonding-curve coins through the pump.fun SDK, graduated coins through the canonical PumpSwap AMM pool — and returns the quote together with any guardrail warning and the firewall's safety verdict, so the owner sees exactly what would block the trade before submitting. On confirm, the same endpoint enforces the full guard stack (kill switch, per-trade and daily SOL caps shared with the autonomous sniper, USD spend ceilings, plain-English policy rules, anomaly detection, price-impact breaker, fee headroom), claims an idempotency-keyed row in the custody ledger, and only then decrypts the agent's custodial key under an audit log. The transaction is built from the venue's official SDK instructions and broadcast through an MEV-aware execution engine that simulates first, sizes the compute budget, attaches a live priority fee, and retries adaptively — rechecking the chain so a landed transaction is never misreported. Holdings and history refresh only from confirmed on-chain state, and the history feed merges manual trades with the sniper's closed positions from the same ledger.

## Every feature

- Buy/Sell segmented toggle (green buy, red sell) with per-side themed submit buttons
- Paste-any-mint coin input with base58 validation — coin-agnostic, trades whatever mint the owner supplies
- Live coin resolution card: name, symbol, image, and a 'Graduated · AMM' vs 'Bonding curve' badge
- Tap any holding to instantly set up a sell — switches side, prefills the full balance, scrolls to the ticket
- Buy sizing in SOL with a live ≈USD equivalent under the input
- Quick-size chips for buys: 25% / 50% / 75% / Max — Max automatically reserves ~0.003 SOL fee-and-rent headroom
- Quick-size chips for sells: 25% / 50% / 75% / Max computed in exact integer base units (BigInt math, zero rounding drift)
- Slippage presets 1% / 3% / 5% plus a custom basis-points field (clamped 0–5000; 3% default)
- Debounced live quote (450 ms) with skeleton loading: expected output/proceeds, minimum received, price impact, max slippage, route, and platform fee
- Price-impact color coding: amber from 5%, red from 15%, with an explicit high-impact warning note
- Pre-buy Safety panel: allow/warn/block verdict, 0–100 safety score, expandable per-check breakdown (mint & freeze authority, tradable venue, buy→sell round-trip, holder concentration, price impact) with pass/warn/fail dots and a 'what this means' explainer
- Hard firewall block: a 'block' verdict disables the buy with the exact reasons shown before any spend
- Two-step confirm card: review → 'You pay / You receive ≈ / Minimum' summary with Confirm and Cancel; Escape backs out; focus moves to the decision for keyboard users
- Risk-acknowledgment gate before every mainnet execution (devnet exempt), with a native-confirm fallback that never bricks the feature
- Idempotent execution: every trade carries a unique key so a retry can never double-spend; a replay is labeled 'Already executed'
- Success banner with a one-click block-explorer link (Solscan on mainnet, Solana Explorer on devnet) plus a toast
- Insufficient-funds recovery: the error swaps the trade button for an 'Add funds' CTA that jumps straight to the Deposit tab
- Holdings card: live on-chain SOL balance plus every SPL token held (Token-2022 included, USDC filtered out), each row tappable to sell
- Trade history card (owner-only): unified feed merging manual trades with the sniper's closed round-trips — green/red PnL in SOL and %, exit reason, venue, status, time-ago, explorer links
- Visitor mode: anyone can view the agent's public holdings; trade controls and history stay owner-only
- Wallet-preparing state: a friendly banner while the agent's wallet is being provisioned
- Mainnet/devnet network switch awareness — the tab resets and reloads holdings, history, and quotes on change
- Designed empty, loading (skeletons), and error states with Retry buttons for holdings and history
- Accessibility throughout: aria-live quote region, aria-pressed toggles, focus rings, reduced-motion support
- Server-side smart routing: bonding-curve coins price and execute through the pump.fun SDK; graduated coins route through the canonical PumpSwap AMM pool
- Pump.fun mayhem-mode coins are refused on buys (read straight off the bonding curve) while sells always stay open as an exit
- Owner-configurable guardrails enforced server-side: kill switch, per-trade SOL cap, rolling 24-hour SOL budget shared with the sniper, per-transaction and daily USD ceilings, wallet freeze, and a price-impact circuit breaker (15% default)
- Natural-language spend policies: the owner's plain-English rules are deterministically enforced on every buy alongside the numeric caps
- Behavioral anomaly guard: spends are scored against the agent's learned normal and can auto-freeze the wallet
- MEV-aware execution engine: real pre-flight simulation sizes the compute budget, live priority-fee estimation, bounded adaptive retries, and a landed-transaction recheck so a confirmed trade is never marked failed
- Full custody ledger and audit trail: every trade claims a ledger row before the key is ever touched, and key decryption itself is audit-logged with the reason
- 1000 SOL hard ceiling per buy and a wrapped-SOL trade refusal at the validation layer
- Balances and history refresh only from confirmed on-chain state after each trade

## Guardrails & safety

Owner-only execution behind session auth plus a single-use CSRF token (quotes are free; only real trades spend one) — the browser never holds a key. Before any buy, the server runs the shared guard stack: a kill switch, an owner-set per-trade SOL cap, a rolling 24-hour SOL budget shared with the autonomous sniper (one wallet, one budget), cross-path per-transaction and daily USD ceilings, the owner's plain-English policy rules, a behavioral anomaly detector that can auto-freeze the wallet, a price-impact circuit breaker (15% default, owner-tunable), and an ~0.003 SOL fee/rent headroom check against the real on-chain balance. Buys additionally pass a rug/honeypot firewall that simulates a real buy→sell round-trip on-chain and audits mint/freeze authorities — a 'block' verdict refuses the trade outright; mayhem-mode coins are refused on buys. The UI adds its own layers: a two-step confirm, a mainnet risk-acknowledgment dialog, slippage clamped to 5000 bps, a 1000 SOL per-buy ceiling, and a mandatory idempotency key so retries can never double-spend. Every guard rejection is a structured, human-readable reason — never a silent failure — and every trade, block, and key access lands in an audited custody ledger.

## Screenshot-worthy (shot list)

- The pre-buy Safety panel: a live allow/warn/block verdict with a 0–100 score and a per-check breakdown — powered by a real simulated buy→sell round-trip on-chain, so a honeypot is blocked before a single lamport moves
- The live quote card mid-typing: expected output, minimum received, and price impact that turns amber then red as size grows, with the route (bonding curve vs AMM) named on the ticket
- The unified trade history: manual buys and sells interleaved with the sniper's automated round-trips, each snipe showing green/red realized PnL in SOL and percent with explorer links

## API surface

- `POST /api/agents/:id/solana/trade (preview:true = live quote; without preview = server-signed execution)`
- `GET /api/agents/:id/solana/trade-history (unified discretionary + sniper feed, owner-only)`
- `GET /api/agents/:id/solana/holdings (SOL balance + SPL token list, public read)`
- `GET /api/pump/coin?mint= (coin name/symbol/image/graduation metadata, best-effort)`
- `Jupiter Lite price API with CoinGecko fallback (client-side SOL/USD for the ≈$ readout, 60s cache)`
