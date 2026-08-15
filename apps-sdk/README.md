<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">apps-sdk</h1>

<p align="center"><strong>The living-agent-body engine three.ws embeds into other people's apps, plus a pointer to where the ChatGPT inline 3D widget actually lives.</strong></p>

---

This directory is **source consumed by page bundles** — it is not an npm package
and has no `package.json`. Nothing here is published; it is imported directly by the
platform.

| Subdirectory | What it is | Where it ends up |
| --- | --- | --- |
| [`embodiment/`](#embodiment) | The `EmbodimentStage` living-agent-body engine + its overlay chrome | Imported by [`pages/embodiment/embed.html`](../pages/embodiment/embed.html), the hosted embed |

## Where the ChatGPT inline 3D widget lives (not here)

The inline 3D preview ChatGPT renders next to a generated model is **not** in this
directory. It is the `<model-viewer>` skybridge component built in
[`api/_mcp-studio/component.js`](../api/_mcp-studio/component.js): the resource
`ui://widget/three-studio-model.html` (and its persona sibling
`ui://widget/three-studio-persona.html`), registered in
[`api/_mcp-studio/dispatch.js`](../api/_mcp-studio/dispatch.js) and linked to every
generation tool through the tool's `_meta["openai/outputTemplate"]`. That is the
widget an OpenAI reviewer sees. For the full server, see
[`docs/mcp-studio.md`](../docs/mcp-studio.md).

The standalone "open in a normal browser" viewer that the tools' `viewerUrl`
(`https://three.ws/viewer?src=<glb>`) points at is a separate page,
[`public/viewer.html`](../public/viewer.html) — also not in this directory.

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
  text-timed mouth envelope. Autoplay refusals are covered too: a host that
  blocks the audio drops to the text envelope for the same reply, so the mouth
  still speaks the line. If the rig has no mouth morphs, `AvatarMouthTarget`
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
| [`overlay.js`](embodiment/overlay.js) | `mountOverlay` | `mountOverlay(container, { onRetry? })` → controller |
| | | `.setName(name)` · `.setState(state, detail?)` · `.setIdentity(visuals\|null)` · `.destroy()` · `.el` |
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

	await stage.loadPersona({ glbUrl: 'https://three.ws/avatars/xbot.glb', name: 'Scout' });
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

- [`docs/mcp-studio.md`](../docs/mcp-studio.md) — the 3D Studio MCP server, its tools, and the inline widget (`api/_mcp-studio/component.js`).
- [`docs/chatgpt-ar.md`](../docs/chatgpt-ar.md) — how each generation carries a place-in-your-room `arUrl`.
- [`STRUCTURE.md`](../STRUCTURE.md) — where every product surface lives.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
