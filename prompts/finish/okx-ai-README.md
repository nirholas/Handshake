# OKX.AI Launch: Work Orders

Sequenced, self-contained prompts to take "three.ws 3D Studio" (agent #2632) from
**rejected listing** to **approved, selling, best-in-category ASP** on OKX.AI. Each file is
designed to be pasted/run in a fresh chat; each starts by reading `okx-ai-00-CONTEXT.md` (shared
facts) and ends by appending to `okx-ai-PROGRESS.md` (the cross-chat handoff log).

## Why this exists

- Listing #2632 was rejected 2026-07-04: our A2MCP endpoint doesn't implement the OKX Agent
  Payments Protocol (we emit x402 for Solana/Base/BSC rails, no X Layer/OKX rail).
- Live marketplace pull (2026-07-06) shows the 3D category is EMPTY and the winning seller
  pattern is many micro-priced A2MCP endpoints + free discovery. Big opportunity, clear
  playbook.

## Run order

| Order | File | What it does | Needs human for |
|---|---|---|---|
| 1 | `01-protocol-research.md` (retired: completed, in git history) | Pin the seller-side payments spec from primary sources + live captures | done |
| 2 | `02-payments-integration.md` (retired: completed, in git history) | Implement the OKX rail on our endpoint, tested | done |
| 3 | `03-service-decomposition.md` (retired: completed, in git history) | Split into micro-priced services + free catalog | done |
| 4 | [04-e2e-real-payment-test.md](okx-ai-04-e2e-real-payment-test.md) | Pay ourselves for real; settlement + adversarial gauntlet | **wallet funding**, OTP |
| 5 | [05-relisting-resubmission.md](okx-ai-05-relisting-resubmission.md) | Update #2632 + resubmit for review | OTP; confirm the on-chain write |
| 6 | `06-agent-pfp-wedge.md` (retired 2026-08-01, verified shipped: `identity-studio` in `api/_lib/okx-catalog.js`, `api/_okx3d/identity.js`, the `/agent-identities` showcase in `data/pages.json`, `docs/agent-identities.md`) | "Agent Identity Studio", 3D avatars for OKX agents | done |
| 7 | [07-final-audit-and-watch.md](okx-ai-07-final-audit-and-watch.md) | Adversarial re-audit, docs closure, approval watch, launch execution | OTP |

Strict chain: 04, then 05, then 07. Each file is self-contained; paste it into a fresh chat.

Both remaining human touchpoints are batched into one message per work order: the email OTP for
`claude@three.ws`, and an explicit yes on any real payment. Everything else runs autonomously.

## Ground rules baked into every order

- CLAUDE.md governs: no mocks, no stubs, no "good enough"; real APIs, real payments, docs
  ship with the feature.
- Owner has pre-authorized OKX/X Layer/fee-token references for commits in this stream
  (details in `okx-ai-00-CONTEXT.md` rule 2).
- Real money on request: work orders compute exact funding needs and pause for the owner.
- Never deactivate/delete agent #2632, all changes via update + re-activate.
- `okx-ai-PROGRESS.md` is the only memory between chats. Write it like the next agent knows nothing.

## Retire this file when the campaign is done (required)

This file is shared context rather than a single order, so it outlives the
prompts that cite it. Delete it in the commit that closes the LAST prompt of
this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'okx-ai-README' prompts/finish/
       git rm prompts/finish/okx-ai-README.md

While any sibling prompt of this campaign is still on disk, leave this file in
place and keep it accurate instead. The shrinking directory is the only signal
to the next agent that a campaign is closed.
