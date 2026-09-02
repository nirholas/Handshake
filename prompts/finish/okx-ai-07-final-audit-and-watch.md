# OKX-07: Final audit, docs closure, approval watch, first-sale readiness

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/okx-ai-07-final-audit-and-watch.md`".
Read `prompts/finish/okx-ai-00-CONTEXT.md`, all of `prompts/finish/okx-ai-PROGRESS.md`,
`prompts/finish/okx-ai-RUNBOOK.md` and `CLAUDE.md` first.

## Binding operating clause

1. Finish 100%. Trust nothing in `okx-ai-PROGRESS.md` until you have re-verified it yourself today.
   This work order exists precisely because earlier work orders claimed done.
2. Stop only for a real payment or an OTP, batched into one message, per the CLAUDE.md gates.
3. CLAUDE.md hard rules: no mocks, no TODO comments, no em-dash or en-dash characters. Stage
   explicit paths only.

## Part 1: independent adversarial audit (against production, today)

1. Unpaid 402 on the cheapest and the flagship endpoints, still spec-valid. Challenges drift
   when unrelated deploys touch shared code.
2. One real paid call end to end including the on-chain settlement check (OKX-04's runbook;
   request funding in your single owner message if the wallet is dry).
3. Replay protection spot check (OKX-04 case 5a) still rejects.
4. Free lane: health honest, catalog identical to the module and to the submitted listing
   (`onchainos agent service-list --agent-id 2632`).
5. Audit every file this work stream touched (derive the list from `okx-ai-PROGRESS.md` plus
   `git log --since` the stream's start) against the CLAUDE.md rules: no TODOs, no dead paths,
   no half-wired states, no scratch files, repo root clean. Fix what you find; do not file it.
6. `npm test` green; `npm run build:pages` green (it validates changelog entries);
   `npm run audit:docs` clean.

## Part 2: docs closure sweep

Read each as a zero-context outsider and verify it is correct, not merely present:

- [ ] `specs/okx-agent-payments.md` matches implemented reality, including every OKX-04 fix.
- [ ] `docs/okx-marketplace.md` documents every service and every curl example actually runs
      (run them), and is linked from `docs/start-here.md`.
- [ ] `docs/agent-identities.md` still matches the shipped Agent Identity Studio.
- [ ] `STRUCTURE.md` has rows for every surface this stream added.
- [ ] `data/pages.json` registers every new page.
- [ ] `data/changelog.json` entries are present and well-formed; any claim OKX-04 disproved is
      corrected. A doc that promises what the code does not do is a release blocker.
- [ ] Every new package or worker directory has a README.

## Part 3: approval watch and launch execution

1. Check current approval status (`onchainos agent get-agents --agent-ids 2632`).
2. `prompts/finish/okx-ai-RUNBOOK.md` already exists. Verify every command in it by running it, fix
   whatever has drifted, and keep it good enough for a zero-context operator to run launch day
   alone.
3. **Execute the branch that matches reality, do not just document it:**
   - **Approved**: confirm activation, add the holder-visible `data/changelog.json` entry
     announcing the listing (tag `feature`), let the changelog cron deliver it (never run
     `changelog:push` manually, its file state double-posts against the cron's DB state), and
     verify the listing renders correctly to a buyer
     (`onchainos agent search --query "3D avatar rigging GLB"`).
   - **Rejected again**: capture the exact `approvalRemark` and email text, append it to
     `okx-ai-PROGRESS.md`, map the stated reason to the responsible work order, fix it, and re-run
     OKX-05.
   - **Still pending**: record the status and the date, and leave the watch command in the
     RUNBOOK. Do not idle-loop or leave a daemon running.
4. First-sale ops in the RUNBOOK: where sales and feedback show up (`soldCount`,
   `feedback-list`), how revenue arrives (the payTo wallet from OKX-04's evidence), where errors
   surface (`api/_mcp/payments.js`), and what to monitor daily.

## Part 4: memory

Write or update the agent-memory file for this work stream so future sessions do not re-derive
it: agent #2632 state, what shipped, where the evidence lives, the RUNBOOK location, the
current watch status. Update `MEMORY.md`.

## Definition of done

- [ ] Part 1 audit run with evidence pasted; every finding fixed, not filed.
- [ ] Part 2 checklist green item by item, each verified rather than assumed.
- [ ] RUNBOOK commands all personally executed and corrected where they had drifted.
- [ ] Approval status checked and recorded, and the matching branch EXECUTED.
- [ ] Memory file written; `okx-ai-PROGRESS.md` closed out with the final state of the whole stream.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| The bot is offline | `npm run okx:bot`. Exit 0 means online, exit 2 means staged but logged out (login URL printed). |
| Wallet dry or logged out | One batched owner message with the funding table and the OTP request. Everything else proceeds without it. |
| A doc claim cannot be reproduced | That is a defect in the doc, not in your test. Correct the doc in the same session. |
| A deploy would be needed to fix a live string | Deploys are owner-gated. Prepare it as one command, say so, and finish everything else. |
| Approval has not moved in days | Record the status, keep the watch command in the RUNBOOK, and end the session. Never poll in a loop. |

## Report format

Which PROGRESS claims you re-verified and which failed re-verification, the docs checklist
result, the executed launch branch, and the single owner action if one remains.
