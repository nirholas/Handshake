# avatar-sources/anny: CC0 parametric body data

Source data for the parametric avatar base. Baked into `public/avatars/parametric-base.glb` by `node scripts/build-parametric-base.mjs`.

## Provenance and license

Vendored 2026-07-22 from [naver/anny](https://github.com/naver/anny) (`src/anny/data/mpfb2/`), which repackages the MakeHuman / MPFB2 core assets. Everything in this directory is **CC0 1.0 Universal** (public domain dedication, see `LICENSE.md`, copied verbatim from the source tree). The original copyright holders who released the assets to CC0 in September 2020: Data Collection AB, Joel Palmius, Jonas Hauquier (the MakeHuman project). No attribution is legally required; we credit MakeHuman and NAVER's anny project as good citizenship.

Only CC0 files are vendored. The anny repository's Apache-2.0 Python code and its optional non-commercial SMPL-X topology are NOT copied here.

## Contents

- `3dobjs/base.obj`: the MakeHuman hm08 base mesh (19,158 vertices: body 0-13379, then helper geometry: eyes, teeth, tongue, eyelashes, hair/cloth caps, joint cubes). Y-up, decimeters, faces +Z.
- `rigs/rig.mixamo.json`: 52-bone Mixamo-named skeleton (`mixamorig:*`). Each bone's head/tail is derived from mesh vertices (`MEAN` of vertex indices, or `CUBE` = centroid of a `joint-*` vertex group), so the skeleton follows the mesh through any morph.
- `rigs/weights.mixamo.json`: per-bone `[vertexIndex, weight]` skinning weights covering all 19,158 vertices.
- `mesh_metadata/basemesh_vertex_groups.json`: named vertex-index ranges (`body`, `helper-l-eye`, `joint-*` cubes, ...).
- `targets/<region>/*.target.gz`: sparse morph targets, one per file. Plain text `vertexIndex dx dy dz` lines (OBJ units), gzipped. Regions vendored: nose, ears, mouth, chin, cheek, eyes, eyebrows, forehead, head, neck, torso, stomach, hip, buttocks, arms, legs, plus the macrodetails phenotype targets (gender/age/muscle/weight/height) the baker composes into body sliders.

## Editing the slider set

The curated morph list (slider name to target file recipe) lives in `scripts/build-parametric-base.mjs` (`MORPHS`). Add an entry there and re-run the baker; the Avatar Studio sculpt panel picks up new morphs automatically from the GLB. 472 target files are vendored; the baker currently bakes a ~120-slider curated set. To add a region we did not vendor, copy it from the anny repo's `src/anny/data/mpfb2/targets/`.
