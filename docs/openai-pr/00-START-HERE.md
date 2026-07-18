# OpenAI Apps SDK submission — agent handoff pack

This directory contains standalone task briefs. Each `NN-*.md` file is a complete
prompt you can hand to one agent. They are ordered by impact and are mostly
independent, so several can run in parallel. Read this file first, then the brief
for your task.

## What we are shipping

three.ws is submitting its **3D Studio** app to OpenAI (ChatGPT Apps SDK / App
Directory). The submission target is the **free, keyless MCP connector** at
`https://three.ws/api/mcp-studio` plus its inline widget and the custom-GPT
Actions surface. A reviewer at OpenAI will exercise these surfaces and read the
manifests we expose. Everything they can reach must be correct, consistent, and
free of any paid or crypto surface.

The submission kit already exists at
[`prompts/store-submissions/_generated/`](../../prompts/store-submissions/_generated/)
(answer sheet `openai-submission.md`, `openai-actions.yaml`, `TRACKER.md`,
screenshots, evidence JSON). Your job is not to recreate it. Your job is to close
the specific gaps that would fail review or embarrass us in front of OpenAI.

## The map of the surface (so you know what you are touching)

| Surface | Where it lives | Notes |
| --- | --- | --- |
| Free MCP connector (submission target) | `api/mcp-studio.js`, `api/_mcp-studio/*` | Keyless. 9 tools. Real forge lane. |
| Inline ChatGPT widget (the real one) | `api/_mcp-studio/component.js` | `<model-viewer>` skybridge resource `ui://widget/three-studio-model.html` |
| Orphaned three.js widget | `apps-sdk/studio-viewer/*`, `scripts/build-apps-sdk-viewer.mjs`, `public/apps-sdk/*` | NOT wired to anything. See task 01. |
| Embodiment embed | `apps-sdk/embodiment/*`, `pages/embodiment/embed.html` | Persona widget iframes this. |
| AR-in-ChatGPT | `api/ar.js`, `api/_lib/ar-launch.js` | Every generation carries `arUrl`. |
| Custom GPT Actions (REST) | `api/3d/studio.js`, `prompts/store-submissions/_generated/openai-actions.yaml` | GPT Store listing is live. |
| Served manifests | `public/.well-known/*` | Publicly discoverable. See task 02. |
| Paid MCP server (NOT the submission) | `api/mcp-3d.js`, `api/_mcp3d/*` | x402/OAuth gated. Out of scope unless a task says so. |

## The tasks

| # | Brief | Priority | Blocks submit? |
| --- | --- | --- | --- |
| 01 | [Resolve the orphaned studio-viewer widget](01-orphan-widget-resolution.md) | P0 | Yes (dead code + false docs) |
| 02 | [Reconcile the served `.well-known` manifests with the zero-payment claim](02-wellknown-manifest-conflict.md) | P0 | Yes (reviewer-discoverable crypto surface) |
| 03 | [Make the `forge_free` tier story true everywhere](03-forge-free-tier-truth.md) | P1 | Yes (submission doc contradicts code) |
| 04 | [Close the test gaps on the ChatGPT-facing surface](04-openai-surface-test-coverage.md) | P1 | No, but required for "done" |
| 05 | [Serve the custom-GPT OpenAPI and align legal URLs](05-custom-gpt-openapi-serving.md) | P1 | Partial |
| 06 | [Fix doc accuracy and reconcile the tool-count story](06-docs-accuracy-reconciliation.md) | P1 | No |
| 07 | [Final live verification and submit checklist](07-final-verification-and-submit.md) | P2 (runs last) | Yes (the actual go/no-go) |

Run 01, 02, 03 first (they change code and docs the later tasks depend on). 04, 05,
06 can run in parallel after. 07 runs last, after everything else is merged.

## Rules every task must follow (from `CLAUDE.md`)

These are non-negotiable and OVERRIDE any default behavior:

1. **No mocks, no fake data, no placeholders, no TODOs, no stubs, no commented-out
   code.** If you write it, finish it and wire it. Real APIs only.
2. **Execute, do not interview.** Pick the most reasonable interpretation, do it,
   verify it, and report. Do not end your turn with "want me to proceed?".
3. **Every state is designed** (loading/empty/error/populated) for any UI you touch.
4. **Tests must pass:** run `npm test` (do NOT pipe through `tail` — it masks the
   exit code; a vitest failure gates the Playwright stage).
5. **Changelog:** any user-visible change gets an entry in
   [`data/changelog.json`](../../data/changelog.json) (date, plain-language title +
   summary, tags from feature/improvement/fix/sdk/infra/docs/security). Run
   `npm run build:pages` to regenerate and validate the feed. Internal-only chores
   do not get an entry.
6. **Docs ship with the feature.** If you touch a surface and its doc is now wrong,
   fix the doc in the same change. New page/route → `data/pages.json`.
7. **Commit gate — read this before staging anything.** `$THREE`
   (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`) is the only coin this platform
   promotes. Before any `git commit` whose diff references ANY crypto project other
   than `$THREE` — in code, docs, manifests, tests, or commit text — STOP and get
   explicit owner approval. Task 02 edits a manifest that currently mentions x402/
   USDC/Solana/Base; edits that keep or restructure those references need the owner's
   yes before commit. Do the work, stage nothing that trips the gate, and flag it.
8. **Do not push, deploy, or submit to OpenAI without owner approval.** Commit
   locally, prepare everything so the ship is one command, and say what remains.
9. **Never use the em-dash character.** Use a period, comma, colon, or parentheses.
10. **Concurrent agents share this worktree.** Stage explicit paths only (never
    `git add -A`). Re-check `git status` and `git diff --staged` right before you
    commit.

## Definition of done for the whole pack

- [ ] Every P0/P1 task's own definition of done is met.
- [ ] `npm test` is green.
- [ ] No surface a reviewer can reach advertises a paid or crypto capability.
- [ ] Every doc and manifest describing the ChatGPT surface matches the running code.
- [ ] `docs/openai-pr/07-final-verification-and-submit.md` checklist passes end to end.
- [ ] The only remaining steps are the human `[HUMAN: ...]` items in `TRACKER.md`.
