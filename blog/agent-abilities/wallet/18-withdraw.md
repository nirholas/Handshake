# 18 · Withdraw

> Sweep any asset out of your agent's wallet in three taps — server-signed, policy-guarded, and audited down to every single key touch.

## What it does

The Withdraw tab is the owner's exit door and control room for an agent's custodial Solana wallet. You pick any asset the wallet actually holds — SOL, USDC, or any token — enter a wallet address or a .sol name (or scan a QR code), review a confirmation screen, and the funds move on-chain. Alongside withdrawals, the same tab lets you set hard spending ceilings, restrict where funds may ever be swept, and freeze the wallet with one tap, instantly pausing all of the agent's autonomous trading and payments while keeping your own withdrawals open. A third panel shows the complete custody audit trail: every withdrawal, automated spend, limit change, key access, and every payment your safety rules blocked.

## How it works

The agent's private key lives encrypted on the server and never touches the browser — a withdrawal is a server-signed request, and each time the key is decrypted, that access is itself recorded as a custody event. Before signing, the server runs the withdrawal through the shared spend policy: the freeze switch, the withdraw allowlist, the owner's plain-English safety rules (compiled by an LLM into deterministic rules, then enforced by code), per-transaction and rolling 24-hour USD ceilings, and a behavioral anomaly guard. Each request carries a unique idempotency key claimed as a row in the custody ledger, so a retry replays the original result instead of double-sending, and an ambiguous network timeout leaves the withdrawal marked pending with an explorer link rather than risking a duplicate. On a SOL "Max" the server reserves rent plus fee headroom so a full sweep can never brick the wallet, and token withdrawals automatically open the recipient's token account when needed. The asset picker, spend totals, and activity feed all read live on-chain and ledger data — nothing is cached guesswork.

## Every feature

- Three sub-sections in one tab: Withdraw, Limits & Safety, and Activity, switchable via a pill button strip
- Owner-only tab — visitors never see it
- Asset picker populated from live on-chain holdings: SOL plus every SPL token with a non-zero balance (both classic and Token-2022 programs), sorted largest first, USDC labeled by name
- Available-balance readout under the amount field that updates when you switch assets
- Destination accepts a raw Solana address or a .sol name, resolved live (debounced) with an inline green check for valid addresses and a resolved-address preview for names
- QR-code scanner (camera overlay) that fills the destination field, understands solana: payment URIs, and supports Escape / click-away / Cancel to dismiss; the button hides itself on unsupported browsers
- Max button that sweeps the full balance — on SOL the server holds back rent plus network-fee headroom so the wallet can never be bricked by its own sweep
- Client-side validation: positive amounts only, amount cannot exceed the available balance, destination must resolve
- Two-step flow: a review/confirm screen summarizing asset, amount, destination, and network before anything is submitted
- Live allowlist badge on the confirm screen: '✓ allowlisted' or '⚠ not on allowlist — this will be rejected' before you even press Confirm
- Irreversibility warning on every confirmation: crypto transfers are final
- Risk-acknowledgment gate before any mainnet withdrawal (with a graceful fallback prompt if the dialog module fails to load); devnet skips it
- Single-use CSRF token on every state-changing request — the server burns each token on use
- Idempotency key generated per withdrawal so retries replay the original result instead of double-sending; an in-flight duplicate returns 'withdrawal in progress'
- Success screen distinguishing 'Withdrawal confirmed' (✓) from 'Withdrawal submitted' (⏳, submitted but not yet confirmed) with matching guidance
- View-on-explorer link for every completed or pending withdrawal, plus a 'Withdraw more' reset button
- Empty state pointing you to the Deposit tab when the wallet holds nothing withdrawable on the selected network
- Skeleton loading states, designed error states with a reason line, and Retry buttons on every data load
- Devnet/mainnet network switch awareness — changing networks resets the form and reloads holdings and limits
- Limits & Safety: one-tap Freeze wallet button that immediately pauses all autonomous spending (trades, snipes, x402 payments) while keeping withdrawals open; unfreezing asks for confirmation since it re-arms spending
- Frozen/active status card with clear copy explaining exactly what a freeze does
- Spent-today chip showing rolling 24-hour USD outflow, with an alert style when the daily cap is reached
- Daily USD spend cap and per-transaction USD cap editors — leave blank for no limit; the ceilings govern every outbound path: trades, snipes, x402 payments, and withdrawals
- Withdraw allowlist editor: add addresses or .sol names (resolved before adding), remove entries with one click, deduplicated, capped at 50 entries; empty list means any valid address
- Server-side allowlist validation on save — an invalid address is rejected with a clear message instead of silently dropped
- Activity: the custody audit trail — withdrawals, trades, snipes, x402 payments, limit changes, and key-recovery events, each with icon, timestamp, amount (SOL or USD), shortened destination, status, and an explorer link
- Policy-block rows in the activity feed that quote the exact plain-English rule that stopped a payment: 'Blocked by your rule', 'Frozen by your rule', 'Needs your approval', 'Auto-frozen by policy', 'Spend policy updated'
- Cursor-based pagination in the activity feed with a 'Load older' button (25 events per page)
- Toast notifications for confirmed withdrawals, saved limits, and freeze/unfreeze
- Server-side destination checks: valid base58, on-curve only (program addresses where funds could be lost forever are rejected), and never the agent wallet itself
- Automatic recipient token-account creation on SPL withdrawals, with an upfront check that the wallet holds enough SOL for the fee and rent
- USD pricing for the spend ceiling: SOL priced live, USDC priced 1:1; unpriced tokens are governed by the allowlist instead
- Reduced-motion support: spinners and skeletons stop animating when the user prefers reduced motion
- Full keyboard and screen-reader support: focus rings, aria-pressed sub-tabs, live-region status for address resolution, labeled remove buttons

## Guardrails & safety

Owner-only end to end: every endpoint verifies the signed-in user owns the agent. Withdrawals are capped at 5 per day per user with an additional per-IP burst guard. Every state-changing request requires a single-use CSRF token, and mainnet withdrawals require an explicit risk acknowledgment. The server enforces the shared spend policy before signing: withdraw allowlist (if set, funds can only go to approved addresses), per-transaction and rolling 24-hour USD ceilings, the owner's plain-English safety rules enforced deterministically, and a behavioral anomaly guard that can auto-freeze the wallet. The freeze switch halts all autonomous spending but deliberately never blocks the owner's withdrawals — a freeze can never trap funds. Destinations must be valid, on-curve addresses and cannot be the wallet itself. SOL sweeps always reserve rent plus fees so the account survives. Idempotency keys make retries safe against double-sends, ambiguous confirmations return a pending state with an explorer link instead of guessing, and every withdrawal, key decryption, limit change, and policy block lands in an owner-visible audit ledger.

## Screenshot-worthy (shot list)

- The confirm screen warns you before the server does: if a destination isn't on your allowlist, a live '⚠ not on allowlist — this will be rejected' badge appears right next to the address
- The one-tap Freeze wallet panel — a kill switch that instantly pauses all of the agent's autonomous trading and payments while your own exit stays open
- The Activity feed showing a payment stopped cold with 'Blocked by your rule' and the exact plain-English rule you wrote, quoted inline

## API surface

- `POST /api/agents/:id/solana/withdraw`
- `GET /api/agents/:id/solana/holdings`
- `GET /api/agents/:id/solana/limits`
- `PUT /api/agents/:id/solana/limits`
- `GET /api/agents/:id/solana/custody`
- `GET /api/sns?name=<name>.sol`
