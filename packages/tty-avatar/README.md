# @three-ws/tty-avatar

**A live 3D avatar in your terminal.** Any GLB, or any three.ws avatar or agent by id, rendered by a software rasterizer to truecolor half-blocks or braille, animated with moods, and wired to Claude Code hooks so your coding agent has a face that thinks while it reads, works while it edits, and celebrates when it stops.

```
npx @three-ws/tty-avatar 81a076b6-55ff-49a2-b007-1d88e7dce2aa
```

No GPU, no browser, no account. Node 18+ and a terminal that can show colour.

```
                        ahd0w
                        bp00
                       h0mYow#
                       hJQpbh**d
                     oo####*ahdod
                     hhohaadwCkaw
                    #abQhaoZZao*om
                    *dwOo*bqO*#wUu
                   #*qk**aU0#*qJ
                  MqUo**hQw*#OL
                 Mp  o*omh##mqL
                #w  o*ooo**hba0
                L#   hhkqcZpZpO
                     bqmU ZpbdC
                      qmU  pdbC
                      qqU   qbQ
                      bU0   LO0
```

That is the `ascii` mode of a real three.ws agent body (`tty-avatar snapshot agent:bd1b56b0-5494-47e2-ad78-04ef4c43ae5b --mode ascii`), which is what you get when stdout is not a TTY. In a terminal you get colour and 24 frames a second.

## Install

```sh
npm i -g @three-ws/tty-avatar     # or: npx @three-ws/tty-avatar …
```

## Run

```sh
tty-avatar ./hero.glb                                   # a local model
tty-avatar https://example.com/robot.glb                # a URL
tty-avatar 81a076b6-55ff-49a2-b007-1d88e7dce2aa         # a three.ws avatar id
tty-avatar agent:bd1b56b0-5494-47e2-ad78-04ef4c43ae5b   # a three.ws agent (its 3D body)
tty-avatar https://three.ws/avatars/81a076b6-55ff-49a2-b007-1d88e7dce2aa   # a page URL
```

Options:

| Flag | Meaning |
|---|---|
| `--mode blocks\|braille\|ascii` | Glyph set. `blocks` (default on a TTY) is 1x2 truecolor half-blocks. `braille` is 2x4 dots per cell, four times the vertical detail. `ascii` is a luminance ramp with no escapes, the default when piped. |
| `--mood <name>` | Starting mood (`tty-avatar moods` lists them). |
| `--fps <n>` | Frame rate, default 24. |
| `--columns <n> --rows <n>` | Override the terminal size. |
| `--yaw <deg> --pitch <deg>` | Base rotation added to the mood's motion. |
| `--zoom <x>` | 1 fits the whole model; 1.4 fills the frame with the upper body. |
| `--frames <n>` | Exit after n frames (recording, CI). |
| `--no-caption` | Hide the name and mood line. |
| `--no-alt` | Draw inline instead of on the alternate screen. |
| `--max-triangles <n>` | Decimate by stride above this many triangles (default 240000). A 20k-triangle avatar renders in under 5 ms per frame at 160x96 subpixels. |
| `--origin <url>` | three.ws origin for id lookups. |
| `--state-dir <dir>` | Where mood and hook files live (default `~/.three-ws/tty-avatar`, or `$TTY_AVATAR_DIR`). |
| `--no-state` | Ignore the state directory. |

## Moods

A mood is procedural whole-body motion: no rig needed, so it works on any GLB, a prop included.

| Mood | Reads as |
|---|---|
| `idle` | slow sway, breathing |
| `spin` | turntable |
| `think` | tilted, looking up, slow sway |
| `work` | small quick nods, like typing |
| `talk` | bobbing on a speech rhythm |
| `happy` | bouncing |
| `attention` | pulsing, asking for you |
| `error` | a fast shake |
| `sleep` | head down, slow breathing |

Change the mood of a running viewer from any other shell:

```sh
tty-avatar mood happy --say "deploy landed" --ttl 5000   # back to idle after 5 s
tty-avatar say "running the migration"
```

## Give your coding agent a face

Claude Code emits a hook event for every prompt, tool call, notification and stop. Wire them to the viewer once:

```sh
tty-avatar install-hooks --write        # merges into ~/.claude/settings.json
```

Then run a viewer in a split pane (`tty-avatar <avatar id>`) and start Claude Code in another. The avatar now:

| Claude Code event | Mood | Caption |
|---|---|---|
| `SessionStart` | happy | session started |
| `UserPromptSubmit` | think | reading your prompt |
| `PreToolUse` | work | `editing index.js`, `$ npm test`, `searching`, `browsing`, `delegating` |
| `PostToolUse` | think, or error when the tool reported failure | `Bash done` |
| `Notification` | attention (30 s) | the notification text |
| `Stop` / `SubagentStop` | happy (4 s) | done |
| `PreCompact` | think | compacting memory |
| `SessionEnd` | sleep | session ended |

The installed hook command is `mkdir -p … && cat > ~/.three-ws/tty-avatar/event.json`. It is not a Node process, so it adds nothing measurable to a tool call; the viewer polls the file and does the mapping. `tty-avatar install-hooks` without `--write` prints the JSON fragment instead, and `--json` prints just the `hooks` object for another tool to merge.

Any other runtime can drive it the same way: write a Claude-Code-shaped payload to `event.json`, or call `tty-avatar mood` / `tty-avatar say` from a script.

## Snapshot

```sh
tty-avatar snapshot ./hero.glb --mode braille --columns 80 --rows 40 --yaw 30
tty-avatar snapshot 81a076b6-55ff-49a2-b007-1d88e7dce2aa --plain > avatar.txt
```

One frame, then exit. `--mood` and `--yaw`/`--pitch` pose it.

## Library

```js
import { resolveSource, parseGlb, TtyAvatar, snapshot } from '@three-ws/tty-avatar';

const { bytes, name } = await resolveSource('81a076b6-55ff-49a2-b007-1d88e7dce2aa');
const mesh = await parseGlb(bytes);

// A viewer that owns the terminal until stop():
const viewer = new TtyAvatar(mesh, { name, mode: 'blocks', fps: 24 });
viewer.on('mood', ({ mood, say }) => console.error(mood, say));
setTimeout(() => viewer.setMood('happy', { say: 'tests green', ttlMs: 3000 }), 2000);
await viewer.start();

// Or one frame as a string, no terminal involved:
console.log(snapshot(mesh, { mode: 'ascii', columns: 60, rows: 30, yaw: 0.5 }));
```

Exports:

| Export | What |
|---|---|
| `resolveSource(input, { origin })` | file path, URL, avatar id, `agent:<id>`, or three.ws page URL → `{ bytes, name, source, url, page }` |
| `parseGlb(bytes, { maxTriangles })`, `loadGlbFile(path)` | GLB → `{ positions, normals, tints, count, bounds }` (unit sphere, Y-up, node transforms baked, meshopt and Draco decoded) |
| `createFrame(w, h)`, `render(mesh, frame, pose, camera)` | the rasterizer: z-buffered scanline fill, back-face culling, key + fill + rim lighting |
| `encode(frame, { mode })`, `encodeBlocks`, `encodeBraille`, `encodeAscii`, `stripAnsi`, `MODES` | frame → lines |
| `MOODS`, `MOOD_NAMES`, `isMood`, `poseAt(current, previous, now)` | motion functions and the cross-fade between them |
| `TtyAvatar` | the frame loop: `start({ frames })`, `stop()`, `setMood(name, { say, ttlMs })`, `setCaption(text)`, `renderLines()`, events `frame`, `mood`, `stop` |
| `snapshot(mesh, opts)` | one frame as a string |
| `writeState`, `writeEvent`, `pollState`, `moodForHookEvent`, `defaultStateDir`, `statePaths` | the file bridge |
| `claudeHooksConfig(dir)`, `installClaudeHooks({ settingsPath, dir })`, `hookCommand(dir)` | Claude Code wiring |

## How it draws

The terminal is the framebuffer. Each character cell is split into subpixels (1x2 for half-blocks, 2x4 for braille), the mesh is projected with a perspective camera onto that grid, and a z-buffered scanline fill writes one lit colour per subpixel. Shading is per face: a key light, a fill light, an ambient floor, and a rim term so silhouettes stay readable on dark and light backgrounds. Colour comes from each primitive's material `baseColorFactor` (and `COLOR_0` when present); textures are not sampled, because a cell is far coarser than a texel and a flat tint under lighting reads better at 80 columns.

Half-block mode packs two colours into one cell (foreground on `▀`, background behind it), so a 100x40 terminal is a 100x80 colour image. Braille mode packs eight coverage bits per cell with one colour, so the same terminal is a 200x160 monochrome-per-cell image.

## Tests

```sh
npm test
```

Builds a real GLB in memory with `@gltf-transform/core`, runs it through the loader, rasterizer, every encoder, the mood blender, the state bridge, the hook installer, and the CLI end to end.

## Links

- Docs: https://three.ws/docs/tty-avatar
- Pick an avatar: https://three.ws/gallery (every avatar page's Embed tab has the `npx` line)
- Source: https://github.com/nirholas/three.ws/tree/main/packages/tty-avatar

Apache-2.0.
