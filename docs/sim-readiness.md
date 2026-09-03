# Simulation readiness: a physics grade for 3D assets

A renderer forgives almost everything. A rigid-body solver forgives nothing.

Point a generator at "a small ceramic teapot" and you get a mesh that looks perfect on screen. Drop that same mesh into MuJoCo, Isaac, Bullet, or a game engine and it may sink through the floor, spin like it is hollow, or be a metre tall when you asked for a teapot. Nothing in the file says so. A GLB carries no claim about whether it can be simulated, so every robotics, game-physics, and world-model pipeline rediscovers the same defects by hand, one asset at a time.

**Simulation readiness is that claim, made once, mechanically, and checkable by anyone.** Give it a GLB and it answers the question a physics engine asks: can I use this as a rigid body right now, and if not, what exactly is wrong?

- **Free grade:** `GET /api/sim-readiness?src=<glbUrl>`
- **Free MCP tool:** `grade_sim_readiness`
- **Spec (CC0):** [`specs/SIM_READINESS.md`](https://github.com/nirholas/three.ws/blob/main/specs/SIM_READINESS.md)
- **Pure core:** [`api/_lib/sim-readiness.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/sim-readiness.js)

No account, no payment, no wallet. It is free the way [provenance verification](./provenance.md) is free: a check that costs money is a check nobody runs, and a check nobody runs prevents nothing.

## The four verdicts

| Verdict | What it means | What you do |
|---|---|---|
| `simulation_ready` | Closed surface, consistent winding, positive volume, and the extents are real meters. | Use it as a rigid body as-is. |
| `needs_scale` | The geometry is sound. Only the units are missing: the generator fitted the mesh to a unit box. | Multiply to the intended size. Mass properties scale with it. |
| `needs_repair` | The surface is open, non-manifold, or inconsistently wound. Volume and inertia are reported but unreliable. | Close the surface first. Do not trust the mass. |
| `unusable` | No triangles, or zero volume. | Reject it. |

There is a fifth value, `unreadable`, for bytes that are not binary glTF 2.0 at all. It is deliberately distinct from `unusable`: one is a broken file, the other is a valid file with nothing to simulate.

If you take one thing from this page: **`simulation_ready` is the only verdict that licenses using the reported mass without further work.**

## Grade an asset

```bash
curl "https://three.ws/api/sim-readiness?src=https://three.ws/avatars/cesium-man.glb"
```

```jsonc
{
  "cached": false,
  "gradedAt": "2026-09-03T07:22:27.401Z",
  "glbSha256": "b7001eaeea8254bd…",
  "grader": "threews.sim.readiness.v1",
  "readable": true,
  "verdict": "simulation_ready",
  "blockers": [],
  "warnings": ["skinned_geometry_graded_at_bind_pose"],

  "geometry": { "triangles": 4672, "verticesWelded": 2338, "generator": "…" },
  "topology": { "watertight": true, "boundaryEdges": 0, "nonManifoldEdges": 0, "inconsistentWindingEdges": 0 },
  "scale":    { "longestAxisMeters": 1.5065, "sizeMeters": [1.138, 1.507, 0.312], "normalizedGuess": false },
  "mass":     { "volumeM3": 0.053713, "surfaceAreaM2": 1.5356, "centroid": [...],
                "inertiaUnitDensity": [ /* 9 numbers, row major, about the centroid */ ],
                "massAtWaterDensityKg": 53.713 },
  "collision":{ "hullTriangles": 440, "convexityRatio": 0.224, "convexEnough": false },
  "bounds":   { "min": [...], "max": [...], "size": [...], "diagonal": 1.94 }
}
```

Everything in that report is derived from the mesh. There is no model call and no heuristic dressed up as a measurement. Where a value cannot be known from the geometry (the object's true physical scale, its material density) the report says so rather than inventing one, because a fabricated mass is worse than an absent one.

`inertiaUnitDensity` is reported at unit density, so it scales linearly: multiply by your material's kg/m³ to get the real tensor, and `volumeM3` by the same number to get the real mass. `massAtWaterDensityKg` is a convenience for orientation, not a claim about the object.

### Look up an already-graded asset

Grades are keyed by the sha256 of the GLB bytes, never by URL. If you already know the hash, ask for it directly and nothing is fetched:

```bash
curl "https://three.ws/api/sim-readiness?hash=b7001eaeea8254bd…"
```

A hash nobody has graded returns `404 {"error": "not graded"}`. That is the cheap call: use it in a loop, and fall back to `?src=` only when you need bytes fetched and measured.

### Every response

| Case | Status | Body |
|---|---|---|
| Graded, fresh or cached | 200 | the report above, with `cached` and `gradedAt` |
| `?hash=` never graded | 404 | `{ "error": "not graded" }` |
| Neither `src` nor `hash`, or malformed | 400 | `{ "error": "…" }` |
| `src` is not a public https URL | 400 | `{ "error": "src must be a public https URL" }` |
| Asset over 64 MB | 413 | `{ "error": "asset exceeds 64 MB" }` |
| The upstream fetch failed | 502 | `{ "error": "could not fetch the asset", "status": 404 }` |
| Not binary glTF 2.0 | 200 | `{ "readable": false, "verdict": "unreadable", "blockers": ["unreadable_glb"] }` |

That last row is not a mistake. "This is not a GLB" is a valid grade, not a server error, and a client that gates on `verdict` handles it without a second code path.

## From an agent (MCP)

The `grade_sim_readiness` tool returns the same object as `structuredContent`. It is free, read-only, and idempotent, so it ships on every track:

```jsonc
{ "name": "grade_sim_readiness", "arguments": { "glb_url": "https://example.com/prop.glb" } }
```

The point of a free grade for an agent is order of operations: check before you spend. An agent shopping for a prop can grade ten candidates for nothing and only pay to buy, rig, or print the one a solver can actually use. See [the MCP reference](./mcp.md) for connecting.

## Why the blockers say what they say

The vocabularies are closed sets. A new value means a new grader version, so you can branch on them safely.

| `blockers[]` | Cause |
|---|---|
| `open_surface` | An edge belongs to only one triangle. There is a hole. |
| `non_manifold_edges` | An edge is shared by three or more triangles. |
| `inconsistent_winding` | Neighbouring triangles disagree on which side faces out. |
| `inverted_winding` | The whole surface is wound inward; signed volume is negative. |
| `zero_volume` | The surface encloses nothing. |
| `scale_normalized` | The longest axis sits on a generator's unit-box signature. |
| `no_triangles` | No triangle primitives at all. |
| `unreadable_glb` | Not binary glTF 2.0, or a compression extension could not be decoded. |

| `warnings[]` | Meaning |
|---|---|
| `scale_outside_physical_window` | Real units, but outside 5 mm to 20 m: a set piece, not a prop. |
| `degenerate_triangles` | Triangles with repeated corners, excluded from the edge counts. |
| `non_triangle_primitives_skipped` | Points or lines present and excluded from the mass. |
| `skinned_geometry_graded_at_bind_pose` | The mesh is skinned and was graded unposed. |

Vertices are welded by quantized position before the topology is measured, because UV and normal seams split geometrically identical vertices and would otherwise fake a hole in a perfectly closed mesh. Compressed input (Draco, meshopt) is decoded first; a decode failure is `unreadable_glb`, never a silent skip.

## Where you will see it

- **[Any model page](https://three.ws/creations)** (`/m/<id>`) carries the verdict beside its geometry stats. Every model forged on three.ws is graded the moment it is generated, so the badge is already there when the page loads.
- **[The GLB viewer](https://three.ws/viewer)** grades any public GLB you point it at. It is one click rather than automatic, because grading an arbitrary URL means fetching the whole file.
- **The details panel** on both surfaces shows every number above and copies the full report as JSON, because the next thing a robotics user does is paste it into their own pipeline.

## Signed grades

An unsigned report is a claim anyone can forge. When a model is credentialed with `anchor_provenance`, its grade rides inside the [signed content credential](./provenance.md) as one field:

```jsonc
{
  "version": "threews.provenance.3d.v2",
  "glbSha256": "…",
  "simReadiness": {
    "grader": "threews.sim.readiness.v1",
    "verdict": "simulation_ready",
    "blockers": [],
    "volumeM3": 0.00298,
    "longestAxisMeters": 0.3197,
    "inertiaUnitDensity": [ /* 9 numbers */ ],
    "convexityRatio": 0.898
  }
}
```

Only that subset is signed. The full report stays out because a credential's canonical bytes must be small and stable, and every signed field is one a future grader version could contradict.

**The grader version is signed with the grade for exactly that reason.** A grade signed by `threews.sim.readiness.v1` is a permanent claim about what v1 measured. A verifier that re-grades with a newer grader and disagrees must report both, attributed, and must never silently overwrite the signed one.

## Reproducing it yourself

The spec is CC0 and the conformance rules are short enough to hold in your head:

- The same bytes always produce the same report. Sampling is fixed-stride with no randomness, so anyone can reproduce a grade from the GLB alone.
- A one-byte change to the GLB changes its content hash and therefore its cache identity. Grades are keyed by content, never by URL.
- Node transforms are applied before measuring: a mesh scaled 2x by its node is 2x as large.
- `needs_repair` is never reported as `simulation_ready` because the numbers look fine. The verdict is topological, not aesthetic.

Volume and centroid come from the divergence theorem over signed tetrahedra; inertia from tetrahedron covariance accumulation, shifted to the centroid. Both are exact for a closed, consistently wound triangle soup, and [`tests/sim-readiness.test.js`](https://github.com/nirholas/three.ws/blob/main/tests/sim-readiness.test.js) checks them against closed forms: a cube of side s must return V = s³ and I = s⁵/6, and it does to float32 accessor precision.

## Related

- [Verifiable 3D provenance](./provenance.md): who made this model and whether the bytes were altered. Simulation readiness answers whether it works; provenance answers where it came from.
- [Rig Doctor](./rig-doctor.md): the same file, the other question. "Will it animate?" instead of "will it simulate?"
- [The 3D API](./3d-api.md): inspect, optimize, and convert the mesh once you know what is wrong with it.
- [Object Library](./object-library.md): hundreds of CC0 props, each a candidate for grading before you build with it.
