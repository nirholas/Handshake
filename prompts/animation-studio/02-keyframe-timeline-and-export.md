# Task 2 — Keyframe timeline, AnimationClip baking, live preview, and export

> Read `prompts/animation-studio/00-README.md` first (shared architecture, clip format, rules).
> Follow `CLAUDE.md`. No mocks, no stubs, wire 100%, design every state, verify in a real browser.
>
> **Depends on Task 1** (`01-avatar-loading-and-rigged-posing.md`): a skeleton-agnostic rig
> abstraction exposing `getPose()` / `applyPose(pose)` / per-bone quaternion getters/setters for
> both the primitive mannequin and loaded GLB avatars. Read Task 1's handoff note for the exact
> method names before starting.

You are turning the poser into an **animation recorder**: the user sets a pose, drops a keyframe on
a timeline, advances the playhead, re-poses, drops another keyframe — and the studio interpolates
between keyframes and plays the result. This is how a walk cycle / wave / dance gets authored.

## Outcome

On `/pose`, with a mannequin or rigged avatar loaded, a user can:
1. Add/move/delete **keyframes** on a timeline scrubber. Each keyframe captures the current pose.
2. Scrub the playhead and see the rig interpolate between keyframes; **play/pause/loop** the whole
   animation in real time.
3. Set animation **duration**, **fps**, per-keyframe **easing**, and **loop** on/off.
4. **Bake** the keyframes into a `THREE.AnimationClip` whose tracks use canonical bone names — i.e.
   the exact format that plays everywhere on three.ws (see README "Animation clip format").
5. **Export** the result as (a) a **GLB with embedded animation** and (b) a three.ws **clip JSON**.

## What to build

### 1. Keyframe data model
- A keyframe = `{ id, time /* seconds */, pose /* canonical getPose() snapshot */, easing }`.
- Keep them sorted by time. Adding a keyframe captures `rig.getPose()` at the current playhead.
  Re-dropping at an existing time updates it. Deleting and dragging-to-retime are supported.
- Store the editing document as `{ name, duration, fps, loop, keyframes[] }` in module state. This
  is the in-memory project Task 4 will serialize/save.

### 2. Interpolation + live preview
Two acceptable approaches — choose one and implement it fully:
- **(Preferred) Bake-then-mix:** build a `THREE.AnimationClip` from the keyframes (see baking
  below) and drive it with a `THREE.AnimationMixer`; scrub by `mixer.setTime(t)`; play by ticking
  `mixer.update(dt)` in the existing render loop. Re-bake when keyframes change (debounced).
- **Manual interpolation:** between bracketing keyframes, `slerp` each bone quaternion and `lerp`
  the root position by the eased fraction, then `applyPose()`. 

Quaternion interpolation (slerp) for rotations is required — do not lerp Euler angles (gimbal
artifacts). Apply per-keyframe easing (at minimum: linear, ease-in, ease-out, ease-in-out).

### 3. Baking to a three.ws-compatible AnimationClip
- For each posed bone, emit a `QuaternionKeyframeTrack` named `"<CanonicalBone>.quaternion"` with
  `times` = keyframe times and `values` = flattened `[x,y,z,w,...]`. Emit a
  `VectorKeyframeTrack`/position track `"Hips.position"` for root translation.
- Use the **canonical Avaturn/Mixamo bone names** from the README (`Hips`, `Spine`, `Head`,
  `LeftArm`, `RightUpLeg`, ...). The rig abstraction from Task 1 already keys poses by normalized
  names — map them to these canonical track names so the clip plays on standard three.ws avatars.
- The baked clip's `.toJSON()` must match the documented clip JSON shape
  (`{ name, duration, tracks:[{name,type,times,values}] }`). Verify by round-tripping through
  `AnimationClip.parse()`.

### 4. Timeline UI (the craftsmanship)
- A horizontal **timeline track** with a draggable **playhead**, time ruler (seconds), and
  **keyframe diamonds** the user can click to select, drag to retime, and delete.
- Transport controls: play / pause / stop, loop toggle, jump-to-start/end, current-time readout.
- Inputs for total **duration** and **fps**; an **easing** picker for the selected keyframe.
- An **"Add keyframe"** button (and a keyboard shortcut, e.g. `K`) that captures the current pose
  at the playhead. Visual confirmation when a keyframe is added/updated.
- **Optional polish (do if time allows, fully wired or omitted):** onion-skinning (ghost the
  neighbouring keyframe poses) to help align a walk cycle.
- Empty state: when there are zero keyframes, explain the workflow ("Pose the figure, then press
  Add keyframe to start your animation"). Never a blank void.

### 5. Export
- **GLB with animation:** reuse the `GLTFExporter` path from [src/avatar-export.js](../../src/avatar-export.js)
  (it already passes `animations`). Export the current rig (or a clean skeleton when on the
  mannequin) with the baked clip embedded; download as `.glb`. The exported file must play its
  animation when re-opened in the three.ws viewer.
- **Clip JSON:** download the baked `clip.toJSON()` as a `.json` matching
  `public/animations/clips/*.json`. This is the artifact that Task 4 saves to the account and Task
  5 plays via `AnimationManager`.
- Both export buttons must have loading + success + error states.

### 6. Provide a clean handoff API for Task 4/5/6
Expose (in module state or a small exported object): the current editing document, a
`bake()` returning the `AnimationClip`, `serializeClip()` returning the clip JSON, and a
`captureThumbnail()` (reuse the existing PNG capture) so Task 4 can save without re-implementing.

## Definition of done
- A user can build a multi-keyframe animation (e.g. a 4–6 keyframe walk cycle on a rigged avatar),
  scrub it, and **play it looping** smoothly — verified in the browser, no console errors.
- Rotations interpolate via slerp (no gimbal popping); easing visibly changes timing.
- "Export GLB" produces a file that **plays its animation** when loaded in the three.ws viewer
  (verify by loading the exported GLB). "Export JSON" matches the clip JSON schema and
  `AnimationClip.parse()` accepts it.
- Timeline empty/loading/error states designed; every control has hover/active/focus + ARIA.
- `npm test` green. Add a small unit/contract test for the bake → `toJSON` → `parse` round-trip if
  the suite has a matching location (e.g. under `tests/`). Run `completionist`; fix all findings.
- Handoff note: the names of the `bake()`/`serializeClip()`/`captureThumbnail()` accessors Task 4
  will call, and the editing-document shape.

Do not build account saving or monetization here (Tasks 4 and 6).
Do not push unless the user explicitly approves (then both remotes per CLAUDE.md).
