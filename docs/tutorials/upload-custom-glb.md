# Upload a custom GLB avatar

The sample avatar is fine for learning, but at some point you want your agent to look like *yours* — a brand mascot, a stylised version of you, a museum guide in period dress, a character your designer built in Blender. That means uploading a custom GLB.

This tutorial covers the whole pipeline. Where compatible GLBs come from, what makes one compatible (and what makes one quietly fail), how to validate before you upload, what the validator output actually tells you, and how to fix the four or five problems that account for almost every upload failure. We'll end-to-end a Mixamo character, the most reliable starting point.

**What you'll build:**
- A custom, rigged 3D avatar running on your live agent
- A workflow for validating GLBs before upload so failures happen in your editor, not in production
- A fix-list for the common failure modes (no idle clip, broken skinning, unsupported materials, oversize files)
- A baked, draco-compressed GLB that loads fast on mobile

**Prerequisites:** Comfort with a file manager and the command line. Some familiarity with Blender helps for the optional baking step but is not required. You should have an existing agent in [three.ws/my-agents](https://three.ws/my-agents) to swap a body into.

---

## Step 1 — Understand what the runtime expects

A GLB is just a binary glTF — a 3D scene packaged in a single file. The runtime accepts any valid glTF 2.0 GLB, but to function as a *conversational agent body* it needs three things on top of the basic geometry:

1. **A skeleton (armature) the runtime can read.** The bones should follow a humanoid pattern — head, neck, spine, two arms, two legs. Mixamo and most humanoid avatar pipelines output skeletons that the runtime understands directly.
2. **An idle animation clip.** Without an idle, the avatar stands in T-pose between turns, which looks like a broken model. Any clip whose name contains "idle" (case-insensitive) works.
3. **At least one talk-style clip.** Used while the agent is speaking. Names containing "talk", "yes", or "wave" all match the runtime's hint search.

That's the *minimum*. A great avatar also has:

- A wave clip (`wave`, `WaveLoop`, etc.) for greetings
- Emote clips (`celebrate`, `cheer`, `flinch`, `concern`) for product moments
- Sensible material setup — PBR (`pbrMetallicRoughness`) materials, no unsupported extensions
- Textures sized for the web — 1024×1024 or 2048×2048 at most, JPEG or WebP rather than PNG where possible
- Draco compression, bringing the file under ~10 MB

If your GLB is missing the bare minimum, you'll see it in T-pose. If it lacks the niceties, it works but feels heavy and pops in slowly on mobile.

---

## Step 2 — Where compatible GLBs come from

Four reliable sources, ranked by how much work they need from you.

### Mixamo (free, the fastest path)

[Mixamo](https://www.mixamo.com) is Adobe's free library of rigged humanoid characters and animations. Every character comes pre-rigged with a clean skeleton, and you can attach any of the library's animations to any character.

Workflow:

1. Sign in with a free Adobe account.
2. Click **Characters**, pick one.
3. Click **Animations**, find an "idle", a "talk" (search for "talking"), a "wave", and any emotes you want.
4. For each animation, click **Download**. Format: **FBX for Unity**. Skin: **With Skin** for the first download (the character), **Without Skin** for every subsequent one (you're just downloading the motion).
5. Convert the FBXs to a single GLB with a tool — see Step 4.

Mixamo characters work *out of the box* with the runtime. This is the recommended path if you don't already have a model.

### three.ws Studio

[three.ws Studio](https://studio.three.ws) lets you create a stylised avatar in minutes with full body customisation. The download is a single GLB with a clean skeleton and Mixamo-compatible rig.

Workflow:

1. Open [three.ws Studio](https://studio.three.ws).
2. Customise your avatar and click **Export**.
3. The GLB has the body and skin but no animations baked in — you'll need to add at least an idle clip. See Step 5 for adding clips with `gltf-transform`.

### Photo-to-avatar

The three.ws photo pipeline generates a realistic humanoid avatar from three face photos. The export is a clean GLB; animations are pulled from a Mixamo-compatible rig, so the same workflow applies.

### Blender (custom, full control)

If you have a model you built or commissioned in Blender:

1. Make sure your armature is a Mixamo-style humanoid rig, or rename your bones to match (`mixamorigHead`, `mixamorigSpine`, etc.).
2. Bake your animations down into NLA strips with sensible names — `Idle`, `Talk`, `Wave`.
3. Export as glTF 2.0 (Binary) (`.glb`).
4. In the export dialog, check **Include → Selected Objects** if you only want the character, **Animation → Always Sample Animations**, and **Compression → Draco mesh compression**.

Blender exports are the most flexible path but also the most error-prone — most upload failures we see in the wild come from Blender exports with missing or misconfigured animation tracks.

---

## Step 3 — Run the validator before you upload

The single best habit you can build is validating *every* GLB before upload. The validator at [three.ws/validation](https://three.ws/validation) wraps the official Khronos glTF Validator with additional runtime-specific checks — does the file have an idle clip, is the skeleton humanoid, are the materials supported.

Workflow:

1. Open [three.ws/validation](https://three.ws/validation).
2. Drag your GLB onto the drop zone.
3. The page renders the model in real time, shows the validator report, and lists every animation clip with a play button so you can preview each one.

What to look for in the report:

| Section | What to check |
|---|---|
| **Errors** | Any errors mean the file will fail to load. Fix them all before uploading. |
| **Warnings** | Most are cosmetic. Texture-size warnings ("3.4 MB PNG") and "unused material" warnings are worth fixing for performance, but won't break the agent. |
| **Animations** | The clip list. Look for at least one clip whose name contains "idle". Click each one to preview. |
| **Skeleton** | Reports whether the rig is humanoid. A "non-humanoid skeleton" message means the runtime won't be able to drive head-look or wave gestures. |
| **Materials** | Lists each material's type. PBR (`pbrMetallicRoughness`) is the safe one. Any extension flagged with "unsupported" means that material will render as a fallback grey. |
| **File size** | The full size and a breakdown. Mesh + textures over ~10 MB is too heavy for mobile. |

If the report is clean and the previews look right, you're ready to upload.

If there are errors, they almost always fall into the four buckets in Step 4.

---

## Step 4 — Convert Mixamo FBX to GLB

Mixamo's "Download" button gives you FBX. The runtime wants GLB. The conversion is a one-line command.

The most reliable tool is [gltf-transform](https://gltf-transform.dev), a Node-based CLI maintained as part of the glTF ecosystem.

```bash
# One character FBX with one baked-in animation:
npx @gltf-transform/cli@latest fbx2glb your-character.fbx your-character.glb

# Apply draco compression to bring the file size down:
npx @gltf-transform/cli@latest draco your-character.glb your-character-draco.glb
```

If you downloaded several animations separately (idle, talk, wave as standalone FBXs), merge them into a single GLB with named clips:

```bash
# Convert each FBX into a GLB first
npx @gltf-transform/cli@latest fbx2glb idle.fbx idle.glb
npx @gltf-transform/cli@latest fbx2glb talk.fbx talk.glb
npx @gltf-transform/cli@latest fbx2glb wave.fbx wave.glb

# Merge animations into the character GLB
npx @gltf-transform/cli@latest merge your-character.glb idle.glb talk.glb wave.glb out.glb

# Rename animation clips so the runtime's hint search picks them up
npx @gltf-transform/cli@latest rename --map "mixamo.com=Talk" out.glb out-named.glb
```

The `rename` step matters. Mixamo names every clip `mixamo.com` by default, which is useless for the runtime's name-based hint matching. Set deliberate names — `Idle`, `Talk`, `Wave`, `Celebrate` — so `playAnimationByHint('idle')` and friends find the right clip.

A faster workflow if you have several clips: open the merged GLB in Blender, manually rename each animation in the NLA editor, re-export. Either approach works.

---

## Step 5 — Draco-compress the file

Draco is a mesh-compression format that shrinks vertex data by 5–10x with no visible quality loss. A 14 MB raw GLB drops to 2 MB compressed, which is the difference between a 6-second mobile load and an instant one.

The runtime ships with the Draco decoder baked in, so compressed GLBs load transparently — no special attributes or flags needed on the agent side.

To compress:

```bash
npx @gltf-transform/cli@latest draco --quantization 14 your.glb your-draco.glb
```

The `--quantization 14` flag balances size against visual quality. The default (14 for position, 12 for normals) is fine for almost all humanoid avatars. If you're seeing visible warping in the mesh after compression, bump it to 16. Anything above 16 stops shrinking the file usefully.

Compare before/after sizes:

```bash
ls -lh your.glb your-draco.glb
```

A 12 MB → 2 MB drop is typical for a Mixamo character with three animation clips and a 2K texture set.

---

## Step 6 — Resize textures

The biggest GLBs we see in production are 90% textures. A character with three 4K textures (diffuse, normal, ARM) is 50 MB before you've added a single bone.

Two ways to handle this. The fast way: tell `gltf-transform` to resize them all:

```bash
npx @gltf-transform/cli@latest resize --width 1024 --height 1024 your.glb your-1k.glb
```

The careful way: open the GLB in [three.ws/validation](https://three.ws/validation), find the largest textures in the report, and resize *just* those in an image editor before repackaging. For faces and skin, keep the diffuse at 2K and downsample the normal/roughness maps to 1K.

For most product-page avatars, 1K diffuse textures are plenty. The avatar is rendered at 280–400px on screen; 2K texels mostly average out before they hit a pixel.

JPEG and WebP are dramatically smaller than PNG for diffuse and ARM maps. PNG is only worth keeping for normal maps where banding shows up otherwise.

---

## Step 7 — Upload via the dashboard

With a validated, compressed GLB in hand:

1. Go to [three.ws/my-agents](https://three.ws/my-agents).
2. Select the agent you want to give a new body, or click **New agent**.
3. Open the **Body** tab.
4. Drag the GLB onto the drop zone, or click **Upload** and pick the file.
5. The dashboard runs the validator again as part of the upload, then renders a preview in the right pane.
6. Click **Save body**.

The dashboard stores the GLB on the platform CDN with the right CORS headers and `Cache-Control` for fast subsequent loads. No further hosting steps needed.

Once the body is saved, every embed of that agent — `<agent-3d agent-id="...">`, script-tag embeds, iframe widgets — picks up the new body on next page load. No code changes anywhere.

---

## Step 8 — The five failure modes (and fixes)

Almost every upload failure falls into one of these categories. The validator catches them, but knowing what each one means cuts your debug time dramatically.

### Failure A: T-pose, no animation playing

**Symptom:** Body loads fine, but stands frozen in T-pose.

**Cause:** No clip whose name matches the runtime's idle hint. The runtime searches case-insensitively for `idle` in clip names.

**Fix:** Rename your idle clip to include "idle" — `Idle`, `idle_loop`, `IdleBreathing` all match.

```bash
npx @gltf-transform/cli@latest rename --map "mixamo.com=Idle" your.glb out.glb
```

Or rename in Blender's NLA editor and re-export.

### Failure B: Animation plays but the mesh deforms wrong

**Symptom:** Limbs stretch, fingers warp, the face caves in.

**Cause:** Broken skinning weights. Usually a Blender export issue where the armature modifier was applied to the mesh accidentally, or a Mixamo download with the wrong skeleton settings.

**Fix:** Re-export from Blender with the armature modifier intact (don't apply it). For Mixamo, re-download the character with "With Skin" rather than re-using skeleton from a different model.

If you can't re-export, sometimes `gltf-transform`'s `weld` and `simplify` commands clean up minor weighting errors:

```bash
npx @gltf-transform/cli@latest weld your.glb welded.glb
```

But genuinely broken skinning needs a fresh export.

### Failure C: Materials look chalky / wrong colour

**Symptom:** Avatar loads, but everything is matte grey or unnaturally bright.

**Cause:** Unsupported material extension. The most common culprits are `KHR_materials_pbrSpecularGlossiness` (the old material spec — runtime falls back to default PBR), or `KHR_materials_volume` / `KHR_materials_transmission` (advanced extensions some loaders skip).

**Fix:** Convert the materials to standard PBR (`pbrMetallicRoughness`). In Blender, swap any "Specular BSDF" or "Glass BSDF" nodes for "Principled BSDF" and re-export. In `gltf-transform`:

```bash
npx @gltf-transform/cli@latest metalrough your.glb pbr.glb
```

This converts `pbrSpecularGlossiness` materials to `pbrMetallicRoughness` automatically.

### Failure D: File too large, slow to load

**Symptom:** Avatar loads, but takes 5–15 seconds to appear, especially on mobile. Initial page paint is fine; the avatar pops in late.

**Cause:** Uncompressed mesh, oversized textures, or both.

**Fix:** Apply Steps 5 and 6 — Draco compression and texture resizing. A combined `transform` invocation does both in one pass:

```bash
npx @gltf-transform/cli@latest optimize \
  --texture-compress webp \
  --texture-size 1024 \
  --simplify true \
  your.glb optimized.glb
```

The `optimize` command bundles draco, texture resize, image format change, and mesh simplification. For aggressive size reduction it usually drops a 15 MB GLB to 2–3 MB.

### Failure E: Validator complains "node has no skin"

**Symptom:** Validator error: "Node X uses skinned vertices but no skin definition".

**Cause:** The GLB references a skeleton that wasn't included in the export. Common with partial Blender exports where the armature wasn't selected at export time.

**Fix:** Re-export with **Selected Objects** turned *off* (or with both mesh and armature selected). Make sure **Include → Armature** is checked in the glTF export dialog.

---

## Step 9 — Complete Mixamo workflow

Here's the end-to-end. Pick a Mixamo character, ship it as a custom agent body.

```bash
# 1. Download from Mixamo: a character "With Skin", plus standalone clips:
#    - Breathing Idle.fbx (Without Skin)
#    - Talking.fbx        (Without Skin)
#    - Waving.fbx         (Without Skin)
#    - Cheering.fbx       (Without Skin)

# 2. Convert each FBX to GLB
for f in *.fbx; do
  npx @gltf-transform/cli@latest fbx2glb "$f" "${f%.fbx}.glb"
done

# 3. Merge the character GLB with the animation GLBs
npx @gltf-transform/cli@latest merge \
  "your-character.glb" \
  "Breathing Idle.glb" \
  "Talking.glb" \
  "Waving.glb" \
  "Cheering.glb" \
  merged.glb

# 4. Rename clips so the runtime's hint search picks them up.
# Mixamo names everything "mixamo.com" by default — fix that.
# Use a glTF editor (Blender or Gestaltor) to rename, or:
npx @gltf-transform/cli@latest script renames.js merged.glb renamed.glb
```

For the rename script (`renames.js`), `gltf-transform` lets you write a small node program against its Document API. The simplest version:

```js
// renames.js
const animationNames = ['Idle', 'Talk', 'Wave', 'Cheer'];

module.exports = (document) => {
  const root = document.getRoot();
  root.listAnimations().forEach((anim, i) => {
    if (animationNames[i]) anim.setName(animationNames[i]);
  });
};
```

```bash
# 5. Optimize for the web
npx @gltf-transform/cli@latest optimize \
  --texture-compress webp \
  --texture-size 1024 \
  renamed.glb final.glb

# 6. Validate
# Drag final.glb onto https://three.ws/validation
# Confirm: file < 5 MB, animations named correctly, no errors.

# 7. Upload at https://three.ws/my-agents
```

Total: 15–25 minutes the first time, 5 minutes once you've done it. The script-based renames step is the only fiddly part; everything else is one-line commands.

---

## Step 10 — Verify on the live agent

Once uploaded:

1. Open any page that embeds the agent (your homepage, the studio preview, [three.ws/my-agents](https://three.ws/my-agents) → preview).
2. Confirm the new body loads — no T-pose, no warped limbs.
3. Send a chat message — the agent should switch to the talk clip while replying.
4. In a browser console, fire each clip by name:

```js
const agent = document.querySelector('agent-3d') || document.querySelector('[data-agent-id]');
await agent.wave();
agent.playAnimationByHint('cheer');
agent.playAnimationByHint('talk');
agent.playAnimationByHint('idle');
```

Each one should trigger the corresponding clip. If a clip you expect doesn't fire, run `agent._scene.clips.map(c => c.name)` in the console — that prints the actual clip names the runtime sees. Compare against the names you set in Step 9.

---

## What you learned

The full custom-GLB pipeline:

- Compatible avatars come from Mixamo, three.ws Studio, the photo pipeline, or Blender — all produce something the runtime understands
- The runtime needs a humanoid skeleton, an idle clip, and a talk clip; it likes a wave and a celebrate too
- The validator at [three.ws/validation](https://three.ws/validation) catches every common failure before upload
- Mixamo's `mixamo.com` clip names need renaming so the hint search finds them
- `gltf-transform optimize` is the one command that handles draco, resize, and simplify in one pass
- The dashboard upload path stores the GLB with correct CORS — no separate hosting work needed

Once the body is on the platform, the embed snippet doesn't change. The same `<agent-3d agent-id="...">` tag picks up the new body automatically.

## Next steps

- [Swap the avatar in Studio](/tutorials/swap-avatar-in-studio) — preview body swaps with no code
- [Build a personal AI website](/tutorials/personal-ai-site) — put your custom avatar at the centre of a homepage
- [Give your agent a personality](/tutorials/agent-personality) — match the brain to the new body
