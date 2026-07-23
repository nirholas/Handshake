# OKX.AI Launch: Work Orders

Sequenced, self-contained prompts to take "three.ws 3D Studio" (agent #2632) from
**rejected listing** to **approved, selling, best-in-category ASP** on OKX.AI. Each file is
designed to be pasted/run in a fresh chat; each starts by reading `00-CONTEXT.md` (shared
facts) and ends by appending to `PROGRESS.md` (the cross-chat handoff log).

## Why this exists

- Listing #2632 was rejected 2026-07-04: our A2MCP endpoint doesn't implement the OKX Agent
  Payments Protocol (we emit x402 for Solana/Base/BSC rails, no X Layer/OKX rail).
- Live marketplace pull (2026-07-06) shows the 3D category is EMPTY and the winning seller
  pattern is many micro-priced A2MCP endpoints + free discovery. Big opportunity, clear
  playbook.

## Run order

| Order | File | What it does | Needs human for |
|---|---|---|---|
| 1 | `01-protocol-research.md` | Pin the seller-side payments spec from primary sources + live captures | OTP login; maybe dust funding |
| 2 | `02-payments-integration.md` | Implement the OKX rail on our endpoint, tested | possibly `vercel env` values |
| 3 | `03-service-decomposition.md` | Split into micro-priced services + free catalog |, |
| 4 | `04-e2e-real-payment-test.md` | Pay ourselves for real; settlement + adversarial gauntlet | **wallet funding**, OTP |
| 5 | `05-relisting-resubmission.md` | Update #2632 + resubmit for review | OTP; confirm on-chain writes |
| 6 | `06-agent-pfp-wedge.md` | "Agent Identity Studio", avatars for OKX agents (parallel after 02) | funding for test buys |
| 7 | `07-final-audit-and-watch.md` | Adversarial re-audit, docs closure, approval watch, launch runbook | OTP |

Strict chain: 01 → 02 → 03 → 04 → 05 → 07. 06 can run any time after 02.

## Ground rules baked into every order

- CLAUDE.md governs: no mocks, no stubs, no "good enough"; real APIs, real payments, docs
  ship with the feature.
- Owner has pre-authorized OKX/X Layer/fee-token references for commits in this stream
  (details in `00-CONTEXT.md` rule 2).
- Real money on request: work orders compute exact funding needs and pause for the owner.
- Never deactivate/delete agent #2632, all changes via update + re-activate.
- `PROGRESS.md` is the only memory between chats. Write it like the next agent knows nothing.
