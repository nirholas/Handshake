# 06. The live 3D home

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Orders
[03](home-03-api-surface.md) and [05](home-05-connect-flow.md) must have landed.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**This is the order that produces the screenshot.** It is the reason three.ws is building this
and not somebody else. Everyone who has tried this shipped a flat SVG floorplan; we already ship
a Three.js renderer, an avatar pipeline and a physics-capable scene. Hold that bar.

---

## Step 0: re-derive the current state

```bash
npm run dev &
curl -N -s localhost:3000/api/home/<id>/stream -H "cookie: <dev session>" | head -40
node -e "console.log(require('./package.json').dependencies.three)"
ls src/ | grep -iE "viewer|scene|stage" | head -10
grep -rn "summarizeLighting\|summarizeSecurity" packages/home-bridge/src/rooms.js | head
```

## What this order owns

`/home/:id`: a live 3D model of the house, with the agent's body standing in it, driven entirely
by the SSE stream from order 03. It owns rendering and reactivity. It does **not** own the room
layout authoring (order 07) or voice (order 08).

## The mapping, room graph to scene

`buildHomeGraph` already produces exactly what a scene needs. Use it; do not invent a second
model.

| Graph field | Scene |
|---|---|
| `floors[]` | vertical stacking, one plane per level, ordered by `level` |
| `rooms[]` | a volume per room, labelled, arranged by order 07's saved layout or the default pack |
| `room.lighting.on` / `.brightness` / `.rgb` | the room's actual light: intensity from `brightness` (0..1), colour from `rgb`, off means genuinely dark, not dimmed |
| `room.climate.temperature` | a readable value in the room, and a subtle warm/cool tint |
| `room.secured` | doors and windows render open or closed; `secure: false` is visible at a glance from across the room |
| `entity.domain` | the object drawn: light, cover, lock, media player, fan, camera, sensor |
| `entity.state === 'unavailable'` | drawn, but visibly unreachable. Never omitted: a device that vanished is information. |

**The agent stands in the scene.** Reuse the existing avatar pipeline rather than a new loader.
The agent's position is a product decision: it stands in the room the user is looking at, turns
toward the camera when spoken to, and reacts when it acts (it should be obvious which room just
changed and that the agent did it).

## Reactivity is the feature

- A real light changing in Home Assistant changes the scene inside one animation frame of the
  SSE event arriving. Measure this end to end and report the number.
- Changes animate. A light does not pop from 0 to 1; it transitions. Use `transform` and
  `opacity` where DOM, and a real interpolation where 3D.
- Stale is a first-class visual state. When order 02 reports `stale: true`, the scene desaturates
  and shows the age. **It never empties.** A user watching their house must never see it vanish.

## Performance budget (measure, do not assume)

| Quantity | Budget |
|---|---|
| First meaningful paint of the scene | under 2.5 s on a mid-range laptop, from a cold load |
| Steady-state frame rate | 60 fps on desktop, 30 fps floor on a mid-range phone |
| Heap after 10 minutes of live updates | flat. A leak here is a tab that dies overnight on a wall display. |
| Update cost | a state burst of 100 entities must not drop a frame |

Wall displays are the real deployment. Something that leaks 2 MB an hour is broken even if it
demos well.

## Every state

1. **Loading** the scene: skeleton, no layout shift, the room list readable before the 3D arrives.
2. **Empty house**: connected but zero entities. Say what to do in Home Assistant, do not show a void.
3. **No areas assigned**: very common. Every entity is unassigned. This must be a designed,
   useful view (a single room containing everything) plus a prompt into order 07, not a blank floor.
4. **Live**: the default.
5. **Stale**: desaturated, age visible, last known state intact.
6. **Disconnected**: distinct from stale; offers reconnect.
7. **Acting**: the agent is performing an action; the affected room is highlighted.
8. **Confirmation pending**: order 04 minted a confirmation; the scene shows exactly which entity
   is about to change, and the confirm control is adjacent to it, not in a distant toast.
9. **WebGL unavailable**: a real, complete 2D fallback. This is not optional; it is the
   accessibility and old-device path, and order 17 will hold you to it.
10. **Error**: actionable and retryable.

## Tasks

| # | Task | Files |
|---|---|---|
| 1 | Route `/home/:id`, page and controller. | `vercel.json`, `pages/home-scene.html`, `src/home/scene.js` |
| 2 | The scene builder: graph to geometry, pure and testable without a GPU. | `src/home/scene-model.js`, `tests/home-scene-model.test.js` |
| 3 | The renderer, subscribed to SSE, with interpolated transitions. | `src/home/scene-render.js` |
| 4 | The agent body in the scene, reusing the existing avatar loader. | same |
| 5 | The 2D fallback, complete enough to operate the house. | `src/home/scene-fallback.js` |
| 6 | All ten states. | as above |
| 7 | Performance instrumentation and the measured numbers. | your report |
| 8 | e2e: the scene reflects a real device change. | `tests/e2e/home-scene.spec.js` |

## Definition of done

- [ ] A video or frame sequence showing a real light being toggled in Home Assistant and the scene changing. Report the measured end-to-end latency.
- [ ] Screenshots of all ten states.
- [ ] The measured frame rate on desktop and on a throttled mobile profile.
- [ ] A ten-minute heap trace showing flat memory under live updates. Paste the numbers.
- [ ] Killing Home Assistant shows state 5 with the house intact and an age; restarting restores live with no reload.
- [ ] A house with zero assigned areas renders state 3 usefully, not as a blank floor.
- [ ] The 2D fallback is reachable (force it) and can read and act on the house.
- [ ] Zero console errors or warnings from your code.
- [ ] `npx playwright test tests/e2e/home-scene.spec.js` passes; `npx vitest run tests/home-scene-model.test.js` passes.
- [ ] `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| Real houses have no geometry in Home Assistant | Correct, and that is order 07. Ship a good default arrangement here (rooms packed by floor, ordered by name) that is usable before anyone authors anything. |
| A room has 60 entities and looks cluttered | Rank by what a person cares about: lights, locks, covers, climate first; sensors summarised. Do not draw 60 objects because 60 exist. |
| The 3D is slower than the 2D fallback on a phone | Measure, then fix, then re-measure. If a class of device genuinely cannot run it, route it to the fallback automatically and say so in the UI. |
| Tempted to poll instead of using the SSE stream | Do not. Order 03 built the stream, and polling a house is both slower and ruder. |
| The scene empties on disconnect | That is a bug, and the most user-visible one in this order. The graph is retained by design; render the retained one. |

## Report format

1. The live-change video or frame sequence, with the measured latency.
2. The ten state screenshots.
3. Frame rate and heap numbers.
4. The kill-and-restore transcript.
5. Test output.
6. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-06-3d-home-scene.md

Never delete it on a partial.
