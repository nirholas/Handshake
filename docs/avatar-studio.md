# Avatar Studio: build a custom avatar from scratch, no selfie

Avatar Studio builds a fully rigged 3D avatar without a photo. You start from a base body and shape it into your own character: tint skin, hair, and outfit; sculpt the face and body with morph sliders; add hats, glasses, and earrings; hide or show garment layers to strip back to the base and build a look up; and drive the rig live with a library of emotes. When you save, the live scene is exported to a GLB exactly as you see it and stored to your account, ready to animate, dress, and use anywhere on the platform.

Page: [/avatar-studio](https://three.ws/avatar-studio) (also reachable at [/create/studio](https://three.ws/create/studio))

## Why it exists

The selfie-to-avatar path is great when you want to look like yourself, but it is a wall when you want to be someone, or something, else. Avatar Studio is the from-scratch path: no camera, no upload, just a base humanoid and the tools to make it yours. It reuses the same building blocks as the platform's avatar editor, the `TalkScene` viewport, the accessory manager, the sculpt panel, and the shared GLB optimize-and-validate path, so an avatar built here is a first-class avatar everywhere, not a lesser one. And because the customization is stored both as a validated GLB (so it always renders right) and as re-editable appearance metadata, you can come back and change it later.

## How it works

The studio mounts a `TalkScene` around a base body and layers a tabbed customization panel over it. A **Base** switcher at the top of the panel picks the starting template (create mode only; a saved avatar always reloads its own model):

- **Stylized** (`/avatars/default.glb`): the dressed feminine stylized body with hair, outfit, and garment layers. The default.
- **Parametric** (`/avatars/parametric-base.glb`): a bare humanoid built from the CC0 MakeHuman/MPFB2 body, baked with **120+ identity morph sliders** by [scripts/build-parametric-base.mjs](../scripts/build-parametric-base.mjs). On this base the Sculpt tab becomes a full character creator: Nose (width, length, tip, hump, nostrils), Mouth (lip volume, corners, cupid's bow, dimples), Ears (size, pointed, lobes, position: yes, elf ears), Eyes (size, tilt, spacing, bags), Brows, Cheeks, Jaw and chin, Head Shape (round/square/oval, forehead), and Body (feminine/masculine, muscle, weight, age, height, chest, waist, hips, glutes, belly, shoulders, arms, thighs, calves, leg length). It rides the same 52-bone Mixamo-named skeleton conventions as everything else, so the entire animation library retargets onto any slider combination. Source data and license provenance: [avatar-sources/anny/README.md](../avatar-sources/anny/README.md).

Every edit updates the live scene graph, and a working "appearance" object tracks the whole configuration: chosen colors, morph values, skeleton proportions, accessories, and hidden layers. That record is the avatar's parameter document, specified in [specs/AVATAR_PARAMETERS.md](../specs/AVATAR_PARAMETERS.md).

- **Color.** Material slots (skin, hair, outfit) each offer a curated swatch palette plus a full-spectrum picker (an `iro.js` wheel with hex entry and eyedropper, falling back to the native OS color dialog). Slots the loaded base has no materials for are hidden rather than rendered dead, and "Default" restores the base's authored color. Above them sit **Looks**: one-tap palettes (Noir, Sunset, Arctic, Cyber, Rosé, Forest, Mono, Ember) that theme skin, hair, and outfit together in a single history step, always landing on real, coherent material colors.
- **Face and body sculpt.** The sculpt panel renders grouped morph sliders against whatever morph targets the base carries, organized into Eyes, Brows, Nose, Mouth, Jaw, Cheeks, Ears, Head Shape, and Body, plus a MetaHuman-style 2-D face-type blend wheel over six archetypes and advanced visemes. Left/right paired morphs collapse into one mirrored slider unless you unlock Mirror L/R for asymmetry. It drives real morph targets, so the change is baked into the saved mesh.
- **Proportions.** Above the morph sliders sits a bone-level build panel: Height, Leg Length, Torso Length, Neck Length, Arm Length, Shoulder Width, Hip Width, Head Size, Hand Size, Foot Size. Morphs reshape a limb; these re-proportion the skeleton, which is the only way to actually lengthen one (a morph is a fixed set of vertex deltas, so pulling the hand further from the elbow would drag the skin off the bone driving it). Each slider is a ratio around the base body, shown as a signed percentage, and double-clicking resets it. Lengthen the legs and the hips ride up so the feet stay on the floor, and the animation library re-measures itself against the new hip height so the walk does not foot-slide. Only parameters the loaded rig has bones for are offered.
- **Accessories.** Hats, glasses, and earrings load from a preset catalog (`/accessories/presets.json`). Hovering a tile previews it live on the avatar; clicking commits it. Hats and glasses are single-slot; earrings stack. A chip row shows everything applied, each removable.
- **Garment layers.** Outfit, glasses, and hair can be toggled visible/hidden, with bulk "Start minimal" and "Dress fully" actions, so you can strip to the base body and rebuild the look deliberately.
- **Animate.** Load the shared canonical clip library and drive the rig live with 17 emotes (idle, waiting, chill, wave, cheer, celebrate, flex, jump, pray, blow kiss, taunt, dance, shuffle, rumba, thriller, capoeira). A looping emote becomes the avatar's resting idle and is baked in on save; one-shots play once and settle back to the current idle. This doubles as proof the avatar is fully rigged.
- **Randomize.** One button rolls a random swatch per color slot, a gentle draw on every proportion parameter, and a random hat and glasses, as a starting point. The proportion draw stays near neutral on purpose: two random avatars should read as different people, not different species.

The studio has 50-deep undo/redo, a dirty-state indicator in the title bar, and a draft autosave to local storage that is offered back if you leave and return (in create mode).

### Save

Saving does not ask a server to re-bake anything. The live Three.js scene, with colors, morphs, and accessories already applied to the scene graph, is exported via `GLTFExporter`, so the resulting GLB is exactly what you saw. It runs through the shared optimize-and-validate path (geometry compression, `gltf-validator`), uploads to your account, and creates or (in edit mode) updates the avatar record. The appearance JSON is stored alongside as metadata so the avatar stays re-editable.

## Walkthrough

1. Open [/avatar-studio](https://three.ws/avatar-studio). The base avatar loads and settles into an idle animation.
2. On the Color tab, tap a Look (say, Cyber) for an instant coherent palette, then fine-tune skin, hair, and outfit with the swatches or the rainbow chip's full picker.
3. Open the Face tab and sculpt: widen the jaw, adjust the nose, nudge body shape. Use the face-type wheel to blend archetypes.
4. Add a hat and glasses from their tabs; hover to preview, click to keep. Add earrings if you want.
5. Use the Layers block to hide the outfit and rebuild it, or leave it dressed.
6. On the Animate tab, pick a looping emote (for example, Dance) to set the avatar's resting idle.
7. Name it and click Save. The studio exports, optimizes, uploads, and lands you with a saved avatar you can animate and dress elsewhere.

## Examples

Avatar Studio is an interactive builder; its examples are its entry points and the account API it saves through.

- **Create a new avatar:** [https://three.ws/avatar-studio](https://three.ws/avatar-studio) or [https://three.ws/create/studio](https://three.ws/create/studio)
- **Edit a saved avatar:** `https://three.ws/avatar-studio?edit=<avatarId>`: reloads that avatar's appearance and updates the existing record on save.

Fetching an avatar record (the same call the studio makes to load edit mode):

```bash
curl 'https://three.ws/api/avatars/<avatarId>' -H 'cookie: <session>'
# → { "avatar": { "id": "…", "name": "…", "model_url": "…", "appearance": { … } } }
```

## States & limits

- **No selfie, no camera.** This is the from-scratch path. To build an avatar from a photo, use the platform's selfie-to-avatar flow under [/create](https://three.ws/create) instead.
- **Two base bodies.** Create mode starts from the Stylized feminine base or the bare Parametric base (which covers masculine, feminine, and everything between via its body sliders). Switching base reloads the studio, so it asks before discarding unsaved changes. The posable primitive with a build toggle lives in [Animation Studio](./animation-studio.md).
- **The Parametric base ships bare.** No hair or outfit meshes yet, so the hair/outfit color slots and the Layers block do not appear on it; hats, glasses, and earrings attach normally. Conforming hair and garments are the next phase of the parametric roadmap ([prompts/finish/roadmap-avatar-parametric-editor.md](../prompts/finish/roadmap-avatar-parametric-editor.md)).
- **Sculpt depends on the base's morphs.** The face/body sliders render against whatever morph targets the base GLB exposes; a slot with no matching morph simply does not appear. Proportions are independent of morphs: they need only a canonical humanoid skeleton, so they work on a rig with no blendshapes at all. Height is the one parameter that needs an armature node above the hips, and is hidden on rigs whose hips sit directly in the scene.
- **Save requires an account.** Export happens client-side, but persisting the avatar to your library needs sign-in. Optimization is best-effort: if compression fails, the original export is saved untouched so the save always completes.
- **What you see is what you save.** Because the save exports the live scene graph, the stored GLB matches the viewport exactly, colors, morphs, accessories, and the chosen idle included.
- **Drafts are local.** Unsaved work autosaves to local storage in create mode and is offered back on return; edit mode does not autosave a draft over the saved avatar.

## Related

- [Animation Studio](./animation-studio.md): pose and keyframe the avatar you build here.
- [Scene Composer](./compose.md): forge props and attach them to the avatar's bones as a saved outfit.
- [Mocap Studio](./mocap-studio.md): drive the avatar's face live from your webcam.
- [Restyle Studio](./restyle.md): shares the same GLB optimize-and-validate path.
- [Trait-based avatar builder](./character-studio.md): the separate VRM studio embedded in the agent editor; a deep dive into its internals.
- [/create](https://three.ws/create): the hub for every avatar-creation path, including selfie-to-avatar.
