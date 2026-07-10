# 15 · Pay

> Your agent shops the open x402 economy: find any paid API, see its live price, and settle it in USDC from the agent's own Solana wallet — receipt on-chain in seconds.

## What it does

The Pay tab turns an agent's wallet into a checkout for the machine economy. Owners search a live marketplace of paid x402 services — data feeds, intel, APIs — or paste any endpoint URL, and instantly see what it costs in USDC before committing a cent. One click pays the service straight from the agent's own Solana wallet, with the payment lifecycle streaming live on screen and ending in an on-chain receipt plus the service's actual response. Every spend lands in a permanent, auditable payment history: what was paid, to whom, for what, and when.

## How it works

Search hits a server-side aggregator that pulls and merges live service catalogs from public x402 facilitators (PayAI and Coinbase's CDP), ranks them against the query, and returns only Solana-payable entries. Selecting a service triggers a preview call: the server probes the endpoint, reads its 402 payment challenge, verifies it asks for USDC on Solana, and returns the live price and recipient — without moving funds or touching keys. On confirm, the server decrypts the agent's custodial Solana keypair (an audit-logged event), atomically reserves the spend against the agent's policy caps, builds and signs a real USDC transfer on Solana mainnet, and presents it to the service as an x402 payment header; the service verifies and settles it on-chain. The whole lifecycle streams back to the browser as live events, and the finished payment — signature, USD value, destination, service name — is written to the agent's custody ledger, which also powers the tab's activity feed. Balances shown are genuine on-chain reads of the wallet's SOL and token accounts.

## Every feature

- Live bazaar search with 350ms debounce-as-you-type plus an explicit Search button, querying the merged x402 service catalog
- Results filtered to services actually payable in Solana USDC (entries without a Solana payment option are hidden)
- Service cards showing name, description, host domain, and live price label, each with a one-click Pay button
- Paste-an-endpoint mode: enter any arbitrary URL to pay an x402 service that isn't in the bazaar, with URL validation (full https/http URLs only)
- Pre-payment preview sheet fetching the live price and the agent's USDC balance in parallel: price in USDC, recipient address, HTTP method, current agent balance
- Editable JSON request-body editor for POST/PUT/PATCH services, pre-filled with the service's example payload
- Free-endpoint detection: if the endpoint answers without asking for payment, the tab says there's nothing to pay and stops
- Not-payable detection with a plain-language reason: lists which other networks the service accepts, or explains a missing Solana fee payer
- Insufficient-funds guard: compares price against balance, disables the Pay button, states exactly how short the wallet is, surfaces the deposit address with a copy button, and a 'Fund wallet →' shortcut that jumps to the Deposit tab
- Risk-acknowledgment dialog gating every payment (with a native-confirm fallback if the dialog module can't load)
- Live streamed payment timeline: Submitting → Price confirmed (with the exact USDC amount) → Payment signed by agent wallet → Settled on-chain (with the transaction signature), rendered as checkmark steps with a spinner on the active step
- Green receipt card after settlement: amount paid, recipient, and the transaction signature linked to the Solscan explorer
- The purchased service's actual response rendered inline in the receipt (truncated past 1,500 characters)
- 'Pay another' one-click return to the service list
- Payment activity feed: the agent's last 25 x402 payments from the custody ledger — service name, destination address, time-ago, status (pending highlighted), USD amount, and explorer-linked signature
- Instant post-payment refresh: balance and activity list update immediately so the spend is visible right away
- Devnet awareness: if the hub's network toggle is on devnet, a note warns that x402 settles on Solana mainnet from the agent's mainnet USDC
- Owner-only tab: hidden entirely from visitors viewing someone else's agent
- Designed error states with Retry buttons on search, preview, payment, and activity; skeleton loading states; reduced-motion support; keyboard focus rings and ARIA live regions
- Agent-wallet isolation: every payment is signed by the agent's own custodial Solana wallet, never a shared platform wallet — a request without an agent context is refused
- Per-agent spend policy enforced before signing: rolling 24-hour daily USD cap and per-transaction USD cap, reserved atomically so simultaneous payments can't overshoot the limit
- Wallet freeze kill switch: a frozen wallet rejects every autonomous payment instantly
- Scoped session-key capabilities: spending can be leashed to specific service hosts under least-privilege rules
- Natural-language spend policy rules and a behavioral anomaly guard that can auto-freeze the wallet on suspicious outflows
- USDC-only asset pinning: a service demanding payment in any other token is refused outright, blocking a wallet-drain attack
- Server-side URL hardening: public-https-only fetches, private-network addresses blocked, connections pinned against DNS tricks, redirects never followed
- Honest failure messaging: errors distinguish 'no funds were transferred' from 'settlement uncertain — check activity before retrying to avoid paying twice'
- Every payment lands in the agent's permanent custody ledger with the service name, URL, destination, USD value, and transaction signature — a full audit trail
- Per-IP and global rate limiting plus single-use CSRF protection on the money-moving path (price previews never burn a token)

## Guardrails & safety

Owner-only tab, gated end to end: the caller must be signed in and must own the agent, and the payment is signed exclusively by that agent's own custodial wallet — the shared platform wallet is never used, and a request without an agent context is rejected. A risk-acknowledgment dialog precedes every payment, and the money-moving call requires a single-use CSRF token. Before any signature, the per-agent spend policy is enforced atomically: rolling 24-hour daily USD cap, per-transaction USD cap, wallet freeze kill switch, scoped per-service capabilities, natural-language policy rules, and a behavioral anomaly detector that can auto-freeze the wallet — a breach moves no funds. The asset is pinned to USDC (any service demanding a different token is refused, closing a wallet-drain vector), target URLs are hardened against internal-network access, and if the wallet can't cover the price the Pay button is disabled and the owner is routed to funding instead. Failures state honestly whether funds moved, pre-settlement rejections release their spend reservation, uncertain outcomes conservatively count as spent, and every payment is written to a permanent, owner-auditable custody ledger.

## Screenshot-worthy (shot list)

- The live payment timeline: press Pay and watch four steps light up in real time — price confirmed, payment signed by the agent's wallet, settled on-chain with the transaction signature — ending in a green receipt with a Solscan link and the service's actual response.
- The bazaar search: type 'weather' or 'intel' and real paid APIs from across the open x402 economy appear with live USDC prices, each one payable in a single click from the agent's own wallet.
- The funding-aware guard: when the agent is short, the tab shows exactly how much it holds versus the price, hands you the deposit address with one-tap copy, and routes you straight to funding instead of letting a doomed payment fire.

## API surface

- `GET /api/bazaar/search (aggregated x402 service catalog from public facilitators — PayAI + Coinbase CDP — filtered to Solana-payable)`
- `POST /api/x402-pay with preview:true (live price probe — no funds move, no key signs)`
- `POST /api/x402-pay streamed as Server-Sent Events (the real payment: challenge → built → settled → result)`
- `GET /api/agents/:id/solana/holdings (live on-chain SOL + SPL token balances, USDC flagged)`
- `GET /api/agents/:id/solana/custody?category=x402 (owner-only payment history from the custody ledger)`
