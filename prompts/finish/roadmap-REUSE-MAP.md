# OSS Reuse Map — integration targets for the 3D/crypto/AI roadmap

Verified June 2026. Use this before building anything in `prompts/roadmap/*` — prefer integrating these proven, permissively-licensed projects over reinventing.

**License legend:** ✅ permissive (MIT/Apache-2.0/BSD/Zlib — safe to ship) · ⚠️ conditional (revenue/MAU/territory caps — read the fine print) · ⛔ AVOID (non-commercial / research / GPL/AGPL / unlicensed).

**Vercel reality:** no GPU model runs *inside* a Vercel function. The pattern everywhere: Vercel function = thin orchestrator that POSTs to a GPU host (Replicate/HF/Modal/Cloud Run) and polls/webhooks for the result URL. This matches the existing Forge architecture.

---

## 1. GLB/glTF compression (Draco + meshopt) — for roadmap 02, 04
| Capability | Repo / npm | License | Note |
|---|---|---|---|
| Build-time pipeline (primary) | donmccurdy/glTF-Transform · `@gltf-transform/cli`+`/core`+`/functions` | ✅ MIT | `gltf-transform optimize in.glb out.glb --compress meshopt`. Use as build/Vercel step. |
| Draco runtime decode | three `DRACOLoader` + `draco3d` (google/draco) | ✅ Apache-2.0 | Copy `three/examples/jsm/libs/draco/` to `public/`; `loader.setDRACOLoader`. Max geometry compression. |
| Meshopt runtime decode (prefer) | zeux/meshoptimizer · `meshoptimizer`,`gltfpack` | ✅ MIT | `loader.setMeshoptDecoder(MeshoptDecoder)`. Tiny + fast decode → best runtime default. |

## 2. Web AR + GLB→USDZ (iOS Quick Look) — for roadmap 04, 10
| Capability | Repo / npm | License | Note |
|---|---|---|---|
| Viewer + AR launcher | google/model-viewer · `@google/model-viewer` | ✅ Apache-2.0 | `<model-viewer ar ios-src="x.usdz">`. Android WebXR/Scene Viewer handled; iOS needs a `.usdz`. |
| USDZ on Vercel (primary) | three `USDZExporter` (`three/addons/exporters/USDZExporter.js`) | ✅ MIT | **Only zero-native-dep server path:** `await new USDZExporter().parseAsync(scene)`. |
| USDZ high-fidelity (fallback) | google/usd_from_gltf (Docker) | ✅ Apache-2.0 (archived 2024) | Native Pixar USD → Cloud Run only, call over HTTP. Use only if fidelity demands it. |

## 3. Headless WebGL / Three.js CI smoke — for roadmap 01, 04
| Capability | Repo / npm | License | Note |
|---|---|---|---|
| Browser-real smoke (primary) | `@playwright/test` (already a dep) | ✅ Apache-2.0 | Real WebGL headless via ANGLE+SwiftShader, no GPU. `toHaveScreenshot()`. Bump timeouts (SwiftShader slow). |
| Pure-Node pixel readback | stackgl/headless-gl · `gl` | ✅ BSD-2 | Feed context to `new THREE.WebGLRenderer({context})`. Native build + system GL on runner. jsdom alone has no WebGL. |

## 4. Audio-driven lipsync / visemes — for roadmap 03 (note: `audio-mcp` + `a2f-nvidia` tests already exist)
| Capability | Repo / npm | License | Note |
|---|---|---|---|
| Real-time browser (primary) | wass08/wawa-lipsync · `wawa-lipsync` | ✅ MIT | 100% in-browser Web Audio, zero deps. `connectAudio()`+`processAudio()` in RAF → morph targets. |
| Real-time MFCC-accurate | mrxz/wLipSync · `wlipsync` | ✅ MIT | WASM uLipSync port; renderer-agnostic viseme weights. |
| Turnkey talking-avatar | met4citizen/TalkingHead (+HeadTTS) | ✅ MIT | Full Oculus OVR + ARKit viseme pipeline on standard humanoid/Mixamo GLB. |
| Precomputed | DanielSWolf/rhubarb-lip-sync · `rhubarb-lip-sync-wasm` | ✅ MIT-equiv | WASM in a Vercel fn on TTS audio → viseme JSON track for deterministic playback. |

## 5. Text/image-to-3D hosted APIs — for roadmap 02, 06, 07 (TRELLIS already powers `forge_free`)
| Model | Repo · endpoint | License | Note |
|---|---|---|---|
| **TRELLIS** (top pick) | microsoft/TRELLIS · Replicate `firtoz/trellis` · free NVIDIA NIM | ✅ MIT | Cleanest license; already wired. |
| **TripoSR** (fastest) | VAST-AI/TripoSR · Replicate `camenduru/tripo-sr` | ✅ MIT | Single-image, cheap/fast. |
| **InstantMesh** (multi-view) | TencentARC/InstantMesh · Replicate `camenduru/instantmesh` | ✅ Apache-2.0 | Image→multi-view→mesh; also covers §6. |
| Hunyuan3D-2.1/3.1 (best texture) | Tencent-Hunyuan/Hunyuan3D-2.1 · Replicate `tencent/hunyuan-3d-3.1` | ⚠️ Tencent Community | **>1M MAU prohibited; void in EU/UK/South Korea.** Bake into terms. |
| Stable-Fast-3D / SPAR3D | Stability-AI/stable-fast-3d | ⚠️ Stability Community | Free commercial only ≤ $1M revenue. Prefer an MIT model. |
| License-clean self-host | TripoSG (MIT), Step1X-3D (Apache-2.0), Direct3D-S2 (MIT), Hi3DGen (MIT) | ✅ | Deploy behind Replicate-custom/Modal/RunPod. |

## 6. Sketch-to-3D, multi-view, photogrammetry, splatting — for roadmap 07
| Capability | Repo · endpoint | License | Note |
|---|---|---|---|
| Multi-view reconstruction | InstantMesh (see §5) | ✅ Apache-2.0 | Primary hosted multi-view path. |
| Sketch-to-3D | HF `linoyts/sketch-to-3d` (TRELLIS) · `VAST-AI/TripoSG-scribble` | ✅ MIT | Feed clean sketch as input image to TRELLIS/TripoSR. |
| Photogrammetry SfM | colmap/colmap | ✅ BSD-3 | GPU C++ binary; GPU-host orchestration. |
| Splat trainer (commercial) | nerfstudio-project/gsplat | ✅ Apache-2.0 | Clean-room rasterizer; GPU training. |
| Splat in-browser | ArthurBrussee/brush | ✅ Apache-2.0 | Rust+WebGPU+WASM; train in visitor's browser, zero server GPU. |
| Splat viewer/editor | playcanvas/supersplat | ✅ MIT | Client-side WASM/WebGL editor, embeddable from Vercel. |
| ⛔ AVOID | graphdeco-inria/gaussian-splatting + `diff-gaussian-rasterization` | non-commercial | License travels even on Replicate wrappers — use gsplat. |

## 7. PBR material editing + AI re-texturing — for roadmap 06
| Capability | Repo / npm | License | Note |
|---|---|---|---|
| Material/IBL base | `three` (`MeshPhysicalMaterial`,`PMREMGenerator`,`HDRLoader`) | ✅ MIT | Already in stack. |
| Editor GUI | `lil-gui` (alt `tweakpane`) | ✅ MIT | Bind controllers to material props for a live PBR panel. |
| Accurate preview | gkjohnson/three-gpu-pathtracer | ✅ MIT | Path-traced final-frame preview; lazy-load. |
| Polish | pmndrs `postprocessing` | ✅ Zlib | Bloom/tonemapping. |
| AI re-texture (primary) | TRELLIS via Replicate `firtoz/trellis`/fal | ✅ MIT | Only fully-permissive commercial option; gate behind $THREE/x402. |
| ⛔ AVOID | TEXTure, Text2Tex, Paint3D, Hunyuan3D-Paint | non-commercial/capped | Research-only or territory/MAU-restricted. |

## 8. Text→scene composition + editor enhancements — for roadmap 05
| Capability | Repo / npm | License | Note |
|---|---|---|---|
| Scene-layout planner (primary) | weixi-feng/LayoutGPT | ✅ MIT | Re-port the LLM bbox-layout prompt into a Node/Vercel fn via the worker proxy — no Python dep. |
| Manipulation gizmo | three `TransformControls` | ✅ MIT | Already in dep. |
| Fast picking | `three-mesh-bvh` | ✅ MIT | Raycast/hover-select at scale. |
| Clean imports | `three-stdlib`, `@pmndrs/vanilla` | ✅ MIT | Tree-shakeable examples + framework-free helpers. |
| ⛔ AVOID | LayoutVLM (unlicensed), SpatialLM (CC-BY-NC) | — | Not commercially usable. |

## 9. Solana SPL NFT minting + metadata + provenance — for roadmap 08 (deps already in package.json)
| Capability | npm | License | Note |
|---|---|---|---|
| NFT standard (new mints) | `@metaplex-foundation/mpl-core` | ✅ Apache-2.0 | Single-account, cheaper rent, built-in royalty/freeze/provenance plugins. **Already a dep.** |
| Legacy/pNFT compat | `@metaplex-foundation/mpl-token-metadata` | ✅ Apache-2.0 | Only for legacy SPL/pNFT. |
| Required substrate | `@metaplex-foundation/umi` (+ bundle-defaults) | ✅ MIT | **Already a dep.** Vite: add `vite-plugin-node-polyfills` for Buffer/crypto. |
| Raw tx / RPC | `@solana/kit` (web3.js v2 successor) | ✅ MIT | Current recommended SDK. |
| Signing | `@noble/ed25519` | ✅ MIT | Prefer noble for new provenance signing. |
| Permanent metadata upload | `@metaplex-foundation/umi-uploader-irys` | ✅ MIT | `uploadJson()` → Arweave URI into mpl-core create, server-side. **Bundlr is now Irys — do NOT use the old bundlr packages.** |

## 10. Embeddable 3D + oEmbed + server-side OG/thumbnail — for roadmap 10
| Capability | npm / source | License | Vercel verdict |
|---|---|---|---|
| Embed component | `@google/model-viewer` | ✅ Apache-2.0 | Standalone `/embed/:id` page consumers iframe. |
| oEmbed provider | oembed.com spec (no lib) | spec | Hand-roll `/api/oembed` returning `type:"rich"` + `thumbnail_url`; add discovery `<link>`. ~30 lines. |
| GLB→PNG (primary) | `poppygl` | ✅ MIT | **Pure-JS software rasterizer — runs on vanilla Vercel Node fn, zero native deps.** Ideal for `/api/og/:id.png`. |
| GLB→PNG (high fidelity) | `@shopify/screenshot-glb` | ✅ MIT | Puppeteer+model-viewer. On Vercel use `puppeteer-core`+`@sparticuz/chromium`; **needs `--enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader`** or WebGL renders blank. |

---

## Top-line picks
- **Compression:** `@gltf-transform/cli` (build) + `MeshoptDecoder` (runtime); Draco for max-compression assets.
- **AR:** `<model-viewer>` + three `USDZExporter` on Vercel; Cloud Run `usd_from_gltf` only if fidelity demands.
- **CI:** Playwright (already a dep) for canvas smoke; `gl` for pure-Node pixel asserts.
- **Lipsync:** wawa-lipsync (live) + Rhubarb-WASM (precomputed) — but check `audio-mcp` first, it may already cover this.
- **Gen-3D:** TRELLIS (MIT, already wired), TripoSR (fast), InstantMesh (multi-view); Hunyuan only with MAU/EU-UK-KR terms baked in.
- **Splatting:** gsplat/Brush + SuperSplat — never the Inria 3DGS rasterizer.
- **Solana:** mpl-core + Umi + umi-uploader-irys + @solana/kit + @noble/ed25519 (mpl-core, umi already deps).
- **Embed/OG:** `<model-viewer>` + hand-rolled oEmbed + poppygl (screenshot-glb as fidelity fallback).

**Hard AVOID:** Inria 3D Gaussian Splatting, TEXTure/Text2Tex/Paint3D, LayoutVLM, SpatialLM weights, Meshroom (serverless), Blender headless. **Read fine print (⚠️):** Hunyuan3D (1M MAU + EU/UK/KR exclusion), SF3D/SPAR3D ($1M revenue cap).
