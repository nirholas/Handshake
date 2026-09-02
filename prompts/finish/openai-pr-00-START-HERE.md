# OpenAI Apps SDK submission: agent handoff pack

This pack holds the task briefs for submitting the three.ws **3D Studio** app to OpenAI
(ChatGPT Apps SDK / App Directory). It moved here from `docs/openai-pr/` on 2026-09-01 so
that every open work order in the repo lives under [prompts/](../README.md) and follows its
standard. Each `NN-*.md` file is a complete prompt for one agent. Read this file first, then
the brief for your task.

## What we are shipping

The submission target is the **free, keyless MCP connector** at
`https://three.ws/api/mcp-studio` plus its inline widget and the custom-GPT Actions surface.
A reviewer at OpenAI will exercise these surfaces and read the manifests we expose.
Everything they can reach must be correct, consistent, and free of any paid or crypto surface.

The submission kit lives at [`prompts/store-submissions/_generated/`](../store-submissions/_generated/)
(answer sheet `openai-submission.md`, `openai-actions.yaml`, `TRACKER.md`, screenshots,
evidence JSON). Your job is not to recreate it. Your job is to close the specific gaps that
would fail review or embarrass us in front of OpenAI.

## The map of the surface

| Surface | Where it lives | Notes |
| --- | --- | --- |
| Free MCP connector (submission target) | `api/mcp-studio.js`, `api/_mcp-studio/*` | Keyless. Live `tools/list` returns 11 tools (8 in `tools.js` plus 3 persona tools; `look_at_model` was added 2026-08-28). Real forge lane. |
| Inline ChatGPT widget | `api/_mcp-studio/component.js` | `<model-viewer>` skybridge resource `ui://widget/three-studio-model.html` |
| Embodiment embed | `apps-sdk/embodiment/*`, `pages/embodiment/embed.html` | Persona widget iframes this. |
| AR-in-ChatGPT | `api/ar.js`, `api/_lib/ar-launch.js` | Every generation carries `arUrl`. |
| Custom GPT Actions (REST) | `api/3d/studio.js`, `prompts/store-submissions/_generated/openai-actions.yaml` | GPT Store listing is live. Served copy: `public/.well-known/3d-studio-openapi.yaml`, byte-pinned by `npm run check:studio-openapi`. |
| Served manifests | `public/.well-known/*` | Publicly discoverable. |
| Paid MCP server (NOT the submission) | `api/mcp-3d.js`, `api/_mcp3d/*` | x402/OAuth gated. Out of scope unless a task says so. |

## The tasks

Briefs 01 through 05 were verified shipped on 2026-09-01 and deleted; they remain readable in
git history (`git log --diff-filter=D -- docs/openai-pr/`). What each closed:

| # | Brief | Verified by |
| --- | --- | --- |
| 01 | Orphaned studio-viewer widget removed | `apps-sdk/studio-viewer`, `scripts/build-apps-sdk-viewer.mjs`, `public/apps-sdk` gone since `19c379125` (2026-07-18) |
| 02 | `.well-known` manifests reconciled with the zero-payment claim | `ai-plugin.json` leads with the free lane and a branded logo; `tests/wellknown-manifests.test.js` asserts the free schema is crypto-free; served and kit copies byte-identical |
| 03 | `forge_free` tier story true everywhere | `api/_mcp-studio/tools.js` defaults to `standard`; the live tool description, the answer sheet and `forge-free-tier-evidence.json` agree |
| 04 | Test coverage on the ChatGPT-facing surface | `tests/api/ar-endpoint.test.js` (20), `tests/api/embodiment-embed-page.test.js` (7), `tests/api/3d-studio-actions-contract.test.js`, `tests/e2e/embodiment-embed.spec.js` (6); production `/api/ar` matches per user agent |
| 05 | Custom-GPT OpenAPI served, legal URLs aligned | `https://three.ws/.well-known/3d-studio-openapi.yaml` 200, two paths, `security: []`, Redocly lint clean; `/legal/privacy` and `/legal/tos` 200 |

Open:

| # | Brief | Priority | State (measured 2026-09-01) |
| --- | --- | --- | --- |
| 06 | [Fix doc accuracy and reconcile the tool-count story](openai-pr-06-docs-accuracy-reconciliation.md) | P1 | Partial. The 2026-08-06 reconciliation shipped and `docs/mcp-studio.md` says eleven, but `api/_mcp-studio/tools.js:3`, `openai-submission.md`, `live-tools-list.json`, `TRACKER.md`, the `/openai` page copy and its locale key, and the partnership brief still say ten or nine. |
| 07 | [Final live verification and submit checklist](openai-pr-07-final-verification-and-submit.md) | P2 (runs last) | Never run. Its "exactly 10 tools" check must read 11; `initialize`, `tools/list`, `resources/list`, the served manifests and `/api/ar` pass today; the live `forge_free` and `POST /api/3d/studio` runs and the kit refresh remain. |

Run 06 first, then 07. The human steps at the end of 07 (partner-portal submit, deleting the
draft GPT) stay with the owner.

## Rules every task must follow (from `CLAUDE.md`)

These are non-negotiable and OVERRIDE any default behavior:

1. **No mocks, no fake data, no placeholders, no TODOs, no stubs, no commented-out
   code.** If you write it, finish it and wire it. Real APIs only.
2. **Execute, do not interview.** Pick the most reasonable interpretation, do it,
   verify it, and report. Do not end your turn with "want me to proceed?".
3. **Every state is designed** (loading/empty/error/populated) for any UI you touch.
4. **Tests must pass:** run `npm test` (do NOT pipe through `tail`; it masks the
   exit code; a vitest failure gates the Playwright stage).
5. **Changelog:** any user-visible change gets an entry in
   [`data/changelog.json`](../../data/changelog.json) (date, plain-language title +
   summary, tags from feature/improvement/fix/sdk/infra/docs/security). Run
   `npm run build:pages` to regenerate and validate the feed. Internal-only chores
   do not get an entry.
6. **Docs ship with the feature.** If you touch a surface and its doc is now wrong,
   fix the doc in the same change. New page/route: `data/pages.json`.
7. **Commit gate.** `$THREE` (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`) is the
   only coin this platform promotes. Before any `git commit` whose diff references ANY
   crypto project other than `$THREE` (in code, docs, manifests, tests, or commit text),
   STOP and get explicit owner approval. Do the work, stage nothing that trips the gate,
   and flag it.
8. **Do not push, deploy, or submit to OpenAI without owner approval.** Commit
   locally, prepare everything so the ship is one command, and say what remains.
9. **Never use the em-dash character.** Use a period, comma, colon, or parentheses.
10. **Concurrent agents share this worktree.** Stage explicit paths only (never
    `git add -A`). Re-check `git status` and `git diff --staged` right before you
    commit.

## Definition of done for the whole pack

- [ ] 06 and 07's own definitions of done are met.
- [ ] `npm test` is green.
- [ ] No surface a reviewer can reach advertises a paid or crypto capability.
- [ ] Every doc and manifest describing the ChatGPT surface matches the running code,
      including the tool count.
- [ ] The only remaining steps are the human `[HUMAN: ...]` items in
      [`TRACKER.md`](../store-submissions/_generated/TRACKER.md).

## Retire this file when the campaign is done (required)

This file is shared context rather than a single order, so it outlives the
prompts that cite it. Delete it in the commit that closes the LAST prompt of
this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'openai-pr-00-START-HERE' prompts/finish/
       git rm prompts/finish/openai-pr-00-START-HERE.md

While any sibling prompt of this campaign is still on disk, leave this file in
place and keep it accurate instead. The shrinking directory is the only signal
to the next agent that a campaign is closed.
