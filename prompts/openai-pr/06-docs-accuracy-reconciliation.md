# Task 06: Fix doc accuracy and reconcile the tool-count story (P1)

Read [`00-START-HERE.md`](00-START-HERE.md) first. This task cleans up the
documentation drift the audit found, EXCEPT the two docs owned by other tasks
(`apps-sdk/README.md` was Task 01, already landed on 2026-07-18; the `forge_free` tier
claim is Task 03). Do not fight those tasks for those specific edits; coordinate.

## The problems (verified)

1. **Tool-count inconsistency.** The free MCP connector exposes **9** tools: 6
   generation (`forge_free`, `text_to_avatar`, `mesh_forge`, `rig_mesh`,
   `forge_avatar`, `refine_model`) + 3 persona (`create_agent_persona`,
   `get_agent_persona`, `persona_say`). But docs tell different stories:
   - `openai-submission.md` says "Nine tools."
   - `docs/mcp-studio.md` headline tool table lists six, with the persona tools in a
     later "Embodiment" section.
   - Code comments drift: `tools.js:1-8` says "Six generation tools (five generators +
     refine_model)"; `tests/mcp-studio.test.js` comment says "five allowed generation
     tools" while the asserted array has six.
   Reconcile these so every count is consistent and correct. The authoritative number
   is whatever the running server returns from `tools/list`; verify it, then make all
   docs and comments match.

2. **model-viewer version is not single-sourced.** Three surfaces load different
   `model-viewer` versions: `api/ar.js` launch page (3.5.0 via jsdelivr), the MCP
   widget in `component.js` (3.5.0), and `/viewer.html` (4.0.0). Pick one version,
   pin it in one place they all reference (a constant/shared import), or at minimum
   document the intended version per surface and why they differ. A reviewer opening
   two of our surfaces should not get two different renderer versions with no reason.

3. **`docs/mcp-studio.md` cross-reference check.** It points the custom-GPT contract to
   `./api-reference.md`. Verify that file exists and actually documents `/api/3d/studio`.
   If not, fix the pointer to the authoritative schema (the served OpenAPI from Task 05)
   or add the missing section. No dead doc links.

4. **General accuracy sweep of the ChatGPT-surface docs.** Read
   `docs/mcp-studio.md`, `docs/chatgpt-ar.md`, `docs/mcp-3d-studio.md`, and
   `docs/ar.md` end to end against the code. Every `ui://` URI, file path, endpoint,
   env var, and example must resolve and be correct. Fix any that are stale. The audit
   already confirmed `docs/chatgpt-ar.md` correctly points at `component.js` (good) and
   that `apps-sdk/README.md` was the worst offender; Task 01 rewrote it on 2026-07-18,
   so treat it as correct unless a link in it stops resolving.

## Constraints

- Every rule in `00-START-HERE.md`. Docs are real implementations: every code sample
  must run, every link must resolve to a live path (`CLAUDE.md` documentation rules).
- Not a crypto surface; commit gate does not apply. Do not introduce any non-$THREE
  coin reference into the docs.
- Coordinate: `apps-sdk/README.md` was rewritten by Task 01 (landed) and is accurate;
  leave the `forge_free` tier language to Task 03. If Task 03 has not landed yet, note
  the dependency rather than duplicating its edits.

## Verification

- Start from the live `tools/list` output (call `/api/mcp-studio` with an
  `initialize` + `tools/list` JSON-RPC batch) and confirm the count and names, then
  grep every doc/comment for tool counts and confirm they match.
- `grep -rn "model-viewer@" api public docs` shows a single intended version story.
- Every internal doc link resolves (spot-check with a link checker or by opening each
  referenced path).
- `npm test` green (docs changes should not break tests, but run it).

## Definition of done

- [ ] Tool count is consistent and correct (9) across `openai-submission.md`,
      `docs/mcp-studio.md`, code comments, and test comments.
- [ ] model-viewer version is single-sourced or its per-surface difference is
      documented and justified.
- [ ] `docs/mcp-studio.md` cross-references resolve; no dead links in any
      ChatGPT-surface doc.
- [ ] All ChatGPT-surface docs are accurate against the code (paths, URIs, endpoints,
      env vars, examples).
- [ ] `data/changelog.json` entry with the `docs` tag.
- [ ] `npm test` green.
