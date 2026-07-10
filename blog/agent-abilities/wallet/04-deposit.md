# 04 · Deposit

> Fund any agent in one scan — a tap-to-pay Solana QR with live on-chain confirmation the second the money lands.

*One of the 23 abilities of the [Agent Wallet](../chapters/10-the-agent-wallet.md) — the money layer of a three.ws agent.*

## What it does

The Deposit tab is the "fund this agent" page anyone can use — owner or visitor. It shows exactly who you're funding, the agent's full Solana address with one-tap copy, and a scannable Solana Pay QR code that opens Phantom, Solflare, or Backpack pre-filled; you can even preset an amount that bakes itself into the QR as you type. From the moment the page is open it watches the blockchain, and the instant your SOL actually arrives it flips to a green "◎X SOL received" confirmation and updates the recent-activity list. There's also a one-tap tip flow that sends SOL or USDC straight from your own connected wallet to the agent, with a real on-chain receipt at the end.

## How it works

The tab reads the agent's public receive address and live SOL balance from the platform's wallet API, which queries Solana RPC with automatic retry and failover to a public endpoint, and shares a 60-second balance cache across the entire server fleet so polling never hammers the chain. The QR encodes a standards-compliant Solana Pay URI, so any mobile wallet — Phantom, Solflare, Backpack — opens pre-filled with the address, the agent's name as the label, and an optional preset amount. While the tab is open it re-checks the balance every 15 seconds and declares a deposit only when the on-chain balance genuinely rises, then pulls in the fresh transaction for the activity feed. Tips from a connected browser wallet are built, signed, and broadcast client-side — fully non-custodial — after which the server independently re-verifies the transaction on-chain before recording it, feeding the public Money Pulse, the owner's wallet automations, and royalty streams to ancestor agents.

## Every feature

- Public, visitor-safe surface: anyone can fund any agent — the tab is visible to owners and visitors alike, with zero secrets or management controls on it
- "You're funding <agent>" identity header with the agent's name and avatar so the sender always knows exactly whose wallet they're paying
- Solana Pay QR code encoding solana:<address>?label=<agent>[&amount=…], generated entirely first-party as a crisp, infinitely-scalable SVG — no third-party CDN or QR library
- Tappable QR: the code itself is a live solana: deep-link, so tapping it on a phone opens Phantom, Solflare, Backpack, or any Solana wallet pre-filled
- "Open in a wallet app" deep-link button firing the same solana: URI
- Optional amount field (SOL) that live-rewrites both the QR and the deep-link with a preset ?amount=, debounced so fast typing stays smooth
- Amount validation with an inline hint — invalid or non-positive input warns the sender and the QR safely falls back to address-only until fixed
- Full wallet address shown untruncated with one-tap "Copy address" and toast confirmation (with a legacy-browser clipboard fallback)
- Block-explorer link for the receive address (Solscan on mainnet, Solana Explorer on devnet)
- "Tip from your wallet" button opening the shared non-custodial tip modal — funds go straight from the visitor's connected browser wallet to the agent; the platform never holds them
- Tip modal token toggle: SOL or USDC, with agents that advertise a preferred payment token automatically flipping the modal into "Pay" mode defaulting to USDC
- Tip presets: one-tap chips for ◎0.05 / 0.1 / 0.25 / 1 SOL or $1 / 5 / 10 / 25 USDC, plus a free-form amount field
- Honest send lifecycle in the tip modal — connecting, preparing, approve-in-wallet, broadcasting, confirming — each label tied to a real step, ending with an on-chain receipt link and a "Tip again" shortcut
- Live "funds received" confirmation: the tab polls the real on-chain balance every 15 seconds and flips to a glowing green "◎X SOL received" the moment the balance rises — never simulated
- Pulsing amber "Waiting for your first deposit…" status while listening, with an aria-live region so screen readers hear the confirmation too
- Toast notification the instant a deposit lands
- Deposit counter — a second deposit reads "That's deposit #2", and the success message points the sender onward to the Balance and Trade tabs
- Recent activity feed (last 8 transactions) with explorer-linked signatures, human summaries, time-ago stamps, green/red +/- SOL deltas, and failed-transaction marking — auto-refreshed the moment a new deposit is detected
- Mainnet/Devnet network switch support: switching clusters resets the confirmation baseline, relabels the address ("· Devnet"), and re-targets explorer links
- Every state designed: loading skeleton, "wallet is being prepared" empty state with a Refresh button, waiting, received, and an RPC-unreachable "Live confirmation paused" state that keeps the address and QR fully usable while retrying automatically
- Polling pauses when the tab is hidden and resumes on show — no wasted requests in the background
- After a tip is sent from the modal, the tab immediately re-baselines and re-polls so the balance reflects the gift
- Accessibility throughout: ARIA labels on the QR and buttons, focus rings, keyboard-reachable controls, and full prefers-reduced-motion support
- Server-side: public no-sign-in balance reads, a shared 60-second balance cache across the whole server fleet, RPC calls with exponential-backoff retry plus automatic public-RPC failover, and rate-limit-aware error reporting
- Recorded tips flow into the platform: they enter the public Money Pulse feed, can trigger the owner's Wallet Intents automations (tip-back, income splits, notifications), write patron relationship memories the agent greets supporters with, and stream fork royalties to ancestor agents

## Guardrails & safety

Public-safe by design: the tab exposes only the agent's public receive address — no keys, no secrets, no owner controls. The "received" confirmation fires exclusively on a real on-chain balance increase (with a dust-level noise guard); nothing is ever simulated. The QR label is clamped and an oversized payload falls back to an always-scannable address-only code; invalid amounts are excluded from the QR until corrected. Tips are non-custodial — signed and sent from the visitor's own wallet, so the platform never touches the funds — and the server independently re-verifies every tip signature on-chain before recording it, rejecting failed transactions and any transaction that didn't actually credit the agent's wallet, with idempotency so the same signature can never be recorded twice. Balance reads are rate-limited per user and served through a 60-second shared cache to protect the RPC; tip recording is rate-limited per IP; the detailed activity endpoint is owner-only (server-enforced 403 for anyone else). Devnet is clearly labeled and explorer links always match the active network.

## Screenshot-worthy (shot list)

- The Solana Pay QR card: a crisp white QR generated entirely in-house as SVG that is itself a tap-to-pay deep link — type an amount and watch the code redraw live to preset it in the sender's wallet app
- The confirmation moment: a pulsing amber "Waiting for your first deposit…" flips to a glowing green "◎0.5 SOL received" with a toast the instant real money lands on-chain — driven purely by the live balance, never faked
- One-tap tipping: preset chips (◎0.05 to $25), an honest stage-by-stage send flow (approve in your wallet → broadcasting → confirming), and a real Solscan receipt at the end

## API surface

- `GET /api/agents/:id/solana?network= — public, no-auth wallet read: agent's Solana address + live SOL balance (60s fleet-wide cache, RPC failover)`
- `GET /api/agents/:id/solana/activity?network=&limit= — recent on-chain signatures with per-tx SOL deltas and summaries (owner-authenticated)`
- `POST /api/agents/:id/solana/tip — records a confirmed browser-wallet tip after independent on-chain re-verification of the signature`
