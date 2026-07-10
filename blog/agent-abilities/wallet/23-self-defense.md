# 23 · Self-defense

> Every agent wallet gets an immune system — it learns what normal spending looks like, freezes itself the instant something looks wrong, and explains why in plain English.

## What it does

The Self-defense tab is the owner's control room for a wallet that protects itself. The platform learns each agent's normal spending behavior — typical amounts, known addresses, usual hours, usual pace — and scores every outbound action against that profile in real time. Anything anomalous auto-freezes the wallet, notifies the owner, and shows up here as a flagged card with a 0–100 risk score and plain-language reasons like "3.2× your largest-ever trade" or "first payment to this address." The owner resolves it with one tap: approve it (which unfreezes the wallet and teaches the guard so the same pattern never trips again), keep it frozen, or sweep every remaining coin to a pre-set safe address.

## How it works

A deterministic scoring engine builds a behavioral baseline from up to 2,000 of the agent's real historical spends (size distribution, up to 200 known counterparties, active hours, assets, velocity), caches it for three hours, and reads live 1-minute/10-minute velocity counts fresh on every action. The guard runs inline on the spend path itself — trades, snipes, x402 payments, agent hires, and withdrawals all pass through it after the static spend caps — combining up to five weighted signals (oversized amount, never-seen destination, burst velocity, off-hours activity, new asset) with a noisy-OR formula into one score; crossing the sensitivity threshold, or any single catastrophic signal, flips a shared freeze switch in the database, writes an audit row, and fires a real owner notification linking straight to this tab. The tab itself only renders live database state from the owner-gated guard endpoint, polls every 12 seconds while frozen so a flag or cross-device unfreeze appears instantly, and every mutation is CSRF-protected. Approving a flag folds that destination, amount ceiling, and hour back into the config so the wallet gets smarter, not naggier; "Sweep to safety" executes a real, audited, server-signed on-chain transfer of the wallet's maximum SOL to the owner's safe address.

## Every feature

- Real-time anomaly scoring of every outbound action (trades, snipes, x402 payments, hires, withdrawals) against a learned behavioral baseline
- Automatic wallet freeze the moment an action crosses the risk threshold, holding the triggering action before funds move
- Frozen-wallet alarm banner with pulsing shield icon: 'Wallet frozen — your money is defending itself'
- Flagged-activity cards showing a plain-language summary, color-coded 0-100 risk score, category, dollar amount, destination address, and time
- Named, human-readable risk factors on every flag, e.g. '3.2× your largest-ever trade ($x vs $y)', 'First payment to this address — never used before', '12 spends in the last minute — far above your normal pace'
- One-tap 'It was me — approve & unfreeze': unfreezes the wallet AND teaches the guard (trusts the address, raises the size ceiling, marks the hour normal) so the same pattern never re-trips
- One-tap 'Keep frozen' to confirm an action as bad and record the verdict
- One-tap 'Sweep to safety': a confirmed, real on-chain transfer of all SOL (minus rent and fees) to the owner's pre-set safe address — available even while frozen, and the wallet stays frozen afterward
- Manual 'Unfreeze wallet' override (with confirmation) when frozen without an open flag; unfreezing also settles any open flags
- 'What your wallet has learned' baseline dashboard: spends learned, largest-ever spend, known addresses, and active hours (UTC)
- Learning mode for young wallets: under 5 priced spends the guard widens tolerances and only freezes on the clearest threats, and the UI says so honestly
- Trusted-pattern counter showing how many owner-approved addresses will never re-trip
- Master on/off toggle for the entire guard
- Three sensitivity presets — Relaxed (freezes only on the clearest threats, score ≥ 0.85), Balanced (recommended default, ≥ 0.7), Strict (freezes on the first sign of unusual activity, ≥ 0.5) — as a segmented control with descriptions
- Safe-address setting with server-side validation that rejects invalid addresses and program addresses where funds could be unrecoverable
- 'Reset what's learned' control (with confirmation) that wipes trusted addresses, the learned size ceiling, and learned hours so everything scores fresh
- Anomaly timeline of every scored action — allowed, flagged, approved, or denied — each with risk score, category, dollar amount, status badge, and relative timestamp
- 'Load older' cursor-based pagination through the full timeline history
- Auto-refresh every 12 seconds while frozen (paused when the tab is hidden) so new flags or an unfreeze from another device appear live
- Five independent anomaly signals: transaction size vs largest-ever, brand-new destination, velocity burst (absolute: 8 spends/minute or 20 per 10 minutes; plus relative 3×-normal-pace detection), off-hours activity, and first-time asset movement
- Catastrophic signals (a new high-value destination, a hard velocity burst) force a freeze regardless of sensitivity — tuned to never miss a drain-the-wallet attack, including drains that stay under daily caps via many small payments
- Dust filter: spends under $1 never flag on size or destination alone
- Owner notification on every auto-freeze (in-app and push) with the summary, top factors, and a direct link to this tab
- Withdrawals are never blocked by a freeze — the owner's escape hatch stays open so a freeze can never trap funds; withdrawals are still scored and shown on the timeline
- Fail-safe scoring: if the guard ever can't finish scoring, Strict-mode wallets freeze on the safe side while others proceed with the incident recorded
- Designed states throughout: skeleton loading, signed-out prompt with sign-in link, actionable error state with retry, and a friendly empty state confirming the guard is watching

## Guardrails & safety

Owner-only surface end to end: the tab is gated to the wallet owner and every API call verifies session or bearer auth plus agent ownership, returning 401/403/404 otherwise. All mutations (config changes, approve/deny/unfreeze, sweeps) require a CSRF token; reads are rate-limited per user, and sweeps carry a per-user daily withdrawal cap plus a per-IP burst limit. Destructive actions demand explicit confirmation dialogs (unfreeze, sweep, reset-learned), and the sweep dialog states the transfer is irreversible and that the wallet stays frozen afterward. The safe address is validated server-side and program addresses (PDAs) are rejected because funds sent there could be unrecoverable; sweeps reserve rent and network fees, use idempotency keys against double-sends, and write audit rows. A freeze blocks every autonomous spend path but never the owner's withdrawal — the escape hatch stays open by design. Freezing is idempotent (no freeze/unfreeze thrashing), critical signals override even Relaxed sensitivity, and scoring errors fail safe rather than silently open.

## Screenshot-worthy (shot list)

- The alarm state: a pulsing red shield beside 'Wallet frozen — your money is defending itself', above a flag card that spells out exactly why in plain English — '3.2× your largest-ever trade' with a red risk-87 badge — and three one-tap verdicts: Approve & unfreeze, Keep frozen, Sweep to safety.
- The 'What your wallet has learned' dashboard — spends learned, largest spend, known addresses, active hours — proof on screen that the wallet has a real behavioral memory, not a static rule list.
- The sensitivity segmented control (Relaxed / Balanced / Strict) next to the promise that approving a flag teaches the guard — the wallet gets smarter, never naggier.

## API surface

- `GET /api/agents/:id/solana/guard`
- `GET /api/agents/:id/solana/guard?before=<cursor>`
- `PUT /api/agents/:id/solana/guard`
- `POST /api/agents/:id/solana/guard`
- `POST /api/agents/:id/solana/withdraw`
