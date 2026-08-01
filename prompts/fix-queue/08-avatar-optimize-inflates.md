# 11. `/api/avatar/optimize?draco=1` returns a file BIGGER than the input, silently

**Severity: P1.** An optimizer that makes things worse and does not say so.
Read [00-INDEX.md](00-INDEX.md) first.

## First, correct the record

`ISSUES.md` item 9 says this endpoint returns
`500 transcode_failed / draco.createCompressedPrimitive is not a function` on
the running image, and blames dependency drift. **That is stale.** Measured
2026-08-01 against production (revision `three-ws-api-00353-tzp`, commit
`6cc0370dc`): the endpoint returns `200`, the output is a valid GLB whose
generator is `glTF-Transform v4.4.0`, and the payload really does carry
`KHR_draco_mesh_compression`. The rebuild that item asked for has happened.
Part of this work order is deleting that item, or rewriting it to the defect
below.

## The real symptom (measured 2026-08-01)

| Source | Raw bytes | `?draco=1` | `?meshopt=1` |
|---|---|---|---|
| `https://three.ws/avatars/default.glb` | 748,088 | **890,160 (+19.0%)** | 752,312 (+0.6%) |
| `https://three.ws/avatars/michelle.glb` | 849,756 | **974,036 (+14.6%)** | 826,740 (-2.7%) |

Reproduce:

```bash
curl -s -o /dev/null -w '%{size_download}\n' https://three.ws/avatars/michelle.glb
curl -s -o /dev/null -w '%{size_download}\n' \
  'https://three.ws/api/avatar/optimize?src=https://three.ws/avatars/michelle.glb&draco=1'
```

The output of the Draco run also still contains `EXT_meshopt_compression`, which
points at the cause: these sources are **already meshopt-compressed**, and the
pipeline is layering Draco on top of, or beside, an existing compression instead
of decoding first and choosing one scheme. Whatever the mechanism, a caller who
asks an endpoint named `optimize` to optimize gets a 19% larger file and no
indication that anything went wrong.

## The job

1. **Confirm the mechanism, do not guess it.** Reproduce locally against the
   handler behind `/api/avatar/optimize` (find it via the route table in
   `vercel.json`; do not assume the path). Inspect the intermediate document:
   are the primitives being decoded before re-encode, are both extensions
   declared on the same primitives, and is the resulting buffer genuinely Draco
   or Draco-wrapping-meshopt?
2. **Fix the pipeline.** Decode existing compression before applying a new
   scheme, and never emit two mesh-compression extensions for the same
   primitive. Quantization settings matter here too: Draco on an
   already-quantized mesh is the classic way to grow a file.
3. **Add the guardrail that would have caught this.** After optimizing, compare
   output size to input size. If the output is larger, return the ORIGINAL bytes
   and say so in a response header (follow the pattern already used for
   `x-render-expression: applied|partial|none` on `/api/avatar/render`, which
   exists for exactly this "the operation silently did nothing useful" class).
   A caller must be able to tell.
4. **Cover it with a test** that runs a known-meshopt source through
   `?draco=1` and asserts the output is not larger than the input, plus a test
   asserting the header contract.
5. **Sweep the other parameters.** Every other `optimize` parameter is reported
   to work; verify that with sizes, not with status codes, and put the table in
   your report.
6. Update `docs/` wherever `optimize` is documented, and add a
   `data/changelog.json` entry: this is user-visible.

## Verification

```bash
npx vitest run tests/avatar-optimize-source-cap.test.js   # existing neighbour
npx vitest run <your new test>
```
plus the size table above, re-measured, with every row at or below the raw size.

## Done when

No `optimize` parameter combination returns a larger file than it was given, the
response says what it did, a test pins both, and `ISSUES.md` item 9 no longer
claims a 500 that stopped happening.
