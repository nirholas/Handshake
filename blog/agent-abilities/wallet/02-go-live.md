# 02 · Go Live

> One tap sends real SOL from the three.ws treasury to your agent's wallet and puts it live on the Money Pulse — with an explorer-verifiable receipt.

*One of the 23 abilities of the [Agent Wallet](../chapters/10-the-agent-wallet.md) — the money layer of a three.ws agent.*

## What it does

Every freshly created agent has a wallet that starts at zero — it can't make its first move, so it never shows up as active anywhere. Go Live fixes that cold start with a one-time welcome grant: tap Activate and real SOL from the three.ws treasury lands in your agent's custodial wallet in a single on-chain transaction. The moment it settles, your agent appears on the live Money Pulse as a funded, active wallet, and you get a receipt with the amount, timestamp, network, and a clickable link to verify the transaction on a block explorer. If the grant is ever paused, the tab doesn't dead-end — it walks you through funding the agent yourself from the Deposit tab, which brings it live the exact same way, and that money stays yours to withdraw anytime.

## How it works

The tab reads an activation-status endpoint that decides which of seven designed states to render: loading skeleton, eligible hero, activating in-flight, live receipt, pending settlement, already-live platform agent, or grant-paused. Clicking Activate posts to the activation endpoint, which claims a one-grant-per-agent slot in a database ledger (the primary key acts as a mutex, so concurrent clicks can never double-spend), lazily provisions the agent's custodial Solana wallet if it doesn't exist yet, verifies the treasury balance covers the grant plus a fee buffer, then signs and broadcasts a real SOL transfer from the platform treasury — with an automatic retry on an expired blockhash and a chain probe on ambiguous timeouts so a landed transaction is never re-granted. The confirmed transfer is recorded as a genuine inbound tip custody event (that record is what puts the agent on the Money Pulse and in active-wallet counts), priced in USD at the live SOL rate, announced on the platform's live ticker, and pushed to the owner as a notification. Activation also registers the agent's wallet as its default payout destination so it can earn from marketplace buyers immediately, and stamps the owner's account-level "first win" milestone, which triggers the two-sided referral reward if the owner was referred.

## Every feature

- One-time, real, on-chain SOL welcome grant from the platform treasury (default 0.004 SOL, operator-configurable, hard-bounded to 0.0001–0.05 SOL)
- Single-tap Activate hero CTA personalized with the agent's name
- Grant-amount pill showing exactly how much SOL you'll receive before claiming
- Three-point value checklist: funds the wallet, goes live on the Money Pulse, one-time and explorer-verifiable
- In-flight activating state — CTA disables and shows a spinner while the grant broadcasts
- On-chain receipt card after activation: grant amount in SOL, timestamp, network, and truncated transaction signature linked to a block explorer
- Green pulsing Live badge on activated agents
- What-next actions on the receipt: jump to the Money Pulse, open the agent's wallet story, or add more funds via Deposit
- Pending state for a concurrent claim still settling, with a Refresh-status button
- Platform-agent state: platform-operated agents show as already live and are excluded from the grant
- Grant-paused fallback state that pitches the self-funding path — depositing your own SOL reaches the identical outcome, and it remains withdrawable
- Loading skeleton with reduced-motion support and full keyboard/focus states
- Toast confirmations: fresh grant amount announced, or 'already live' on a repeat claim
- Owner-only tab — hidden entirely from read-only viewers of an agent's wallet
- Idempotent claiming: activating twice returns the original receipt, never a second grant
- Automatic custodial wallet provisioning if the agent doesn't have one yet (with an audit trail)
- Grant recorded as a genuine inbound tip, instantly counting the agent as active on the Money Pulse and in tip stats
- Live USD valuation of the grant at the current SOL price
- Platform-wide live-ticker announcement plus an owner notification when an agent goes live
- Auto-registers the agent's wallet as its default payout destination so listed skills can earn from real buyers immediately
- Stamps the owner's first-win activation milestone, firing the two-sided referral reward for referred accounts
- Runs on Solana mainnet (devnet switchable by operator config), noted right under the CTA
- Distinct, recoverable error messages per failure mode: grant paused, daily cap reached, transfer failed — each pointing to a working alternative
- Works via browser session or API bearer token, so agents can be activated programmatically with the right write scope
- Responsive receipt layout — two-column grid collapses to one column on small screens

## Guardrails & safety

Owner-only end to end: the tab is hidden from non-owners and the server rejects claims from anyone but the agent's owner (bearer-token callers additionally need the write scope, and every claim requires a CSRF token plus per-user/IP rate limiting). Exactly one grant per agent, enforced at the database level — the ledger's primary key with an insert-if-absent claim acts as a mutex, so concurrent double-clicks cannot double-spend. A rolling 24-hour platform-wide cap (default 500 grants/day, counting in-flight claims) bounds total treasury spend, and the grant size itself is hard-clamped to 0.0001–0.05 SOL regardless of configuration. The whole feature is inert unless explicitly enabled AND a treasury key is configured. The treasury balance is pre-checked with a fee buffer so a dry treasury pauses cleanly instead of failing mid-send. On an ambiguous send timeout, the claim stays locked and the chain is probed before any retry is allowed — a transaction that actually landed can never be granted twice. Platform-operated agents are excluded from claiming.

## Screenshot-worthy (shot list)

- The live receipt card: a green pulsing Live badge over a clean grid showing the SOL grant, the timestamp, the network, and a clickable transaction signature that opens the block explorer — on-screen proof the grant is real money on Solana mainnet.
- The hero moment: 'Bring [your agent] to life' with the grant amount in a monospace pill and a single Activate button — one tap from empty wallet to live, funded agent.
- The payoff handoff: the success toast fires with the granted amount, and one click lands on the Money Pulse where the newly activated agent is beating in the platform-wide live feed of real on-chain activity.

## API surface

- `GET /api/agents/:id/activate`
- `POST /api/agents/:id/activate`
- `GET /api/csrf-token`
