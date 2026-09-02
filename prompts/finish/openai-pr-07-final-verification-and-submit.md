# Task 07: Final live verification and submit checklist (P2, runs last)

Read [`openai-pr-00-START-HERE.md`](openai-pr-00-START-HERE.md) first. **Run this only after tasks
01-06 are merged.** This is the go/no-go gate before the app is submitted to OpenAI.

## Purpose

The submission answer sheet
([`prompts/store-submissions/_generated/openai-submission.md`](../store-submissions/_generated/openai-submission.md))
asserts many "verified live" facts, dated 2026-07-14. Deployments move. Before we put
this in front of OpenAI, re-verify every claim against the *currently deployed*
production, close the loose `[HUMAN: ...]` items where you can, and produce a clean
go/no-go report. Do not submit; prepare so the human's final submit is one action.

## The checklist (run every item, record the result)

### A. The MCP connector is live, keyless, and crypto-free
- [ ] `POST https://three.ws/api/mcp-studio` with an `initialize` request returns the
      server info (`three-ws-3d-studio-free`, protocol `2025-06-18`) with no auth.
- [ ] `tools/list` returns exactly the expected 11 tools (Task 06's reconciled count,
      pinned by `tests/mcp-studio.test.js`: `forge_free`, `text_to_avatar`,
      `mesh_forge`, `rig_mesh`, `forge_avatar`, `refine_model`, `check_job`,
      `look_at_model`, `create_agent_persona`, `get_agent_persona`, `persona_say`)
      with correct `openai/*` annotations and `outputTemplate` linkage.
- [ ] `resources/list` returns both widget skybridge resources
      (`ui://widget/three-studio-model.html`, `ui://widget/three-studio-persona.html`)
      with their `openai/widgetCSP`, `widgetDescription`, `widgetDomain` metadata.
- [ ] A real `forge_free` call returns a real GLB with `glbUrl`, `viewerUrl`, `arUrl`,
      and NO internal ids (`job_id`, `creation_id`, `backend`) and NO crypto/payment
      fields. Save the response as fresh evidence (overwrite the stale
      `_generated/*forge_free.json` evidence if the shape changed).
- [ ] The connector response body contains no x402/payment/crypto tokens (the
      `tests/mcp-studio.test.js` regex should still pass against live output).

### B. Every reviewer-discoverable manifest is consistent (depends on Task 02, 05)
- [ ] `https://three.ws/.well-known/ai-plugin.json` does not present the 3D app as a
      paid crypto service; free vs paid is explicit; logo is a real branded asset.
- [ ] The served 3D Studio OpenAPI (Task 05) is fetchable, lints clean, describes only
      the free endpoints, and every legal URL in it returns 200.
- [ ] `https://three.ws/legal/privacy` and `https://three.ws/legal/tos` return 200 in
      the exact form the submission and schema cite.

### C. The widget and AR surfaces render (depends on Task 01, 04)
- [ ] The inline widget renders a real GLB in a `window.openai`-less browser via its
      standalone/`viewerUrl` path (loading, ready, empty, error states all reachable).
- [ ] `GET /api/ar?src=<glb>&title=<t>` returns the correct surface per device class
      (Scene Viewer intent on Android UA, launch page on iOS/desktop UA); the error
      page renders for a bad `src`.
- [ ] `kind=avatar` returns the IRL "Bring it to life" handoff.

### D. The custom GPT Actions surface works (depends on Task 05)
- [ ] `POST https://three.ws/api/3d/studio` submits and returns the documented shape;
      `GET ?job=&title=` polls to completion with a real GLB.
- [ ] The response validates against the served OpenAPI (Task 04's contract test).

### E. Submission kit is current
- [ ] `openai-submission.md` facts all re-verified against the checks above; fix any
      that drifted. Update the date.
- [ ] Screenshots in `prompts/store-submissions/_generated/openai-screenshots/` show
      the CURRENT shipped widget and resolve the `[HUMAN verify]` dimension flag
      (confirm they meet OpenAI's required screenshot dimensions; re-shoot against the
      live widget if stale). Task 01 deleted the orphaned three.js viewer, so confirm
      no screenshot or evidence file still points at the retired
      `https://three.ws/apps-sdk/` viewer URL as "the widget" (verified clean on
      2026-08-06; re-check after any evidence regeneration).
- [ ] `TRACKER.md` `[HUMAN: ...]` items: resolve every one you technically can (e.g.
      the duplicate-draft-GPT deletion if you have access); leave only items that
      genuinely require the human's partner-portal login, and list them explicitly.
- [ ] `npm test` green on the merged tree.

## Constraints

- Every rule in `openai-pr-00-START-HERE.md`. Especially rule 8: **do NOT submit to OpenAI, push,
  or deploy.** Prepare everything; the human does the final submit in the partner
  portal.
- If any check fails, do not paper over it. Root-cause it, fix it (or route it back to
  the owning task 01-06), and re-run. A red check is a blocker, not a footnote.
- Do not commit anything that trips the commit gate (rule 7); flag it.

## Definition of done

- [ ] Every checklist item has a recorded PASS with evidence, or a FAIL with the fix
      applied and re-verified to PASS.
- [ ] `openai-submission.md` and `TRACKER.md` reflect the current, verified reality.
- [ ] The only open items are `[HUMAN: ...]` steps that truly require the owner
      (partner-portal submit, portal-side actions), listed explicitly in your report.
- [ ] Final report is a clean go/no-go: either "ready to submit, remaining human steps
      are X, Y" or "not ready, blockers are A, B and here is the state of each."
