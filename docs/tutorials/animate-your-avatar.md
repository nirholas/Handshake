# Animate your avatar

By the end of this tutorial you'll be able to take any rigged avatar, browse the three.ws clip library, apply a motion to it live, control its speed and looping, and export an animated GLB you can use anywhere. You'll also understand *why* a clip authored for one skeleton plays correctly on yours — the runtime retargeting that makes the library universal.

**Prerequisites:** a three.ws account and at least one rigged avatar ([create one](/create), or load any public avatar). No code required — everything here happens in the browser. Light JavaScript familiarity helps only for the optional "how retargeting works" section.

---

## What you're building

```
Pick an avatar  ──►  Browse the clip library  ──►  Click a clip
                                                        │
                                  retarget onto your rig + play live
                                                        │
                              tune speed / loop  ──►  export animated GLB
```

You don't author motion from scratch (you can — that's the keyframe timeline, a separate workflow). Here you *apply* and *remix* the shared library: dozens of pre-baked clips — idle, walk, dances, gestures, reactions — that drive **any** humanoid rig without manual bone mapping.

Two surfaces do this, and they're connected:

| Surface | Route | What it's for |
|---|---|---|
| **Animation Studio** | [/pose](/pose) | Load an avatar, apply or generate motion, tune it, export an animated GLB |
| **Animation Gallery** | [/animations](/animations) | Browse public community clips, preview on a live avatar, send any to the Studio |

The Gallery is where you *discover* a clip; the Studio is where you *apply* it. Every Gallery card's **Open in Studio** button deep-links to `/pose?anim=<id>`, so the two are one workflow.

---

## How clips drive any rig (two minutes of theory)

The thing that makes the library work is that **motion and body are stored separately**.

- An avatar is a **GLB** — geometry, skeleton, skin, textures.
- A motion is a **clip JSON** — keyframe tracks only, no geometry. One clip can play on every avatar.

A clip's tracks are named against a **canonical skeleton** — the 52-bone humanoid set exported as `CANONICAL_BONES` (`Hips → Spine → Spine1 → Spine2 → Neck → Head`, both arms `Shoulder → Arm → ForeArm → Hand` with finger chains, both legs `UpLeg → Leg → Foot → ToeBase`). Every clip in [public/animations/clips](../../public/animations/clips) is baked against the reference rig `public/avatars/cz.glb`.

Your avatar almost certainly names its bones differently — `mixamorig:Hips`, `DEF-spine`, `J_Bip_C_Hips`, `pelvis`, `leftUpperArm`. Two runtime modules bridge that gap:

1. **Bone-name canonicalization** ([src/glb-canonicalize.js](../../src/glb-canonicalize.js)) recognizes the common skeleton conventions — Mixamo (`mixamorig:`), Blender (`Armature_`, `.L`/`.R`), Rigify (`DEF-`/`ORG-`), Unreal (`upperarm_l`), VRM/VRoid (`J_Bip_L_UpperArm`), VRM 1.0 (`leftUpperArm`), Daz/Genesis (`lShldr`), MakeHuman, and simple rigs (`shoulderL`) — and maps each bone to its canonical name.

2. **Retargeting** ([src/animation-retarget.js](../../src/animation-retarget.js)) rewrites each track onto your rig's actual bone names, applies a per-bone bind-pose correction (so an A-pose clip plays right on a T-pose rig, and a hip baked at −90°X doesn't tip the body over), and rescales hip translation by your avatar's height so root motion lands where it should.

**There is no rig allowlist.** Any humanoid avatar drives the library through this canonicalize-then-retarget path. The only gates are sanity thresholds: a rig needs **≥8** recognizable humanoid bones, and a clip must map **≥50%** of its tracks onto the rig to land. Below that the motion would read as a few twitching joints, so the Studio refuses it with an actionable message instead of playing garbage. If you hit a brand-new skeleton convention the canonicalizer doesn't know, the fix is to add its bone-name mapping to `glb-canonicalize.js` — never to hardcode a curated list of supported rigs.

---

## Step 1: Open the Studio and load an avatar

![The Pose Studio at /pose: viewport in the middle, clip library and playback controls on the right.](figure:page:/pose?settle=6000)

Open **[/pose](/pose)**. You'll land on the built-in **mannequin** — a primitive figure for FK/IK posing. The mannequin has no skinned skeleton to export, so the preset library stays locked until you load a real avatar.

![The mannequin itself. It poses, but it carries no skinned skeleton, which is why the preset library stays locked until you load a rigged avatar over it.](figure:live:/avatars/mannequin.glb)

In the top bar, click **Load avatar** and pick one of your rigged avatars (or a public one). The right-panel **Animation** section unlocks the moment a compatible rig is loaded.

If you'd rather skip the picker, deep-link directly:

```
/pose?avatar=0f25b676-e27b-4929-875c-4135fea0f635
```

The Studio reads `?avatar=` on boot and loads it for you (swap in your own avatar's id from its `/avatars/<id>` page). Add `&anim=<clip-id>` and it also opens that saved clip; this is exactly what the Gallery's **Open in Studio** button does.

If the right panel shows **"Load a rigged avatar to animate"**, you're still on the mannequin — load an avatar. If it shows **"This rig can't be retargeted,"** the model exposes fewer than 8 recognizable humanoid bones (see Troubleshooting).

---

## Step 2: Browse the clip library

With an avatar loaded, the **Animation** section on the right fills with a searchable, categorized gallery:

- **Category chips** across the top (Featured plus grouped categories) filter the grid.
- **Search** ("Search animations…") matches clip labels and names as you type.
- Each **card** shows an icon, a label, and a **loop** / **once** badge so you know up front whether a clip cycles forever or plays a single shot.

The library covers a wide range — idle breaths, walks, dances, celebrations, reactions, sitting and crouching poses, and more. Browse by category, or search for what you want (e.g. `dance`, `wave`, `idle`).

> Want to browse the *full* community catalog first? Open the **[Animation Gallery](/animations)** in another tab. It lists public clips with hover-to-preview on a live avatar, a loop/one-shot filter, and infinite scroll. When you find one you like, click **Open in Studio** and it lands back here applied to your avatar.

---

## Step 3: Apply a clip

Click any card. The Studio:

1. Fetches that clip's JSON.
2. Retargets it onto your loaded rig (rewrites bone names, corrects the bind pose, scales the hips).
3. Plays it live on the figure in the viewport.

The shared 3D stage **is** the preview — one figure performing the motion, the way Mixamo previews look, rather than a wall of video thumbnails. The active card gets a "now playing" equalizer animation and a highlighted border.

The status line at the bottom of the stage confirms the retarget, e.g.:

```
Playing "Cheering" — 96% retargeted (51/53 bones matched).
```

That percentage is the coverage — how many of the clip's tracks found a home on your rig. (The counter is tracks, which the status line labels "bones": a full library clip carries 53 of them, one rotation track per canonical bone plus the hips' position track.) A couple of dropped bones (often fingers a simpler rig lacks) is normal and fine. If coverage falls below 50%, the clip won't apply and the status explains why (see Troubleshooting).

Clips marked **once** play a single shot and hold the final frame; **loop** clips cycle until you stop them or pick another.

---

## Step 4: Control playback — speed and loop

Once a clip is playing, a **transport bar** appears under the gallery:

- A pulsing **now-playing** indicator with the clip's name.
- A **Speed** slider, `0.25×` to `2.5×`. Drag it to taste — `1.8×` turns a walk into something close to a jog; `0.5×` slows a gesture down for emphasis. The value updates live.
- **⏹ Stop** ends the preview and hands the figure back to a clean rest pose.
- **Export animated GLB** (covered next).

Looping follows the clip's own `loop` flag (the **loop** / **once** badge). Speed is a live preview control *and* it's baked into the export — the GLB you download carries the tempo you previewed, not a default one.

To swap clips, just click a different card — the new motion retargets and replaces the old one. To compare two dances, apply one, watch it, then click the other; the transport always reflects what's currently playing.

---

## Step 5: Generate a motion that doesn't exist yet

The preset library is finite; your imagination isn't. At the top of the **Animation** section is a text-to-motion box:

```
Generate a motion — "waving confidently"   [ ✨ Generate ]
```

Type a short description (e.g. `waving confidently`, `a slow bow`, `excited jumping`) and click **Generate**. The Studio submits a motion job, polls until the clip is ready (typically ~10–30s on a warm GPU; up to ~90s), then **retargets and plays it on your rig through the exact same path as a preset.** A generated motion behaves identically — same transport, speed slider, loop, and export. The status line counts the seconds while it works.

If the deployment hasn't enabled text-to-animation, you'll get a clear "isn't enabled on this deployment yet" message rather than a hang. Either way, the preset library is always available.

---

## Step 6: Export an animated GLB

When a clip looks right, click **Export animated GLB** in the transport bar.

The Studio bakes the retargeted clip — at your chosen speed — onto your avatar's rig and downloads a single self-contained file:

```
<avatar-name>-<clip-name>.glb
```

This closes the loop: you started with a GLB (body) and a separate clip (motion), and you end with **one GLB that has the motion embedded.** It loads in any standard glTF viewer or in any three.ws surface, no retargeting required at play time.

The figure is parked on the clip's first frame before export, so the file's rest pose is the animation's actual start — not wherever the live preview happened to pause.

> The Studio can also export **clip JSON** (motion only, reusable on other rigs) and a **PNG screenshot** from the top bar, and — if you author your own motion on the keyframe timeline — save it to your account and list it. Those are adjacent workflows; this tutorial is the apply-and-remix path.

---

## Step 7: Discover and remix from the Gallery

The **[Animation Gallery](/animations)** is the social, browse-first side of the same system. It lists public, community-authored clips:

- **Search** and a **loop / one-shot** filter narrow the grid.
- **Hover or click a card** to launch a live preview — an embedded viewer plays the clip on the reference CZ avatar, so you see real motion, not a static thumbnail.
- **Open in Studio** deep-links to `/pose?anim=<id>`, dropping the clip into the Studio so you can apply it to *your* avatar, tune its speed, and export.

This is the remix loop: find a motion someone else published, open it in the Studio, retarget it onto your own avatar, adjust it, export. Because every clip is format-light JSON addressed by canonical bone names, the same clip that previewed on the CZ avatar drives your custom rig with no extra work.

---

## Emotion and expression on the live agent

Applying clips in the Studio is the **authoring** side. On a *running* agent, the same library drives emotion and gesture automatically through two channels that share one emotional state — the avatar's **Empathy Layer** ([src/agent-avatar.js](../../src/agent-avatar.js)):

**Gesture slots** ([src/runtime/animation-slots.js](../../src/runtime/animation-slots.js)) — a fixed vocabulary the agent plays in conversation. The conversational slots are `idle`, `wave`, `nod`, `shake`, `think`, `celebrate`, `concern`, `bow`, `point`, `shrug`, `fidget`, `dance`; a second group exists because skills emit the matching hint: `inspect`, `present`, `sign`, `curiosity`, `patience`, `manipulate`, `conjure`. Each slot resolves to a concrete library clip at runtime through `DEFAULT_ANIMATION_MAP` — most map to the clip of the same name (`celebrate` → `celebrate`, `think` → `think`), and a few borrow the closest baked motion where no dedicated clip exists yet (`concern` → `defeated`, `bow` → `sitclap`, `dance` → `rumba`). An agent picks a slot when the moment calls for it; the clip retargets onto that agent's avatar exactly as in the Studio. You can override any slot per agent via `meta.edits.animations` — point `wave` at a different clip, or map a slot to a motion you authored yourself.

**Facial expression** ([src/runtime/arkit52.js](../../src/runtime/arkit52.js)) — driven from the same blend of morph targets as the gesture layer, not a separate track. If your avatar carries ARKit-52 blendshapes (most modern avatar-platform exports do, as do VRoid models), the runtime resolves those morph targets and drives expression and lip-sync directly on the face. A skeletal clip plays the body; the blendshape layer plays the eyes, brows, and mouth on top.

The two channels are wired to the *same* emotional state, at two different timescales, so the body and the face never disagree:

- **Momentary events** (an error just happened, a skill just finished) inject a transient emotion spike — `concern`, `celebration`, `curiosity`, and friends — that decays over seconds. A spike crossing threshold both reshapes the face immediately *and* biases the gesture slot the avatar plays next (e.g. sustained `celebration` picks the `celebrate` slot).
- **Sustained mood** — the agent's resting valence/arousal, set via `setMood()` (see [docs/tutorials/emotion-from-data.md](emotion-from-data.md)) — is the continuous baseline between events. It biases the resting face (a soft smile at high valence, a worried brow at low) and posture (lean, gaze) every frame, and, once nothing more urgent claims the gesture slot, biases *which* ambient gesture plays too: a sustained up-and-energetic mood leans toward the `celebrate` slot, a sustained down-and-subdued mood toward `concern` — the opposite bias, never the energetic one. A momentary event always takes priority over the ambient mood bias, and slot overrides via `meta.edits.animations` apply identically whether the trigger was a spike or the resting mood.

The division of labor: **clips move the body, blendshapes move the face, slots choose *which* body motion fits the emotion — and one emotional state, not two independent tracks, drives all of it.** All three ride the same universal-rig foundation — name your bones (and your blendshapes) in a convention the resolvers know, and everything just works.

---

## Troubleshooting

- **The Animation section says "Load a rigged avatar to animate."** You're on the built-in mannequin. The mannequin has no skinned skeleton to retarget or export — click **Load avatar** in the top bar (or open `/pose?avatar=<id>`).

- **"This rig can't be retargeted — only N recognizable humanoid bones."** The model exposes fewer than 8 canonical bones. It's likely non-humanoid, a static prop, or a rig whose bone names the canonicalizer doesn't recognize. Re-export it as a standard humanoid (Mixamo, VRM, or any common avatar-platform export all work), or auto-rig a rig-less mesh first.

- **A clip won't apply: "can't retarget to this rig — only X/Y tracks mapped."** Coverage fell below 50%. The rig is missing too many of the clip's bones (often a stripped-down skeleton with no spine subdivisions or no fingers). Try a clip that uses fewer bones, or use a more complete humanoid rig. The fix for a recurring convention is to add its bone-name mapping in [src/glb-canonicalize.js](../../src/glb-canonicalize.js) — never a hardcoded allowlist.

- **The motion plays but limbs look skewed or the body lies down.** This is the symptom the bind-pose correction exists to prevent, so it should be rare. It usually means the rig rests in an unusual pose the canonicalizer mapped but couldn't fully correct. Verify the avatar imports upright and T- or A-posed; re-export from the source tool if it doesn't.

- **A few bones are "not on this rig" but it still plays.** Expected. The status note (`51/53 bones · 2 not on this rig`) just lists dropped tracks — usually fingers or toes a simpler rig lacks. As long as coverage is ≥50% the performance reads correctly.

- **"Text-to-animation isn't enabled on this deployment yet."** The motion generator isn't configured on this instance. Use the preset library, which is always available.

- **Generation times out.** The job exceeded the poll window. Try a shorter, simpler prompt.

- **Export downloads nothing / fails.** Make sure a clip is actively playing (the transport bar is visible) before clicking **Export animated GLB** — export bakes the *currently previewing* clip onto the rig.

---

## Recap

You learned the apply-and-remix workflow for motion on three.ws:

- **The library is universal.** Motion is stored as canonical-skeleton clip JSON, separate from the avatar GLB. [glb-canonicalize.js](../../src/glb-canonicalize.js) maps any humanoid's bone names to canonical; [animation-retarget.js](../../src/animation-retarget.js) rewrites tracks, corrects the bind pose, and scales the hips so one clip drives every rig. No rig allowlist — only an 8-bone / 50%-coverage sanity gate.
- **[/pose](/pose) is where you apply.** Load a rigged avatar, browse or search the categorized gallery, click to retarget and preview live, tune speed (0.25×–2.5×) and loop in the transport bar, and **export an animated GLB** with the motion baked in.
- **[/animations](/animations) is where you discover.** Browse public community clips with live hover-preview, then **Open in Studio** to apply any of them to your own avatar.
- **Generate what doesn't exist.** Text-to-motion synthesizes a brand-new clip and runs it through the identical retarget-and-apply path as a preset.
- **On a live agent**, the same clips drive emotion through gesture **slots**, while **ARKit-52 blendshapes** drive facial expression independently — clips move the body, blendshapes move the face.

**See also:**

- [docs/animations.md](../animations.md) — the runtime animation registry, manifest, and agent slot reference.
- [docs/3d-asset-pipeline.md](../3d-asset-pipeline.md) — how FBX, GLB, and clip JSON relate, and how clips are built and retargeted.
- [docs/tutorials/swap-avatar-in-studio.md](swap-avatar-in-studio.md) — loading and switching avatars in the Studio.
- [docs/tutorials/upload-custom-glb.md](upload-custom-glb.md) — getting a Mixamo or custom rig into three.ws as a clean, animatable GLB.

Primary call to action: open **[/pose](/pose)**, load an avatar, and apply your first clip.
