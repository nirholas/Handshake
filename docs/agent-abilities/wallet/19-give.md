# 19 · Give

> Turn your agent's wallet into a giving wallet — round up the spare change or donate any amount to any Solana cause, settled on-chain with a receipt you can verify.

*One of the 23 abilities of the [Agent Wallet](../chapters/10-the-agent-wallet.md) — the money layer of a three.ws agent.*

## What it does

The Give tab turns an agent's wallet into a charity wallet. Pick a cause — any Solana wallet or a human-readable .sol name — and it's saved so giving is one tap from then on. Donate SOL, USDC, or any token the wallet holds: type an amount, tap a quick percentage of the live balance, or use round-up to give just the spare change (12.37 becomes a 0.37 donation and a clean 12.00 kept). An Impact tracker tallies everything you've given to the cause, pulled straight from the wallet's on-chain history, with an explorer link for every donation.

## How it works

The browser never holds a key. A donation is a server-signed transfer from the agent's self-custodied Solana wallet: the server authenticates the owner, validates the destination, enforces the agent's spend policy and daily caps, decrypts the custodial key (with an audit log entry), signs a versioned Solana transaction, submits it with retries, and polls for on-chain confirmation — returning a pending state instead of risking a double-send if confirmation is ambiguous. Balances in the asset picker come from live Solana RPC reads of the wallet's SOL and token accounts, with automatic failover to a public RPC. The Impact tally is computed by filtering the wallet's custody ledger for confirmed transfers whose destination matches the cause address and summing their USD value. Cause names ending in .sol are resolved through the Solana Name Service.

## Every feature

- Cause picker: set any Solana wallet address or any .sol name as the giving destination
- Optional cause name label (up to 60 characters, e.g. "Ocean Cleanup") shown across the tab
- Live .sol name resolution as you type (debounced), with instant visual feedback: green check for a valid address, resolved address preview for a .sol name, warning for anything unresolvable
- Cause is remembered per agent, so giving is one tap next time; Change and Cancel controls to edit or keep the current cause
- Give now form with an asset dropdown built from live on-chain holdings — SOL plus every token the wallet actually holds (USDC named, other tokens shown by short mint), each with its available balance
- Quick-amount percentage chips: 1%, 5%, 10%, 25%, and Max (100%) of the live balance
- Free-form amount field with decimal keyboard on mobile and a live "Available" readout that updates when you switch assets
- Client-side validation before review: amount must be positive and within the available balance, with clear inline error messages
- Two-step review-and-confirm flow: a summary card showing cause name, full destination address, exact amount, and network, plus an explicit "crypto transfers are final" warning before anything moves
- Round-up / spare change mode: one tap per asset donates only the fractional remainder (e.g. 12.37 USDC → give 0.37, keep 12.00), with the rounding math spelled out on each row
- Impact tracker: total USD given and donation count to the current cause, computed from the wallet's real on-chain custody trail — never self-reported
- Recent donations list (up to 5) with dates and "view transaction" explorer links
- Success screen with a thank-you, the exact amount given, a "View on explorer" button, and a "Give again" reset
- Distinct "Donation submitted" pending state when the network hasn't confirmed yet, telling you to verify on the explorer before retrying — prevents accidental double-gives
- Mainnet / devnet network awareness: switching networks resets the form and reloads balances and impact for that network
- Per-donation idempotency key, so a retried or repeated request can never send the same donation twice
- Risk acknowledgment gate before any mainnet donation (skipped on devnet)
- Cross-site request forgery protection on every donation submission
- Owner-only tab — visitors browsing someone else's agent never see it
- Designed loading skeletons while balances and impact load, error states with Retry buttons, and helpful empty states (no funds points you to the Deposit tab; whole-number balances explain how spare change accrues)
- Accessibility built in: live-region status announcements, alert roles on errors, keyboard focus rings, and reduced-motion support

## Guardrails & safety

Owner-only end to end: the tab is hidden from visitors, and the server independently verifies the signed-in user owns the agent before any read or transfer. Every donation passes a review-and-confirm step with an explicit finality warning, plus a risk-acknowledgment dialog on mainnet. Server-side, donations ride the hardened withdraw rail: CSRF-protected, capped at 5 withdrawals per user per day plus a per-IP burst guard, and governed by the agent's shared spend policy — per-transaction USD ceiling, rolling 24-hour daily USD cap, an optional destination allowlist, owner-authored natural-language policy rules, and a behavioral anomaly guard. Destinations are validated as real on-curve Solana addresses (program addresses and self-sends rejected). A SOL "max" donation always reserves rent and fee headroom so the wallet can never be bricked. Idempotency keys make retries safe: a confirmed donation replays its original receipt, an in-flight one returns "in progress," and an ambiguous confirmation is held as pending (never silently failed) so nothing double-sends. Every key recovery and transfer is recorded in an audited custody ledger.

## Screenshot-worthy (shot list)

- Round up spare change: one tap turns 12.37 USDC into a $0.37 real on-chain donation while keeping the clean $12.00 — micro-philanthropy straight from an agent's wallet
- The Impact card tallies total giving straight from the blockchain custody trail — every donation counted with a live explorer link, zero self-reported numbers
- Type a human-readable .sol name like oceancleanup.sol and watch it resolve live to the cause's wallet address before you save

## API surface

- `GET /api/sns?name= — resolves .sol names to wallet addresses via Solana Name Service (Bonfida), cached 5 min, IP rate-limited`
- `GET /api/agents/:id/solana/holdings?network= — live on-chain balances: SOL plus every SPL token held (Token + Token-2022 programs), USDC flagged, sorted by size`
- `GET /api/agents/:id/solana/custody?network=&limit=100 — owner-only custody audit trail (agent_custody_events ledger) used to compute the Impact tally`
- `POST /api/agents/:id/solana/withdraw — server-signed, idempotent, spend-policy-governed on-chain transfer; the donation is this withdraw with the cause wallet as destination`
