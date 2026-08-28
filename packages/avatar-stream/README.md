<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/avatar-stream</h1>

<p align="center"><strong>Progressive 3D over plain HTTP. The first 50 KB is already a complete, skinned avatar.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/avatar-stream"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/avatar-stream?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/avatar-stream?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/avatar-stream?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="https://three.ws/stream">Live demo</a>
</p>

---

A GLB is atomic: nothing renders until the last byte lands. On a slow connection
that is several seconds of blank frame on every embed, and it is the first thing
a visitor sees.

`@three-ws/avatar-stream` repacks a GLB into an **A3S** stream: nested layers
ordered so that any byte-prefix of the file is a complete, skinned, spec-valid
avatar. One ranged request puts a posed character on screen; everything after it
refines the mesh already rendering, in place.

No custom server. No WebSocket. No new codec. Just a file, ordered intelligently,
served with the `Range` header every CDN has supported since 1997.

```
michelle.glb  829.8 KB  ->  first frame at 16,597 ms on slow 3G
michelle.a3s   54.7 KB  ->  first frame at  1,094 ms on slow 3G     15.2x faster
```

## Install

```sh
npm install @three-ws/avatar-stream
```

The browser entry (`.` and `./three`) has zero dependencies. Packing pulls in
`@gltf-transform/*`, `meshoptimizer`, `draco3dgltf`, and `sharp`, all declared as
optional peers so a front-end bundle never sees them.

## Quick start

### Pack

```sh
npx @three-ws/avatar-stream pack avatar.glb -o avatar.a3s
```

```
packed avatar.glb -> avatar.a3s in 281 ms

  source     829.8 KB
  container  1629.2 KB
  base layer 50.8 KB  (6.1% of source, 842 of 28106 triangles)

  level  kind   triangles      bytes      cumulative
  0      base         842    50.8 KB        54.7 KB
  1      patch       2810   557.3 KB       612.0 KB
  2      patch       8430   220.2 KB       832.2 KB
  3      patch      28106   797.0 KB      1629.2 KB
```

### Render progressively

```js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { A3SPlayer } from '@three-ws/avatar-stream/three';

const player = await A3SPlayer.load('/avatars/michelle.a3s', {
  THREE,
  GLTFLoader,
  onLayer: (l) => console.log(`level ${l.level}: ${l.triangleCount} triangles`),
});

scene.add(player.scene);   // already skinned, posed, and framed
await player.refine();     // detail arrives without disturbing camera or pose
```

`load()` resolves as soon as the coarse avatar is renderable, after exactly one
HTTP request. `refine()` walks the remaining layers, mutating the geometry that
is already on screen.

### Serve it

Any static host works, because an A3S file is a static file:

```
GET /avatars/michelle.a3s
Range: bytes=0-56035
```

`three.ws` also packs on demand at
[`/api/avatar-stream?src=/avatars/michelle.glb`](https://three.ws/api/avatar-stream?src=/avatars/michelle.glb&format=json),
which serves `206 Partial Content` and will hand you the layer table as JSON with
`&format=json`.

## CLI

```sh
a3s pack <input.glb> [-o out.a3s] [--levels 0.03,0.1,0.3,1] [--base-texture 64] [--json]
a3s inspect <file.a3s|url> [--json]
a3s verify  <file.a3s|url> [--deep] [--json]
a3s extract <file.a3s|url> [-o preview.glb]
a3s bench   <input.glb> [--connection slow-3g|fast-3g|4g] [--json]
```

`verify --deep` replays every layer headlessly and proves the refined surface
matches the source triangle for triangle, with no renderer involved.

`extract` writes layer 0 out as a standalone GLB. It opens in Blender, in the
Khronos validator, in any glTF viewer, because it is not a custom blob:

```sh
a3s extract avatar.a3s -o preview.glb   # 50.8 KB, 842 triangles, fully rigged
```

## API

### `@three-ws/avatar-stream` (isomorphic, no dependencies)

| Export | Purpose |
|---|---|
| `A3SStream.open(target, options)` | Open a URL, bytes, or custom source. One request to a renderable base layer. |
| `stream.base` | Layer 0 as a `Uint8Array`. A complete GLB. |
| `stream.layer(level, { verify })` | Fetch one refinement layer. |
| `stream.layers({ verify })` | Async iterator over the refinement layers. |
| `httpSource(url, { fetch, headers })` | Range-request byte source. Handles hosts that ignore `Range`. |
| `decodePreamble` / `decodeHeader` / `encodeContainer` | The container format itself. |

### `@three-ws/avatar-stream/three`

| Export | Purpose |
|---|---|
| `A3SPlayer.load(target, { THREE, GLTFLoader, onLayer })` | Open a stream and parse layer 0 into a scene. |
| `player.refine(options)` | Apply every remaining layer, coarse to fine. |
| `applyPrimitivePatch` / `applyTexturePatch` | The primitives, if you drive refinement yourself. |

`three` and `GLTFLoader` are injected, never imported, so this package pins no
renderer version and never ships a second copy of three into your bundle.

### `@three-ws/avatar-stream/node`

| Export | Purpose |
|---|---|
| `pack(glbBytes, options)` | GLB to A3S. Returns `{ container, header, stats }`. |
| `reconstruct(target, options)` | Replay a stream into plain typed arrays, no GPU. |
| `triangleFingerprint(positions, indices)` | Order-independent surface fingerprint, for tests. |

## How it works

Edge-collapse simplification has a useful property: simplify a mesh
*successively*, finest to coarsest, and the vertices surviving at each level are a
strict subset of those at the level below. The levels nest.

So the packer ranks every vertex by the coarsest level it reaches, sorts the
vertex buffer by that rank, and level *k*'s vertices become exactly the first
*V(k)* entries. A refinement layer only ever appends vertices the client lacks. It
never rewrites a byte already sent.

Skinning survives untouched, because a simplifier emits a new index buffer over
the vertex array it was handed, carrying `JOINTS_0` and `WEIGHTS_0` along with it.
That is why the 842-triangle base layer is already bound to all 65 joints.

Animation clips are deliberately excluded from layer 0. On a rigged character the
keyframe data often outweighs the mesh several times over, and it is the one part
invisible in the first frame. Clips arrive in the first patch as a geometry-free
companion GLB whose tracks bind by node name.

The wire format is specified in
[`specs/AVATAR_STREAM.md`](https://github.com/nirholas/three.ws/blob/main/specs/AVATAR_STREAM.md)
and is CC0. Independent implementations are welcome.

## Measured on the three.ws avatar corpus

Base layer as a share of source, across 17 production avatars:

| Avatar | Source | Base layer | Share | Triangles |
|---|---|---|---|---|
| `pumpfun-pill-cupsey-static` | 1641 KB | 67 KB | 4.1% | 1336 of 44544 |
| `parametric-base` | 4244 KB | 234 KB | 5.5% | 902 of 27676 |
| `michelle` | 830 KB | 51 KB | 6.1% | 842 of 28106 |
| `xbot` | 781 KB | 48 KB | 6.1% | 1472 of 49112 |
| `studio` | 1796 KB | 154 KB | 8.6% | 1349 of 15817 |
| `brainstem` | 3120 KB | 404 KB | 12.9% | 6813 of 61666 |
| `realistic-male` | 1206 KB | 202 KB | 16.8% | 587 of 10677 |

Every base layer in that corpus passes Khronos glTF validation with zero errors,
and every stream replays to a surface identical to its source.

## License

Apache-2.0
