# 17 · Policy

> Write your agent's spending rules in plain English — AI translates them, deterministic code enforces them on every single spend.

*One of the 23 abilities of the [Agent Wallet](../chapters/10-the-agent-wallet.md) — the money layer of a three.ws agent.*

## What it does

The Policy tab lets a wallet owner govern their AI agent's money the way they'd explain it to a person: type "Block any payment over $25, never let the wallet drop below 1 SOL, and freeze everything if a trade drops more than 30%" and hit Compile. The platform turns that sentence into numbered, enforceable rules and reads them back in plain English so you confirm exactly what will be enforced. Before you save, it backtests the rules against your agent's real spending history — "against your last 47 spends, this would have blocked 3 ($61)" — or, with no history yet, shows how hypothetical cases like "a $250 payment" or "buying a 30-minute-old token" would be decided. Once saved, the rules run on every trade, snipe, service payment, and withdrawal the agent makes; the AI only translates and explains — it never approves a payment.

## How it works

The tab talks to an owner-gated policy endpoint on the agent's custodial Solana wallet. On compile, the server sends the English through the platform's free-first LLM chain (Groq/OpenRouter/NVIDIA free tiers, Claude/OpenAI as last resort) with a strict JSON-only prompt, then hard-validates the output against a bounded rule DSL — anything unenforceable is dropped, and a real deterministic phrase parser takes over if no model is available, so compiling always works. Rules are an ordered first-match firewall (allow / block / ask-me / freeze) over twelve live signals like amount, rolling daily total, token age, SOL reserve after the spend, trade P&L, time of day, and whether the recipient has been paid before. The backtest replays up to 60 days of real custody spend events through the exact evaluator that runs in production, including faithful rolling 24-hour totals. Saving writes the policy to the agent record with a full audit diff; at runtime the shared spend guards evaluate it on every outbound path, log every block with the human-readable rule that fired, and a freeze rule automatically trips the wallet's kill-switch.

## Every feature

- Plain-English policy composer: free-text rules compiled into a deterministic rule document
- Three one-click starter presets: Conservative, Active trader, and Pay-only
- Compile & preview button with real async state; Cmd/Ctrl+Enter keyboard shortcut to compile
- Numbered plain-English readback generated from the compiled rules themselves, so it can never drift from what code enforces
- Per-rule action tags: Block, Freeze, Allow, and Ask me (require step-up approval)
- Assumptions callout listing anything the AI defaulted, inferred, or couldn't capture
- Backtest against real spend history (last 60 days, up to 1,000 spends) run by the exact production evaluator
- Backtest summary chips: allowed vs blocked counts with USD totals for each
- Green/red proportion bar visualizing the allow/block split
- Per-spend timeline: one square per historical spend (up to 120, newest first) with hover tooltips showing type, amount, date, and the rule that would have blocked it
- Per-rule attribution list showing which rule blocked how many spends and how much USD
- Synthetic 'How it behaves' probes when there's no history yet: up to 8 hypothetical cases derived from the policy's own thresholds (e.g. 'A $250 payment → Blocked', 'Buying a 30-minute-old token → Blocked')
- Explicit Save / Discard flow — nothing is enforced until the owner reviews and saves
- Loosening guard: a confirmation dialog before saving a policy that removes protections the wallet has now
- 'Remove all rules' action with confirmation; numeric caps and the freeze switch stay in place
- Active-policy card showing the live rule count, the numbered rules, and cap chips (daily cap, per-tx cap, frozen/active status)
- Cross-link to Withdraw → Limits & Safety for the always-enforced numeric caps
- Network-aware: policy, history, and backtest load per network (mainnet/devnet) and refresh on network switch
- Draft box pre-filled with the saved policy's original English for easy editing
- Four rule actions: allow (whitelist carve-out), block, require step-up (ask the owner), freeze (block + trip the wallet kill-switch)
- Twelve condition signals: spend amount (USD), today's spend so far, today's running total, token age in hours, SOL left after the spend, trade profit/loss %, hour of day (UTC), asset, recipient address, spend type (trade/snipe/x402 payment/withdraw), allowlist membership, and recipient-seen-before
- Ordered first-match firewall semantics with AND-combined clauses per rule; no match means allowed (numeric caps still apply)
- Deterministic fallback parser compiles common phrasings even with no AI model configured (marked 'parsed locally' in the preview)
- Freeze rules automatically trip the wallet's kill-switch when they fire live, pausing all autonomous spending
- Every live block is recorded to the wallet's custody feed with the exact human-readable rule that stopped it
- Every policy change is audited with a before/after diff written to the custody log
- Signed-out state with a sign-in link that returns to the tab; skeleton loading, retry-able errors, refusal vs error styling, and toasts
- Accessible throughout: ARIA roles and labels, focus rings, reduced-motion support

## Guardrails & safety

Owner-only end to end: the tab is hidden from non-owner viewers and the server independently verifies session auth plus agent ownership (401/403 otherwise), with rate limiting on every call. Saving or clearing rules requires a CSRF token. The AI never decides a spend — its output is hard-validated and only the normalized, enforceable rules are ever stored or run; if nothing survives validation the save is refused rather than silently storing an empty policy. Policies are bounded (max 40 rules, 8 conditions each) and a rule with no valid conditions is dropped so a typo can never brick all spending. Policy rules layer on top of the always-enforced numeric caps, withdraw allowlist, and freeze switch — they can tighten but never weaken them. Saving a policy that removes existing protections requires an explicit confirmation, as does removing all rules. At runtime, if the safety check itself can't complete, autonomous spends fail safe to blocked while the owner's own withdrawals are never trapped; every block and every auto-freeze is written to the audit trail.

## Screenshot-worthy (shot list)

- The backtest timeline: a row of green and red squares — one per real past spend — scored by the exact evaluator that will run live, with headline chips like '47 allowed · $312' vs '3 blocked · $61'
- One sentence in, a numbered firewall out: 'stop everything if a trade drops more than 30%' becomes rule #4 with a Freeze tag that literally trips the wallet's kill-switch on-chain activity
- The readback + assumptions card: the platform explains every rule back in plain English and openly lists what it assumed, so the owner confirms intent before anything is enforced

## API surface

- `GET /api/agents/:id/solana/policy?network= — current compiled policy, plain-English readback, source text, numeric limits`
- `POST /api/agents/:id/solana/policy {op:'compile', text} — LLM/heuristic compile + backtest + synthetic probes`
- `POST /api/agents/:id/solana/policy {op:'backtest', rules} — replay a rule set against real custody history`
- `PUT /api/agents/:id/solana/policy {rules, english} — save the validated policy (CSRF-gated, audited)`
