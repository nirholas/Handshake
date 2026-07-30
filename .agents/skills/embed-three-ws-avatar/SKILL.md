---
name: embed-three-ws-avatar
description: Embed a live, animated three.ws 3D avatar in any website with the <agent-3d> web component. Use when you or the user want to embed, integrate, add, or show a 3D avatar, character, or agent on a site or app ("embed a 3D avatar on my site", "add an animated character to my landing page", "integrate three.ws", "put an avatar in my hero section"), wire avatar animations or moods from page code, let users design an avatar in the three.ws Avatar Studio from inside another app, or debug an existing agent-3d embed.
when_to_use: A site or app (any framework, or plain HTML) should display or control a three.ws avatar. To generate the avatar model itself, use create-3d-avatar or generate-3d-model first; this skill covers putting the result on a page and driving it.
license: MIT
metadata:
  category: 3d/creative
  cross-platform-safe: true
  pack: three-ws-skills
---

# Embed a three.ws avatar on any site

The `<agent-3d>` web component renders a rigged, animated 3D avatar (GLB) with
zero framework dependencies. It works in plain HTML, React, Vue, Svelte, Angular,
WordPress, Webflow, Shopify, Framer, and Notion embeds. The bundle is served from
the three.ws CDN with `access-control-allow-origin: *`, so it loads from any origin.

## Quick start

```html
<script
  type="module"
  src="https://three.ws/agent-3d/1.5.2/agent-3d.js"
  integrity="sha384-xkFDjVP866hYt7voUhfnQHj6IO4hYxA6n8Laupk+VtD6y+IKiO/AZdE3VbfLtg0C"
  crossorigin="anonymous"
></script>

<agent-3d
  body="https://three.ws/avatars/default.glb"
  mode="section"
  kiosk
  poster="/images/avatar-poster.webp"
  style="width:100%;height:420px;display:block"
></agent-3d>
```

A UMD build exists at the same path as `agent-3d.umd.cjs` if ES modules are not an option.

## Pick the right CDN channel (do not ship `latest`)

| Path | Cache | Use when |
| --- | --- | --- |
| `/agent-3d/<MAJOR>.<MINOR>.<PATCH>/agent-3d.js` | immutable, 1 year | production. Pin exact bytes, always combine with SRI |
| `/agent-3d/<MAJOR>.<MINOR>/agent-3d.js` | 5 min | follow patch releases automatically |
| `/agent-3d/<MAJOR>/agent-3d.js` | 5 min | follow minor + patch releases |
| `/agent-3d/latest/agent-3d.js` | 5 min | demos and prototypes only |

`latest` can ship breaking changes with no action on your side. For production,
pin an exact version with an `integrity` attribute. Machine-readable release
data:

- `https://three.ws/agent-3d/versions.json`: current version, channels, publish time.
- `https://three.ws/agent-3d/<version>/integrity.json`: sha384 SRI hashes for that exact version.

## Getting a GLB for `body`

Any humanoid GLB URL works. Models generated on three.ws come back on persistent
`https://three.ws/cdn/forge/...` URLs you can use directly in `body` with no
re-hosting (self-hosting also works if you want control):

- Generate from text or a reference image: the `create-3d-avatar` skill (rigged,
  animation-ready) or `generate-3d-model` (static prop). Both return a `glbUrl`.
- Rig an existing GLB: the `rig-a-model` skill.
- Let end users design one interactively: the Avatar Studio iframe flow below.

Rigging is universal on three.ws: any humanoid skeleton convention (Mixamo,
VRM/VRoid, Avaturn, Unreal, Daz, MakeHuman, and more) is auto-mapped so the
built-in animation clips (idle, walk, wave, dance, ...) play on it.

## Key attributes

| Attribute | What it does |
| --- | --- |
| `body` | GLB URL of the avatar to render (absolute URL) |
| `brain` | Conversation engine. Omit or `none` = silent decorative avatar. `free` = real chat with a host-paid free LLM lane: no API key, no cost to you. Any other value is treated as a specific model id |
| `mode` | Layout: `section` for in-page blocks, plus floating widget positions |
| `kiosk` (or `viewer`) | Bare display mode: no chrome, pure avatar showcase |
| `poster` | Image painted instantly while the GLB streams, then crossfaded out. Use it instead of your own skeleton/placeholder div |
| `eager` | Boot immediately. Default is lazy: the element boots when scrolled into view. Set on above-the-fold hero placements |
| `background` | `transparent`, `dark`, `light`, or any CSS color |
| `name-plate` | `off` to hide the floating name label |
| `clip` | Named animation to play decoratively (e.g. `dance`) |
| `framing` | `portrait` for a head-and-shoulders crop |
| `responsive` | Adapt sizing to the container |

There is no `auto-rotate` attribute on `<agent-3d>`; setting one is silently
ignored (it belongs to `<model-viewer>`, a different element).

## Events (all bubble and cross shadow DOM)

- `agent:ready`: model loaded and animating. Gate your "loaded" UI on this, never on a timeout.
- `agent:error`: load or boot failed. Show your fallback here.
- `agent:load-progress`: `{ phase, pct }` detail for a real progress indicator.
- With a brain enabled: `brain:thinking`, `brain:message`, `brain:stream`,
  `voice:speech-start`, `voice:speech-end`, `voice:transcript`.

## Imperative API (methods on the element)

```js
const el = document.querySelector('agent-3d');
el.addEventListener('agent:ready', async () => {
  await el.wave({ style: 'enthusiastic' }); // greeting gesture
  await el.playClip('dance', { loop: false }); // any named clip, reduced-motion aware
  await el.lookAt('user'); // face the camera
  el.setMood(0.8, 0.4); // sustained expression: valence -1..1, arousal 0..1
  await el.say('Welcome!'); // speech bubble + talk animation (works with brain="none")
  await el.speak('Welcome!'); // spoken TTS variant
});
// el.pause() / el.resume() for tab-visibility or carousel logic
// el.destroy() on unmount (call from your framework's cleanup hook)
```

Theming: the element reads CSS custom properties, led by `--agent-accent`, so
you can match it to your brand color per instance:
`el.style.setProperty('--agent-accent', '#b8ff2e')`.

## Let users design their avatar: Avatar Studio iframe

Open `https://three.ws/create/studio` in an iframe (a modal works well; set
`allow="camera *; microphone *; clipboard-write"`). When the user exports, the
studio posts the finished GLB to the parent window:

```js
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://three.ws') return; // always check origin
  const msg = event.data;
  if (msg?.source === 'characterstudio' && msg.type === 'export' && msg.glb instanceof ArrayBuffer) {
    const blob = new Blob([msg.glb], { type: 'model/gltf-binary' });
    // Upload the blob to your storage (or use it in-memory), then point
    // <agent-3d body="..."> at the resulting URL.
  }
});
```

The message shape is `{ source: 'characterstudio', type: 'export', format: 'glb', glb: ArrayBuffer }`.
The protocol is currently export-only: you cannot seed an existing GLB into the
studio for re-editing.

There is also a plain link target for text-to-3D generation with no integration
work: `https://three.ws/create/prompt`.

## Common mistakes

1. Loading `/agent-3d/latest/` in production. Pin a version and add SRI.
2. Marking the avatar "ready" on a `setTimeout`. Use `agent:ready` and `agent:load-progress`.
3. Building your own loading placeholder. Pass a `poster` image instead.
4. Forgetting `eager` on a hero placement, so the avatar boots late.
5. Forgetting `el.destroy()` on unmount in SPA frameworks, leaking WebGL contexts.
6. Setting `auto-rotate`, which does nothing on this element.
7. Leaving conversation off when it would be free: `brain="free"` costs the embedder nothing.

## Reference

- Full element reference (all attributes, events, JS API): `https://three.ws/docs/web-component`
- Embedding guide: `https://three.ws/docs/embedding`
- Release manifest: `https://three.ws/agent-3d/versions.json`
