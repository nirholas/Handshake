# Animation Studio: pose, keyframe, and sell motion

Animation Studio is where a three.ws avatar (or a built-in mannequin) becomes animated. Click any body part and rotate it with a gizmo, or drag a hand or foot and let inverse kinematics solve the limb. Drop the pose as a keyframe, advance the playhead, re-pose, and drop another; the studio interpolates between them and plays the result. Export the finished motion as an animated GLB or as clip JSON, save it to your account, deep-link it to play on any avatar, hand it to [Scene Studio](./scene-studio.md) to record as video, or list it for sale in the animation marketplace for USDC.

Page: [/pose](https://three.ws/pose) · API: `/api/animations/clips`

> This page covers the Animation Studio surface. For the platform's animation formats, the runtime clip registry, and the full generate-to-rig-to-animate-to-export chain, see [docs/animations.md](./animations.md) and [docs/3d-asset-pipeline.md](./3d-asset-pipeline.md).

## Why it exists

Rigging and animation are the steepest part of 3D. Animation Studio flattens it into something you can do in a browser with a mouse, on the exact avatar you already made, and then actually use the result: play it across the platform, record it, or earn from it. It is built so that posing is direct (grab a body part, move it), keyframing is a two-button loop (pose, drop key), and every export path leads somewhere real, a downloadable file, an account clip, a scene render, or a marketplace listing, rather than a dead end.

## How it works

The studio is a Three.js scene with filmic tone mapping and image-based lighting, a shadow-catching ground, a grid, and a posable rig. The rig is one of two kinds behind a common interface: the built-in primitive **mannequin** (with adjustable build, skin color, and optional biological joint constraints) or a **loaded rigged GLB**, including your own three.ws avatars, resolved through the avatar gallery picker or `?avatar=<id>`.

### Posing: FK and IK

- **FK (forward kinematics).** Click a body part to select its bone; a rotate gizmo attaches, and three sliders (bend/pitch, twist/yaw, tilt/roll) show and set the exact Euler angles. A searchable bone list lets you jump to any joint by name.
- **IK (inverse kinematics).** Switch to IK and drag a glowing hand or foot handle; the limb chain solves to follow it. IK is available only when the rig exposes recognizable limb chains; the toggle disables itself and explains why when it cannot.
- **Pose tools.** Undo/redo (100 deep, with drags collapsing to a single step), mirror left-to-right, copy/paste a pose, a preset picker grouped by category, per-bone reset, and keyboard shortcuts (F for FK, I for IK, M mirror, C/V copy-paste, R reset bone, Escape deselect).

### The keyframe timeline

Set a pose, drop a keyframe on the playhead, move the playhead, re-pose, drop another. The render loop samples the document at the current time (slerping between keyframes) and plays it back. Each keyframe carries an easing curve you can change. You control the clip name, duration, FPS, and loop flag. Transport is play/pause/stop with start/end jumps. Keyframes drag along the lane and delete with a key. In-progress work autosaves to local storage and is offered back on the next visit, and an unload guard warns before you lose unsaved keyframes.

### Preset and text-to-animation library

A curated gallery of ready-made motion clips sits beside the timeline. Picking one retargets it onto the loaded rig and plays it live in the same viewport, then offers an animated-GLB export. The library also drives a text-to-animation path (`POST /api/forge-motion`), so you can describe a motion and get a clip retargeted onto your figure. While a preset previews, it owns the figure and the keyframe timeline yields, so the two never fight over bone transforms.

### ASL fingerspelling

Under the motion generator sits a Spell box: type a word and the avatar spells it letter by letter in American Sign Language on its right hand. All 26 handshapes are built in, including the traced motions for J and Z and the small bounce signers use to mark double letters; between letters the hand transitions smoothly and the figure holds a natural signing posture (right hand raised palm-out, off hand relaxed). Spelling is generated locally in the browser from a parametric hand model (`src/fingerspelling.js`), so it is instant, deterministic, and works offline; nothing is sent to a server. The spelled clip plays through the same retarget path as a preset, which means scrub, speed, stop, and the animated-GLB export all work on it, and it plays on any rigged avatar whose skeleton includes finger bones. A rig without finger bones cannot form handshapes, so the studio refuses it with an explanation instead of playing a wrong result.

Fingerspelling is the deterministic, spelling-based subset of sign language, it spells English words rather than translating into grammatical ASL. It is the first step of the platform's signing-avatars work; lexical signs come from the motion-capture lane, which can turn video of a real signer into a library clip.

### Export, save, and sell

- **Clip JSON** serializes the keyframe document to a documented `{ name, duration, tracks }` shape.
- **Animated GLB** bakes the document onto the live rig and exports the mesh with the clip embedded, so the motion plays anywhere the GLB is opened. This baked GLB is also the sellable artifact for a marketplace listing.
- **Open in Scene Studio** stashes the baked GLB in IndexedDB and navigates to `/scene?handoff=1`, where you record it to video.
- **Save to account** stores the clip through `/api/animations/clips` with a visibility of private, unlisted (anyone with the link), or public (listed in the gallery). Saved clips appear under "My animations".
- **Sell for USDC.** Each saved clip has a Sell action that lists it in the animation marketplace; listed clips show a price badge in USDC, and your sales and earnings live under [/marketplace?tab=earn](https://three.ws/marketplace?tab=earn).

## Walkthrough

1. Open [/pose](https://three.ws/pose). The mannequin loads in a starting pose. Click "Load avatar" to pose one of your own instead, or keep the mannequin.
2. Click the mannequin's forearm; the rotate gizmo appears. Drag it, or use the sliders, to bend the arm. Or switch to IK and drag the hand.
3. Set the timeline's duration and FPS. With the playhead at 0, pose the figure and click "Add keyframe".
4. Move the playhead forward, change the pose, and add another keyframe. Press play to watch it interpolate.
5. Tune easing per keyframe, mirror or copy/paste poses, and refine.
6. Export: download the animated GLB or clip JSON, click "Open in Scene Studio" to record video, or "Save" to keep it in your account.
7. To monetize, open the saved clip in "My animations" and click Sell to list it for USDC.

## Examples

Deep links into the studio:

- **Pose a specific avatar:** `https://three.ws/pose?avatar=<avatarId>`
- **Animate a model by URL** (from the viewer's "Animate" funnel; trusted-host gated): `https://three.ws/pose?src=<glbUrl>&title=My%20model`
- **Open a saved clip or a preset:** `https://three.ws/pose?anim=<clipUuidOrPresetName>`: a 36-char UUID opens your saved clip; anything else opens a built-in preset (auto-loading a rigged avatar to play it on).

The account clip API the studio drives:

```bash
# List your clips, plus public ones.
curl 'https://three.ws/api/animations/clips?include_public=true&limit=60' \
  -H 'cookie: <session>'

# Create a clip from a serialized keyframe document.
curl -X POST 'https://three.ws/api/animations/clips' \
  -H 'content-type: application/json' -H 'cookie: <session>' \
  -d '{"name":"wave-loop","visibility":"public","clip":{ "name":"wave-loop","duration":2,"tracks":[] }}'
```

## States & limits

- **IK requires limb chains.** On rigs without recognizable arm/leg chains the IK mode disables itself; FK posing always works.
- **Presets need a rigged figure.** Deep-linking straight to an animation with no avatar chosen auto-loads a built-in rigged avatar (deterministically picked from the clip id) so the motion has a body to play on.
- **Autosave is local, not the account.** Posing and keyframing never touch your account until you explicitly Save. The autosave draft lives in local storage and is offered back next session; an unload guard warns while work is unsaved.
- **Saving and selling need an account.** Export and download are open to everyone; saving to the library and listing for sale require sign-in.
- **The sellable artifact is the baked GLB.** A marketplace listing sells the baked animated GLB, so the buyer gets a self-contained, playable file.
- **Mannequin-only controls.** Build, skin color, and joint constraints apply to the primitive mannequin; on a loaded GLB avatar those controls are disabled.
- **Fingerspelling spells A to Z.** The Spell box keeps letters and spaces and drops everything else (digits and punctuation have distinct signs that are not letter handshapes). It needs a loaded rigged avatar with finger bones; the mannequin and finger-less rigs are refused with an explanation.

## Related

- [Animations reference](./animations.md): the runtime clip registry, formats, and agent slots.
- [3D asset pipeline](./3d-asset-pipeline.md): how GLB, FBX, and clip JSON convert across the platform.
- [Scene Studio](./scene-studio.md): record your animation to video.
- [Avatar Studio](./avatar-studio.md): build the avatar you animate here.
- [/marketplace](https://three.ws/marketplace): where listed animation clips are bought and sold.
