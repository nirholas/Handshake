# Work order 01: the printability engine (analyze, repair, export)

**How to run:** paste this whole file into a fresh Claude Code chat in this
repo, or name its path. Read `prompts/finish/materialize-00-CONTEXT.md` first; its
decisions bind this order.

**Binding operating clause:** finish 100%. Never end the session with a
question, an unexecuted plan, or "let me know". CLAUDE.md hard rules apply:
no mocks, no fake data, no unfinished markers, no em-dash anywhere, commit
finished work promptly with explicit paths. Pushes and production deploys
are owner-gated; everything else in this file is yours to do.

## Why this order exists

Every downstream piece (quotes, orders, the page, fulfillment) consumes one
thing: a trustworthy answer to "can this mesh be printed, at what size, and
what exact bytes go to the printer". AI-generated meshes are the worst case
the printing world sees: non-manifold shells, self-intersections, paper-thin
decorations, textures instead of geometry. Turning that into a printable
solid automatically, server-side, at forge scale, is the platform's hard
technical moat. Get this right and everything above it is plumbing.

## Step 0: re-derive current state (never trust status claims, even here)

```
ls api/print/ 2>/dev/null
npm ls manifold-3d three-mesh-bvh fflate 2>/dev/null
grep -rn "print" api/_lib/3d-catalog/ | head
ls tests/api/ | grep -i print
git log --oneline -10 -- api/print src/print
```

Whatever already exists and passes its tests, keep and extend; skip any
task below that is verifiably done. Read `api/3d/inspect.js` end to end
before writing anything: analyze is its sibling and must match its
conventions (keyless, CORS, bounded input, no persistence).

## Tasks

### 1. Dependencies

Add `manifold-3d` (pin `^` range). Verify `fflate` and `three-mesh-bvh`
per the 00-CONTEXT table; add whichever are missing. Log the rationale in
the commit message per CLAUDE.md OSS rules.

### 2. `api/_lib/print/` core modules (pure, unit-testable, no HTTP)

- `mesh-io.js`: load a GLB from a URL or buffer via gltf-transform, merge
  primitives, bake node transforms, return indexed positions + uvs +
  texture handles. Bound input size (reject > 100 MB or > 2M triangles
  with a designed error naming the limit).
- `analyze.js`: produce the printability report exactly as specified in
  00-CONTEXT (manifold check, shells, self-intersections, open edges,
  bbox_mm, volume_cm3 via manifold-3d, min-wall sampling via inward
  ray casts with three-mesh-bvh over a deterministic sample of surface
  points, score with named deductions). Deterministic: same bytes, same
  report. Include `version: 1`.
- `repair.js`: manifold reconstruction via manifold-3d (union of shells,
  hole fill), optional decimation to a triangle budget via
  gltf-transform's simplify, scale-to-target-height, and optional hollow
  (manifold offset) with two drain holes for resin economy, gated to
  meshes where hollowing is geometrically safe. Every operation returns
  metrics before/after so the UI can show what changed.
- `export-stl.js`: binary STL from the repaired mesh (three's STLExporter
  or a direct writer; binary only, watertight input asserted).
- `export-3mf.js`: a minimal, spec-correct 3MF writer over fflate: OPC
  zip layout, `3D/3dmodel.model` XML, units mm, vertex colors when the
  source had textures (sample the base-color texture at each vertex UV in
  `mesh-io.js`; this is what makes full-color sandstone prints possible
  and no competitor's export button does it). Validate output opens in at
  least one real slicer toolchain via a structural test (parse the zip,
  validate XML against the 3MF core spec requirements you assert).

### 3. HTTP surface (thin handlers over the core, forge conventions)

- `POST /api/print/analyze` (`api/print/analyze.js`): body
  `{glbUrl}` or `{creationId}` (resolve via `api/_lib/forge-store.js`).
  Free, keyless, CORS like `api/3d/inspect.js`. Returns the report.
- `POST /api/print/prepare` (`api/print/prepare.js`): body adds
  `{targetHeightMm, material, hollow}`. Runs repair + exports, mirrors
  STL/3MF/repaired GLB to R2 exactly the way the forge mirrors finished
  models (reuse the forge's persistence helper, do not fork it), returns
  permanent URLs + the post-repair report. If p95 wall time in your local
  measurement exceeds 20s on a 200k-triangle mesh, implement the async
  job-token pattern from `api/forge.js` (HMAC token, poll param) instead
  of raising timeouts.
- Register both in the free 3D API catalog: new descriptors in
  `api/_lib/3d-catalog/` plus the barrel import lines, so `/api/3d` and
  its OpenAPI advertise them with zero page edits.

### 4. Tests (vitest, `tests/api/`)

Fixtures: generate three tiny deterministic GLBs in-test (a clean cube, a
two-shell non-manifold, an open-bottom shell); never commit binary blobs.
Cover: report shape and determinism, manifold repair actually closes the
open shell (re-analyze reports manifold true), volume within 1% of the
analytic cube volume, STL byte-level header/count correctness, 3MF zip
structure + color payload presence, both handlers' validation errors, and
the size bounds.

## Definition of done (every line mechanically checkable)

- [ ] `npm test` green, including the new `tests/api/print-*.test.js`.
- [ ] `curl -s localhost:3000/api/print/analyze -d '{"glbUrl":"<a real R2 forge model URL>"}' -H 'content-type: application/json'` returns a version-1 report with a numeric score, on the dev server.
- [ ] The same call against a creationId of a real `forge_creations` row works.
- [ ] `/api/3d` index and `/api/3d/openapi.json` list both new endpoints.
- [ ] `npm run check:rules -- --paths <files you touched>` passes.
- [ ] Deliverables committed with explicit paths; this file deleted in the closing commit (`git rm prompts/finish/materialize-01-printability-engine.md`) and PROGRESS.md appended.

## Never blocked

| Blocker | Resolution |
|---|---|
| manifold-3d WASM will not load in the API runtime | It is plain WASM + JS, no native binding. Check the import style (ESM default export needs `await Manifold.init()` style setup); mirror how other WASM (draco decoders) is handled in this repo. |
| No real GLB URL for the curl check | `psql "$DATABASE_URL" -c "select id, asset_url from forge_creations where status='succeeded' order by created_at desc limit 5"` or generate one on the spot via `POST /api/3d/generate`. |
| R2 credentials | Same env the forge uses; find the mirroring helper by grepping `api/_lib/` for the R2 upload call. They are set in `.env`. |
| Wall-thickness sampling too slow | Sample count is a dial: 2,000 surface points with BVH raycasts is milliseconds. Fix the sample count, document it in the report's `sampling` field, never drop the metric. |
| 3MF spec ambiguity | The core spec is public (3mf.io); assert the small required subset (content types, relationship, model XML with mesh + color group). A structural round-trip test is the arbiter, not a vendor tool. |

## Report format

End the session with: files created/changed (paths), test names added and
their status, the measured analyze/prepare wall times on a real forge
model, any deviation from 00-CONTEXT (one line each, with why), and the
single next action for order 02.
