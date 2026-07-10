<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">apps-sdk</h1>

<p align="center"><strong>The two host-embeddable 3D surfaces three.ws ships into other people's apps: an inline GLB viewer component for the OpenAI Apps SDK, and the living-agent-body engine behind the embodiment embed.</strong></p>

---

This directory is **source consumed by build scripts and page bundles** — it is not
an npm package and has no `package.json`. Nothing here is published; the two
subdirectories are built or imported directly by the platform.

| Subdirectory | What it is | Where it ends up |
| --- | --- | --- |
| [`studio-viewer/`](#studio-viewer) | Self-contained Three.js GLB orbit-preview component | Bundled into the `ui://widget/studio-viewer.html` skybridge resource served to ChatGPT |
| [`embodiment/`](#embodiment) | The `EmbodimentStage` living-agent-body engine + its overlay chrome | Imported by [`pages/embodiment/embed.html`](../pages/embodiment/embed.html), the hosted embed |

---

## studio-viewer

Renders the GLB produced by the 3D Studio generation tools (`forge_free`,
`text_to_avatar`, `mesh_forge`, `rig_mesh`, `forge_avatar`, …) as an interactive,
orbitable 3D preview **inline in ChatGPT**. It uses PMREM `RoomEnvironment`
lighting, auto-framing, a contact shadow, and `AnimationMixer`-driven idle
playback for rigged models — the same rendering approach as the Claude.ai
artifact viewer and the Forge chat preview.

The entry point is a single file, [`studio-viewer/src.js`](studio-viewer/src.js).
It is bundled to one self-contained IIFE (three.js + `GLTFLoader` +
`OrbitControls` + `RoomEnvironment` + the viewer inlined) so the component needs
no external `<script>`. The only network call it makes is fetching the GLB
itself, permitted via the resource's `openai/widgetCSP` `connectDomains`.

### Host contract (OpenAI Apps SDK)

- `window.openai.toolOutput` supplies the tool's `structuredContent`.
- The GLB URL is read from the documented `glb_url` key (camelCase `glbUrl` and a
  few aliases are tolerated for forward-compat).
- The `openai:set_globals` event fires when `toolOutput`, theme, or layout change;
  the viewer re-reads on it.

**Standalone fallback.** Opened directly in a browser (no `window.openai`), it
reads `?glb=<url>&viewer=<url>&name=<text>` from the query string — used for local
verification and the "open in a normal browser" path.

### Build

```bash
npm run build:apps-sdk-viewer     # → node scripts/build-apps-sdk-viewer.mjs
```

Both outputs inline the same IIFE:

| Output | Consumed by |
| --- | --- |
| `public/apps-sdk/studio-viewer.bundle.js` | Read at runtime by [`api/_mcp3d/studio-viewer-resource.js`](../api/_mcp3d/studio-viewer-resource.js) and inlined into the skybridge resource |
| `public/apps-sdk/studio-viewer.html` | Standalone page that inlines the bundle and reads `?glb=<url>` |

### Runnable example

Build it, then open the standalone page against any public GLB:

```bash
npm run build:apps-sdk-viewer
npx serve public -l 4173
# → http://localhost:4173/apps-sdk/studio-viewer.html?glb=https://three.ws/models/agent.glb&name=Agent
```

---

## embodiment

`EmbodimentStage` is a **living agent body you can drop into a panel**: a
generated, rigged avatar that renders inline, lip-syncs the assistant's replies,
shows the matching emotion, plays a body gesture, idles between turns, and reacts
while a tool runs. It is framework-agnostic — give it a DOM container and a
persona (a name + a GLB URL) and it mounts a Three.js scene and drives it.

Everything runs on real platform pipelines, not canned stand-ins:

- **Body animation** rides `AnimationManager` plus the canonicalize/retarget
  pipeline, so the baked clip library drives *any* humanoid rig. A rig that can't
  be skeleton-driven (no skin, non-humanoid prop) is detected up front by
  `decideRigMode` and falls back to a gentle alive-idle — never a frozen T-pose.
- **Lip-sync** is best-first: an Audio2Face ARKit track synced to TTS audio when
  present, else live spectral analysis of playing audio, else a deterministic
  text-timed mouth envelope. If the rig has no mouth morphs, `AvatarMouthTarget`
  drives the jaw (or head) bone instead, so the face is never frozen.
- **Emotion** is detected from the reply text (or set explicitly), blended onto the
  face via `FaceExpression` / ARKit morphs **and** expressed through a body
  gesture, so even a morph-less rig emotes.

State machine: `loading → idle ⇄ listening ⇄ thinking ⇄ speaking → (error)`. Every
transition is observable through `opts.onState` so the host can paint a status.

### Exports

| Module | Export | Signature |
| --- | --- | --- |
| [`embodiment-stage.js`](embodiment/embodiment-stage.js) | `EmbodimentStage` | `new EmbodimentStage(container, { onState?, background? })` |
| | | `.loadPersona({ glbUrl, name?, personaId? }) → Promise<boolean>` |
| | | `.speak({ text, emotion?, intensity?, gesture?, audioUrl?, visemeTrack? }) → Promise<void>` |
| | | `.listening()` · `.thinking()` · `.setChainState(identity)` · `.destroy()` |
| [`overlay.js`](embodiment/overlay.js) | `mountOverlay` | `mountOverlay(container, { onRetry? })` → controller with `.setName(name)` and `.setState(state, detail?)` |
| [`chain-visuals.js`](embodiment/chain-visuals.js) | `mapChainStateToVisuals` | `mapChainStateToVisuals(identity)` → `{ aura, cosmetic, muted, nameplate }` |
| | `AURA_BY_REPUTATION_TIER`, `COSMETIC_BY_HOLDINGS_TIER` | Tier → visual lookup tables |
| [`face-expression.js`](embodiment/face-expression.js) | `FaceExpression` | Re-export of [`src/embodiment/face-expression.js`](../src/embodiment/face-expression.js) |

`setChainState()` takes a `getPersonaIdentity()` result and maps the agent's
on-chain standing onto the render: reputation tier drives an aura, `$THREE`
holdings tier drives a cosmetic, and a `muted` (unfunded) wallet dims the aura
regardless of reputation.

### Runnable example

Mount a body, wire the overlay to its state, load a persona, and have it speak:

```html
<div id="stage-root" style="width:100%;height:480px"></div>
<script type="module">
	import { EmbodimentStage } from '/apps-sdk/embodiment/embodiment-stage.js';
	import { mountOverlay } from '/apps-sdk/embodiment/overlay.js';

	const root = document.getElementById('stage-root');

	const overlay = mountOverlay(root, { onRetry: () => location.reload() });
	overlay.setName('Scout');

	const stage = new EmbodimentStage(root, {
		onState: (state, detail) => overlay.setState(state, { ...detail, name: 'Scout' }),
	});

	await stage.loadPersona({ glbUrl: 'https://three.ws/models/agent.glb', name: 'Scout' });
	await stage.speak({ text: 'Found you. Walk with me.', emotion: 'joy' });
</script>
```

The hosted embed does exactly this — see
[`pages/embodiment/embed.html`](../pages/embodiment/embed.html), which additionally
resolves a durable `persona_id` through `GET /api/mcp3d/persona?id=` so a reload
always renders the current body.

### Try it without writing code

```
https://three.ws/embodiment/embed?glb=<glb-url>&name=Scout
https://three.ws/embodiment/embed?persona=<persona-id>&bg=transparent
```

---

## Related

- [`docs/mcp.md`](../docs/mcp.md) — the 3D Studio MCP tools whose output the viewer renders.
- [`STRUCTURE.md`](../STRUCTURE.md) — where every product surface lives.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
