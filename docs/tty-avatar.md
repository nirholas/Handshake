# Terminal avatar (`@three-ws/tty-avatar`)

Every three.ws avatar and every agent's 3D body can run in a terminal. One command, no browser, no GPU:

```sh
npx @three-ws/tty-avatar 81a076b6-55ff-49a2-b007-1d88e7dce2aa
```

That draws the avatar in colour at 24 frames a second in whatever terminal you are in, swaying gently, and keeps it there until you press Ctrl-C. Point it at an agent instead (`agent:<id>`) and you get that agent's bound body. Point it at any `.glb` on disk or on the web and it draws that.

The reason it exists is the second half: wire it to Claude Code once and the avatar becomes your coding agent's face. It looks up and thinks while the agent reads your prompt, nods quickly while it edits and runs commands, shakes when a tool fails, pulses when the agent is waiting on you, and bounces when it finishes. The caption under it says what the agent is doing right now (`editing index.js`, `$ npm test`, `searching`).

## Try it

Pick any avatar in the [gallery](/gallery). Its page's **Embed** tab has a **Terminal** section with the exact command for that avatar. Or use an agent from [/agents](/agents) with `agent:` in front of its id.

```sh
# a three.ws avatar
npx @three-ws/tty-avatar 81a076b6-55ff-49a2-b007-1d88e7dce2aa

# an agent's body
npx @three-ws/tty-avatar agent:bd1b56b0-5494-47e2-ad78-04ef4c43ae5b

# the page URL works too
npx @three-ws/tty-avatar https://three.ws/avatars/81a076b6-55ff-49a2-b007-1d88e7dce2aa

# your own model
npx @three-ws/tty-avatar ./hero.glb --mode braille --zoom 1.3
```

Three glyph modes. `blocks` (default in a terminal) draws truecolor half-blocks, two colours per cell. `braille` draws 2x4 dots per cell for four times the vertical detail. `ascii` is a plain luminance ramp with no colour codes, and is what you get automatically when the output is piped, so `npx @three-ws/tty-avatar snapshot <id> > avatar.txt` produces something you can paste anywhere.

## Give your coding agent a face

```sh
npx @three-ws/tty-avatar install-hooks --write
```

That merges nine hook entries into `~/.claude/settings.json` (it leaves any hooks you already have alone, and running it twice does not duplicate them). Open two panes: run the viewer in one, Claude Code in the other.

| What Claude Code does | What the avatar does |
|---|---|
| Starts a session | bounces once, "session started" |
| Reads your prompt | tilts and looks up, "reading your prompt" |
| Reads, edits, runs, searches | quick working nods with the file or command as the caption |
| A tool fails | a short shake, "Bash failed" |
| Needs your permission or input | pulses, with the notification text, until you answer |
| Finishes a turn | bounces, "done", then settles |
| Compacts context | thinks, "compacting memory" |
| Ends the session | head down, asleep |

The hook command that gets installed is just `cat > ~/.three-ws/tty-avatar/event.json`. It starts no interpreter, so it costs a tool call nothing. The viewer polls that file five times a second and maps each payload to a mood itself. Any agent runtime that can write a Claude-Code-shaped JSON payload to that path gets the same behaviour, and any script can drive the mood directly:

```sh
npx @three-ws/tty-avatar mood happy --say "deploy landed" --ttl 5000
npx @three-ws/tty-avatar say "migrating the database"
```

`install-hooks` without `--write` prints the JSON so you can paste it yourself; `--json` prints just the `hooks` object for another tool to merge.

## Moods

`idle`, `spin`, `think`, `work`, `talk`, `happy`, `attention`, `error`, `sleep`. Each is procedural whole-body motion (sway, tilt, nod, bounce, shake), which is why it works on any GLB with no rig at all, props included. Switching moods cross-fades over half a second so a burst of hook events never makes the model pop. `tty-avatar moods` lists them.

## As a library

```js
import { resolveSource, parseGlb, TtyAvatar, snapshot } from '@three-ws/tty-avatar';

const { bytes, name } = await resolveSource('agent:bd1b56b0-5494-47e2-ad78-04ef4c43ae5b');
const mesh = await parseGlb(bytes);

const viewer = new TtyAvatar(mesh, { name, fps: 24 });
viewer.setMood('talk', { say: 'hello from the terminal', ttlMs: 4000 });
await viewer.start();
```

`snapshot(mesh, { mode, columns, rows, yaw, pitch, zoom, mood })` returns one frame as a string without touching the terminal, which is how the package tests render and how you would put a frame in a log or a README. The rasterizer (`createFrame`, `render`) and encoders (`encodeBlocks`, `encodeBraille`, `encodeAscii`) are exported separately for anything custom. The full export table is in the [package README](https://github.com/nirholas/three.ws/tree/main/packages/tty-avatar#library).

## How it draws

The terminal is the framebuffer. A character cell is split into subpixels (1x2 for half-blocks, 2x4 for braille), the mesh is projected with a perspective camera onto that grid, and a z-buffered scanline fill writes one lit colour per subpixel. Faces are shaded with a key light, a fill light, an ambient floor and a rim term so silhouettes stay legible on both dark and light terminal themes. Colour comes from each primitive's material factor and vertex colours; textures are not sampled because a cell is far coarser than a texel. A typical 20k-triangle three.ws avatar renders in under 5 ms per frame at 160x96 subpixels, so 24 fps costs a fraction of one core.

Id resolution uses the same public endpoints the web studio does: `/api/avatars/:id` for an avatar's `model_url`, `/api/agents/:id` for an agent's `avatar_model_url`. Models are decoded with `@gltf-transform`, so meshopt-compressed three.ws avatars and Draco files load as-is.

## Related

- [Avatar CLI](/docs/avatar-cli): manifests, validation and embed snippets from the shell.
- [Web component](/docs/web-component): the same avatar in a browser.
- [Share & embed](/docs/share-and-embed): every other way to put an avatar somewhere.
- Source and tests: [packages/tty-avatar](https://github.com/nirholas/three.ws/tree/main/packages/tty-avatar).
