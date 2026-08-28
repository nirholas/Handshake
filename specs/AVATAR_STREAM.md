# A3S: Progressive 3D over plain HTTP

**Version `threews.a3s.v1`** · Open specification · License: CC0 / public domain

> Reference implementation: [`packages/avatar-stream/`](../packages/avatar-stream). Live demonstration: [three.ws/stream](https://three.ws/stream). Endpoint: `GET /api/avatar-stream?src=<glb>`.

## The problem

A GLB is atomic. A client must hold every byte before it can draw a single
triangle, because the index buffer at the end of the file may reference the
vertex at the start of it. For a 3 MB rigged avatar on a slow connection that is
several seconds of empty frame, and it is the first thing a visitor sees on every
embed.

The usual answers do not solve it. Draco and `EXT_meshopt_compression` make the
file smaller but keep it atomic. Texture streaming helps textures only, and an
untextured mesh is still nothing until the mesh arrives. Custom streaming
protocols solve it at the cost of a custom server, which is exactly what a static
CDN asset is supposed to avoid.

## The idea

Reorder the asset so that **any byte-prefix of the file is a complete, valid
asset**, then let the client stop reading whenever it likes.

That is achievable because of one property of edge-collapse simplification: when
you simplify a mesh *successively*, finest to coarsest, the vertices surviving at
each level are a strict subset of the vertices at the level below it. The levels
nest. Rank every vertex by the coarsest level it survives into, sort the vertex
buffer by that rank, and level *k*'s vertices become exactly the first *V(k)*
entries of the buffer. A refinement layer then only appends vertices the client
does not yet have; it never rewrites bytes already sent.

Skinning is preserved for free. A mesh simplifier emits a new index buffer over
the vertex array it was given, so `JOINTS_0` and `WEIGHTS_0` are carried along
untouched and the coarse mesh is already bound to the full skeleton.

## Container layout

All integers are unsigned 32-bit little-endian. All chunks are 4-byte aligned.

```
offset  size  field
0       4     magic, the ASCII bytes "A3S1"
4       4     formatVersion (1)
8       4     headerOffset
12      4     headerLength
16      4     baseOffset
20      4     baseLength
24      4     layerCount
28      4     totalLength
32      ...   header JSON (UTF-8)
...     ...   layer 0: a complete, spec-valid GLB
...     ...   layer 1 .. layerCount-1: patches
```

The 32-byte preamble is the only fixed-offset structure. A client reads it, then
the header, then layer 0, and can render. In practice all three arrive in one
ranged request: readers should ask for the first 96 KiB
(`RECOMMENDED_PREFIX_BYTES`) and issue a second request only if
`baseOffset + baseLength` exceeds what came back.

### Layer 0 is a real GLB

Layer 0 is not a custom blob. It is a standalone binary glTF that validates
against the glTF 2.0 specification and opens in any conforming viewer:

```sh
a3s extract avatar.a3s -o preview.glb
```

It carries the coarsest mesh, the complete node hierarchy, the skin with its
inverse bind matrices, the materials, and thumbnail textures. It deliberately
does **not** carry animation clips: on a 65-joint character the keyframe data
routinely outweighs the mesh several times over, and it is the one part nobody
can see in the first frame. Clips ship in the first patch as a geometry-free
companion GLB whose tracks address nodes by name, so they bind to the skeleton
layer 0 already put on screen.

## Header

```jsonc
{
  "version": "threews.a3s.v1",
  "generator": "@three-ws/avatar-stream",
  "source": {
    "name": "michelle.glb",
    "sha256": "<64-hex of the original GLB bytes>",
    "byteLength": 849756
  },
  "geometry": {
    "vertexCount": 16340,
    "triangleCount": 28106,
    "primitiveCount": 1,
    "passthroughPrimitiveCount": 0   // non-triangle prims carried whole in layer 0
  },
  "levels": [0.03, 0.1, 0.3, 1.0],   // triangle ratios, coarsest first
  "layers": [ /* see below */ ]
}
```

Every layer entry carries `level`, `kind` (`"base"` or `"patch"`), the absolute
`offset` and `length` of its bytes in the container, a `sha256` over exactly
those bytes, and the cumulative `triangleCount` / `vertexCount` once the layer is
applied.

**The encoder is the single source of truth for `offset` and `length`.** A packer
must compute them while writing and overwrite whatever the caller supplied, so a
header can never disagree with the payload behind it.

### Patch entries

A patch layer additionally carries:

```jsonc
{
  "prims": [{
    "prim": 0,                  // the packer's primitive ordinal
    "newVertexStart": 910,      // first vertex index this patch delivers
    "newVertexCount": 1349,
    "vertexCount": 2259,        // cumulative, after applying
    "attributes": {
      "POSITION":  { "offset": 0,    "length": 16188, "componentType": 5126, "type": "VEC3", "normalized": false, "elementSize": 3 },
      "JOINTS_0":  { "offset": 16188, "length": 10792, "componentType": 5121, "type": "VEC4", "normalized": false, "elementSize": 4 },
      "targets/0/POSITION": { /* morph target deltas use the same shape */ }
    },
    "indices": { "offset": 40000, "length": 16860, "componentType": 5125, "count": 8430 }
  }],
  "animations": { "offset": 57000, "length": 483584, "clips": ["Idle", "Walk"] },
  "textures": [{
    "texture": 0, "offset": 540000, "length": 35112, "mimeType": "image/webp",
    "slots": [{ "material": "Body", "slot": "baseColorTexture" }]
  }]
}
```

All `offset` values inside a patch are **relative to the start of that patch's
payload**, so a client that fetched only this layer can address into it without
knowing where the layer sits in the file.

Attribute keys are glTF semantics (`POSITION`, `NORMAL`, `JOINTS_0`, ...). Morph
target deltas use the key form `targets/<index>/<semantic>`.

## Applying a patch

For each primitive in the patch:

1. For each attribute, allocate an array of
   `(newVertexStart + newVertexCount) * elementSize` components, copy the first
   `newVertexStart * elementSize` components from the array already held, and
   write the patch bytes after them.
2. Replace the index buffer with the patch's, wholesale. Index buffers are not
   incremental: level *k*'s topology differs from level *k-1*'s.
3. Recompute bounds.

Then, if present, parse the animation companion and merge its clips, and decode
each texture and bind it to every material slot listed in `slots`.

Nothing is re-parsed and no second scene graph is built, so camera, pose, and
animation state survive refinement untouched.

## Conformance

A conforming **reader** must:

- reject a buffer whose magic is not `A3S1`, and a `formatVersion` it does not implement;
- treat layer 0 as renderable on its own, without fetching any patch;
- tolerate a host that ignores `Range` and answers `200` with the whole body;
- verify a layer against its `sha256` when integrity is requested.

A conforming **packer** must:

- guarantee the nesting property, and fail rather than emit a stream that breaks it;
- emit a layer 0 that passes glTF 2.0 validation;
- never emit a level whose vertex or index count is zero;
- give each primitive sole ownership of its accessors before reordering, since
  accessors are commonly shared between primitives in real files.

## Why `Range` and not something new

`Range` is a 1997 HTTP feature. Every CDN, object store, and static host already
implements it, every browser already speaks it, and every corporate proxy already
allows it. An A3S file needs no server logic, no WebSocket, no session, and no
new codec: it is a static asset that happens to be ordered intelligently. The
reference endpoint at `/api/avatar-stream` is a convenience for packing on
demand, not a requirement of the format.

## Interoperability notes

- **Quantized sources.** Positions in a meshopt-compressed GLB arrive as
  normalized integers. A packer must dequantize before simplifying.
- **Non-indexed geometry.** A triangle soup shares no vertices, so every edge
  reads as a border and nothing can collapse. Weld before building the chain.
- **Non-triangle primitives.** Points, lines and strips have nothing to simplify.
  Carry them whole in layer 0 and count them in `passthroughPrimitiveCount`.
- **Source defects are preserved, not repaired.** A packer copies the source's
  node hierarchy verbatim. If the source fails validation, so will layer 0.

## Version history

- `threews.a3s.v1` (2026-08-28): initial release. Preamble, header, GLB base
  layer, geometry patches, animation companion, texture pyramid, per-layer
  SHA-256.
