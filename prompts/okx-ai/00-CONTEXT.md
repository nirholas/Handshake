# OKX.AI Launch — Shared Context (read this FIRST, every prompt requires it)

You are working on getting **three.ws listed and selling on OKX.AI**, OKX's on-chain agent
marketplace (agents hire agents; payments settle on X Layer). This file is the single source
of truth for facts every work order depends on. Do not re-derive these; do not contradict them.

## Where we stand (verified on-chain 2026-07-06)

- We registered an ASP (Agent Service Provider) agent: **#2632 "three.ws 3D Studio"**.
- **It was REJECTED** on 2026-07-04. Exact rejection reason from OKX's email:
  > "your A2MCP service has not been integrated with the OKX Agent Payments Protocol standard.
  > Please complete the integration, then resubmit your listing application through your Agent
  > conversation interface."
- On-chain state: `approvalDisplayStatus: 5` ("Listing rejected"), `status: 2` ("not listed"), `soldCount: 0`.

## Hard facts (verified via onchainos CLI)

| Fact | Value |
|---|---|
| Our agent ID | `#2632` |
| Agent name | `three.ws 3D Studio` |
| Owner wallet (X Layer) | `0x75d00a2713565171f33216e5aa2a375e076ecf69` |
| Communication address | `0xfaBDeadF019267576a155E166110eDdA8BeE9729` |
| Agent key UUID | `8848356c-f4a5-418a-a189-6a6ad72c8fdc` |
| Marketplace chain | X Layer, chainId **196** (`eip155:196`) |
| Marketplace fee token | `0x779ded0c9e1022225f8e0630b35a9b54be713736` (verify symbol/decimals in 01) |
| Login email | `claude@three.ws` (email OTP; the human running the chat reads the code) |
| CLI | `onchainos` v4.2.0+ at `~/.local/bin/onchainos` |

## Our existing code (the thing being fixed)

- **A2MCP endpoint**: [api/mcp-3d.js](../../api/mcp-3d.js) — MCP server for the 3D studio, prices
  tool batches via `priceBatch` + `studioX402Amount` ([api/_mcp3d/pricing.js](../../api/_mcp3d/pricing.js)).
- **402 challenge builder**: `paymentRequirements()` in [api/_lib/x402-spec.js](../../api/_lib/x402-spec.js)
  — emits x402 v2 `accepts` entries for **Solana / Base / BSC / Arbitrum via Coinbase/PayAI/CDP
  facilitators. There is NO X Layer entry and NO OKX facilitator entry. This is the exact
  reason we were rejected.**
- Payment helpers: [api/_mcp/payments.js](../../api/_mcp/payments.js) (`send402`, `sendX402Error`),
  settlement via `settlePayment` in x402-spec.js.
- The MCP tools themselves (mesh generation, rigging, retargeting) work and are deployed —
  the rejection is ONLY about the payment rail.

## Client-side protocol knowledge already in this repo

`.claude/skills/okx-agent-payments-protocol/` documents how OKX agents PAY (the buyer side):
- 402 with `PAYMENT-REQUIRED` header = base64 JSON `{x402Version: 2, resource, accepts: [...]}`.
- Schemes: `exact` (EIP-3009 or Permit2), `upto` (requires `accepts[].extra.facilitatorAddress`),
  `aggr_deferred` (TEE session cert), plus `WWW-Authenticate: Payment` charge/session channels.
- Buyers pay via `onchainos payment pay --payload '<raw 402>'` → returns `authorization_header`
  to replay. Settlement is facilitator-mediated.
This tells us the wire shapes OKX buyers can sign. The SELLER-side contract (which facilitator
verifies/settles, exact required fields) is what prompt 01 pins down.

## Competitive intelligence (live marketplace pull, 2026-07-06)

- **3D category is EMPTY.** Query "3D model avatar rendering game asset" → 1 result, a novelty
  trading-card generator. No text→3D, no rigging, no avatars. We would be first and only.
- **The winning pattern** — "Onchain Data Explorer", **174 sales** (most-sold agent found):
  ~19 tiny, sharply-scoped A2MCP endpoints, micro-priced ($0.000015–$0.000075 per call).
  Granular + cheap + composable + free discovery endpoints.
- **The losing pattern** — "TO1 Intelligence": 100+ services sprayed at $0.25 → 0 sales.
- Everything that sells is **A2MCP fixed-price**. A2A "negotiated" listings ≈ 0 sales.
- Creative/media: 2 agents total, both 2D, both 0 sales. Prices $0.5–$1.0.

## Session preflight (run at the start of EVERY work order)

```bash
export PATH="$HOME/.local/bin:$PATH"
onchainos --version   # if missing: install per .claude/skills/okx-agentic-wallet/_shared/preflight.md
onchainos wallet status
```
If not logged in: `onchainos wallet login claude@three.ws --locale en_US`, then ask the human
for the 6-digit OTP from that inbox and run `onchainos wallet verify <otp>`. Never guess codes.

## Operating rules that BIND every work order

1. **CLAUDE.md governs.** Read `/workspaces/three.ws/CLAUDE.md` in full. No mocks, no fake
   data, no TODOs, no stubs, no "good enough".
2. **Commit gate / owner approval:** CLAUDE.md requires owner approval before committing
   content referencing crypto projects other than $THREE. **The owner has explicitly
   authorized this OKX work stream** (these prompt files ARE the owner's directive): OKX,
   OKX.AI, X Layer, chain 196, the marketplace fee token address, OKB, and the OKX Agent
   Payments Protocol may be referenced in code, docs, and commits for this work. Anything
   OUTSIDE that scope (other coins, other projects) still requires asking first.
3. **Real money, real rails.** The owner will fund wallets on request. When funds are needed,
   compute the exact amount + address + chain + token, present it, and pause for funding.
   Never simulate a payment where a real one is specified.
4. **Concurrent agents share this worktree.** Stage explicit paths only (never `git add -A`),
   re-check `git status` before committing.
5. **Push with `git push threews main`** — the only push target (owner decision 2026-07-07).
   Never push, pull, fetch, or merge `threeD` (retired `nirholas/3D-Agent` mirror, diverged history).
6. **`npx vercel build` trap:** it overwrites `api/*.js` in place. If you ran it, check
   `head -1` of changed api files for `__defProp` before committing; recover with
   `git restore -- api/ public/`.
7. **Do not deactivate/delete agent #2632.** All listing changes go through `update` +
   re-activate (resubmission), preserving the agent ID.
8. **Progress log:** append a dated entry to `prompts/okx-ai/PROGRESS.md` when you finish
   (create it if absent): what you did, what you verified, what's blocked, what's next.
   The next work order's chat has no memory of yours — this file is the handoff.

## Work-order sequence

| # | File | Depends on |
|---|---|---|
| 01 | `01-protocol-research.md` — pin down the seller-side OKX payments spec | — |
| 02 | `02-payments-integration.md` — implement OKX rail on our endpoint | 01 |
| 03 | `03-service-decomposition.md` — split into micro-priced A2MCP services | 02 |
| 04 | `04-e2e-real-payment-test.md` — pay ourselves for real, verify settlement | 02, 03 |
| 05 | `05-relisting-resubmission.md` — update #2632 + resubmit for review | 04 |
| 06 | `06-agent-pfp-wedge.md` — the "avatars for OKX agents" flagship service | 02 (parallel ok) |
| 07 | `07-final-audit-and-watch.md` — full audit, docs closure, approval watch | all |
