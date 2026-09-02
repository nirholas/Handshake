# OKX-04: End-to-end real payment test (we pay ourselves and verify settlement)

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/okx-ai-04-e2e-real-payment-test.md`".
Read `prompts/finish/okx-ai-00-CONTEXT.md`, `prompts/finish/okx-ai-RUNBOOK.md`, `specs/okx-agent-payments.md`
and `CLAUDE.md` first. Append your outcome to `prompts/finish/okx-ai-PROGRESS.md` at the end.

## Binding operating clause

1. Finish 100% of everything that does not move money. Never end with a question about scope,
   design, or "should I proceed?".
2. **Two exceptions, and only two, where you stop and wait for the owner** (CLAUDE.md
   stop-and-ask gates, which override the autonomy rule):
   - spending real funds: render recipient, amount, token and chain, then wait for an explicit
     yes;
   - the email OTP for `claude@three.ws`, which only a human can read.
   Batch both into ONE message. Do everything else before you send it, and everything else that
   does not depend on it afterwards.
3. CLAUDE.md hard rules: no mocks, no simulated payments where a real one is specified, no TODO
   comments, no em-dash or en-dash characters. Stage explicit paths only.
4. Owner has pre-authorized OKX, X Layer, chain 196 and the marketplace fee token in commits
   for this work stream. Anything outside that scope still needs the gate.

## Mission

Prove the whole machine with real money before resubmitting: act as an OKX buyer agent, pay our
own endpoint through the OKX Agent Payments Protocol on X Layer, receive the artifact, and
confirm settlement landed on-chain. If OKX's reviewer does this and anything breaks, we get
rejected again.

## Step 0: everything you can do before any money moves

```bash
export PATH="$HOME/.local/bin:$PATH"
onchainos --version && onchainos wallet status
curl -s https://three.ws/api/okx/3d/health | head -40
curl -s https://three.ws/api/okx/3d/catalog | head -60
curl -si -X POST https://three.ws/api/okx/3d/text-to-3d -H 'content-type: application/json' \
  -d '{"prompt":"a small ceramic teapot"}' | head -30      # expect HTTP 402
node scripts/okx-listing-payload.mjs | head -40
npx vitest run tests/api/okx-3d-services.test.js
```

Confirm: the free lane serves real data with no payment demanded, the 402 challenge carries an
`eip155:196` entry first, and the live catalog matches `api/_lib/okx-catalog.js` exactly (the
three-copy rule: module equals live equals submission). Any drift is a defect to fix now,
before spending anything.

## Phase 1: funding request (the one owner message)

1. Identify the buyer wallet the CLI signs with (`onchainos wallet status`) and read its
   current fee-token and gas balances on X Layer.
2. Compute exactly what the gauntlet needs: cheapest service, one mid service, the flagship
   avatar service, times two for retries and margin, plus gas if the chosen scheme requires
   buyer-side gas (cite the spec on whether the facilitator sponsors it).
3. Send ONE message containing: the exact amounts, the token contract, the chain, the receiving
   address, and the OTP request if login is also needed. Then wait. Do not simulate a payment
   instead.
4. When funds land, verify the balance on-chain before proceeding.

## Phase 2: the gauntlet (production endpoints, real payments)

Capture every command, header, decoded challenge and tx hash into `prompts/okx-ai/e2e-evidence/`
as you go. Run each case individually; no case is "covered by" another.

1. **Free lane**: health and catalog return correct live data, no payment demanded.
2. **Cheapest paid service**: unpaid call returns 402, `onchainos payment pay` returns an
   authorization header, the replay runs the job, a real GLB is delivered. Download it and
   verify it parses and has geometry (not a zero-byte file, not an error JSON saved as `.glb`).
3. **Flagship service**: same flow, and the GLB additionally contains a skeleton and skinned
   mesh (bones present, skin weights non-empty, verified programmatically with the repo's GLB
   inspection utilities, not assumed).
4. **Settlement verification, never skipped**: for each payment find the settlement tx on
   X Layer, confirm the fee-token transfer to our payTo wallet for the exact advertised amount,
   and confirm any `PAYMENT-RESPONSE` header matches on-chain reality. Record tx hashes.
5. **Adversarial cases**, all against production, all must fail safely with the tool not
   running and an actionable error:
   a. replay the same authorization header twice, second attempt rejected;
   b. pay the cheapest challenge, attempt to replay it against the flagship service;
   c. expired or stale challenge, rejected with a fresh challenge offered;
   d. garbage payment header, clean 4xx, no crash, no tool execution.
6. **Failure semantics**: force a failing job (input that passes payment but fails generation)
   and verify our pay-only-on-success promise holds mechanically. A mismatch between code and
   the promise in our listing or docs is a release blocker: fix the code or fix the promise.
7. **Legacy rails regression**: one paid call over an existing rail still works.

## Phase 3: fix loop

Any failure: root-cause it, fix it, redeploy, and re-run the failed case plus cases 2 and 5a as
the regression floor. Repeat until the entire gauntlet passes in one clean sequence. Log each
iteration in PROGRESS.md; iterations are evidence of rigor.

## Definition of done

- [ ] Entire gauntlet green in one final clean run, evidence directory complete.
- [ ] At least 3 real settlements on X Layer with tx hashes and amounts matching advertised
      prices exactly.
- [ ] All 4 adversarial cases fail safely, with captured evidence.
- [ ] Pay-only-on-success verified mechanically, or the promise corrected everywhere it appears.
- [ ] `docs/okx-marketplace.md` has a "verified behavior" section stating settlement timing,
      refund semantics and replay protection from evidence, not intention.
- [ ] `data/changelog.json` entry only if user-visible behavior changed in the fix loop.
- [ ] `prompts/finish/okx-ai-PROGRESS.md` appended: case-by-case table, remaining risks, and an
      explicit GO or NO-GO for OKX-05.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| Wallet not logged in | `onchainos wallet login claude@three.ws --locale en_US`, then include the OTP request in your single owner message. Never guess a code. |
| The bot or daemon is offline | `npm run okx:bot` (`scripts/okx-bot-revive.mjs`) installs, starts and reports health. Exit 2 means staged but logged out. |
| A deploy is needed for a fix | Deploys are owner-gated. Prepare everything so the ship is one command, state it, and continue with what does not need it. |
| Catalog drift between module, live endpoint and listing | Fix the module first, then redeploy, then re-verify the live endpoint. The three copies must never diverge, even for one review cycle. |
| Settlement tx not found | The test is not passed. Find the tx or find the bug; never mark a 200 response as success. |
| `gcloud` auth dead | Not needed for this work order. Note it and carry on. |

## Report format

The gauntlet table (case, result, evidence pointer), the tx hashes, what you fixed in the loop,
the GO or NO-GO, and the single owner action if one remains.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/okx-ai-04-e2e-real-payment-test.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
