# Building three.ws 3D Studio: text to rigged, animated 3D inside ChatGPT (Apps SDK connector + custom GPT Actions), and the open-source pipeline behind it

_Forum post for the [OpenAI Developer Community](https://community.openai.com), posted from the nichxbt account. Category: API (Actions / Apps SDK). Tags: chatgpt, actions, apps-sdk, mcp, 3d. First person, technical, no marketing voice. Every URL in this post is live and keyless unless it says otherwise._

---

Hi all. I build [three.ws](https://three.ws), an open-source (Apache-2.0) browser-native 3D AI platform. For the last few months a big part of my time has gone into making it usable from inside ChatGPT, and I wanted to write up the whole thing properly for this community: what the integration looks like on the OpenAI side (a ChatGPT app over the Apps SDK connector, and a custom GPT over Actions), what actually happens on my side when a prompt comes in (a fleet of GPU workers running open 3D models), the parts that were hard, and where it is all going. It is long. The short version is at the top; the rest is for people who want the details.

**Short version:** type "a low-poly orange fox sitting down" into ChatGPT and about a minute later you get a real, textured, downloadable GLB, an interactive 3D viewer, and a link that puts the model in your room in AR on your phone. Optionally the model gets a humanoid skeleton, skin weights and 52 ARKit blendshapes, and then it walks, waves and talks. All of it is free, no account, no API key. The same pipeline is reachable from Claude, Cursor, curl, or any MCP client, and the whole stack (frontend, API, workers, contracts) is public on GitHub.

## 1. The two ChatGPT surfaces

ChatGPT has two integration models with different strengths, so the 3D lane ships into ChatGPT twice.

### 1a. The ChatGPT app (Apps SDK / MCP connector)

The connector is a Streamable HTTP MCP server at `https://three.ws/api/mcp-studio` (MCP protocol `2025-06-18`, JSON-RPC 2.0 over POST, no auth). It exposes exactly ten tools, deliberately scoped to 3D generation only: no wallet, no payments, no token, nothing a store reviewer would need to think twice about.

- Six generation tools: `forge_free` (text to 3D), `text_to_avatar` (text to a rigged humanoid), `mesh_forge`, `rig_mesh` (add a skeleton to a static GLB you already have), `forge_avatar`, and `refine_model` (iterate on a previous result; every refinement is its own version with its own AR link).
- One collector, `check_job`, which picks up a generation that outran the tool call.
- Three persona/embodiment tools: `create_agent_persona`, `get_agent_persona`, `persona_say`, which give a rigged body a name, a voice line and a living-avatar page.

Each generation tool renders inline through an Apps SDK widget (`ui://widget/three-studio-model.html`) that shows the rotatable model plus a **View in your space** button. If the result is rigged, the response also carries an `irlUrl` and the button becomes **Bring it to life**. The persona tools render in their own widget.

One thing worth calling out for anyone shipping a 3D widget: the widgets declare an `openai/widgetCSP` whose allowlist includes the GLB storage origin. Real ChatGPT enforces that CSP. A widget that loads fine in a permissive test harness and then shows a blank viewer in production is almost always this: the model file is on a CDN host you did not allowlist.

You can hit the same server without ChatGPT at all:

```bash
curl -s https://three.ws/api/mcp-studio \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Full server doc: [three.ws/docs/mcp-studio](https://three.ws/docs/mcp-studio).

### 1b. The "three.ws 3D Studio" custom GPT (Actions)

Not every plan supports connectors, so the same free lane also ships as plain REST Actions for the custom GPT in the GPT Store. The OpenAPI 3.1 contract is served at `https://three.ws/.well-known/3d-studio-openapi.yaml` and the GPT imports it from that URL (never an inline paste; more on why below). Two operations:

```bash
# submit
curl -s -X POST https://three.ws/api/3d/studio \
  -H 'content-type: application/json' \
  -d '{"prompt":"a small ceramic robot figurine"}'
```

Submit returns either the finished model or a job to poll:

```json
{ "status": "pending", "job": "…", "poll": "/api/3d/studio?job=…&title=a%20small%20ceramic%20robot%20figurine", "format": "glb", "etaSeconds": 62, "watchUrl": "https://three.ws/…" }
```

```json
{
  "status": "done",
  "glbUrl": "https://three.ws/cdn/creations/…/model.glb",
  "viewerUrl": "https://three.ws/viewer?src=…",
  "arUrl": "https://three.ws/api/ar?src=…&title=a%20small%20ceramic%20robot%20figurine",
  "format": "glb"
}
```

Design notes that came directly from ChatGPT's constraints:

- **Actions time out at roughly 45 seconds, and a reconstruction takes 30 to 90.** So submit never blocks. It answers `pending` fast, with a `poll` path that already carries the job handle and the title, an `etaSeconds` countdown, and a `watchUrl` to a three.ws page that shows the concept art and a real countdown and opens the finished model by itself. The GPT hands the user the watch link on the first pending response, then polls `checkModelJob` at roughly `etaSeconds` intervals. The poll endpoint returns `429` with a `retry_after` if the model polls too fast, and the GPT is instructed to honor it rather than to tell the user something broke.
- **The text-to-3D path goes through an intermediate image.** So a pending response can carry `previewImageUrl`, the concept art that the geometry model is about to sculpt. The GPT shows it as a markdown image while waiting. It makes the minute feel short.
- **Age-13+ safety gate and store-clean responses.** The Actions surface returns model URLs and job state only.

### 1c. Lessons from QA on the custom GPT (the part I wish someone had told me)

On 2026-07-29 I ran the four conversation starters through the GPT and two of them failed in ways that had nothing to do with my API:

1. "Make me a low-poly fox for my game" produced a DALL-E image, never called the action, and returned no model.
2. "Create a dragon miniature" produced a DALL-E image plus two fabricated links (`three.ws/models/<id>.glb` and `three.ws/preview/<id>`). Neither route exists. Both 404ed.
3. "Create a 3D mascot for my community" stalled on clarifying questions.
4. "Surprise me" worked end to end.

Three root causes, all in builder configuration:

- **Image Generation capability was enabled.** With DALL-E available, the model sometimes satisfies "make me a fox" by painting a picture. Style-section rules like "do not return .png" do not reliably stop it. Unchecking the capability does. This was load-bearing.
- **An instruction said "always return GLB links from https://three.ws".** Real GLB downloads live on an R2 CDN host, so that rule pushed the model to fabricate plausible three.ws-hosted links whenever it had skipped the action. The corrected instruction says the opposite: present URLs exactly as returned, and the CDN host is correct. The iron rule in the instructions is now "the ONLY way you produce a model is the generate3DModel action; if you have no URL from an action, you have no model."
- **A stale inline action schema.** The builder held a pasted copy of an old spec without `arUrl`, `previewImageUrl`, `tier`, `etaSeconds` or the title-carrying poll path. Now the schema is only ever imported from the `.well-known` URL and re-imported after any spec change.

And a smaller one: every conversation starter must name one concrete subject ("a low-poly fox", "a dragon miniature") so the GPT generates immediately. "Create a 3D mascot for my community" was dropped because it invites questions. The full builder configuration is versioned in the repo at [docs/chatgpt-3d-studio-gpt.md](https://github.com/nirholas/three.ws/blob/main/docs/chatgpt-3d-studio-gpt.md), so a change in the builder and a change in git land together.

### 1d. AR from a chat surface that cannot run WebGL

ChatGPT cannot run WebGL, ARKit or ARCore. It can only print links. So the entire AR capability is compressed into one URL that any chat surface can hand to the user:

```
https://three.ws/api/ar?src=<glbUrl>&title=<name>
https://three.ws/api/ar?src=<glbUrl>&title=<name>&kind=avatar   (rigged body)
```

Everything hard happens after the tap, on my side: device detection, format conversion (USDZ for Quick Look on iOS, Scene Viewer intent on Android, a WebXR session on desktop browsers that support it), and the AR session itself. A shared link unfurls with a real render of the model. `kind=avatar` unlocks the living-agent lane, where the rigged body idles, walks and talks instead of standing in a T-pose. Nothing here is ChatGPT-exclusive; the contract is public and keyless, so an email, a text message, or a Claude conversation gets the identical capability. Write-up: [three.ws/docs/chatgpt-ar](https://three.ws/docs/chatgpt-ar).

## 2. What happens after the prompt: the generation pipeline

Now the part that has nothing to do with ChatGPT and everything to do with 3D.

### 2a. Inputs and tiers

Forge ([three.ws/forge](https://three.ws/forge)) accepts three kinds of input:

| Input | How it works | Typical time |
|---|---|---|
| Text | Prompt to reference image (FLUX) to reconstructed mesh | 30 to 90 s |
| Image | 1 to 6 reference views (front/back/left/right/top/three-quarter); multi-view removes back-of-object hallucination | 30 to 90 s |
| Sketch | A drawing plus a name; a scribble-conditioned rectified-flow model reconstructs the geometry | 30 to 90 s |

Three quality tiers: `draft` (about 12k polygons), `standard` (about 30k, the default), `high` (about 200k with PBR textures). The public REST endpoint is one call:

```bash
curl -X POST https://three.ws/api/forge \
  -H 'content-type: application/json' \
  -d '{"prompt": "a brass steampunk owl, full body", "tier": "standard"}'
# → { "job_id": "…" }
curl 'https://three.ws/api/forge?job=<job_id>'
# → { "status": "done", "glb_url": "https://…/model.glb" }
```

`GET /api/forge?catalog` returns the live tier/backend/cost matrix, which matters because the backend set changes.

### 2b. The GPU worker fleet

Generation runs on a fleet of single-purpose Python FastAPI services on Google Cloud Run, most of them on L4 GPUs, all scale-to-zero, all sharing one job contract (`POST /infer` returns `202 { task_id }`, `GET /tasks/:id` returns status and a result URL). A CPU controller fans out to them and picks a mesh backend per job. The open models in the pool:

- **Hunyuan3D-2.1** (Tencent): single image to textured mesh.
- **TRELLIS** (Microsoft, MIT): single image to textured mesh via structured latent representations. This is the default text-to-3D lane behind ChatGPT: FLUX makes the reference image, TRELLIS reconstructs it.
- **TripoSR** (VAST-AI, MIT): fast single-image reconstruction, 5 to 15 seconds with a baked texture. Used as the fast path and as a fallback.
- **TripoSG** (VAST-AI Research, MIT): a 1.5B-parameter rectified-flow transformer for high-fidelity geometry. Two modes on one contract: `image` (RMBG-1.4 background removal, recenter, 50 steps) and `scribble` (the CFG-distilled TripoSG-scribble pipeline, 16 steps), which is what powers sketch-to-3D.
- **Bring-your-own-key lanes** for Meshy and Tripo when someone wants native quad topology; the key stays in the browser and never touches my server.

Around the mesh generators sit the processing workers:

- **rembg**: BRIA RMBG-2.0 with U2Net as a CPU fallback, cleaning source photos before reconstruction.
- **remesh** (CPU): repair, simplify (quadric decimation), retopologize (QuadriFlow), UV unwrap (xatlas), and format conversion across GLB, OBJ, FBX, STL, PLY, USDZ and 3MF. Headless Blender handles FBX so a rigged GLB converts with its bone hierarchy, skin weights and blendshapes intact, which is what Unity and Unreal users need.
- **stylize** (CPU, pure geometry, no inference): `voxel`, `brick` (voxels plus studs), `voronoi` (an open strut-and-node lattice shell), `lowpoly` (decimated with hard flat-shaded facets). Source color is preserved per output element where the style allows.
- **segment** (CPU, pure geometry): splits a model into named, separable parts. Connected-component splitting handles physically disjoint shells; the minima rule (region growing that cuts the face-adjacency graph at concave creases, where human perception sees part seams) handles the rest. Each part becomes a named node in the output GLB with a manifest (id, name, region, bbox, centroid, face counts, color) so you can hide, recolor, replace or export it individually.
- **texture** (GPU): full retexture from a prompt by rendering depth from 8 canonical viewpoints, generating coherent views with SDXL plus ControlNet-Depth, rasterizing the mesh into UV space and back-projecting each view through the camera it was rendered with, weighting texels by how squarely each view sees them and refusing the ones the depth buffer says are occluded. A magic-brush mode inpaints only a masked UV region and feathers the seam so untouched texels stay bit-identical across passes.
- **rig** (GPU): Make-It-Animatable. Takes a raw generated mesh and adds a 52-bone Mixamo-named humanoid skeleton, per-vertex skinning weights, and ICT-FaceKit ARKit-52 blendshapes. The rig is grafted into the original GLB bytes, so the materials and PBR textures the generator produced survive untouched. This is what `rig_mesh` and `text_to_avatar` call.
- **avatar-reconstruction** (GPU): the selfie lane. 1 to 6 face photos, six multi-view renders synthesized with Zero123++, InstantMesh reconstruction, and a newer path that morphs a rigged template head to the person's 468 MediaPipe landmarks and projects the photo onto its skin.
- **text2motion**, **video2motion**, **video2scene**: text to an animation clip, a phone video to a retargetable motion clip, a video to a scene.
- **garment-forge**: clothing generation for avatars.
- **longcat**: LongCat-Video-Avatar-1.5 for lip-synced talking-avatar video from a reference image plus audio. Built and tested; it needs an 80 GB-class GPU (about 45 GB resident even at int8), so it does not fit Cloud Run's L4 and runs on a dedicated A100/H100 instance.

Every lane has a failover chain. A single model being unavailable degrades quality gracefully instead of failing the request, and a submit that fails over never double-charges on the paid rail. Worker directory with each service's contract: [workers/](https://github.com/nirholas/three.ws/tree/main/workers).

One practical detail that bit me more than once: most three.ws avatars ship with `EXT_meshopt_compression`, which trimesh cannot decode. Any worker that loads a caller's mesh routes it through a meshopt decode step first (using a pinned `gltfpack` binary shipped in the image). A new mesh-consuming worker inherits that requirement or it fails on the first real input.

### 2c. The 3D Studio MCP server (the paid, full-pipeline twin)

Beyond the ten free tools, the full pipeline is exposed as a second MCP server at `https://three.ws/api/mcp-3d` (OAuth 2.1 against the same authorization server as the main MCP endpoint, or x402 pay-per-call). The tools compose into one flow, each step's output feeding the next:

```
direct_prompt ─▶ text_to_3d ─┐
                image_to_3d ─┴▶ generation_status ─▶ auto_rig_model ─▶ apply_animation
                                                                   └─▶ pose_model
mesh ops: remesh_model · stylize_model · segment_model · retexture_model · retexture_region · generate_material
analyze:  inspect_model · optimize_model · animation_signature · find_similar_animations
preview:  preview_3d · export_ar
```

So "optimize this idea, generate it, rig it, and make it wave" is `direct_prompt` (an LLM rewrites a vague multi-subject idea into one optimized single-subject prompt) to `text_to_3d` to poll to `auto_rig_model` to poll to `apply_animation(animation: "wave")`. `animation_signature` returns a clip's measured motion (energy, tempo, leading region, loop seam, travel) and a fit verdict against a runtime slot; `find_similar_animations` ranks the library by motion distance from a reference clip. `inspect_model` reports meshes, triangles, materials, textures, animations and extensions; `optimize_model` suggests Draco/Meshopt, KTX2 and triangle budgets. When a job finishes, `generation_status` returns a `text/html` resource so the client can render an inline interactive viewer. Doc: [three.ws/docs/mcp-3d-studio](https://three.ws/docs/mcp-3d-studio).

## 3. Animation as infrastructure, not content

Anyone who has shipped 3D characters knows this pain: a model rigged in one ecosystem rarely animates correctly in another. I treated it as an infrastructure problem.

- **Skeleton canonicalization.** A canonicalizer maps the bone-naming conventions of the major ecosystems (Mixamo, Avaturn, Unreal, VRM/VRoid, VRM 1.0, Daz/Genesis, MakeHuman, Blender `.L/.R` suffixes, plain `shoulderL`-style rigs) onto one canonical humanoid skeleton. There is deliberately no allowlist of supported rigs. A new convention is a bone-name mapping to add plus a test case, not a feature to request.
- **Retargeting.** A retargeting layer drives a shared clip library (idle, walk, run, gestures, dances, a seated idle for chat mode) onto any canonicalized rig, legs included. A rig that genuinely cannot be skeleton-driven (no skin, a non-humanoid prop) falls back to the default body rather than a bind-pose T-pose.
- **Slot-based animation manager.** Clips are decoupled from rigs and blended per slot (idle, gesture, locomotion) with crossfades, driven by a state machine that listens to protocol events. A new clip is authored against any rig in Blender, exported, and dropped into the library; the runtime picks it up and the agent can invoke it by name.
- **Asset formats.** Every avatar is a GLB (body, rig, textures in one file); every shared gesture is a format-light clip JSON (a serialized `THREE.AnimationClip`, motion only, retargeted at runtime). The web build runs `gltfpack` for meshopt compression, which cuts a typical avatar by about 90 percent.
- **Rig Doctor** ([three.ws/rig-doctor](https://three.ws/rig-doctor)) reports in seconds whether a given GLB will animate and why, which turned "my model is broken" support threads into a link.
- **Talk mode.** TTS audio is analyzed in real time and drives the 52 ARKit blendshapes for lip-sync, with weighted emotion blending (celebration, concern, curiosity, empathy, patience) layered on top from protocol events rather than a finite-state machine.

Longer write-ups: [three.ws/docs/animations](https://three.ws/docs/animations) and [three.ws/docs/3d-asset-pipeline](https://three.ws/docs/3d-asset-pipeline).

## 4. The studios: what you do with the model once you have it

A generated model is not a dead end. Each of these is a live page that consumes what Forge produces:

- **Scene Studio** (`/scene`): a vendored three.js r184 editor. Import GLBs, compose scenes, edit materials and lights, export.
- **Diorama** (`/diorama`): one sentence becomes an explorable 3D world. An LLM composes the scene graph, every object in it is forged to a real GLB, the scene is assembled live, and it saves to a public gallery with a shareable permalink. Also an MCP server (`@three-ws/scene-mcp`).
- **Scene Composer** (`/compose`): forge props from text and parent them to a rigged avatar's skeleton bones, with bones grouped into readable regions, transform gizmos, 50-deep undo, grid snap and camera presets. Export a GLB or save the outfit back onto the avatar.
- **Material Studio** (`/restyle`): PBR restyling, colorway variants, and an LLM-generated glTF 2.0 PBR material from a text description.
- **Parts Studio** (`/segment`): the segmentation worker with a viewer for each part.
- **Pose Studio** (`/pose`), **Mocap Studio** (`/mocap-studio`), **Voice Lab** (`/voice`): author poses, capture and retarget motion from video into reusable clips, bind voices.
- **Avatar Studio**: a vendored, web-first character creator (based on the MIT-licensed CharacterStudio) for building a humanoid from parts.
- **Selfie to avatar** (`/create`): three shots (frontal, left, right) with real-time quality gates for lighting, framing and blur, reconstructed, rigged, stored, and delivered as a rigged GLB in under a minute. If rigging is unavailable the bare mesh is delivered tagged `unrigged`; the user is never left empty-handed. A server-side sweep finishes the job if the tab is closed mid-poll.
- **Model pages** (`/m/:id`): every finished model is a first-class page with an interactive viewer, AR and fullscreen, live triangle/vertex stats, the full prompt, likes, a comment thread, embed/share/download, paid remix, and a same-category suggested rail. Creators get a public portfolio at `/u/:username` with a Creations tab merging forged models, Scene Studio worlds and Material Studio restyles, all rendered as live spinning `<model-viewer>` cards.
- **Forge-Off**: community voting on fresh generations, feeding a "top this week" strip on `/forge`.
- **readme-3d**: an open-source toolkit for putting a real, drag-to-rotate 3D model in any GitHub README, issue or discussion, by decimating a GLB to about 1,200 triangles and embedding it as ASCII STL, which GitHub renders natively. The three.ws README opens with one.

## 5. Distribution: the `<agent-3d>` web component and the SDKs

A generated avatar is not locked into the platform. `<agent-3d>` is a framework-free custom element that embeds a live, animated avatar in any page with one script tag; it lazy-boots on intersection so off-screen agents cost nothing, and animations, moods and speech are drivable from page JavaScript. Five widget variants (turntable, animation gallery, talking agent, passport card, hotspot tour), a WYSIWYG embed editor at `/embed`, Open Graph and oEmbed so world and creation links unfurl as interactive 3D in WordPress, Ghost, Discord, dev.to and Notion, and versioned CDN bundles at `/agent-3d/x.y.z/agent-3d.js`.

The frontend philosophy is worth stating: vanilla JavaScript modules built with Vite, three.js for rendering, Rapier compiled to WebAssembly for physics, Draco/KTX2/Meshopt decoders, no heavyweight framework. That is what makes the embed story credible; the components carry no runtime tax onto host pages. The viewer targets every browser with WebGL 2.0 and refuses to boot without it rather than rendering a broken canvas.

Fifteen packages ship from the repo to npm under the `@three-ws` scope. The 3D-relevant ones: `@three-ws/avatar` (viewer, creator iframe, AR/VR runtime, React bindings), `@three-ws/agent-ui` (an avatar overlay that reacts to buttons, inputs and navigation), `@three-ws/avatar-schema` (JSON Schema plus validator for avatar manifests), `@three-ws/viewer-presets` (light rigs, floor reflections, bloom), `@three-ws/avatar-cli` (scaffold, validate, hash and preview manifests from a shell or CI), `@three-ws/walk` (a corner mascot that walks your page, plus a full-page playground). The MCP servers are in the official MCP registry under `io.github.nirholas`. Load-bearing wire formats are written up as specs: the agent manifest, the `<agent-3d>` element and its `postMessage` host protocol with origin lock, the skill bundle layout, the stage/scene configuration, the memory format.

## 6. The agent layer: giving the body a brain, an identity and a wallet

This is where three.ws goes beyond "a 3D generator". The founding idea is: give your AI a body.

- **Runtime.** Any avatar can be wrapped with an LLM brain running a structured tool loop (up to 8 tool iterations per turn) with built-in tools like `wave`, `lookAt`, `play_clip`, `setExpression`, `speak`, `remember`, plus installable skill bundles from IPFS, Arweave or HTTP. The brain is provider-agnostic behind a single interface: OpenAI models, Claude, Gemini, Groq, OpenRouter and NVIDIA are all wired, selectable per agent in the manifest, and there is a side-by-side comparison surface at `/brain`. Routing is free-first (free tiers tried before paid keys) so chat never fails silently on one quota.
- **Agent shell.** Every visitor to the site gets a named ephemeral agent in the first five seconds, a corner companion with an identity chip, and a ⌘K palette that runs real commands (forge, digest, price, ask) and announces completions so the companion reacts. The agent is the interface.
- **Identity.** An agent can be registered on-chain as an ERC-8004 token on any EVM chain (IdentityRegistry, ReputationRegistry, ValidationRegistry in Foundry) or as a Metaplex Core asset on Solana, with a stable ID, owner wallet, delegated signer (EIP-712), EIP-7710 delegated permissions, an IPFS-pinned manifest, and a signed action log. Solana is the home chain; the EVM legs are additional surfaces.
- **Payments (x402).** Agents pay other agents per request in USDC using the HTTP 402 pattern: an unpaid call returns `402` with a machine-readable price, an x402-capable client pays and retries, and settlement happens on-chain only after the call succeeds. The paid twin of Forge (`POST /api/x402/forge`) charges $0.05 draft, $0.15 standard, $0.50 high, polling is free, and retried payments are idempotent. Pay-by-name resolves `@username`, `*.sol` names and raw addresses. There is a SKU catalog, subscriptions, receipts, a bazaar search API, and an A2A (agent-to-agent) bridge that exposes paid MCP tools as x402 endpoints. Any signed-in user can mint `[username].threews.sol` in one atomic Solana transaction with three.ws paying gas.
- **Worlds.** At `/play` every Solana token community gets a persistent multiplayer 3D world derived from its mint address, with proximity voice chat, collaborative voxel building, an in-game economy, vehicles, and a shared deterministic day/night clock so two people in the same world always agree on whether it is night. `/temporary` walks your avatar through six staged environments with heightfield physics and live peers. `/club` is a multiplayer venue with rigged dancers. The multiplayer backend is a Colyseus server.
- **Open inference network.** Anyone can run a node: the node-operator client registers with the coordinator using a signature under its own ed25519 key, claims jobs from a queue, runs a real open model on CPU or CUDA, and returns results signed over a canonical receipt binding job, model and input/output hashes, which the coordinator recomputes before accepting. Paid inference settles through the x402 rail and the platform signing key is published so receipts verify offline.
- **$THREE.** The platform's token on Solana (contract `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`). Holders follow a public changelog that is pushed to Telegram automatically after every deploy; there is also a small MCP server that treats burning it as an agent primitive.

## 7. Infrastructure, honestly

- One Node container on Google Cloud Run serves the static frontend and every API handler; `GET https://three.ws/api/version` returns the exact commit and revision that is live right now.
- Global HTTPS load balancer plus Cloud CDN in front, with a synchronous CDN purge as part of every deploy (an async purge caused phantom post-deploy failures, so it is synchronous on purpose).
- Neon Postgres for metadata with a migration gate that refuses to submit a build over an unapplied schema (production once served handlers querying a column whose migration never ran; that gate exists because of that day).
- Cloudflare R2 for model storage, Upstash Redis for rate limiting.
- Over a hundred scheduled jobs on Cloud Scheduler (changelog delivery, reconstruction sweeps, reputation crawls, subscription and DCA execution, and so on).
- GPU workers on Cloud Run L4s that scale to zero, which is most of why the free tier is economically sustainable.
- A pre-push hook that lints every commit subject and scans for secrets, a build chain whose order is load-bearing and enforced by a script, and a 1,200-file test tree (Vitest unit tests plus Playwright end-to-end smokes against the real site).
- Part of the stack runs on AWS `us-east-1` (a Lambda sculptor and an S3 avatar bucket), and the IBM Granite models on watsonx.ai power a few surfaces (prompt direction, PBR material generation, a semantic agent galaxy).

The repo is one npm-workspaces monorepo. A `STRUCTURE.md` maps every product surface (700-plus routes at last count) to its directory so a newcomer does not have to read 60 top-level folders.

## 8. Partnerships and where it lives

- **OpenAI**: the ChatGPT app over the Apps SDK connector and the "three.ws 3D Studio" custom GPT in the GPT Store, described above.
- **Anthropic**: the same pipeline runs from Claude Desktop, Claude Code and Claude artifacts through the MCP servers.
- **IBM**: three.ws is an IBM Business Partner; Granite models on watsonx.ai run inside the studio, and `@three-ws/ibm-x402-mcp` is the first x402-metered MCP server on IBM Cloud (a few cents of USDC per Granite call, no IBM account required). There is a three.ws user group on IBM Community that held its first in-world meetup at `/play` in August with a peak concurrency of 3,145.
- **AWS**: AWS Partner (APN Software Path), marketplace SaaS listing in review, engineering write-ups on the AWS Builder Center.
- **Alibaba Cloud**: live marketplace listing.
- **Google Cloud**: production runs there, GPU inference included.
- **OKX**: three.ws Forge is listed as paid services on the OKX.AI agent marketplace (agent #2632), sold to other agents over A2MCP, with an always-on XMTP chat bot host.
- **Solana Mobile**: the Seeker wallet (MWA) is wired into the web app and there is a Solana dApp Store release pipeline.
- **BNB Chain**: indexed on Dappbay under AI Agent Launchpad, AI Data and AI Infra.
- **Pump.fun**: a launcher and a set of 23 free read-only MCP tools for token and Solana data.
- **Livepeer**: federation with its inference network sits behind a flag in the open inference layer.

## 9. What is next

The roadmap has four phases and I try to keep the status column honest.

- **Phase 1, selfie to avatar**: capture, reconstruction, rigging, storage and draft mint are wired end to end. The open track is likeness fidelity, measured by an Identity Shape Error metric against a reference set and an adversarial set rather than by eye. The goal is anyone taking three selfies and getting a rigged avatar of themselves in under 60 seconds that actually looks like them.
- **Phase 2, personalization**: voice cloning (30-plus seconds of speech to a custom voice bound to the agent), persona extraction from a short interview, memory seeding from connected accounts with explicit consent, all shipped behind `/demos` and moving into the main flow.
- **Phase 3, on-chain economy**: agent tokens with bonding-curve or fair-launch pricing, reputation markets, per-call skill royalties (the ledger already accrues on paid skill calls), then contract audits.
- **Phase 4, open inference**: the node client and signed receipts are live; next is on-chain settlement per token and a cryptoeconomic security model.

On the 3D side specifically, the things I am actively working on: bringing the SDXL+ControlNet texture worker up as a permanent lane, garment generation for the avatar creator, video-to-motion into the clip library so a phone video becomes a retargetable gesture, text-to-world in Diorama getting physically-based lighting presets, and a generation-quality leaderboard fed by Forge-Off votes so the backend pool weights itself toward what people actually prefer.

## 10. Try it, break it, fork it

- ChatGPT app: add the connector `https://three.ws/api/mcp-studio` with no authentication, then say "make me a low-poly fox for my game".
- Custom GPT: search the GPT Store for "three.ws 3D Studio".
- No ChatGPT: `curl -X POST https://three.ws/api/forge -H 'content-type: application/json' -d '{"prompt":"a brass steampunk owl, full body"}'`.
- In a browser: [three.ws/forge](https://three.ws/forge), no account.
- Source: [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws), Apache-2.0. `docs/first-contribution.md` goes from clone to open pull request in about 15 minutes, and every `good first issue` names the file to change and the command that proves it worked.

If you are building a ChatGPT app or a custom GPT that does long-running work, the three things I would pass on are: make submit return in under a second with a poll handle and an ETA, give the user a self-updating link so the conversation is not the only place the result can arrive, and turn off every capability the model could use to "satisfy" the request without calling your action. Happy to answer questions about any of it, especially the widget CSP, the Actions timeout design, or the rigging and retargeting pipeline.

nich
