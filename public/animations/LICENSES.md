# Animation clip licensing

This file records the upstream source and license for every clip in
`/public/animations/clips/`. Each entry uses the canonical-skeleton JSON
emitted by [`scripts/build-animations.mjs`](../../scripts/build-animations.mjs)
from a source FBX or GLB.

This is the same library exposed one-click in the `/pose` **Animation presets**
gallery (preview + animated-GLB export) and through the `apply_animation` MCP
tool. Every clip here is retargetable onto an arbitrary rigged humanoid via
[`src/animation-retarget.js`](../../src/animation-retarget.js); nothing in the
gallery is a placeholder or empty clip.

## Mixamo (commercial use OK)

All clips below were exported from [mixamo.com](https://www.mixamo.com/) under
an authenticated Adobe Creative Cloud account. Mixamo's terms allow free
commercial use of exported animations as part of a product (Mixamo Terms of
Use §2 — characters and animations may be used in personal, commercial, or
non-profit projects).

| Clip name in manifest | Mixamo source      | Notes |
| --------------------- | ------------------ | ----- |
| `idle`                | Idle               | trim  |
| `walk`                | Walking            | trim  |
| `dance`               | Hip Hop Dancing    | loop  |
| `rumba`               | Rumba Dancing      | loop  |
| `silly`               | Silly Dancing      | loop  |
| `thriller`            | Thriller Part 2    | loop  |
| `capoeira`            | Capoeira           | loop  |
| `kiss`                | Blow A Kiss        | —     |
| `pray`                | Praying            | —     |
| `wave`                | Waving             | —     |
| `taunt`               | Taunt              | —     |
| `angry`               | Angry Gesture      | —     |
| `celebrate`           | Cheering           | —     |
| `reaction`            | Surprised          | —     |
| `defeated`            | Defeated           | —     |
| `dying`               | Dying              | —     |
| `falling`             | Falling            | —     |
| `falltolanding`       | Falling To Landing | —     |
| `jump`                | Jumping            | —     |
| `jumpdown`            | Jump Down          | —     |
| `jumpdown2`           | Jump Down (Light)  | —     |
| `jumpdown3`           | Jump Down (Heavy)  | —     |
| `header`              | Soccer Header      | —     |
| `goalkeeper`          | Goalkeeper Save    | —     |
| `dodge`               | Dodging            | —     |
| `stepback`            | Step Back          | —     |
| `shoved`              | Pushed To Floor    | —     |
| `coverstand`          | Cover Stand        | —     |
| `removing`            | Standup Cover      | —     |
| `standup`             | Standing Up        | —     |
| `sitclap`             | Sitting Clap       | —     |
| `sitidle`             | Sitting Idle       | —     |
| `sitlaugh`            | Sitting Laughing   | —     |
| `downdog`             | Down Dog           | —     |
| `av-listening-music`  | Listening To Music | —     |
| `av-leaning-wall`     | Leaning On A Wall  | —     |
| `av-rap-dance`        | Rap Dancing        | —     |
| `nod`                 | Nodding Head Yes   | agent `nod` slot |
| `shrug`               | Shoulder Shrug     | agent `shrug` slot |
| `point`               | Pointing (arm bent)| agent `point` slot |
| `think`               | Thoughtfully Nodding Head Yes | agent `think` slot |
| `sitloop`             | Sitting With Breathing Idle | loop; the walk `sit` gesture |
| `turn`                | Standing 180 Left Turn | —  |
| `jog`                 | Jog Forward        | loop; the walk `jog` gesture |

To add a new Mixamo clip:

1. Log into Mixamo, find the animation, choose **In Place** and **Without Skin**,
   download as FBX (binary, 30fps).
2. Drop the FBX into the source directory consumed by
   [scripts/build-animations.mjs](../../scripts/build-animations.mjs).
3. Run `npm run build:animations` to retarget to the canonical skeleton and
   emit the JSON under `/public/animations/clips/`.
4. Register the clip in [`/public/animations/manifest.json`](./manifest.json)
   with a `name`, `url`, `label`, `icon`, and `loop` flag.
5. Add a row to the table above with the Mixamo source name.

## Avaturn animation library (GLB packs)

The `av-*` clips (plus `facepalm`) below are retargeted from GLB animation packs
produced through the project's Avaturn avatar pipeline — the `Standard_*`,
`Idle_*`, and named-action GLBs that ship with Avaturn-exported avatars. They
are used under the Avaturn platform terms accepted at avatar export and are
retargeted to the canonical three.ws rig by
[`scripts/build-animations.mjs`](../../scripts/build-animations.mjs).

> **License note:** these clips are cleared for use _within three.ws products_
> as part of the Avaturn export pipeline. Before redistributing any single clip
> as a standalone asset, confirm its upstream terms — packs whose individual
> provenance is unverified should be treated as internal-only until checked.

| Clip name in manifest   | Source GLB                            | Label              |
| ----------------------- | ------------------------------------- | ------------------ |
| `facepalm`              | Facepalm.glb                          | Facepalm           |
| `av-idle-breath`        | Idle_Breath.glb                       | Idle Breath        |
| `av-waiting`            | Standard_Waiting.glb                  | Waiting            |
| `av-superhero-jump`     | Suoerhero_Jump.glb                    | Superhero Jump     |
| `av-walk-crouching`     | Standard_Walk_Crouching.glb           | Walk Crouching     |
| `av-arm-flex`           | Arm_Flex.glb                          | Arm Flex           |
| `av-boxer-dance`        | Boxers_dance.glb                      | Boxer Dance        |
| `av-brag-claps`         | Brag_n_Claps.glb                      | Brag & Clap        |
| `av-flexing-arm`        | Flexing_Arm.glb                       | Flex Arm           |
| `av-vtubing`            | Standard_Vtubing_Movement.glb         | VTubing            |
| `av-stand-crouch-stand` | Standard_Stand_To_Crouch_To_Stand.glb | Stand-Crouch-Stand |
| `av-smoking`            | Standard_Smoking.glb                  | Smoking            |
| `av-gymnastics-aerial`  | Gymnastics_Aerial.glb                 | Gymnastics         |
| `av-idle-anim`          | idle_anim.glb                         | Idle (Avaturn)     |
| `av-back-flip`          | back_flip.glb                         | Back Flip          |
| `av-idle-male`          | idle_male_jan25.glb                   | Male Idle          |
| `av-idle-female`        | idle_female_jan25.glb                 | Female Idle        |
| `av-chest-bump`         | Gorilla_chest_bump.glb                | Chest Bump         |
| `av-walk-feminine`      | Standard_Walk_Cycle_Feminine.glb      | Feminine Walk      |
| `av-push-block`         | Standard_Push_Block_Variation.glb     | Push Block         |
| `av-dance-shuffle`      | dance_shuffle.glb                     | Shuffle Dance      |
| `av-headbang`           | Dance_Head_Banging_V03.glb            | Head Banging       |
| `av-call-me`            | Call_Me.glb                           | Call Me            |
| `av-chilling`           | Just_chilling.glb                     | Chilling           |
| `av-pose1`              | pose1.glb                             | Pose               |
| `av-muay-thai`          | Arm_Combo_Muay_Thai.glb               | Muay Thai Combo    |
| `av-banging-tunes`      | Banging_Tunes_left.glb                | Banging Tunes      |
| `av-celebrating`        | Celebrating.glb                       | Celebrating        |
| `av-spy`                | Cheap_Spy.glb                         | Spy                |
| `av-cheering`           | Cheering.glb                          | Cheering           |
| `av-joy`                | Expressing_joy.glb                    | Joy                |
| `av-conductor`          | Energic_conductor.glb                 | Conductor          |

### Farming & chores pack

Sourced from the Mixamo "Farming Pack" and the standalone "Digging" clip,
exported under the same authenticated Adobe Creative Cloud account and terms
as the clips above. The pack's bundled character mesh (`Ch17_nonPBR.fbx`) is
not shipped — only the animation clips, retargeted onto the canonical rig.

| Clip name in manifest      | Mixamo source         | Notes |
| -------------------------- | --------------------- | ----- |
| `digging`                  | Digging               | loop  |
| `farm-dig-plant`           | dig and plant seeds   | —     |
| `farm-pull-plant`          | pull plant            | —     |
| `farm-plant-tree`          | plant tree            | —     |
| `farm-plant-a-plant`       | plant a plant         | —     |
| `farm-watering`            | watering              | —     |
| `farm-pick-fruit`          | pick fruit            | —     |
| `farm-cow-milking`         | cow milking           | —     |
| `farm-kneeling-idle`       | kneeling idle         | loop  |
| `farm-box-idle`            | box idle              | loop  |
| `farm-box-walk`            | box walk arc          | loop  |
| `farm-box-turn`            | box turn              | —     |
| `farm-holding-walk`        | holding walk          | loop  |
| `farm-holding-turn-left`   | holding turn left     | —     |
| `farm-holding-turn-right`  | holding turn right    | —     |
| `farm-wheelbarrow-idle`    | wheelbarrow idle      | loop  |
| `farm-wheelbarrow-walk`    | wheelbarrow walk      | loop  |
| `farm-wheelbarrow-turn`    | wheelbarrow walk turn | —     |
| `farm-wheelbarrow-dump`    | wheelbarrow dump      | —     |

## Three.js example models (MIT License)

Clips extracted from the animated GLB models shipped with the
[three.js](https://github.com/mrdoob/three.js) library under the
[MIT License](https://github.com/mrdoob/three.js/blob/dev/LICENSE).
Source files downloaded from the three.js `examples/models/gltf/` directory
and split into per-clip GLBs by
[`scripts/extract-glb-animations.mjs`](../../scripts/extract-glb-animations.mjs).

### Soldier.glb — Mixamo Y-Bot skeleton

| Clip name in manifest | Source animation | Loop |
| --------------------- | ---------------- | ---- |
| `soldier-idle`        | Idle             | ✓    |
| `soldier-run`         | Run              | ✓    |
| `soldier-walk`        | Walk             | ✓    |

### Michelle.glb

| Clip name in manifest    | Source animation | Loop |
| ------------------------ | ---------------- | ---- |
| `michelle-samba-dance`   | SambaDance       | ✓    |

### Xbot.glb — Mixamo Y-Bot skeleton

| Clip name in manifest | Source animation | Loop |
| --------------------- | ---------------- | ---- |
| `xbot-agree`          | agree            | —    |
| `xbot-head-shake`     | headShake        | —    |
| `xbot-idle`           | idle             | ✓    |
| `xbot-run`            | run              | ✓    |
| `xbot-sad-pose`       | sad_pose         | ✓    |
| `xbot-sneak-pose`     | sneak_pose       | ✓    |
| `xbot-walk`           | walk             | ✓    |

> **Note:** Soldier.glb and Xbot.glb use the Mixamo Y-Bot skeleton; they
> retarget at full 156/156 bone coverage. Michelle.glb drops 39 finger/facial
> bones (156/195 matched) — motion quality is unaffected for full-body play.

## Custom mocap

When a non-Mixamo source lands here (custom recording, third-party studio,
etc.), add a section below covering: the clip name, the licensor, the license
terms (commercial use, attribution requirements, derivative works), and a
link to the signed agreement or storefront receipt.

### `av-offabean-dance` — provenance unconfirmed

| Field | Value |
| ----- | ----- |
| Clip name | `av-offabean-dance` |
| Source | <https://github.com/nvr-ndr/offabean_dance> (`offabean_dance.fbx`) |
| Licensor | Unknown |
| License | **None declared** — the repository ships no `LICENSE` file and no terms in a README |
| Rig | Mixamo "Beta" character (`Beta_Joints` / `Beta_Surface`, 65-joint `mixamorig:` skeleton) |

The retargeted clip carries only the motion; the source mesh and textures are
discarded at build time, so nothing of the Beta character ships. The skeleton
and the 16.1s choreography are Mixamo-rigged, but this repository is not an
Adobe/Mixamo distribution channel and declares no license, so the Mixamo
Terms of Use grant recorded at the top of this file **cannot be assumed to
cover it**: that grant runs to the account that exported the asset, and we
have no evidence of who that was.

Unresolved before this clip ships publicly: confirm with the repository owner
(`nvr-ndr`) whether the choreography is their own work or a stock Mixamo clip,
and on what terms three.ws may redistribute it. If it turns out to be an
unmodified stock Mixamo animation exported under an authenticated account, it
belongs in the Mixamo table above instead and this section can be deleted.

## Pole choreography (pending)

The `/api/x402/dance-tip` endpoint advertises three pole choreography styles
— `spin`, `climb`, `combo` — that chain the following clip names:

- `pole-walk-on`
- `pole-spin`
- `pole-climb`
- `pole-invert`
- `pole-floorwork`
- `pole-bow`

These clips are **not yet shipped**. Until the source FBX (Mixamo "Strut Walk",
"Pole Spin", "Floor Work", "Bow" — and custom mocap for `pole-climb` /
`pole-invert`) lands and `npm run build:animations` regenerates them, a tip
with `dance=spin|climb|combo` will pay successfully and the dancer will walk
on stage, but `AnimationManager.crossfadeTo` will warn that the clip is
unavailable and skip the missing step. Add the entries to the table above
when the FBX sources are committed.
