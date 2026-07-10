# 3D creation

three.ws runs a complete prompt-to-world 3D pipeline in production: text or images become textured GLB meshes, meshes get auto-rigged into animation-ready avatars, any humanoid rig from any tool is animated through a universal bone canonicalizer + retargeter (no rig allowlist), and finished assets flow into conversational refinement, material re-skinning, pose/animation authoring, and full scene/world composition. Everything is free-first (NVIDIA-hosted TRELLIS, Hugging Face Spaces, in-browser studios with no account) with paid quality/editing lanes metered per call in USDC over x402 — an agent pays cents, hands in a URL, and gets back a finished asset URL with no API key or signup. Every output is a portable glTF 2.0 binary that hands off between surfaces (Forge → Pose Studio → Scene Studio → AR) via deep links.

## Text→3D Forge — free TRELLIS lane + paid tiered lanes

Type a prompt at /forge (or call the forge_free MCP tool) and get a downloadable textured 3D model (GLB) plus a browser viewer link. The default lane is completely free — no account, no key, no wallet — with paid quality tiers (draft $0.05 / standard $0.15 / high $0.50 USDC) when more geometric budget is needed.

**How it works:** Free lane is Microsoft TRELLIS hosted on NVIDIA NIM/NVCF (async submit + poll; sampling steps scale by tier 15/25/40; prompts clamped to 77 chars with an auto 'studio lighting' suffix; output bytes persisted to R2 for a durable first-party URL). The backend registry (api/_lib/forge-tiers.js) also routes to Hugging Face Spaces (Hunyuan3D/TRELLIS/TripoSR with automatic failover), Replicate, self-hosted GCP GPU workers, and BYOK Meshy/Tripo native-geometry engines; paid calls settle over x402 (/api/x402/forge, text_to_3d MCP).

**Why it matters:** Zero-cost text→3D that any human or AI agent can use instantly, with a transparent pay-per-call ladder — identical pricing across REST and MCP — when quality matters.

## Text→Avatar & one-call rigged avatar (text_to_avatar, forge_avatar)

Generate a humanoid avatar GLB from a prompt (text_to_avatar), or get a fully rigged, animation-ready avatar in a single call (forge_avatar) that chains mesh generation and auto-rigging. Complementary no-AI paths exist too: three selfies → realistic avatar at /create, and a full builder (body, skin, hair, clothing) at /studio.

**How it works:** forge_avatar runs generation then rigging behind a humanoid gate — a mesh that can't safely carry a humanoid skeleton is never forced into a broken rig (an allow_non_humanoid flag overrides). The photo path downscales three selfies, opens an Avaturn editor session, and saves the exported GLB to the user's account (src/selfie-pipeline.js, src/avatar-creator.js). Results ship as Spatial MCP artifacts that render inline in MCP hosts.

**Why it matters:** One sentence to a character that can already walk, wave, and emote — no Blender, no rigging knowledge, no multi-step orchestration.

## Image→3D reconstruction

Turn 1–4 reference photos or concept-art views into a textured GLB (image_to_3d MCP, mesh_forge, /forge photo drop). Multi-view input removes back-of-object hallucination. mesh_forge adds an art-direction layer: IBM Granite rewrites the intent and directs a FLUX text→image + reconstruction chain.

**How it works:** NVIDIA's hosted TRELLIS preview is text-only, so photo input routes to the free Hugging Face Spaces lane (Hunyuan3D/TRELLIS/TripoSR failover) or paid backends. The text→3D path itself is image-intermediate: FLUX.1-schnell paints a clean, centered reference view first because a clean subject reconstructs into a far better mesh. A $0.01 background-removal stage (pipeline-rembg, five model choices) produces the transparent-PNG subject cutout so a room never gets baked into the mesh.

**Why it matters:** A product photo, sketch, or generated concept image becomes real 3D geometry — with the reference-image quality problem solved for you.

## Auto-rigging (rig_mesh / UniRig / pipeline-rig)

Adds a humanoid skeleton with per-vertex skin weights to any static GLB, turning a rig-less mesh into an animation-ready model that can walk, wave, and emote.

**How it works:** Runs the VAST-AI UniRig lane on GCP Cloud Run GPU workers (workers/unirig, avatar-pipeline controller /rig). Sold three ways at $0.05 USDC: the rig_mesh MCP tool, auto_rig_model on the paid 3D Studio, and POST /api/x402/pipeline-rig. Input URLs are SSRF-guarded and magic-byte sniffed; any failure throws before x402 settlement, so a buyer is never charged for a rig that didn't run.

**Why it matters:** Every generated or uploaded mesh becomes animatable in one paid call of a few cents — nobody else in the x402 ecosystem sells rigging as a per-call stage.

## Universal retargeting — any humanoid rig animates (src/glb-canonicalize.js + src/animation-retarget.js)

Any humanoid avatar from any tool plays the entire animation library — legs included — with zero manual bone mapping. Mixamo, VRM/VRoid, VRM 1.0, Unreal mannequin, Daz/Genesis, MakeHuman, Blender .L/.R, Rigify, HumanIK/Maya namespaces, CharacterStudio, snake_case/kebab-case, and simple shoulderL-style rigs are all handled out of the box.

**How it works:** glb-canonicalize.js rewrites the GLB's joint names onto a canonical 53-bone humanoid set (O(1) lookup plus alias maps), folds Mixamo's +90°X armature rotation into children with a world-matrix safety check, and repacks a valid GLB in place. animation-retarget.js then renames each clip track to the rig's actual bones, applies per-bone bind-pose correction (C = targetRest · sourceRest⁻¹, handling A-pose vs T-pose rests), and rescales hip translation by height ratio. Gates: ≥8 canonical bones to be playable, ≥50% track coverage per clip, and a 45° hips-tilt sanity check; a genuinely non-riggable prop falls back to the default rig via AnimationManager.supportsCanonicalClips() — never a bind-pose T-pose.

**Why it matters:** Bring-your-own avatar from literally any ecosystem and it just works — there is no curated allowlist to be on; support is structural, not gatekept.

## refine_model — conversational iteration with version lineage

Iterate on a model by describing the change in words — 'make it metallic', 'bigger helmet', 'add wings'. Every refinement is a real anchored re-generation (never a fake diff) appended to an immutable, revertable, branchable version history rendered as a clickable version strip in the viewer.

**How it works:** The prior prompt is carried forward and folded with the instruction (composeRefinement); an optional reference image of the current model anchors the regeneration as image→3D. Each call returns a lineage array; pass it back as parent_lineage to extend the thread or target an earlier version with parent_index to branch — reverting is a pointer move, no mutation. Free on the mcp-studio server, $0.25 USDC on the paid agent server, both on the same shared lineage core (mcp-server/src/tools/_lineage.js).

**Why it matters:** Sculpt with sentences instead of re-prompting from scratch, and never lose a version — every fork of the design stays one click away.

## restyle_material / Restyle Studio — re-skin without regenerating

Change what a model is made of without touching its geometry: apply PBR presets (chrome, gold, glass, wood…), restyle from a plain-language AI instruction ('cyberpunk neon'), or fan out seeded, reproducible colorway variants — then fine-tune metalness/roughness live and export a validated GLB.

**How it works:** The free rate-limited /restyle web page and the paid restyle_material MCP tool are thin clients over one shared implementation (api/_lib/material-studio-store.js). Every restyle and persisted variant set is recorded in the same immutable parent→child lineage shape refine_model uses, so any earlier material version can be reverted to or branched from. Seeded variants are deterministic — the same seed reproduces the same colorway.

**Why it matters:** Infinite material variations in seconds at a fraction of regeneration cost — the mesh you approved stays byte-identical while its look changes.

## Scene/world composition — compose_scene, build_world, /diorama

Speak a world into being: one short sentence becomes a planned diorama (title, mood, palette, ground, 2–8 placed objects), every object is forged as its own mesh, and the result merges into one explorable GLB you can walk through and take into AR.

**How it works:** compose_scene turns the sentence into a placement plan via the platform's free-first LLM chain (nothing forged yet); export_scene merges the forged objects into a single glTF 2.0 binary where every object is a named selectable node, plus a real ground disc and mood-tuned lighting; build_world runs the whole compose→forge→export pipeline server-side in one call for agents with no browser. All of it runs against the public /api/diorama endpoint — no key, signer, or payment.

**Why it matters:** A complete multi-object 3D scene from a single sentence — the kind of output people screenshot — available equally to a human at /diorama and an agent over MCP.

## Scene Studio (/scene) & Scene Composer (/compose)

Scene Studio is a full in-browser 3D editor: import models (GLB, FBX, OBJ, Collada, USDZ, STL, VOX and more), arrange with Move/Rotate/Scale gizmos, edit PBR materials live, add primitives and five light types, keyframe on a timeline, and export the entire scene as one self-contained GLB. Scene Composer is the lighter sibling: forge items from text in place, attach them to an avatar's skeleton bones (hat to head, sword to hand), and export or save the assembly as an outfit.

**How it works:** Scene Studio mounts the vendored mrdoob/three.js editor (r184) under the three.ws nav, autosaves to browser storage, and accepts /scene?model=<url> deep links — which is how 'Open in Scene Studio' hand-offs from Forge and the Animation Studio work. Everything runs client-side through an undoable command system; groups and names survive into the exported GLB.

**Why it matters:** A real, no-install editor producing a portable single file that flows into AR, other tools, and every other three.ws surface — plus a purpose-built fast path for dressing avatars.

## Pose Studio / Animation Studio (/pose)

Pose any three.ws avatar (or the built-in mannequin) with FK gizmos, sliders, and drag-IK; keyframe a timeline; generate brand-new motion from a text prompt; and export an animated GLB, a reusable clip JSON, or a PNG. Saved animations play back across the platform and can be sold for USDC.

**How it works:** A Three.js workspace (src/pose-studio.js, src/animation-library.js) with the full preset-clip gallery live-previewing on the loaded rig; text→motion generation calls /api/forge-motion; export bakes the retargeted clip onto the current rig via GLTFExporter. Agents get the same surface programmatically: pose_model ($0.01) maps a pose description to a deterministic seed plus a full Euler joint-rotation map.

**Why it matters:** Author, generate, and monetize motion without ever opening a DCC — and everything you export is a standard GLB/clip that works anywhere.

## Animation library & gallery (/animations)

One shared motion library that drives every avatar: the curated studio manifest, a ~2,000-clip R2-hosted motion-capture library, and community-published clips — all browsable with poster thumbnails, derived categories, live hover previews, and shareable deep-linked filters.

**How it works:** Clips are THREE.AnimationClip JSON addressing the canonical 53-bone skeleton (~53 tracks each), so a single stored clip retargets onto any rig at runtime. Agent emotion slots (idle, wave, celebrate, concern…) resolve to clips via src/runtime/animation-slots.js, and apply_animation ($0.01) retargets any library clip onto any rigged GLB over MCP. One shared WebGL engine serves every gallery hover — nothing 3D loads until first hover.

**Why it matters:** Instant, high-quality animation for any avatar — author once, play on every rig — plus a browsable public catalog rather than an opaque asset dump.

## Pay-per-stage mesh pipeline (remesh / game-ready / stylize / retexture / segment)

Every post-generation stage of a professional 3D pipeline sold as its own few-cent x402 call: retopologize to predictable topology with textures re-baked ($0.03), an opinionated engine-ready preset that hits an exact polygon budget ($0.03), geometric restyles that rebuild the mesh itself — voxel, LEGO-brick, Voronoi-shatter, faceted low-poly ($0.02–0.03), prompt-driven retexturing (full-mesh or magic-brush masked region, $0.05), and mesh segmentation into named parts ($0.02). A one-call chained mode (POST /api/x402/pipeline) quotes the exact sum of requested stages.

**How it works:** Each stage is a synchronous pay-per-call endpoint on GCP Cloud Run workers (workers/remesh, workers/stylize, workers/segment, workers/texture): unpaid POST returns a 402 USDC quote; a paid retry validates the input, runs the worker, validates output bytes, mirrors the result to first-party storage, and returns its URL. Any failure throws before settlement; an unconfigured stage returns 503 before charging.

**Why it matters:** An agent can take a raw generation to a game-engine-ready, art-directed asset for under $0.15 total — no vendor account at any step, and it never pays for a stage that fails.
