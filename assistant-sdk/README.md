# @three-ws/assistant

A 3D avatar assistant for any website, in one script tag. A floating launcher opens a real, animated 3D avatar in a panel, standing directly on your page (transparent), or against a color or gradient. It has two modes:

- **Chat**: a real chatbot. Replies stream into a speech bubble above the avatar's head and optionally speak aloud. Default answers come from the platform's free model chain (no key, no account). Visitors can switch to their own Groq or OpenRouter key in the widget settings; the key stays in their browser.
- **Speak**: the avatar says exactly what you type, out loud, with a speech bubble. No model involved, browser text-to-speech, zero cost.

The avatar, chat, and speech run inside an iframe hosted on three.ws (`/assistant-frame`), so your page never sees model keys and the frame never sees your DOM. This package is the small host-side loader.

- Live builder and demo: [three.ws/assistant](https://three.ws/assistant)
- Docs: [three.ws/docs/assistant-widget](https://three.ws/docs/assistant-widget)
- Generate an MCP-driven config from any agent: [`@three-ws/assistant-mcp`](https://www.npmjs.com/package/@three-ws/assistant-mcp)

## Install

### 1. One tag (no build)

```html
<script src="https://three.ws/assistant/v1.js" async
  data-avatar="/avatars/selfie-girl.glb"
  data-name="Atelier AI"
  data-greeting="Ask anything about Atelier."
  data-context="Atelier is a design studio for 3D artists."
  data-bg="transparent"
  data-accent="#f97316"></script>
```

### 2. npm

```bash
npm install @three-ws/assistant
```

```js
import ThreeAssistant from '@three-ws/assistant';

ThreeAssistant.init({
  avatar: '/avatars/selfie-girl.glb',
  name: 'Atelier AI',
  greeting: 'Ask anything about Atelier.',
  context: 'Atelier is a design studio for 3D artists.',
  bg: 'transparent',
});
```

## Options

Every option is a config key (npm) or a `data-*` attribute (one-tag). Unknown or invalid values are re-validated inside the frame and fall back to a safe default, so a bad value never breaks the page.

| Key / attribute | Values | Default | Description |
| --- | --- | --- | --- |
| `avatar` / `data-avatar` | avatar id, `/avatars/*.glb`, or a GLB URL | default mannequin | Which body to load. External URLs must be GLB/GLTF/VRM on an allow-listed host (three.ws, R2, Ready Player Me). |
| `agent` / `data-agent` | a three.ws agent id | none | Load that agent's avatar instead. |
| `bg` / `data-bg` | `transparent`, `#hex`, a preset (`ember`, `ocean`, `violet`, `forest`, `dusk`, `slate`), or `gradient:#a,#b,angle` | `transparent` | `transparent` floats the avatar over your page; anything else paints the panel. |
| `mode` / `data-mode` | `chat`, `speak`, `both` | `both` | `both` shows a Chat / Speak toggle. |
| `name` / `data-name` | text (60) | `Assistant` | Header title and chatbot persona name. |
| `greeting` / `data-greeting` | text (200) | mode default | First speech bubble on open. |
| `context` / `data-context` | text (500) | none | What the chatbot should know about your site. |
| `accent` / `data-accent` | `#hex` | `#f97316` | Launcher, send button, focus rings. |
| `position` / `data-position` | `right`, `left` | `right` | Launcher corner. |
| `voice` / `data-voice` | `false` | on | Start with voice muted. |
| `badge` / `data-badge` | `false` | on | Hide the three.ws attribution badge. |
| `open` / `data-open` | present | closed | Start with the panel open. |
| `origin` | URL | `https://three.ws` | Frame host (self-hosting only; npm config key). |
| `data-manual` | present | auto | One-tag only: do not auto-mount; call `ThreeAssistant.init()` yourself. |

## API

`window.ThreeAssistant` (one-tag) and the default export (npm) share the same API:

```js
ThreeAssistant.init(config);   // replaces any existing instance, returns the Assistant
ThreeAssistant.open();
ThreeAssistant.close();
ThreeAssistant.toggle();
ThreeAssistant.say('Welcome to the sale!'); // opens and speaks the line aloud
ThreeAssistant.setMode('speak');            // or 'chat' (only when mounted with mode 'both')
ThreeAssistant.destroy();
ThreeAssistant.instance;        // the live Assistant, or null
```

Named exports are also available for tree-shaking bundlers:

```js
import { init, say, createAssistant, VERSION } from '@three-ws/assistant';
```

`createAssistant({ origin })` returns an isolated API bound to a specific frame host, if you run more than one or self-host.

## Events

Listen once on `window` for the widget lifecycle:

```js
window.addEventListener('three-assistant', (e) => {
  // e.detail.type: 'ready' | 'open' | 'close' | 'message' | 'speak:start' | 'speak:end' | 'error'
  if (e.detail.type === 'message') {
    console.log(e.detail.payload.role, e.detail.payload.content);
  }
});
```

## How it works

The launcher and panel are plain DOM this package injects. The panel holds an `<iframe>` pointing at `https://three.ws/assistant-frame?<your config>`. Inside that frame: a Three.js avatar with idle, wave, and talking animations; a head-anchored speech bubble; streaming chat over the platform's free model chain (or the visitor's own key, sent browser-to-provider); and Web Speech text-to-speech. Config crosses to the frame as query params and is re-validated there, so a hostile embedding page cannot inject CSS or URLs. Host and frame talk over a tiny `postMessage` protocol on the `three-assistant` channel.

## Develop

```bash
npm install     # esbuild for the build, jsdom for the DOM tests
npm run build   # esbuild -> dist/assistant.mjs + dist/assistant.global.js
npm test        # node --test: the pure loader logic, plus the mounted widget under jsdom
npx serve .     # after build, open http://localhost:3000/examples/
```

Serve this package root, not `examples/`: the example page loads the build you
just made from `../dist/`, which a server rooted at `examples/` cannot reach.
The page talks to the live `three.ws` frame, so chat, voice, and the avatar all
work from `localhost` with no extra setup.

## License

Proprietary. Free to embed on any site via the published builds (the one-tag CDN script or this npm package). See [LICENSE](./LICENSE).
