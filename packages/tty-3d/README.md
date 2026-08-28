# `@three-ws/tty-3d`

Render a rigged, animated 3D model in a terminal. GLB in, coloured text out.

No GPU, no browser, no display server, no WebGL. It is a software rasterizer: it
decodes the glTF, evaluates the animation, blends the joint matrices per vertex
on the CPU, and rasterizes triangles into a z-buffered framebuffer sized to your
terminal. That makes it work identically over SSH, in CI, inside a container with
no display, and on a serverless instance.

```bash
npx @three-ws/tty-3d ./avatar.glb
```

Or, with nothing installed at all:

```bash
curl three.ws/tty
```

## Why this exists

three.ws gives AI agents a body. AI agents increasingly live in a terminal. This
closes that gap: the same avatar that renders in WebGL on a web page renders in
the shell where the agent actually runs.

It is also the renderer core underneath [`@three-ws/tty-avatar`](../tty-avatar),
which adds moods, avatar-id resolution and Claude Code hooks on top of a
terminal renderer. This package owns the part that is purely 3D: skeletal
animation and rasterization.

## Install

```bash
npm install @three-ws/tty-3d
```

Requires Node 18 or newer.

## CLI

```bash
three-tty <model.glb | https://...> [options]
```

| Option | Meaning | Default |
| --- | --- | --- |
| `--width <n>` | Columns | terminal width |
| `--height <n>` | Rows. One row is two vertical pixels | terminal height minus 2 |
| `--fps <n>` | Frames per second | 24 |
| `--spin <n>` | Turntable speed, radians per second. `0` holds still | 0.9 |
| `--clip <name\|n>` | Which animation to play | the first one |
| `--no-anim` | Hold the rest pose | |
| `--once` | Draw one frame and exit | implied when piped |
| `--frames <n>` | Draw n frames and exit | |
| `--time <s>` | Where in the clip to start | 0 |
| `--pitch <r>` | Camera elevation, radians | 0.08 |
| `--zoom <n>` | 1 fits the model, higher moves closer | 1 |
| `--color <mode>` | `truecolor`, `ansi256`, or `mono` | detected |
| `--transparent` | Leave the background unpainted | |
| `--info` | Print what was loaded as JSON, then exit | |

Interactive: arrow keys or `a`/`d` orbit, `w`/`s` tilt, `+`/`-` zoom, space
pauses, `q` quits.

**Piping is safe.** When stdout is not a terminal, the default is a single frame,
not an infinite animation, so `three-tty model.glb > frame.txt` terminates.

```bash
# a still frame in plain ASCII, for a README or a commit hook
three-tty avatar.glb --once --width 72 --color mono > frame.txt

# eight seconds of animation, then exit
three-tty avatar.glb --frames 200 --fps 25
```

## Library

```js
import { loadModel, createRenderer } from '@three-ws/tty-3d';

const model = await loadModel('./avatar.glb');   // path, https URL, or bytes
const renderer = createRenderer(model, { width: 80, height: 40 });

process.stdout.write(renderer.frame(1.25));      // one string per frame
```

### `loadModel(source, options?)`

`source` is a filesystem path, an `http(s)` URL, or a `Uint8Array` / `ArrayBuffer`
of GLB bytes. Returns a model with `triangleCount`, `skinned`, `animations` and
`bounds`.

`EXT_meshopt_compression` is decoded unconditionally. Most real avatars ship with
it, and a reader that skips the decoder does not fail loudly, it reads garbage
vertex data.

### `createRenderer(model, options?)`

| Option | Type | Default |
| --- | --- | --- |
| `width`, `height` | number, in characters | 96 x 48 |
| `animation` | clip name, index, or `false` for the rest pose | first clip |
| `mode` | `'truecolor'` \| `'ansi256'` \| `'mono'` | `'truecolor'` |
| `background` | `[r, g, b]` in 0..1 | near black |
| `transparent` | leave uncovered cells as spaces | `false` |
| `spin` | turntable radians per second | 1 |
| `pitch`, `zoom` | camera elevation and distance | 0.08, 1 |
| `tint` | `[r, g, b]` multiplier | white |

Returns `{ frame(time), setOrbit({yaw, pitch, zoom}), orbit, width, height, framing }`.
`frame(time)` is pure and deterministic: the same time always renders the same
string.

### Other exports

`renderOnce(source, options)`, `describeModel(model)`, `selectAnimation(model, wanted)`,
`detectColorMode(env, stream)`, `toAnsi256(r, g, b)`, `framebufferToText(fb, opts)`,
`ColorMode`, and `ansi` (cursor control strings). The lower layers are reachable
at `@three-ws/tty-3d/model`, `/raster` and `/term` if you want the framebuffer
rather than the text.

## How it looks like graphics and not ASCII art

Each character cell is a `▀` (upper half block) with its own foreground and
background colour, so one cell carries **two** independently coloured pixels.
That doubles vertical resolution and, more importantly, makes pixels square:
terminal cells are roughly 1:2, so a half-block grid has a 1:1 pixel aspect and a
sphere comes out round instead of squashed.

Colour depth is detected conservatively. Guessing truecolor wrong sprays literal
escape sequences across the user's screen; guessing 256 wrong just looks flatter.
`NO_COLOR` is honoured, and `THREE_TTY_COLOR` forces a mode.

## Three things that are easy to get wrong

These are documented because each one shipped as a bug during development and is
now covered by a regression test.

1. **The skinned mesh node transform must be ignored.** glTF defines the skinning
   matrix as `inverse(meshNodeWorld) * jointWorld * inverseBind`, then transforms
   the result by `meshNodeWorld` again, so the two cancel. Applying the leading
   inverse without re-applying the outer transform cancels the skeleton's up-axis
   correction and lays the character on its back.
2. **A matrix multiply must not alias its own output.** `multiply(m, ibm, m)`
   reads `m`'s earlier columns while writing later ones. The result looks like a
   plausible matrix and renders as spikes radiating out of every joint.
3. **Unresolvable joints must keep their slot.** `JOINTS_0` indexes the joint list
   positionally, so filtering a hole out renumbers every joint after it and rigs
   vertices to the wrong bones.

## Framing

The camera radius is fixed from the widest frame of the clip while the centre is
recomputed per frame. Fitting the current frame alone makes the camera breathe as
the silhouette changes; unioning every frame is worse on anything with root
motion, because the union is a corridor as long as the character walks and fitting
that corridor shrinks the character to a speck.

## Tests

```bash
npx vitest run packages/tty-3d/tests
```

The fixtures are the Khronos sample models this repository already ships
(`cesium-man`, a skinned walk cycle with a Z-up skeleton root; `brainstem`, many
primitives and materials).

## License

Apache-2.0.
