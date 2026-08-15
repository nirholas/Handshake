# Upload a custom GLB avatar

The sample avatar is fine for learning, but at some point you want your agent to look like *yours* — a brand mascot, a stylised version of you, a museum guide in period dress, a character your designer built in Blender. That means uploading a custom GLB.

This tutorial covers the whole pipeline. Where compatible GLBs come from, what makes one compatible (and what makes one quietly fail), how to validate before you upload, what the validator output actually tells you, and how to fix the four or five problems that account for almost every upload failure. We'll end-to-end a Mixamo character, the most reliable starting point.

**What you'll build:**
- A custom, rigged 3D avatar running on your live agent
- A workflow for validating GLBs before upload so failures happen in your editor, not in production
- A fix-list for the common failure modes (a rig that won't canonicalize, mis-named clips, broken skinning, unsupported materials, oversize files)
- A baked, draco-compressed GLB that loads fast on mobile

**Prerequisites:** Comfort with a file manager and the command line. Some familiarity with Blender helps for the optional baking step but is not required. You should have an existing agent in [three.ws/my-agents](https://three.ws/my-agents) to swap a body into.

---

## Step 1 — Understand what the runtime expects

A GLB is just a binary glTF — a 3D scene packaged in a single file. The runtime accepts any valid glTF 2.0 GLB. To function as a *conversational agent body*, the one thing that really matters on top of the basic geometry is:

**A humanoid skeleton (armature) the runtime can name-map.** Bones following a humanoid pattern — head, neck, spine, two arms, two legs. There is no rig allowlist: `src/glb-canonicalize.js` maps the common conventions (Mixamo, Avaturn, Unreal, VRM/VRoid, VRM 1.0, Daz/Genesis, MakeHuman, Blender `.L` suffixes, simple `shoulderL` rigs) onto one canonical bone set.

**You do not have to ship animation clips.** Once the skeleton canonicalizes, `src/animation-retarget.js` retargets the platform's pre-baked clip library (idle, walk, and the emotes) onto your rig, legs included. A rig that genuinely can't be skeleton-driven — no skin, a non-humanoid prop — falls back to the default rig rather than freezing. And if only *some* bones name-map, `relaxUndrivenArms()` swings the un-driven arms down to a relaxed rest, so an avatar never reads as a broken bind-pose T-pose.

Baking your own clips in is therefore an *upgrade*, not a requirement. Do it when you want motion the shared library doesn't have — a brand-specific gesture, a costume-driven idle. Clips are matched by a case-insensitive substring search on the clip name, so `idle`, `idle_loop`, and `IdleBreathing` all satisfy an "idle" lookup; `talk`, `yes`, and `wave` all match the talk-style hint.

Beyond the rig, a great avatar has:

- A wave clip (`wave`, `WaveLoop`, etc.) for greetings
- Emote clips (`celebrate`, `cheer`, `flinch`, `concern`) for product moments
- Sensible material setup — PBR (`pbrMetallicRoughness`) materials, no unsupported extensions
- Textures sized for the web — 1024×1024 or 2048×2048 at most, JPEG or WebP rather than PNG where possible
- Compressed geometry, bringing the file under ~10 MB

If it lacks the niceties, it works but feels heavy and pops in slowly on mobile.

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

### Avatar Studio

[Avatar Studio](https://three.ws/avatar-studio) lets you create a stylised avatar in minutes with full body customisation (body, hair, face, clothing, accessories). The export is a single GLB with a clean skeleton and Mixamo-compatible rig. It is also reachable at [/create/studio](https://three.ws/create/studio), and the [Forge](https://three.ws/create) opens it in a modal. (Don't confuse it with [/studio](https://three.ws/studio), which is Widget Studio, the embed-snippet builder.)

Workflow:

1. Open [Avatar Studio](https://three.ws/avatar-studio).
2. Customise your avatar and click **Save Avatar**.
3. The GLB has the body and skin but no bespoke animation clips baked in. You don't have to add any: the platform retargets its pre-baked idle/walk/emote library onto any humanoid rig it can canonicalize, so a Studio avatar animates as soon as it is on an agent. Bake your own clips into the file only when you want motion the library doesn't have — Step 4 covers merging clips in.

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
| **Animations** | The clip list. If you baked your own clips in, confirm at least one name contains "idle" so the hint search finds it. A file with no clips is fine: the platform's own library retargets onto the rig. Click each one to preview. |
| **Skeleton** | Reports whether the rig is humanoid. A "non-humanoid skeleton" message means the runtime won't be able to drive head-look or wave gestures. |
| **Materials** | Lists each material's type. PBR (`pbrMetallicRoughness`) is the safe one. Any extension flagged with "unsupported" means that material will render as a fallback grey. |
| **File size** | The full size and a breakdown. Mesh + textures over ~10 MB is too heavy for mobile. |

If the report is clean and the previews look right, you're ready to upload.

If there are errors, they almost always fall into the four buckets in Step 4.

---

## Step 4 — Convert Mixamo FBX to GLB

Mixamo's "Download" button gives you FBX. The runtime wants GLB. The conversion is a one-line command.

If you're working inside the repo, use the built-in converter — it's backed by FBX2glTF and preserves the skeleton, skin weights, animation, and textures, then prints a summary so you can confirm the rig survived:

```bash
# One character FBX with its baked-in animation → public/avatars/<name>.glb:
npm run convert:fbx -- your-character.fbx

# Make it web-ready (lossless geometry + WebP textures, typically ~90% smaller):
npm run optimize:glb -- public/avatars/your-character.glb
```

> **`optimize:glb` uses WebP, not Draco.** The avatar runtime *does* decode Draco — the viewer and the avatar body loaders wire a `DRACOLoader` pointed at the vendored `/three/draco/` decoder, so a Draco-compressed GLB loads fine (that's Step 5). `optimize:glb` itself deliberately stays within plain glTF 2.0 and leans on WebP textures for its ~90% size win, so its output needs no decoder at all. See [docs/3d-asset-pipeline.md](../3d-asset-pipeline.md) for the full format and pipeline reference.

Outside the repo, install the same converter directly. [FBX2glTF](https://github.com/facebookincubator/FBX2glTF) (Meta's converter) ships as a prebuilt binary inside the `fbx2gltf` npm package, and it is exactly what `npm run convert:fbx` wraps:

```bash
npm i -D fbx2gltf
```

The package exports a function, not a CLI shim — there is no `npx fbx2gltf`. Call it from a small script:

```js
// convert.mjs — node convert.mjs your-character.fbx your-character.glb
import { createRequire } from 'node:module';
import { renameSync } from 'node:fs';

const convert = createRequire(import.meta.url)('fbx2gltf');
const [input, output] = process.argv.slice(2);

// A destination ending in .glb yields binary glTF. Some builds write to a
// slightly different path and return it, so normalize to what you asked for.
const written = await convert(input, output, ['--pbr-metallic-roughness']);
if (written && written !== output) renameSync(written, output);
console.log(`wrote ${output}`);
```

PBR metallic-roughness materials, the skeleton, skin weights, animation clips, and textures all survive the conversion. If you would rather drive the binary straight from a shell, it is at `node_modules/fbx2gltf/bin/<Darwin|Linux|Windows_NT>/FBX2glTF`; run it with `--help` to see the flags (note that its `-o` takes a path *without* a suffix, which is why the wrapper above normalizes the result).

> **`gltf-transform` cannot read FBX.** It is a glTF-to-glTF toolkit — every command it exposes takes a `.glb`/`.gltf` in and writes one out, so there is no `fbx2glb`. Use it for the *optimization* steps below, after FBX2glTF has produced a GLB. It also has no `rename` and no `script` subcommand; renaming clips is a Blender or Document-API job (below).

If you downloaded several animations separately (idle, talk, wave as standalone FBXs), convert each with the script above and merge them into a single GLB:

```bash
# Merge the animation GLBs into the character GLB
npx @gltf-transform/cli@latest merge your-character.glb idle.glb talk.glb wave.glb out.glb
```

Then rename the clips. Mixamo names every clip `mixamo.com` by default, which is useless for the runtime's name-based hint matching. Set deliberate names — `Idle`, `Talk`, `Wave`, `Celebrate` — so `playAnimationByHint('idle')` and friends find the right clip. Two ways:

- **Blender (no code):** open the merged GLB, rename each action in the NLA editor, re-export. This is the faster path for a handful of clips.
- **The glTF Transform Document API (scriptable):** the library is a normal npm package, so write a tiny Node script against it. There is no CLI subcommand for this.

```js
// rename-clips.mjs — node rename-clips.mjs merged.glb renamed.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const NAMES = ['Idle', 'Talk', 'Wave', 'Cheer'];
const [input, output] = process.argv.slice(2);

// Registering the extensions is not optional: most three.ws avatars ship
// EXT_meshopt_compression, and a bare NodeIO throws
// `Missing required extension, "EXT_meshopt_compression"` on read.
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const document = await io.read(input);
document.getRoot().listAnimations().forEach((anim, i) => {
  if (NAMES[i]) anim.setName(NAMES[i]);
});
await io.write(output, document);
```

Install its three dependencies first: `npm i -D @gltf-transform/core @gltf-transform/extensions meshoptimizer`. Clip order follows merge order, so pass the animation GLBs to `merge` in the order you list them in `NAMES`.

---

## Step 5 — Draco-compress the file

Draco is a mesh-compression format that shrinks vertex data by 5–10x with no visible quality loss. A 14 MB raw GLB drops to 2 MB compressed, which is the difference between a 6-second mobile load and an instant one.

The runtime ships with the Draco decoder baked in, so compressed GLBs load transparently — no special attributes or flags needed on the agent side.

To compress:

```bash
npx @gltf-transform/cli@latest draco --quantize-position 14 your.glb your-draco.glb
```

Quantization is per-attribute, not one global flag: `--quantize-position` (default 14), `--quantize-normal` (10), `--quantize-texcoord` (12), `--quantize-color` (8), and `--quantize-generic` (12), each accepting 1-16 bits. The defaults are fine for almost all humanoid avatars, so the command above is really just being explicit. If you see visible warping in the mesh after compression, raise `--quantize-position` to 16, which is the ceiling — there is nothing above it.

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

With a validated, compressed GLB in hand, this is two steps: get the file into your avatar library, then point an agent at it.

**Upload the GLB**

1. Go to [three.ws/create](https://three.ws/create).
2. Pick the **Upload your own GLB** card.
3. Drop the `.glb` file, or click to choose it. The header is checked before anything uploads, so a mis-renamed file is rejected immediately rather than half-saved.
4. The avatar lands in your library at [/dashboard/avatars](https://three.ws/dashboard/avatars).

**Attach it to an agent**

1. Open the agent in the editor and go to its **Outfit** panel.
2. Under **Avatar**, pick the avatar you just uploaded. Upload progress and a **Cancel** control show inline; the selection is saved to the agent as soon as the attach completes.
3. The same panel is where you pick which clips from the three.ws library the agent uses (**Animations**), which clip plays per behaviour (**Animation states**), and its **Gesture slots**.

The platform stores the GLB on its CDN with the right CORS headers and `Cache-Control` for fast subsequent loads. No further hosting steps needed.

Once the body is saved, every embed of that agent — `<agent-3d agent-id="...">`, script-tag embeds, iframe widgets — picks up the new body on next page load. No code changes anywhere.

---

## Step 8 — The five failure modes (and fixes)

Almost every upload failure falls into one of these categories. The validator catches them, but knowing what each one means cuts your debug time dramatically.

### Failure A: frozen, no animation playing

**Symptom:** Body loads fine, but stands frozen instead of breathing.

**Cause:** Two different ones, and they need different fixes.

1. **The skeleton didn't canonicalize.** The retargeting layer couldn't name-map the rig, so the shared clip library has nothing to drive. This is the real failure, and it shows in the validator as a non-humanoid skeleton.
2. **You baked in clips but named them badly.** If the GLB ships its own clips, the runtime prefers them and searches case-insensitively for `idle` in the names. `mixamo.com` matches nothing.

**Fix for (1):** rename the bones to a convention `glb-canonicalize.js` knows — Mixamo (`mixamorigHead`), VRM, Avaturn, Unreal, Daz, MakeHuman, or Blender `.L`/`.R` suffixes. Hitting a genuinely new skeleton convention is a gap worth reporting rather than working around.

**Fix for (2):** rename your idle clip to include "idle" — `Idle`, `idle_loop`, `IdleBreathing` all match. Use Blender's NLA editor or the `rename-clips.mjs` script from Step 4; `gltf-transform` has no `rename` command.

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

The `optimize` command bundles geometry compression, texture resize, image format change, and mesh simplification. Note its default compression is **meshopt**, not Draco: pass `--compress draco` if you specifically want Draco (or `--compress quantize`, or `false` to skip it). For aggressive size reduction it usually drops a 15 MB GLB to 2–3 MB.

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

# 2. Convert each FBX to GLB with the convert.mjs wrapper from Step 4
for f in *.fbx; do
  node convert.mjs "$f" "${f%.fbx}.glb"
done

# 3. Merge the character GLB with the animation GLBs.
# Merge order sets clip order, which the rename step relies on.
npx @gltf-transform/cli@latest merge \
  "your-character.glb" \
  "Breathing Idle.glb" \
  "Talking.glb" \
  "Waving.glb" \
  "Cheering.glb" \
  merged.glb

# 4. Rename clips so the runtime's hint search picks them up.
# Mixamo names everything "mixamo.com" by default — fix that.
# Use a glTF editor (Blender or Gestaltor), or the Step 4 script:
node rename-clips.mjs merged.glb renamed.glb
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

# 7. Upload at https://three.ws/create, then attach it in the agent editor's Outfit panel
```

Total: 15–25 minutes the first time, 5 minutes once you've done it. The script-based renames step is the only fiddly part; everything else is one-line commands.

---

## Step 10 — Verify on the live agent

Once uploaded:

1. Open any page that embeds the agent (your homepage, or the live preview in the agent editor's Outfit panel).
2. Confirm the new body loads — no T-pose, no warped limbs.
3. Send a chat message — the agent should switch to the talk clip while replying.
4. In a browser console, fire each clip by name:

```js
const agent = document.querySelector('agent-3d');
agent.wave();
agent.play('Cheer'); // exact clip name (case-insensitive fallback); returns false if missing
agent.play('Talk');
agent.play('Idle');
```

Each one should trigger the corresponding clip. If a clip you expect doesn't fire, run `agent._scene.clips.map(c => c.name)` in the console — that prints the actual clip names the runtime sees. Compare against the names you set in Step 9.

---

## What you learned

The full custom-GLB pipeline:

- Compatible avatars come from Mixamo, three.ws Studio, the photo pipeline, or Blender — all produce something the runtime understands
- The runtime needs a humanoid skeleton, an idle clip, and a talk clip; it likes a wave and a celebrate too
- The validator at [three.ws/validation](https://three.ws/validation) catches every common failure before upload
- Mixamo's `mixamo.com` clip names need renaming so the hint search finds them
- `gltf-transform optimize` is the one command that handles geometry compression, resize, and simplify in one pass (meshopt by default; `--compress draco` for Draco)
- The dashboard upload path stores the GLB with correct CORS — no separate hosting work needed

Once the body is on the platform, the embed snippet doesn't change. The same `<agent-3d agent-id="...">` tag picks up the new body automatically.

## Next steps

- [Swap the avatar in Studio](/tutorials/swap-avatar-in-studio) — preview body swaps with no code
- [Build a personal AI website](/tutorials/personal-ai-site) — put your custom avatar at the centre of a homepage
- [Give your agent a personality](/tutorials/agent-personality) — match the brain to the new body
