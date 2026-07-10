# Work Order 07 — Final audit, docs closure, approval watch, first-sale readiness

Read `prompts/okx-ai/00-CONTEXT.md` and ALL of `prompts/okx-ai/PROGRESS.md`. 01–05 must be
complete (06 ideally too). Read `/workspaces/three.ws/CLAUDE.md`.

## Mission

Close the loop: independently audit everything shipped in this work stream, close every
docs/changelog gap, watch the resubmission through review, and make sure the day we get
approved is the day we're ready to sell — not the day we start scrambling.

## Part 1 — Independent adversarial audit

Trust nothing in PROGRESS.md until re-verified. Sample-run the critical path yourself,
against production, TODAY:

1. Unpaid 402 on the cheapest and flagship endpoints → still spec-valid (challenges drift
   when unrelated deploys touch shared code).
2. One real paid call end to end incl. on-chain settlement check (04's runbook; request
   funding if dry).
3. Replay-protection spot check (04 case 5a) — still rejects.
4. Free lane: health honest, catalog 1:1 with the catalog module and with the submitted
   listing (pull the live listing: `onchainos agent service-list --agent-id 2632`).
5. Run the repo's completionist audit (the completionist agent) over every file this work
   stream touched (derive from PROGRESS.md + `git log --since` the stream's start). Fix
   everything it finds: no TODOs, no dead paths, no half-wired states, no stray scratch
   files, repo root clean.
6. `npm test` green; `npm run build:pages` green (validates changelog entries).

## Part 2 — Docs closure sweep

Per CLAUDE.md's Documentation section, verify each layer exists and is CORRECT (read them
as a zero-context outsider):

- [ ] `specs/okx-agent-payments.md` — matches implemented reality, incl. every 04 fix
- [ ] `docs/okx-marketplace.md` — every service documented, every curl example actually
      runs (run them), linked from `docs/start-here.md`
- [ ] `STRUCTURE.md` — rows for the new surface(s)
- [ ] `data/pages.json` — any new pages registered (06's showcase)
- [ ] `data/changelog.json` — entries from 02/03/06 present + well-formed; stale claims
      corrected (docs that promise what 04 disproved are release blockers)
- [ ] README(s) in any new package/worker directories created by this stream

## Part 3 — Approval watch + launch runbook

1. Check current approval status (`onchainos agent get-agents --agent-ids 2632`).
2. Write `prompts/okx-ai/RUNBOOK.md` — the operator's guide for the human + future agents:
   - Daily status-check one-liner; how to read approval states (approvalDisplayStatus map).
   - **If APPROVED**: activation confirmation; the launch checklist — changelog entry
     announcing the listing (tags: `feature`; this is THE holder-visible moment), Telegram
     changelog push per repo process, set 06's avatar live if deferred, verify the listing
     renders correctly in the marketplace UI (search for us as a buyer would:
     `onchainos agent search --query "3D avatar rigging GLB"` — confirm we appear, cells
     read well, prices right).
   - **If REJECTED again**: capture the exact remark (`approvalRemark` + email), append to
     PROGRESS.md, map the stated reason to the responsible work order, fix, re-run 05.
   - **First-sale ops**: how to see sales/feedback (`soldCount`, `feedback-list`), how
     revenue arrives (payTo wallet, from 04's evidence), where errors surface
     (existing error-reporting path from api/_mcp/payments.js), what to monitor daily.
3. If the platform exposes review timing/messaging via the task/chat surface, note in the
   RUNBOOK how the human triggers the check (the okx-task-watch flow exists for live
   monitoring — reference it as the tool for the human to invoke, don't leave a daemon).

## Part 4 — Memory

Write/update the agent-memory file for this work stream (per the memory system in the
system prompt) so future sessions don't re-derive: agent #2632 state, what shipped, where
evidence lives, RUNBOOK location, current watch status. Update `MEMORY.md` index.

## Definition of done

- [ ] Part 1 audit run with evidence pasted; every finding fixed, not filed
- [ ] Part 2 checklist fully green (each item verified, not assumed)
- [ ] RUNBOOK.md written and complete enough that a zero-context operator could run launch
      day from it alone
- [ ] Approval status checked and recorded; if already decided, the corresponding RUNBOOK
      branch EXECUTED (launch checklist or rejection loop), not just written
- [ ] Memory file written; PROGRESS.md closed out with final state of the whole stream
- [ ] All changes committed (explicit paths) + pushed to `threews` (only push target)

## Anti-laziness gates

- This audit exists BECAUSE the prior work orders claimed done. Re-verify with fresh eyes;
  every "verified in 04" claim you re-test and confirm, say so; every one you can't
  reproduce is a defect to fix now.
- Do not write the RUNBOOK from imagination — every command in it must be one you ran.
