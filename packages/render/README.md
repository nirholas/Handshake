# @three-ws/render

**Render rigged, animated 3D avatars with no GPU, no WebGL, and no headless
browser.** A pure JavaScript software rasterizer for glTF/GLB that outputs PNG,
animated PNG, and truecolor terminal ANSI.

Everything is a pure function of bytes in and pixels out, so the same call works
in a serverless handler, a CLI, a cron job, or a test. No display, no driver, no
Chromium.

## Install

```bash
npm install @three-ws/render
```

## Library

```js
import { writeFile } from 'node:fs/promises';
import { renderAvatar, encodePng } from '@three-ws/render';

const { frames } = await renderAvatar('https://three.ws/avatars/default.glb', {
	width: 512,
	height: 512,
	focus: 'head',
});
await writeFile('avatar.png', encodePng(frames[0]));
```

Animate it, retargeting a clip from a second file onto this skeleton by bone name:

```js
import { renderAvatar, encodeApng } from '@three-ws/render';

const { frames } = await renderAvatar('avatar.glb', {
	animation: 'walk.glb',
	clip: 'Walk',
	frames: 36,
	spin: 360,
});
await writeFile('turntable.png', encodeApng(frames, { fps: 20 }));
```

## In a terminal

```bash
three-ws-tty avatar.glb
three-ws-tty https://three.ws/avatars/default.glb --focus head --spin 360 --loop
three-ws-tty avatar.glb --animation walk.glb --clip Walk --out walk.png --frames 36
three-ws-tty avatar.glb --clips        # list the clips and exit
```

| Option | Meaning |
| --- | --- |
| `--out <file>` | Write a PNG (animated PNG when `--frames` > 1) |
| `--width`, `--height` | Output size in pixels (default: fits the terminal) |
| `--focus <mode>` | `full`, `bust`, or `head` (default: `full`) |
| `--preset <name>` | `studio`, `terminal`, or `daylight` (default: `terminal` for a tty) |
| `--clip <name\|idx>` | Clip to play, from the model or from `--animation` |
| `--animation <file>` | GLB or clip JSON to retarget onto this rig |
| `--frames <n>` | Frame count (default: 1, or 36 with `--spin`) |
| `--fps <n>` | Frames per second (default: 20) |
| `--spin <deg>` | Turntable degrees across the loop |
| `--yaw`, `--pitch` | Camera angles (defaults: 26, 6) |
| `--bg <color>` | Hex colour, or `transparent` |
| `--loop` | Keep animating in the terminal until interrupted |
| `--blocks` | Force half-blocks even where inline images work |

The terminal output adapts to what the terminal can actually do: Kitty and iTerm2
get real inline images, everything else gets truecolor half-blocks, and a
256-colour fallback exists for terminals that need it. `detectTerminal()` is
exported if you want to make that decision yourself.

## API

| Export | What it does |
| --- | --- |
| `renderAvatar(source, options)` | Load and render in one call. Returns `{ model, frames }`. |
| `loadModel(source, options)` / `AvatarModel` | Load once, render many times. |
| `renderFrame(model, opts)` / `renderFrames(model, opts)` | The rasterizer. |
| `frameCamera()`, `PRESETS`, `FOCUS` | Camera framing, lighting presets, focus modes. |
| `encodePng(frame)` / `encodeApng(frames, opts)` | Pixels to bytes. |
| `toHalfBlocks()`, `toKitty()`, `toITerm()`, `to256()`, `detectTerminal()`, `CURSOR` | Terminal output. |
| `retargetClip()`, `normalizeBoneName()` | Retarget a clip onto a different humanoid rig by bone name. |
| `parseClipJson()`, `loadClipJson()` | Load clips from JSON, including [`@three-ws/motion`](../motion) output. |
| `parseGlb()`, `packGlb()`, `extractImages()`, `stripImages()` | GLB container surgery. |
| `decodeImage()`, `decodePng()`, `buildMipmaps()` | Texture decoding. |

## Why this exists

Rendering an avatar server-side normally means a GPU instance or a headless
browser: slow to start, expensive to keep, and awkward to run inside a request.
A software rasterizer that is a pure function of bytes has none of those
problems. It is fast enough for an `<img>` endpoint, deterministic enough for a
snapshot test, and small enough to run in a cron job.

## Related

- [`@three-ws/motion`](../motion): generate the clip this renders.
- [`@three-ws/glb-diff`](../glb-diff): the structural check alongside the visual one.
- [`STRUCTURE.md`](../../STRUCTURE.md): where every three.ws surface lives.

## License

Apache-2.0
