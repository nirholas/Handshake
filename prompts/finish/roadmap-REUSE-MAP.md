# OSS Reuse Map: integration targets for the 3D/crypto/AI roadmap

License survey June 2026. Integration status re-verified against the working
tree on 2026-09-03 (see "How this file was verified" at the bottom). Use this
before building anything in `prompts/roadmap/*`: prefer integrating these
proven, permissively-licensed projects over reinventing.

**License legend:** ✅ permissive (MIT/Apache-2.0/BSD/Zlib, safe to ship) · ⚠️ conditional (revenue/MAU/territory caps, read the fine print) · ⛔ AVOID (non-commercial / research / GPL/AGPL / unlicensed).

**Status legend:** **[wired]** already integrated here, do not re-adopt · **[dep-only]** in `package.json` but imported nowhere · **[open]** not adopted, still a live option.

## Runtime reality (read before you design)

Production runs on **Google Cloud Run**, not Vercel (migrated 2026-07-07; see
CLAUDE.md "Stack notes"). One container serves the static frontend, the
`vercel.json` route table, and every `api/**` handler. Earlier revisions of this
file framed every verdict as "can this run in a Vercel function"; that framing
is retired, and any advice below that survives it is restated in Cloud Run terms.

What did not change is the GPU rule: no GPU model runs inside the API container.
The pattern everywhere is that an `api/` handler is a thin orchestrator that
POSTs to a GPU host (a `workers/<name>` Cloud Run service, Replicate, HF, Modal)
and polls or takes a webhook for the result URL. This matches the existing Forge
architecture. What Cloud Run buys you over the old Vercel constraint is that a
native binary or a headless chromium in the image is now a normal option rather
than a disqualifier, so "needs a native dep" is no longer on its own a reason to
reject a library.

---

## 1. GLB/glTF compression (Draco + meshopt), for roadmap 02, 04
| Capability | Repo / npm | License | Status | Note |
|---|---|---|---|---|
| Build-time and server-side pipeline | donmccurdy/glTF-Transform · `@gltf-transform/core`+`/functions` | ✅ MIT | **[wired]** | The compression rail is `api/_lib/glb-compress.js` (`output_format: glb-draco` / `glb-meshopt`), plus roughly a dozen other `api/_lib/*` passes (bake, cleanup, themer, composer, diorama). Extend those, do not add a parallel pipeline. |
| CLI form of the same | `@gltf-transform/cli` | ✅ MIT | **[open]** | Not a dependency. The library API already covers the server-side path, so add the CLI only for an actual build step (`gltf-transform optimize in.glb out.glb --compress meshopt`). |
| Draco runtime decode | three `DRACOLoader` + google/draco | ✅ Apache-2.0 | **[wired]** | Decoder assets are vendored at `public/three/draco/gltf/`, not pulled from the `draco3d` npm package. `src/forge-export.js` points `setDecoderPath` there. Reuse that path rather than shipping a second copy of the wasm. |
| Meshopt runtime decode (prefer) | zeux/meshoptimizer · `meshoptimizer` | ✅ MIT | **[wired]** | `setMeshoptDecoder(MeshoptDecoder)` across roughly nine viewer modules (`src/viewer.js`, `src/walk.js`, `src/stage.js`, others). Also the CLAUDE.md worker rule: caller-supplied glTF is meshopt-decoded through `gltf_meshopt.decode_if_meshopt` before trimesh reads it. |
| `gltfpack` binary | zeux/meshoptimizer | ✅ MIT | **[wired]** | Not an npm dep; the pinned binary ships inside the mesh-consuming worker images. A new mesh worker inherits that requirement. |

## 2. Web AR + GLB→USDZ (iOS Quick Look), for roadmap 04, 10
| Capability | Repo / npm | License | Status | Note |
|---|---|---|---|---|
| Viewer + AR launcher | google/model-viewer | ✅ Apache-2.0 | **[wired]** | Loaded as a CDN script tag, **not** as an npm dependency: `@google/model-viewer` is absent from `package.json` on purpose. Used by `src/account.js` (off-screen thumbnail capture), `src/worlds-lobby.js`, `src/cosmos.js`, `src/forge-optimize.js`, and vendored at `pages/ibm/vendor/model-viewer.min.js`. Version drift is real here: live pages load 3.5.0 and 4.0.0 from three different CDNs. Match the neighboring page rather than introducing a fourth. |
| USDZ export | three `USDZExporter` | ✅ MIT | **[wired]** | `src/usdz-pipeline.js` and `src/forge-export.js`. Note the documented limitation in `usdz-pipeline.js`: the three.js exporter does not carry skinning, so animated USDZ takes the separate path in `src/usdz-animated.js`. |
| USDZ high-fidelity fallback | google/usd_from_gltf (Docker) | ✅ Apache-2.0 (archived 2024) | **[open]** | Native Pixar USD. On Cloud Run this is a normal sidecar service now rather than an exotic one, but the in-process exporter still covers the shipped cases. Reach for it only when fidelity genuinely demands it. |

## 3. Headless WebGL / Three.js CI smoke, for roadmap 01, 04
| Capability | Repo / npm | License | Status | Note |
|---|---|---|---|---|
| Browser-real smoke | `@playwright/test` | ✅ Apache-2.0 | **[wired]** | 43 specs under `tests/e2e/`. Real WebGL headless via ANGLE + SwiftShader, no GPU. Bump timeouts, SwiftShader is slow. A vitest failure gates the whole Playwright stage (`npm test`). |
| Pure-Node pixel readback | stackgl/headless-gl · `gl` | ✅ BSD-2 | **[open]** | Not a dependency, and mostly superseded here: the server-side renderers already produce real pixels through headless chromium (`api/_lib/render-glb.js`). Consider `gl` only for a pure-Node assert that must not boot a browser. |

## 4. Audio-driven lipsync / visemes, for roadmap 03
| Capability | Repo / npm | License | Status | Note |
|---|---|---|---|---|
| Real-time browser | wass08/wawa-lipsync · `wawa-lipsync` | ✅ MIT | **[wired]** | Powers `/lipsync` (`public/demos/lipsync-tts.html`), which imports it as a bare specifier resolved by the vite demo-HTML rollup inputs. Its visemes are mapped onto Oculus-named morph targets in that file. |
| In-app lipsync drivers | hand-rolled | n/a | **[wired]** | Two of them, and they are not wawa: `src/voice/lipsync-driver.js` (three-band energy estimate off a live `AnalyserNode`, for streaming TTS with no viseme timestamps) and `src/runtime/lipsync.js` (text-to-viseme heuristic, no audio analysis). Replacing either is a behavior change to a shipped surface, so flag it and prove it in a browser. |
| Real-time MFCC-accurate | mrxz/wLipSync · `wlipsync` | ✅ MIT | **[open]** | WASM uLipSync port, renderer-agnostic viseme weights. The upgrade path if the energy-based driver proves too coarse. |
| Turnkey talking-avatar | met4citizen/TalkingHead (+HeadTTS) | ✅ MIT | **[open]** | Full Oculus OVR + ARKit viseme pipeline on standard humanoid/Mixamo GLB. |
| Precomputed | DanielSWolf/rhubarb-lip-sync · `rhubarb-lip-sync-wasm` | ✅ MIT-equiv | **[open]** | WASM pass over TTS audio producing a deterministic viseme JSON track. |
| Adjacent, check first | `packages/audio-mcp/` | n/a | **[wired]** | TTS, STT, audio-to-face lipsync and motion capture already live here. Read it before adding any lipsync dependency. |

## 5. Text/image-to-3D hosted APIs, for roadmap 02, 06, 07
| Model | Repo · endpoint | License | Status | Note |
|---|---|---|---|---|
| **TRELLIS** (top pick) | microsoft/TRELLIS · Replicate `firtoz/trellis` · free NVIDIA NIM | ✅ MIT | **[wired]** | Powers the free forge lane. Cleanest license of the set. |
| **TripoSR** (fastest) | VAST-AI/TripoSR · Replicate `camenduru/tripo-sr` | ✅ MIT | **[open]** | Single-image, cheap and fast. |
| **InstantMesh** (multi-view) | TencentARC/InstantMesh · Replicate `camenduru/instantmesh` | ✅ Apache-2.0 | **[open]** | Image to multi-view to mesh; also covers §6. |
| Hunyuan3D-2.1/3.1 (best texture) | Tencent-Hunyuan/Hunyuan3D-2.1 | ⚠️ Tencent Community | **[open]** | **>1M MAU prohibited; void in EU/UK/South Korea.** Bake into terms before shipping, not after. |
| Stable-Fast-3D / SPAR3D | Stability-AI/stable-fast-3d | ⚠️ Stability Community | **[open]** | Free commercial only up to $1M revenue. Prefer an MIT model. |
| License-clean self-host | TripoSG (MIT), Step1X-3D (Apache-2.0), Direct3D-S2 (MIT), Hi3DGen (MIT) | ✅ | **[open]** | Deploy behind a `workers/<name>` Cloud Run GPU service, Replicate-custom, Modal, or RunPod. GCP is the pre-approved surface (CLAUDE.md standing resource approvals). |

## 6. Sketch-to-3D, multi-view, photogrammetry, splatting, for roadmap 07
| Capability | Repo · endpoint | License | Status | Note |
|---|---|---|---|---|
| Multi-view reconstruction | InstantMesh (see §5) | ✅ Apache-2.0 | **[open]** | Primary hosted multi-view path. |
| Sketch-to-3D | HF `linoyts/sketch-to-3d` (TRELLIS) · `VAST-AI/TripoSG-scribble` | ✅ MIT | **[open]** | Feed a clean sketch as the input image to TRELLIS/TripoSR. |
| Photogrammetry SfM | colmap/colmap | ✅ BSD-3 | **[open]** | GPU C++ binary, so a GPU worker service. |
| Splat trainer (commercial) | nerfstudio-project/gsplat | ✅ Apache-2.0 | **[open]** | Clean-room rasterizer; GPU training. |
| Splat in-browser | ArthurBrussee/brush | ✅ Apache-2.0 | **[open]** | Rust + WebGPU + WASM; trains in the visitor's browser, zero server GPU. |
| Splat viewer/editor | playcanvas/supersplat | ✅ MIT | **[open]** | Client-side WASM/WebGL editor, embeddable. |
| ⛔ AVOID | graphdeco-inria/gaussian-splatting + `diff-gaussian-rasterization` | non-commercial | | The license travels even through Replicate wrappers. Use gsplat. |

## 7. PBR material editing + AI re-texturing, for roadmap 06
| Capability | Repo / npm | License | Status | Note |
|---|---|---|---|---|
| Material/IBL base | `three` (`MeshPhysicalMaterial`, `PMREMGenerator`, `HDRLoader`) | ✅ MIT | **[wired]** | Already the stack. |
| Polish | pmndrs `postprocessing` | ✅ Zlib | **[wired]** | Roughly ten call sites. Bloom, tonemapping. |
| Accurate preview | gkjohnson/three-gpu-pathtracer | ✅ MIT | **[wired]** | One call site. Path-traced final-frame preview; keep it lazy-loaded. |
| Editor GUI | `lil-gui` | ✅ MIT | **[dep-only]** | Declared in `package.json` at `^0.21.0` and imported by nothing in the repo. Either use it for the PBR panel this section anticipated, or drop the dependency. Do not add `tweakpane` alongside it. |
| AI re-texture | TRELLIS via Replicate/fal | ✅ MIT | **[open]** | The only fully permissive commercial option here. Gate behind $THREE / x402. |
| ⛔ AVOID | TEXTure, Text2Tex, Paint3D, Hunyuan3D-Paint | non-commercial/capped | | Research-only or territory/MAU-restricted. |

## 8. Text to scene composition + editor enhancements, for roadmap 05
| Capability | Repo / npm | License | Status | Note |
|---|---|---|---|---|
| Scene-layout planner | weixi-feng/LayoutGPT | ✅ MIT | **[open]** | Re-port the LLM bbox-layout prompt into a Node handler via the worker proxy, no Python dependency. |
| Manipulation gizmo | three `TransformControls` | ✅ MIT | **[wired]** | Ships with three. |
| Fast picking | `three-mesh-bvh` | ✅ MIT | **[wired]** | Two call sites. Raycast/hover-select at scale. |
| Clean imports | `three-stdlib`, `@pmndrs/vanilla` | ✅ MIT | **[open]** | Neither is a dependency. The repo imports `three/addons/*` directly, which is the established pattern; match it rather than introducing a second convention. |
| ⛔ AVOID | LayoutVLM (unlicensed), SpatialLM (CC-BY-NC) | | | Not commercially usable. |

## 9. Solana SPL NFT minting + metadata + provenance, for roadmap 08
| Capability | npm | License | Status | Note |
|---|---|---|---|---|
| NFT standard (new mints) | `@metaplex-foundation/mpl-core` | ✅ Apache-2.0 | **[wired]** | `api/nft/mint-scene.js`, `api/_lib/skill-nft.js`, `api/_lib/draft-mint.js`, `api/_lib/tokenize-3d.js` and more. Single-account, cheaper rent, built-in royalty/freeze/provenance plugins. |
| Required substrate | `@metaplex-foundation/umi` (+ bundle-defaults) | ✅ MIT | **[wired]** | Note `api/nft/mint-scene.js`: umi is constructed over the failover `Connection`, so a single node's malformed 200 fails over instead of throwing a StructError. Preserve that when you add a mint path. |
| Raw tx / RPC | `@solana/kit` | ✅ MIT | **[wired]** | Present alongside `@solana/web3.js`. |
| Signing | `@noble/curves/ed25519` | ✅ MIT | **[wired]** | **Correction to the June survey, which recommended the standalone `@noble/ed25519`.** The repo standardized on the `@noble/curves` bundle (15 modules import `@noble/curves/ed25519`, zero import `@noble/ed25519`), alongside `secp256k1`, `bls12-381` and `@noble/hashes`. Adding the standalone package would duplicate a dependency already present. |
| Metadata permanence | `@metaplex-foundation/umi-uploader-irys` | ✅ MIT | **[open]** | **Not the road taken.** Mint metadata is pinned to IPFS through `pinAsset` (`api/_lib/ipfs-gateways.js`) and the resulting URI goes into `createV1`. Adding Irys/Arweave would be a second permanence rail, not a drop-in. Decide deliberately. (Bundlr is now Irys; the old bundlr packages are dead either way.) |
| Legacy/pNFT compat | `@metaplex-foundation/mpl-token-metadata` | ✅ Apache-2.0 | **[open]** | Not a dependency. Only needed for legacy SPL/pNFT. |

## 10. Embeddable 3D + oEmbed + server-side OG/thumbnail, for roadmap 10
| Capability | npm / source | License | Status | Note |
|---|---|---|---|---|
| Embed component | model-viewer | ✅ Apache-2.0 | **[wired]** | See §2 on the CDN-not-npm reality. |
| oEmbed provider | oembed.com spec (no library) | spec | **[wired]** | Hand-rolled exactly as this file predicted: `api/agent-oembed.js` (routed from `/api/oembed`) and `api/play-oembed.js`, plus `/api/widgets/oembed`. Extend those. |
| GLB→PNG | `puppeteer-core` + `@sparticuz/chromium-min` | ✅ Apache-2.0 | **[wired]** | **Correction to the June survey**, which named `poppygl` primary and `@shopify/screenshot-glb` (plain `@sparticuz/chromium`) the fallback. Neither was adopted. Three renderers share the headless-chromium approach: `api/_lib/render-glb.js` (OG cards), `api/_lib/avatar-render.js` (the public render endpoint and the `render_avatar_image` MCP tool) and `api/_lib/render-clip.js` (`render_avatar_clip`). The `-min` build downloads its chromium pack at first use, pinned in lockstep with the package version. |
| The renderers' three.js supply | `api/_lib/three-cdn.js` | n/a | **[wired]** | The chromium pages build an import map pointing at a pinned three.js release, and resolve the host through `resolveThreeCdn()` (unpkg, falling back to jsDelivr on a bounded HEAD probe, cached ten minutes). `THREE_VERSION` lives in that one module, not three copies. This is the one external dependency in the render path, and it only bites on the chromium failover, so it stayed invisible while the CPU lane absorbed the traffic. Do not hardcode a CDN host in a renderer; `tests/api/three-cdn-wiring.test.js` fails the build if you do. |
| GLB→PNG, pure JS | `@three-ws/render` (`packages/render/`) | in-house | **[wired]** | **The role poppygl was proposed for, filled by our own package instead.** `api/_lib/render-cpu.js` is the PRIMARY thumbnail lane: an in-process software rasterizer, same framing and three-light rig as the chromium page, roughly 200-500 ms with no subprocess and no CDN fetch. Chromium is now the failover, taken only for models this lane cannot decode itself (Draco geometry, KTX2/Basis textures), which is most forge output. `RENDER_CPU_LANE=off` pins everything back to chromium without a deploy. See `docs/avatar-thumbnails.md`. |
| GLB→PNG, pure JS (alternative) | `poppygl` | ✅ MIT | **[open]** | Not adopted, and now largely redundant next to `@three-ws/render`. Its original selling point was surviving a Vercel function, which no longer constrains us. |

---

## Top-line picks

- **Compression:** the `@gltf-transform` passes in `api/_lib/` (server) plus `MeshoptDecoder` (runtime); vendored Draco decoder for max-compression assets.
- **AR:** model-viewer plus three's `USDZExporter`; a `usd_from_gltf` sidecar only if fidelity demands it.
- **CI:** Playwright for canvas smoke; `gl` only for a pure-Node pixel assert.
- **Lipsync:** wawa-lipsync is already live on `/lipsync`; read `packages/audio-mcp/` before adding anything else.
- **Gen-3D:** TRELLIS (MIT, already wired), TripoSR (fast), InstantMesh (multi-view); Hunyuan only with MAU and EU/UK/KR terms baked in.
- **Splatting:** gsplat/Brush plus SuperSplat, never the Inria 3DGS rasterizer.
- **Solana:** mpl-core + umi + `@solana/kit` + `@noble/curves/ed25519`, with metadata pinned to IPFS.
- **Embed/OG:** model-viewer, the hand-rolled oEmbed handlers, and the shared chromium renderers.

**Hard AVOID:** Inria 3D Gaussian Splatting, TEXTure/Text2Tex/Paint3D, LayoutVLM, SpatialLM weights, Meshroom, headless Blender. **Read the fine print (⚠️):** Hunyuan3D (1M MAU plus EU/UK/KR exclusion), SF3D/SPAR3D ($1M revenue cap).

## Open items this audit surfaced

1. `lil-gui` is a dependency nobody imports (§7). Use it or drop it.
2. model-viewer is loaded at two major versions from three CDNs across live pages (§2). Worth converging.
3. The headless renderers pin three.js at 0.176.0 while the app runs 0.184.0. That is deliberate for now (a bump changes every OG card and needs visual verification), but the pin is a single constant in `api/_lib/three-cdn.js` when someone takes it on.

## How this file was verified

The status column is not a memory of what was planned. Every **[wired]**,
**[dep-only]** and **[open]** marker above was re-derived on 2026-09-03 by
reading `package.json` and grepping the working tree for the actual import
sites. Re-run that when you touch this file; a status marker that has quietly
gone stale is worse than no marker, because agents execute this file verbatim.

## Retire this file when the campaign is done (required)

This file is shared context rather than a single order, so it outlives the
prompts that cite it. Delete it in the commit that closes the LAST prompt of
this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'roadmap-REUSE-MAP' prompts/finish/
       git rm prompts/finish/roadmap-REUSE-MAP.md

While any sibling prompt of this campaign is still on disk, leave this file in
place and keep it accurate instead. The shrinking directory is the only signal
to the next agent that a campaign is closed.
