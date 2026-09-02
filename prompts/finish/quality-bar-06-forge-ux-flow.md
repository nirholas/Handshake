# QB-06: Forge UX, from prompt to proud screenshot

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/quality-bar-06-forge-ux-flow.md`".
It is complete on its own. Also read `prompts/finish/quality-bar-_shared.md` and `CLAUDE.md`.

## Binding operating clause

1. Finish 100%. Never end with a question, a plan you did not execute, or "should I proceed?".
2. Blockers have pre-answered routes at the bottom. Use them and keep going.
3. CLAUDE.md hard rules: no mocks, no stubs, no TODO comments, no fake progress bars, no
   em-dash or en-dash characters. Stage explicit paths only. Do not push unless asked.

## Mission

Make `/forge` feel like a flagship product: the path from typing a prompt to holding a
share-worthy 3D result should be legible, alive, and impossible to dead-end.

## Step 0: re-derive current state (trust nothing below)

```bash
npm run dev            # port 3000, then walk /forge as a first-time user in a real browser
ls src/forge-compare.js src/forge-prompt-gen.js api/_lib/forge-lane-health.js
grep -n "starter\|chip" pages/forge.html | head -20
npm run audit:web -- /forge      # page-audit takes explicit routes as positional args
```

Known shipped as of 2026-07-30, verify then skip: generation history persistence, the
side-by-side compare mode (`src/forge-compare.js`, `tests/forge-compare.test.js`, documented in
`docs/forge.md`), and the six curated starter prompts on `pages/forge.html`.

## Tasks

1. **Walk the flow as a first-time user** (`npm run dev`, real browser, also at 320 px). Write
   down every moment of confusion: what is happening now, how long will it take, what do I do
   with the result. Fix what you find. The list below is the floor, not the ceiling.
2. **Generation timeline.** Replace passive waiting with a real stage timeline (enhancing
   prompt, generating reference views, sculpting mesh, painting textures, finishing) driven by
   the poll states the API already returns, with elapsed time and the honest ETA from
   `api/_lib/forge-lane-health.js`. Show reference images as they are produced; watching the
   concept appear kills perceived latency.
3. **Result moment.** When the GLB lands: a camera intro move, the quality viewer, and
   immediate actions with zero hunting: download GLB and USDZ, view in AR (`/ar` handoff), rig
   it, refine it (`refine_model`), restyle materials, place it IRL (`/irl`), share a link whose
   og-image renders this model. Click every one of those through to its destination and back.
   A dead button is a failed task.
4. **Prompt help.** After generation, show the director's enhanced prompt ("what we actually
   asked the model") with a one-click "try a variation".
5. **Error and retry UX.** Every failure path renders a designed state: what failed in plain
   language, the automatic recovery that already happened (failover), and the one-click manual
   options (engine switch). No raw error strings, no dead ends. Session expiry mid-generation
   must preserve the job and resume after re-auth; test that by clearing the session cookie
   mid-poll.
6. **Keyboard and accessibility.** Cmd/Ctrl+Enter submits, Esc collapses panels, focus-visible
   everywhere, ARIA labels on viewer controls, `prefers-reduced-motion` respected on the intro
   move. Confirm with `npm run audit:a11y`.

## Definition of done

- [ ] The full walk-through repeats clean: no confusion points, no console errors, loading,
      empty, error and success states designed at 320, 768 and 1440 px.
- [ ] Every result-moment action clicked through to its destination feature and back, listed
      one by one in the report with what happened.
- [ ] `npm run audit:web` clean on `/forge`; `npm run audit:a11y` no new failures.
- [ ] `npm test` green (do not pipe through `tail`).
- [ ] `data/changelog.json` entry in holder language; screenshots of the result moment in the
      report.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| A poll payload lacks a stage you want to show | Extend the response in `api/forge.js` as an additive field (old clients keep working). Never fake a state client-side. |
| USDZ missing for a model | Generate on demand through the existing bake pipeline and show a brief honest "preparing AR file" state. |
| Persistence store choice | Use what `api/` already uses for user artifacts (R2 plus database rows). Do not introduce new storage. |
| The crawler reports WebGL or texture errors | `npm run audit:web` runs pages concurrently and produces false 3D failures. Re-check any 3D failure serially before reporting it. |
| A generation is slow because a GPU is cold | That is task 2's subject, not a blocker. Show the honest ETA. |

## Report format

The confusion list with what you changed for each, the action-by-action click-through table,
screenshots, and any single remaining owner action. No recap of this file.
