# Work Order 04 — End-to-end REAL payment test (we pay ourselves and verify settlement)

Read `prompts/okx-ai/00-CONTEXT.md`, `specs/okx-agent-payments.md`, and
`prompts/okx-ai/PROGRESS.md` (02 + 03 must be done). Read `/workspaces/three.ws/CLAUDE.md`.

## Mission

Before resubmitting the listing, prove the whole machine with real money: act as an OKX
buyer agent, pay our own endpoint through the OKX Agent Payments Protocol on X Layer,
receive the artifact, and confirm settlement landed in our wallet on-chain. If OKX's
reviewer does exactly this and anything breaks, we get rejected again — so we do it first,
against production, and we do not stop at the first green result.

**The owner has explicitly committed to funding wallets for this. Compute what you need,
present the funding request, and wait — do not simulate instead.**

## Phase 1 — Funding plan

1. Session preflight (00-CONTEXT). Identify the buyer wallet the CLI signs with
   (`onchainos wallet status`; the TEE account's X Layer address — surface it).
2. Compute required funds and present ONE consolidated funding request to the owner:
   - Fee token (`0x779d…3736`) for: cheapest service ($0.01), one mid service, the flagship
     Text→Rigged Avatar ($0.50), ×2 for retries + margin.
   - Gas (OKB on X Layer) if the chosen scheme requires buyer-side gas — the spec says
     whether the facilitator sponsors gas (Permit2/EIP-3009 paths usually do); cite it.
   - Exact addresses, chain, token contract, amounts. Wait for the owner's confirmation.
3. Verify funds arrived on-chain before proceeding (balance query via CLI or X Layer RPC).

## Phase 2 — The gauntlet (production endpoints, real payments)

Run each numbered case; capture EVERYTHING (commands, headers, decoded challenges, tx
hashes) into `prompts/okx-ai/e2e-evidence/` as you go:

1. **Free lane**: health + catalog endpoints — correct, live data, no payment demanded.
2. **Cheapest paid service** ($0.01 Text→3D): unpaid call → 402; `onchainos payment pay`
   → authorization header; replay → job runs → real GLB delivered. Download the GLB,
   verify it parses and has geometry (not zero-byte, not an error JSON saved as .glb).
3. **Flagship** ($0.50 Text→Rigged Avatar): same flow; verify the GLB additionally contains
   a skeleton + skinned mesh (bones present, skin weights non-empty — use the repo's
   existing GLB inspection utils from the rig/retarget test suite).
4. **Settlement verification (the part everyone skips — do not skip):** for each payment,
   find the settlement tx on X Layer (explorer/RPC), confirm the fee token transfer to OUR
   payTo `0x75d0…cf69` for the exact advertised amount, and confirm any `PAYMENT-RESPONSE`
   header matches the on-chain reality. Record tx hashes.
5. **Adversarial cases** (all against production, all must fail SAFELY — tool must not run,
   error must be actionable, a fresh challenge must be offered where applicable):
   a. Replay the same authorization header twice → second attempt rejected (no double-spend
      of one payment, no free second job).
   b. Tampered amount: pay the $0.01 challenge, attempt replay against the $0.50 service.
   c. Expired/stale challenge (wait out `maxTimeoutSeconds` or mint a stale one) → rejected
      with fresh challenge.
   d. Garbage payment header → clean 4xx, no crash, no tool execution.
6. **Failure refund/no-charge semantics:** force a failing job (invalid input that passes
   payment but fails generation — e.g. rig a non-humanoid prop through the humanoid-gated
   lane). Verify our pay-only-on-success promise holds mechanically: either the payment is
   not settled, or the documented refund path executes. Whatever the code actually does,
   confirm it matches what our listing/docs PROMISE — a mismatch is a release blocker: fix
   the code or fix the promise (and its docs) before proceeding.
7. **Legacy rails regression:** one paid call over an existing rail (Base/Solana per
   existing test rig) still works.

## Phase 3 — Fix loop

Any failure: diagnose root cause, fix (code per 02/03 conventions), redeploy, re-run the
FULL failed case plus cases 2 and 5a (regression floor). Repeat until the entire gauntlet
passes in one clean sequence. Log each iteration in PROGRESS.md — iterations are evidence
of rigor, not embarrassment.

## Definition of done

- [ ] Entire gauntlet green in one final clean run; evidence directory complete (add to
      .gitignore if artifacts are large; summarize + link hashes in PROGRESS.md either way)
- [ ] At least 3 real settlements on X Layer with tx hashes recorded, amounts matching
      advertised prices exactly
- [ ] All 4 adversarial cases fail safely (evidence captured)
- [ ] Pay-only-on-success promise verified mechanically or promise corrected everywhere
- [ ] Any code fixes committed per repo rules + pushed to `threews` (only push target)
- [ ] `docs/okx-marketplace.md` updated with a "verified behavior" section: settlement
      timing, refund semantics, replay protection — stated from evidence, not intention
- [ ] `data/changelog.json`: only if user-visible behavior changed in the fix loop
- [ ] `prompts/okx-ai/PROGRESS.md` appended: gauntlet table (case → result → evidence
      pointer), remaining risks, explicit GO/NO-GO for Work Order 05

## Anti-laziness gates

- No case is "covered by" another case. Run all of them, individually, against production.
- A 200 response is not success — success is the artifact being real (GLB parses, skeleton
  present) AND the money being on-chain in our wallet.
- If you cannot verify settlement on-chain, the test is not passed. Find the tx or find
  the bug.
