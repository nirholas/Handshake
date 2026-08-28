# @three-ws/render

Render rigged, animated 3D avatars to PNG, animated PNG, or truecolor terminal
output. **No GPU. No WebGL. No headless browser.** A pure-JavaScript software
rasterizer that runs anywhere Node runs: a serverless handler, a cron job, a
container with 512 MB of RAM, a CI step, your laptop.

```bash
npx @three-ws/render https://three.ws/avatars/default.glb --out avatar.png
```

This is the renderer behind every server-side avatar picture on three.ws. It
replaced a headless-chromium pipeline that cost a 300 MB browser launch and
3-15 seconds per cold render with an in-process call that takes a few hundred
milliseconds and fetches nothing.

## Why this exists

Rendering a 3D model on a server has meant one of two things: a GPU, or a
headless browser pretending to be one. Both are heavy, and both fail in the
places you most want a picture: a social-card handler with a 30 second budget,
a batch job over a hundred thousand models, a machine with no display stack at
all.

There is a third option nobody ships, because it is a lot of work: rasterize it
yourself. That is what this package is. It parses the glTF, blends the bone
matrices on the CPU, walks the triangles with a z-buffer, samples the textures
through real mip pyramids, and writes the pixels out. It is fast because it
only ever does the work a still frame actually needs.

## Install

```bash
npm install @three-ws/render
```

`three` is the only required dependency (used for glTF parsing, animation
sampling and matrix maths, never for rendering). `sharp` is optional and only
decodes JPEG textures; PNG textures decode in-process with `zlib`. Without
`sharp`, a JPEG-textured model renders with its material colours instead of its
maps, and everything else is identical.

## Use it

### A still

```js
import { renderAvatar, encodePng } from '@three-ws/render';
import { writeFile } from 'node:fs/promises';

const { frames } = await renderAvatar('https://three.ws/avatars/default.glb', {
  width: 1200,
  height: 630,
  focus: 'full',                       // 'full' | 'bust' | 'head'
  background: { inner: '#1b2440', outer: '#05060c' },
});

await writeFile('card.png', encodePng(frames[0]));
```

### An animation

```js
import { renderAvatar, encodeApng } from '@three-ws/render';
import { writeFile } from 'node:fs/promises';

const { frames } = await renderAvatar('avatar.glb', {
  animation: 'walk.glb',   // clips are retargeted onto this rig by bone name
  clip: 'walk',
  frames: 24,
  fps: 20,
  width: 320,
  height: 320,
  background: 'transparent',
});

await writeFile('walk.png', encodeApng(frames, { fps: 20 }));
```

Animated PNG rather than GIF on purpose: GIF would quantize the render to 256
colours and hard-edge the alpha, while APNG keeps the full 24-bit image and the
soft contact shadow, and every current browser plays it.

### A turntable, with no animation data at all

```js
const { frames } = await renderAvatar('prop.glb', { frames: 36, spin: 360 });
```

### In a terminal

```js
import { renderAvatar, toHalfBlocks, detectTerminal } from '@three-ws/render';

const term = detectTerminal();
const { frames } = await renderAvatar('avatar.glb', { width: 60, height: 60, preset: 'terminal' });
process.stdout.write(toHalfBlocks(frames[0], { truecolor: term.truecolor }));
```

Each terminal cell carries two vertical pixels (the upper half-block glyph,
foreground over background), so a 60-column render is 60x60 pixels rather than
60x30. On Kitty, Ghostty, WezTerm and iTerm2 the CLI sends the real PNG through
the terminal's own graphics protocol instead.

## CLI

```
three-ws-tty <model.glb | url> [options]

  --out <file>        write a PNG (animated PNG when --frames > 1)
  --width <n>         output width in pixels (default: fits the terminal)
  --height <n>        output height in pixels
  --focus <mode>      full | bust | head            (default: full)
  --preset <name>     studio | terminal | daylight  (default: terminal for tty)
  --clip <name|idx>   clip to play, from the model or --animation
  --animation <file>  GLB or clip JSON to retarget onto this rig
  --frames <n>        frame count                   (default: 1, or 36 with --spin)
  --fps <n>           frames per second             (default: 20)
  --spin <deg>        turntable degrees across the loop
  --yaw <deg>         camera yaw                    (default: 26)
  --pitch <deg>       camera pitch                  (default: 6)
  --bg <color>        hex colour or 'transparent'
  --loop              keep animating in the terminal until interrupted
  --blocks            force half-blocks even where inline images work
  --clips             list the model's clips and exit
```

```bash
# A headshot, ready for an avatar field
three-ws-tty avatar.glb --focus head --width 512 --out headshot.png

# A looping wave, transparent, for a README
three-ws-tty avatar.glb --animation wave.glb --clip wave --frames 24 --bg transparent --out wave.png

# Look at a model you just downloaded, without opening anything
three-ws-tty ~/Downloads/model.glb --spin 360 --loop
```

## What it renders

- **Skinned humanoid avatars**, posed by real animation clips. Bone matrices are
  blended per vertex on the CPU, and normals ride the same matrix, so a walking
  avatar shades correctly instead of shimmering.
- **Meshopt-compressed and quantized glTF** (`EXT_meshopt_compression`,
  `KHR_mesh_quantization`), which is what most three.ws avatars ship as.
- **Textures** through box-filtered mip pyramids with trilinear sampling and a
  per-triangle level of detail, so a 1024px skin atlas on a 96px avatar reads as
  skin rather than noise.
- **Transparency**: alpha-masked hair and eyelash cards, and a depth-tested
  back-to-front blended pass for genuinely transparent materials.
- **A planar projected contact shadow**, blurred, so the model sits on a surface
  instead of floating.
- **Supersampled edges**, resolved through an ACES tonemap into straight-alpha
  RGBA.

## What it does not render

Stated plainly, because a renderer that lies about its coverage is worse than
one with gaps:

- **Draco-compressed geometry** (`KHR_draco_mesh_compression`) needs a decoder
  this package does not ship. It throws with a message telling you to re-export
  with `gltfpack -cc`.
- **KTX2 / Basis textures** are skipped; the material falls back to its base
  colour factor, which is a real colour, not a placeholder.
- **Morph targets / blendshapes** are not evaluated. Skeletal animation is.
- **PBR is approximated.** Base colour, roughness and emissive drive a
  Blinn-Phong studio rig with a rim light. There is no image-based lighting, no
  metallic reflection and no ray tracing. It is built to make an avatar look
  like itself in a card, not to be a path tracer.

## API

| Export | What it does |
|---|---|
| `renderAvatar(source, options)` | Load and render in one call. Returns `{ model, frames }`. |
| `AvatarModel.load(source, options)` | Load a GLB into a posable model. |
| `model.addClips(clips)` | Retarget clips onto this skeleton by bone name. |
| `model.play(nameOrIndex)` / `model.setTime(s)` | Pose the model. |
| `renderFrame(model, options)` | One RGBA frame. |
| `renderFrames(model, options)` | A frame list, with animation and turntable spin. |
| `frameCamera(bounds, options)` | The camera used for a given focus mode. |
| `encodePng(frame)` / `encodeApng(frames, { fps })` | Image bytes, no native dependency. |
| `toHalfBlocks(frame)` / `toKitty(png)` / `toITerm(png)` | Terminal output. |
| `detectTerminal()` | Columns, truecolor support, inline-image support. |
| `parseClipJson(json)` / `loadClipJson(url)` | three.js AnimationClip JSON. |
| `parseGlb` / `packGlb` / `stripImages` / `extractImages` | The GLB container layer. |
| `normalizeBoneName(name)` / `retargetClip(clip, skeleton)` | Rig-independent bone naming. |
| `PRESETS` / `FOCUS` | Named lighting rigs and framing modes. |

`source` is a URL, a file path, an `ArrayBuffer` or a typed array. Frames are
`{ width, height, data }` where `data` is straight-alpha RGBA, which is exactly
what `sharp`, `canvas`, `ImageData` and every encoder already expect.

### Options

| Option | Default | Meaning |
|---|---|---|
| `width` / `height` | `512` | Output size in pixels. |
| `supersample` | `2` | Render scale before the box-filtered resolve (1-4). |
| `preset` | `'studio'` | `studio`, `terminal` or `daylight`. |
| `focus` | `'full'` | `full`, `bust` or `head`. |
| `yaw` / `pitch` | `26` / `6` | Camera angles in degrees. |
| `fov` | `30` | Vertical field of view. |
| `background` | preset | `'transparent'`, `'#rrggbb'`, `[top, bottom]`, or `{ inner, outer }`. |
| `shadow` | preset | Contact-shadow strength, `0` to disable. |
| `frames` / `fps` | `1` / `24` | Animation length. |
| `spin` | `0` | Turntable degrees spread across the frames. |
| `clip` | `null` | Clip name or index to play. |
| `animation` | none | A second GLB whose clips are retargeted onto this rig. |
| `maxBytes` | 64 MB | Cap on the fetched model. |
| `maxTextureSize` | `1024` | Working texture resolution. |

## Rig support

Clips are bound by normalized bone name, so a Mixamo walk drives a Ready Player
Me body. `normalizeBoneName` collapses Mixamo (`mixamorig:LeftForeArm`), Ready
Player Me (`LeftForeArm`), VRM/VRoid (`J_Bip_L_UpperArm`), Blender
(`upper_arm.L`), and bare camelCase side suffixes (`shoulderL`) onto one key. A
clip whose rig shares fewer than four bones with the target is refused rather
than played as a scramble.

## Performance

Measured on one shared vCPU, rendering the default three.ws avatar (13k
triangles, six 512-1024px textures):

| Render | Time |
|---|---|
| Load and decode the model (once, then cached) | ~1.0 s |
| 512x512, 2x supersampled | ~520 ms |
| 1200x630 OG card, 2x supersampled | ~540 ms warm |
| 288x288, no supersampling | ~60 ms |
| 16-frame animation at 288x288 | ~910 ms |

Decoding dominates the first render, so hold the `AvatarModel` if you are
rendering the same avatar more than once.

## Where it runs on three.ws

- Every OG card and avatar thumbnail, through
  [`api/_lib/render-cpu.js`](../../api/_lib/render-cpu.js). The dispatcher in
  `api/_lib/render-glb.js` tries this lane first and keeps chromium as failover.
- [`GET /api/render/animate`](../../docs/api-reference.md), which turns any
  public avatar into an animated PNG you can drop in a README.

## License

Apache-2.0
