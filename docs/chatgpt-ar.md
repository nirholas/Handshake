# AR in ChatGPT

How a sentence typed into ChatGPT becomes a 3D model standing in your room. This document covers the whole pipeline: the free generation lane ChatGPT calls, the place-in-your-room link (`arUrl`) every generation carries, the device-aware launcher behind that link, the living-avatar handoff for rigged bodies, and how a shared link unfurls with a real render of the model.

Nothing here is ChatGPT-exclusive. ChatGPT is the first surface that ships the full flow, but every contract below is public and keyless, so any agent, MCP client, or plain HTTP caller gets the identical capability.

If you just want to try it, start with the tutorial: [Your first prompt to 3D in ChatGPT](/tutorials/first-prompt-to-3d).

---

## The one-link design

ChatGPT cannot run WebGL, ARKit, or ARCore. It can only print links. So the entire AR capability is compressed into a single URL that any chat surface can hand to the user:

```
https://three.ws/api/ar?src=<glbUrl>&title=<name>
https://three.ws/api/ar?src=<glbUrl>&title=<name>&kind=avatar   (rigged avatar)
```

- `src` (required): a public `https` `.glb`/`.gltf` URL, URL-encoded.
- `title` (optional): a human label. The launcher accepts up to 120 characters ([api/ar.js](../api/ar.js)); the generation pipeline puts the user's prompt here, trimmed to 80, so the AR page arrives labeled ([api/_mcp-studio/gpt-forge-client.js](../api/_mcp-studio/gpt-forge-client.js)).
- `kind=avatar` (optional): marks the model as a rigged agent body and unlocks the living-agent lane (below).

Every free generation endpoint returns this link as the `arUrl` field, built by one shared constructor (`buildArLaunchUrl` in [api/_lib/ar-launch.js](../api/_lib/ar-launch.js), mirrored by `arLaunchUrl` in [api/_mcp-studio/gpt-forge-client.js](../api/_mcp-studio/gpt-forge-client.js), the ChatGPT surfaces' client over `/api/gpt-forge`, the ChatGPT-dedicated clone of the forge pipeline). ChatGPT's only job is to print it. Everything hard (device detection, format conversion, the AR session itself) happens on the three.ws side after the tap, which is why one URL works identically in ChatGPT, Claude, an email, or a text message.

---

## The two ChatGPT surfaces

The same free lane ships into ChatGPT twice, because ChatGPT has two integration models with different strengths.

### 1. The ChatGPT app (Apps SDK / MCP connector)

The MCP connector at `https://three.ws/api/mcp-studio` (no authentication) exposes eleven free tools: six generation tools (`forge_free`, `text_to_avatar`, `mesh_forge`, `rig_mesh`, `forge_avatar`, `refine_model`), the `check_job` collector that picks up a generation which outran the tool call (a pending result now names its `stage`, `mesh` or `rig`, so the collector knows which leg it is waiting on), the read-only `look_at_model` tool that renders any public GLB from several angles and returns the frames as images plus a plain reading of its geometry, so the assistant can judge its own output before printing a link, and three persona/embodiment tools (`create_agent_persona`, `get_agent_persona`, `persona_say`, in [api/_mcp-studio/persona-tools.js](../api/_mcp-studio/persona-tools.js)). Full server documentation: [3D Studio MCP](./mcp-studio.md).

Every successful tool result carries `arUrl` in its `structuredContent`, and the inline 3D widget renders it as a **View in your space** button next to the rotatable model. When the result is a rigged avatar the response additionally carries `irlUrl` and the button becomes **Bring it to life**. Refined versions (`refine_model`) each carry their own `arUrl`, so any point in the version lineage can be placed in the room.

### 2. The "three.ws 3D Studio" custom GPT (Actions)

Not every ChatGPT plan supports connectors, so the same lane also ships as a plain REST Actions surface for the custom GPT in the GPT Store. The GPT's builder settings and instruction text live in [chatgpt-3d-studio-gpt.md](./chatgpt-3d-studio-gpt.md); the REST contract it calls:

```bash
curl -s -X POST https://three.ws/api/3d/studio \
  -H 'content-type: application/json' \
  -d '{"prompt":"a small ceramic robot figurine"}'
```

Submit returns either the finished model or a job to poll (the response shaping lives in [api/_mcp-studio/studio-shape.js](../api/_mcp-studio/studio-shape.js), shared with the tests):

```json
{ "status": "pending", "job": "…", "poll": "/api/3d/studio?job=…&title=a%20small%20ceramic%20robot%20figurine", "watchUrl": "https://three.ws/watch?job=…&title=…", "etaSeconds": 45, "format": "glb" }
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

Design decisions on this endpoint, all deliberate:

- **Store-clean responses.** The payload carries model URLs and job state only: no pricing, no upgrade hints, no internal identifiers, no wallet or token surface. That is what makes it publishable as a GPT Store action. (The agent-facing twin, `POST /api/3d/generate`, returns the same core fields plus `free`/`upgrade`; see [the free 3D API](./3d-api.md).)
- **The full forge experience.** The request accepts an optional `tier` (`draft` | `standard` | `high`; High runs the deepest sampler and texture budget on the self-host GPU lanes, operator-funded, and simply takes minutes through the poll loop). Routing is the same health-aware free-first router the /forge page uses, with no pinned backend. And because the forge paints a concept image before sculpting the mesh, pending and done states carry `previewImageUrl`, so ChatGPT shows the painted view the moment it exists while the 3D model is still generating.
- **The title-carrying poll.** ChatGPT Actions never resend context, so the submit response embeds the prompt in the poll URL as `&title=`. When the poll finally returns `done`, the `arUrl` and `viewerUrl` are labeled with the original prompt without the GPT doing anything except calling the poll path verbatim.
- **Timeout honesty.** Actions calls time out around 45 seconds; generation takes 20 to 60. The endpoint holds the request as long as it safely can and falls back to `pending` + poll rather than dying mid-request.
- **Safety before GPU.** Every prompt passes an age-13+ appropriateness gate ([api/_mcp-studio/safety.js](../api/_mcp-studio/safety.js)) before any provider work; refusals return `400 prompt_rejected` with a clear message.
- **An outage is an answer, not a 5xx.** When the poll finds the generation lane unconfigured upstream (`503`/`501` with `unconfigured` or `backend_unconfigured`), it answers `200 { "status": "error", "job": "…", "error": "3D generation is temporarily unavailable…" }`, so the GPT can tell the user plainly instead of surfacing a transport failure.

The GPT's instructions tell it to present three links on every finished model, in this order: **See it in your space** (`arUrl`), **Preview in your browser** (`viewerUrl`), **Download** (`glbUrl`), and to never fabricate a URL an action did not return. The OpenAPI schema the GPT imports is served at [`https://three.ws/.well-known/3d-studio-openapi.yaml`](../public/.well-known/3d-studio-openapi.yaml) and describes `/api/ar` alongside the generation action, so the AR launch is part of the app's published contract rather than an undocumented link. The full GPT build sheet lives at [prompts/store-submissions/_generated/](../prompts/store-submissions/_generated/) (`openai-gpt-config.md`, plus `openai-actions.yaml`, which is regenerated from the served schema by `npm run sync:studio-openapi`).

---

## What happens when the link is tapped

`GET /api/ar` ([api/ar.js](../api/ar.js)) reads the request's User-Agent server-side (no client round-trip, no JS sniffing) and branches:

| Device | What the user gets |
|---|---|
| **iPhone / iPad** | A tiny interstitial carrying the model's real `og:image`/`og:title` (so a pasted link still unfurls; crawlers do not follow a bare redirect's JS) that refreshes straight into **`/ar/view?src=…&title=…`** ([pages/ar-view.html](../pages/ar-view.html), [src/ar-view.js](../src/ar-view.js)). That Vite-bundled page generates a real USDZ from the GLB on the device with three's `USDZExporter` and then offers Apple **Quick Look** with a genuine `ios-src`. No server-side USD tooling exists or is needed; `<model-viewer>` alone does not do the conversion, which is why the AR page is a bundled page rather than HTML the handler writes inline. |
| **Android** (static model) | An HTTP `302` straight into Google **Scene Viewer** via an ARCore `intent://` URL, with a `browser_fallback_url` back to the WebGL viewer for devices without ARCore. |
| **Desktop** | The same interstitial into `/ar/view`, which falls back to the interactive WebGL viewer. There is no dead end: the link is safe to open anywhere. |

Responses set `vary: user-agent` so CDN caching stays correct per device class. Bad input (non-https, non-GLB, missing `src`) returns a designed error page, never a crash.

The pure routing logic (`detectArTarget`, `buildSceneViewerUrl`, `buildArViewUrl`, `planArLaunch`) lives dependency-free in [api/_lib/ar-launch.js](../api/_lib/ar-launch.js) and is covered by [tests/ar-export.test.js](../tests/ar-export.test.js). `planArLaunch` now resolves every branch to a redirect target: Scene Viewer for a static model on Android, `/ar/view` for everything else, with `viewerUrl` and `sceneViewerUrl` still returned for callers such as the `export_ar` tool that want the raw URLs alongside the launch link. The deeper AR reference (WebXR sessions, USDZ pipeline details, optimization limits) is [docs/ar.md](./ar.md).

---

## Living avatars: `kind=avatar`

AR on three.ws is not a prop viewer; it is how agents cross into physical space. When the generated model is a rigged avatar (an agent's body), the pipeline appends `kind=avatar` to the `arUrl`, and the launcher changes behavior:

- `/ar/view` receives the handoff as `&irl=<irlUrl>` and leads with a **Bring it to life** button into [`/irl?avatar=<glbUrl>`](/irl), where the avatar walks, animates, and talks with the user through the camera, standing in their real room. See [IRL](./irl.md).
- Android is NOT blind-redirected into Scene Viewer, because that would hide the living path. It lands on `/ar/view` too, with static placement still one tap away.

In ChatGPT this happens automatically: the avatar-producing tools (`text_to_avatar`, `rig_mesh`, `forge_avatar`) set the flag and return `irlUrl` alongside `arUrl`, and the inline widget swaps its button label accordingly.

---

## Sharing: links that unfurl with the model

A place-in-your-room link is built to be forwarded. When it is pasted into a chat app or social surface, the launch page's Open Graph tags make it unfurl with a real render of that exact model, not a bare URL:

- `og:title`: "Place `<title>` in your room"
- `og:image`: `https://three.ws/api/render/glb?glbUrl=<encoded GLB>&width=1200&height=630`

`GET /api/render/glb` ([api/render/glb.js](../api/render/glb.js)) is a public, URL-addressable GLB-to-PNG renderer: point any image tag at it with a public GLB URL and get a PNG back (the shared `renderGlbToPng` in `api/_lib/render-glb.js`: an in-process software rasterizer first, headless Chromium as the failover for Draco/KTX2 models, the same pipeline as the platform's OG cards). It clamps dimensions to 64-2048, HEAD-checks the GLB at 10 MB max, accepts a `background` of `transparent` or any CSS color (markup or anything else that is not a color is rejected with `400 bad_request`), is SSRF-guarded and per-IP rate-limited, and is CDN-cached for a day. The launch page itself ends with a "Create your own" link, so a shared model converts its recipient into a creator.

---

## Using the same contract outside ChatGPT

Everything above is public plumbing:

- **Plain HTTP, free:** `POST /api/3d/generate` is the keyless agent-facing twin of the studio endpoint, same lane, same `arUrl`. Contract, states, and per-IP limits: [the free 3D API](./3d-api.md).
- **Any MCP client:** the connector at `/api/mcp-studio` works in Claude and every other MCP host, not just ChatGPT. Every generation it returns already carries `arUrl` (and `irlUrl` for rigged avatars) plus a [Spatial MCP](./spatial-mcp.md) artifact, so no extra tool call is needed to get the AR link. To build that link set for a GLB the connector did **not** generate, use the read-only `export_ar` tool on the separate [`/api/mcp-3d` server](./mcp-3d-studio.md), which returns `arLaunchUrl`, `sceneViewerUrl`, `viewerUrl`, and `irlUrl`. That server is account- or payment-gated and is not part of the free connector.
- **By hand:** the `arUrl` format is stable. If you have a public GLB, you can construct `https://three.ws/api/ar?src=<encoded GLB>&title=<name>` yourself and it will route correctly on every device.

The generation lane is operator-funded (NVIDIA NIM running Microsoft TRELLIS for text-to-3D), so the end user pays nothing and needs no account; real per-IP rate limits apply and are documented per endpoint.

---

## Where it lives

| Piece | File |
|---|---|
| Custom GPT Actions endpoint | [api/3d/studio.js](../api/3d/studio.js) |
| Free agent endpoint | [api/3d/generate.js](../api/3d/generate.js) |
| AR launcher (`/api/ar`) + unfurl tags | [api/ar.js](../api/ar.js) |
| AR routing core (`buildArLaunchUrl`, device branch, IRL handoff) | [api/_lib/ar-launch.js](../api/_lib/ar-launch.js) |
| MCP studio tools + response envelope | [api/_mcp-studio/tools.js](../api/_mcp-studio/tools.js) |
| Studio Actions response shaping (`shapeSubmit`, `shapePoll`) | [api/_mcp-studio/studio-shape.js](../api/_mcp-studio/studio-shape.js) |
| The on-device AR page (`/ar/view`) | [pages/ar-view.html](../pages/ar-view.html), [src/ar-view.js](../src/ar-view.js) |
| Inline widget (View in your space / Bring it to life) | [api/_mcp-studio/component.js](../api/_mcp-studio/component.js) |
| GLB-to-PNG renderer (og:image) | [api/render/glb.js](../api/render/glb.js) |
| GPT OpenAPI schema (served, source of truth) | [public/.well-known/3d-studio-openapi.yaml](../public/.well-known/3d-studio-openapi.yaml) |
| GPT build sheet + submission kit | [prompts/store-submissions/_generated/](../prompts/store-submissions/_generated/) |
| Tests | [tests/api/3d-studio.test.js](../tests/api/3d-studio.test.js), [tests/ar-export.test.js](../tests/ar-export.test.js) |

## See also

- [Your first prompt to 3D in ChatGPT](/tutorials/first-prompt-to-3d): the user-facing walkthrough of this whole flow
- [Place your 3D model in AR](/tutorials/view-in-ar): the on-site AR tutorial
- [3D Studio MCP](./mcp-studio.md): the free MCP server behind the ChatGPT app
- [The free 3D API](./3d-api.md): the keyless HTTP contract with `arUrl`
- [AR and WebXR reference](./ar.md): Quick Look, Scene Viewer, WebXR, and the USDZ pipeline in depth
- [IRL](./irl.md): the living-agent experience behind Bring it to life
