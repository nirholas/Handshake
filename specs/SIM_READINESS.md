# Simulation Readiness: a physics grade for 3D assets

**Version `threews.sim.readiness.v1`** · Open specification · License: CC0 / public domain

> Pure core: `api/_lib/sim-readiness.js`. Free grade: `GET /api/sim-readiness` and the `grade_sim_readiness` MCP tool. Probe: `scripts/sim-readiness-probe.mjs`. Companion spec: [`PROVENANCE_3D.md`](PROVENANCE_3D.md).

## The problem

A renderer forgives almost everything. A rigid-body solver forgives nothing. It needs a closed
surface to integrate a volume over, consistent winding so that volume comes out positive, a
real-world size so gravity and friction mean anything, and a convex proxy so collision queries
stay cheap. Generated meshes routinely fail every one of those while looking perfect on screen,
and the failure surfaces later as an object that sinks through a floor or spins like it is hollow.

Nothing in the 3D asset supply chain states this. A GLB carries no claim about whether it can be
simulated, so every robotics, game-physics and world-model pipeline rediscovers the same defects
by hand. This spec fixes the vocabulary and the report so the claim can be made once, mechanically,
and checked by anyone.

**Everything in a report is derived from the mesh.** No model call, no heuristic dressed as a
measurement. Where a value cannot be known from the geometry (true physical scale, material
density) the report says so rather than inventing one, because a fabricated mass is worse than
an absent one.

## The verdict

Exactly four values, ordered by how much work stands between the asset and a simulator.

| Verdict | Meaning | What a consumer does |
|---|---|---|
| `simulation_ready` | Closed, consistently wound, positive volume, and the extents are real meters. | Use it as a rigid body as-is. |
| `needs_scale` | The geometry is sound; only the unit anchoring is missing (the generator fitted it to a unit box). | Multiply to the intended size, then use it. Mass properties scale with it. |
| `needs_repair` | The surface itself is open, non-manifold, or inconsistently wound. Volume and inertia are reported but unreliable. | Close the surface first. Do not trust the mass. |
| `unusable` | No triangles, or a zero volume. | Reject. |

A consumer that understands only one thing should understand this: **`verdict == "simulation_ready"`
is the only value that licenses using the reported mass without further work.**

## The report

```jsonc
{
  "grader": "threews.sim.readiness.v1",   // required: the contract version, see Versioning
  "readable": true,                        // false only when the buffer is not binary glTF 2.0
  "verdict": "simulation_ready",           // required: one of the four above
  "blockers": [],                          // machine reasons the verdict is not simulation_ready
  "warnings": [],                          // conditions a consumer should know but that do not block

  "geometry": {
    "triangles": 4624,
    "verticesRaw": 2796,                   // as authored, before welding
    "verticesWelded": 2314,                // after position welding, the topological vertex count
    "weldToleranceMeters": 1.1e-6,
    "skippedPrimitives": 0,                // non-triangle primitives, excluded from mass
    "skinnedPrimitives": 0,
    "generator": "…"                       // glTF asset.generator, verbatim or null
  },

  "topology": {
    "triangles": 4624, "degenerateTriangles": 0,
    "edges": 6936, "boundaryEdges": 0, "nonManifoldEdges": 0, "inconsistentWindingEdges": 0,
    "edgeManifold": true, "windingConsistent": true, "watertight": true
  },

  "scale": {
    "longestAxisMeters": 0.3197,           // glTF defines 1 unit = 1 meter
    "sizeMeters": [x, y, z],
    "centerOffsetMeters": [x, y, z],
    "withinPhysicalWindow": true,          // 0.005 m .. 20 m along the longest axis
    "normalizedGuess": false               // true = fitted to a unit box, units are not the object's
  },

  "mass": {
    "volumeM3": 0.00298,
    "surfaceAreaM2": 0.187,
    "centroid": [x, y, z],
    "inertiaUnitDensity": [ixx, ixy, ixz, iyx, iyy, iyz, izx, izy, izz],  // row-major, about the centroid
    "massAtWaterDensityKg": 2.98           // convenience only; multiply volumeM3 by your own density
  },

  "collision": {
    "sampledPoints": 2314, "hullVertices": 680, "hullFaces": 678, "hullTriangles": 1356,
    "hullVolumeM3": 0.00332,
    "convexityRatio": 0.898,               // meshVolume / hullVolume, in (0, 1]
    "convexEnough": true                   // convexityRatio >= 0.9: one hull is an honest proxy
  },

  "bounds": { "min": [..], "max": [..], "size": [..], "diagonal": 0.41, "center": [..] }
}
```

`mass` and `collision` are present whenever `readable` is true and the mesh has triangles, and are
reported even for `needs_repair` so a consumer can see how far off the asset is. **Reading them
without checking `verdict` is the one misuse this spec exists to prevent.**

### Blocker and warning vocabulary

Closed sets. A new value is a new spec version.

| `blockers[]` | Cause |
|---|---|
| `open_surface` | One or more edges belong to a single triangle. |
| `non_manifold_edges` | An edge is shared by three or more triangles. |
| `inconsistent_winding` | A directed edge is traversed more than once: neighbouring triangles disagree on the outward face. |
| `inverted_winding` | The whole surface is wound inward; the signed volume is negative. |
| `zero_volume` | The surface encloses nothing. |
| `scale_normalized` | The longest axis sits on the generator unit-box signature; the units are not the object's. |
| `no_triangles` | No triangle primitives at all. |
| `unreadable_glb` | Not binary glTF 2.0, or a compression extension could not be decoded. |

| `warnings[]` | Meaning |
|---|---|
| `scale_outside_physical_window` | Real units, but outside 0.005 m to 20 m: a set piece, not a prop. |
| `degenerate_triangles` | Triangles with repeated corners; excluded from the edge counts. |
| `non_triangle_primitives_skipped` | Points, lines or strips present and excluded from the mass. |
| `skinned_geometry_graded_at_bind_pose` | The mesh is skinned; it was graded unposed. Do not read it as a rigid body without saying so. |

## How the numbers are derived

Standard and exact for a closed, consistently wound triangle soup. All of it is unit-tested
against closed forms in `tests/sim-readiness.test.js` (a cube of side s at unit density must
return V = s³ and I = s⁵/6, and does to float32 accessor precision).

| Quantity | Method |
|---|---|
| Volume, centroid | Divergence theorem over signed tetrahedra (0, a, b, c). |
| Inertia | Tetrahedron covariance accumulation, C = det(J)·J·Ĉ·Jᵀ with Ĉ = (1/120)·[[2,1,1],[1,2,1],[1,1,2]], shifted to the centroid, then I = tr(C)·1 - C. Reported at unit density so it scales linearly with any density a caller assigns. |
| Manifoldness | Every undirected edge shared by exactly two triangles; every directed edge traversed exactly once. Vertices are welded by quantized position first, at a tolerance relative to the model's own bounding diagonal, because UV and normal seams split geometrically identical vertices and would fake a boundary. |
| Scale | World-space extents after node transforms, read as meters per the glTF 2.0 unit convention. |
| Collision proxy | Convex hull over welded points (deterministic stride sampling above the point cap), with the hull volume from the same signed-tetra sum. |

Compressed input (Draco, meshopt) is decoded before grading. A decode failure is `unreadable_glb`,
never a silent skip.

## Free grade over HTTP

`GET /api/sim-readiness?src=<glbUrl>` (or `?hash=<sha256>` for an already-graded asset) returns the
report. No account, no payment, no coin surface, mirroring `GET /api/provenance`. The response adds
one envelope field:

```jsonc
{ "cached": true, "gradedAt": "2026-08-13T…Z", …the report… }
```

`?hash=` returns `404` with `{ "error": "not graded" }` when that content hash has never been
graded; it never fetches bytes. `?src=` grades on demand and caches by content hash.

The `grade_sim_readiness` MCP tool (free, `api/_mcp3d/tools/`) returns the same object as
`structuredContent`.

## In the content credential

A signed grade is the point: an unsigned report is a claim anyone can forge. The grade rides the
existing content credential ([`PROVENANCE_3D.md`](PROVENANCE_3D.md)) as one optional field:

```jsonc
{
  "version": "threews.provenance.3d.v2",   // v2, per that spec's additive-field rule
  "glbSha256": "…",
  "createdAt": "…",
  "simReadiness": {
    "grader": "threews.sim.readiness.v1",
    "verdict": "simulation_ready",
    "blockers": [],
    "volumeM3": 0.00298,
    "longestAxisMeters": 0.3197,
    "inertiaUnitDensity": [ … 9 numbers … ],
    "convexityRatio": 0.898
  }
}
```

Only that subset is signed. The full report stays out of the credential because the credential's
canonical bytes must stay small and stable, and because every signed field is a field a future
grader version could contradict.

**The grader version is signed with the grade for exactly that reason.** A verifier that re-grades
with a newer grader and gets a different answer must report both, attributed, and must never
silently overwrite a signed grade. A grade signed by `threews.sim.readiness.v1` is a claim about
what v1 measured, permanently.

## Conformance

- The same bytes must always produce the same report. Sampling is deterministic (fixed stride, no
  randomness), so a grade is reproducible by any implementer from the GLB alone.
- A one-byte change to the GLB changes its content hash and therefore its cache identity; the grade
  is keyed by content hash, never by URL.
- Node transforms are applied before measuring. A mesh scaled 2× by its node is 2× as large.
- `needs_repair` must never be reported as `simulation_ready` because the numbers "look fine".
  The verdict is topological, not aesthetic.

## Versioning

`grader` is the contract. Additive fields, new blocker values, and threshold changes all ship a new
version string; consumers select behaviour by it. Thresholds that a deployment may tune without a
version bump are exactly the two documented in `SCALE_BOUNDS`; a report generated under tuned
bounds must still say `threews.sim.readiness.v1` only if the bounds are unchanged from this spec.

CC0: reimplement and extend freely.
