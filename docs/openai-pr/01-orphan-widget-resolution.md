# Task 01 — Resolve the orphaned studio-viewer widget (P0)

> **Resolved 2026-07-18** in commit `0b50834d7` ("Refactor apps-sdk studio viewer"): the orphaned viewer source and its build script were removed, exactly as this task specifies. Kept as the record of the finding; the file links below point at the now-deleted paths and are left as plain code references.

Read [`00-START-HERE.md`](00-START-HERE.md) first for the shared rules and the map.

## The problem (verified, with evidence)

There are **two** inline-widget implementations in the tree, and they are not
connected:

1. **The widget ChatGPT actually renders** is the `<model-viewer>` component built
   inline in [`api/_mcp-studio/component.js`](../../api/_mcp-studio/component.js)
   (`COMPONENT_HTML`). It is served as the skybridge resource
   `ui://widget/three-studio-model.html` and is fully wired and tested.

2. **A second, unrelated three.js viewer** lived in
   `apps-sdk/studio-viewer/src.js` (619 lines,
   full GLTFLoader + OrbitControls + RoomEnvironment). It was built by
   `scripts/build-apps-sdk-viewer.mjs`
   into `public/apps-sdk/studio-viewer.bundle.js` and `.../studio-viewer.html`.
   (Both files deleted in `0b50834d7`.)

The second one is **orphaned**:

- The consumer the build script names,
  `api/_mcp3d/studio-viewer-resource.js`, **does not exist** (confirmed:
  `ls` returns "No such file or directory").
- Nothing serves `ui://widget/studio-viewer.html`. The only references to that URI
  are the source comment in `apps-sdk/studio-viewer/src.js:7` and the build script
  comment in `scripts/build-apps-sdk-viewer.mjs:8`.
- The `/viewer` route in `vercel.json` maps to `/viewer.html`, a different page, not
  this bundle.
- The build is not in `prebuild`/`build`, so the committed bundle can silently go
  stale.

On top of that, [`apps-sdk/README.md`](../../apps-sdk/README.md) **describes the
orphaned viewer as if it were the live ChatGPT widget** (lines 17 and 59 claim the
bundle is "Bundled into the `ui://widget/studio-viewer.html` skybridge resource
served to ChatGPT" and "Read at runtime by
`api/_mcp3d/studio-viewer-resource.js`"). Both statements are false against the
current tree. For a handoff to OpenAI, a public README that misdescribes our own
integration is unacceptable.

## Your job

Pick ONE of these two resolutions, implement it fully, and make the README true.
Default to Option A unless you find a concrete reason the three.js viewer is
better for our submission (if so, state it in your report and do Option B).

### Option A (default) — Delete the dead path

The live `<model-viewer>` widget in `component.js` already renders GLBs inline in
ChatGPT, is tested, and is what the screenshots were taken against. The three.js
viewer duplicates it with no consumer.

1. Delete `apps-sdk/studio-viewer/` (the whole subdir), `scripts/build-apps-sdk-viewer.mjs`,
   the `build:apps-sdk-viewer` script in `package.json`, and the generated
   `public/apps-sdk/studio-viewer.bundle.js` + `public/apps-sdk/studio-viewer.html`
   (and any `dist/apps-sdk/*` copies). Grep first for every reference and remove
   each one so nothing dangles.
2. Rewrite [`apps-sdk/README.md`](../../apps-sdk/README.md) so the `studio-viewer`
   section is gone and the doc accurately describes the two things that DO ship from
   `apps-sdk/`: the embodiment engine, and a pointer to where the real ChatGPT widget
   lives (`api/_mcp-studio/component.js`). Do not leave a section describing a
   directory you just deleted.
3. Update [`STRUCTURE.md`](../../STRUCTURE.md) if it references `apps-sdk/studio-viewer`.

### Option B — Wire the three.js viewer as the real widget

Only if you determine the three.js viewer is materially better (PBR lighting, contact
shadow, animation mixer) than the CDN `<model-viewer>` and worth being the widget.

1. Create the missing resource module (the correct path, given the free connector
   owns the widget, is under `api/_mcp-studio/`, not `api/_mcp3d/`) that reads the
   built bundle and serves it as the `text/html+skybridge` resource. Register it in
   [`api/_mcp-studio/dispatch.js`](../../api/_mcp-studio/dispatch.js) alongside the
   existing `three-studio-model.html` resource and point the tool
   `openai/outputTemplate` at it.
2. Add `build:apps-sdk-viewer` to the build pipeline (`prebuild` or `build`) so the
   bundle can never go stale, and add it to the esbuild-bundle guard if applicable.
3. Add a test that the resource serves non-empty HTML containing the bundle and
   carries the required `openai/widgetCSP`/`widgetDescription` metadata.
4. Make `apps-sdk/README.md` accurate against the new wiring (correct file path,
   correct `ui://` URI, correct build step).

Whichever option: **the CSP must still allowlist exactly the origins the widget
fetches from** (three.ws, the R2 storage origin, and the CDN if used). Match what
`api/_mcp-studio/component.js` `componentCsp()` already does.

## Constraints

- Follow every rule in `00-START-HERE.md`.
- This is not a crypto surface, so the commit gate does not apply here, but still
  stage explicit paths only.
- No dead references left behind: after your change, `grep -rn "studio-viewer" .`
  (excluding node_modules) must return only intentional, accurate hits.

## Verification

- `grep -rn "apps-sdk/studio-viewer\|studio-viewer-resource\|widget/studio-viewer" . | grep -v node_modules`
  returns only what your chosen option intends (nothing for Option A; the real
  resource wiring for Option B).
- `npm test` is green (run the full suite, do not pipe through `tail`).
- For Option B: build the bundle, load the served resource, and confirm it renders a
  GLB. For Option A: confirm the live `<model-viewer>` widget still renders (exercise
  a `forge_free` call against `/api/mcp-studio` and open the resulting `viewerUrl`).
- `apps-sdk/README.md` reads correctly to someone with zero context and every file
  path and `ui://` URI in it resolves.

## Definition of done

- [ ] One option fully implemented, no half-state.
- [ ] `apps-sdk/README.md` is accurate; `STRUCTURE.md` updated if needed.
- [ ] No dangling references to the deleted/created paths.
- [ ] `npm test` green.
- [ ] `data/changelog.json` entry if this changed anything user-visible (Option B
      would; Option A is an internal cleanup and doc fix, which is `docs`-tagged only
      if the README is user-facing — use judgment, default to a short `docs`/`infra`
      entry).
- [ ] Report states which option you chose and why.
