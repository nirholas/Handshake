# Assistant widget: a 3D avatar assistant on any website

The assistant widget puts a full-body, animated three.ws avatar on any website behind a floating launcher button. Click it and the avatar pops up, standing directly on the page (transparent background) or against a color or gradient, with a message box underneath. It has two modes:

- **Chat**: a real chatbot. Messages go to an LLM and the reply streams into a speech bubble above the avatar's head, optionally spoken aloud. By default answers come from the platform's free model chain (Groq, then OpenRouter, then NVIDIA, no key and no account needed). Visitors can instead bring their own Groq or OpenRouter API key in the widget's settings; the key is stored only in their browser and calls go straight from the browser to the provider.
- **Speak**: the avatar repeats exactly what you type, out loud, with a speech bubble and a talking animation. No model involved; speech uses the browser's built-in text-to-speech voices at zero cost.

Configure everything and copy your snippet at [three.ws/assistant](https://three.ws/assistant). The builder page runs the real widget, so what you see in the corner is exactly what your visitors get.

Looking for a support-chat panel grounded in your page's content instead of a full-body avatar? That is the sibling [Concierge widget](./concierge.md). Use Concierge for "answer questions about this page"; use the assistant widget when you want a character who stands on your site, speaks, and can run on a visitor's own model key.

There are three ways to add it: a one-tag script, the [`@three-ws/assistant`](https://www.npmjs.com/package/@three-ws/assistant) npm package, or let an AI agent generate the embed for you through the [assistant-widget MCP server](#generate-a-widget-from-an-ai-agent-mcp). New to it? The [step-by-step tutorial](./tutorials/add-a-3d-assistant.md) builds one from scratch.

## Install

### 1. One tag (no build)

One script tag before `</body>`:

```html
<script src="https://three.ws/assistant/v1.js" async></script>
```

That alone gives you the launcher with the default avatar, transparent background, both modes, and the free chat lane. Everything is configurable with data attributes:

```html
<script src="https://three.ws/assistant/v1.js" async
  data-avatar="/avatars/selfie-girl.glb"
  data-bg="transparent"
  data-mode="both"
  data-name="Atelier AI"
  data-greeting="Ask anything about Atelier."
  data-context="Atelier is a design studio for 3D artists."
  data-accent="#f97316"
  data-position="right"></script>
```

| Attribute | Values | Default | What it does |
| --- | --- | --- | --- |
| `data-avatar` | avatar id, `/avatars/*.glb`, or a GLB URL | default mannequin | Which body to load. three.ws avatar ids resolve through the public GLB proxy; external URLs must be GLB/GLTF/VRM on an allow-listed host (three.ws, R2, Ready Player Me). |
| `data-agent` | a three.ws agent id | none | Load that agent's avatar instead (alternative to `data-avatar`). |
| `data-bg` | `transparent`, `#hex`, a preset (`ember`, `ocean`, `violet`, `forest`, `dusk`, `slate`), or `gradient:#a,#b,angle` | `transparent` | `transparent` floats the avatar directly over your page. Anything else paints the panel. Values are strictly validated inside the frame; invalid input falls back to transparent. |
| `data-mode` | `chat`, `speak`, `both` | `both` | `both` shows a Chat / Speak toggle in the widget. |
| `data-name` | text (60 chars) | `Assistant` | Header title and the chatbot's persona name. |
| `data-greeting` | text (200 chars) | mode-aware default | First speech bubble when the widget opens. |
| `data-context` | text (500 chars) | none | What the chatbot should know about your site; injected into the system prompt. |
| `data-accent` | `#hex` | `#f97316` | Launcher button, send button, focus rings. |
| `data-position` | `right`, `left` | `right` | Which corner the launcher sits in. |
| `data-voice` | `false` | on | Start with voice muted (the visitor can toggle it). |
| `data-badge` | `false` | on | Hide the three.ws attribution badge. |
| `data-open` | present | closed | Start with the panel open. |
| `data-manual` | present | auto | Don't auto-mount; call `ThreeAssistant.init()` yourself. |

### 2. npm

For bundler projects, install the loader from npm instead of the CDN tag. It is the same code (the one-tag build is generated from this package), with types and named exports.

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

Every config key matches the `data-*` attribute above without the `data-` prefix. Self-hosting the frame? Pass `origin` to `init` (defaults to `https://three.ws`). Full package reference: the [`@three-ws/assistant` README](https://github.com/nirholas/three.ws/tree/main/assistant-sdk).

## JavaScript API

The loader exposes `window.ThreeAssistant`:

```js
ThreeAssistant.init({ avatar: '/avatars/michelle.glb', name: 'Atelier AI' }); // replaces any existing instance
ThreeAssistant.open();
ThreeAssistant.close();
ThreeAssistant.toggle();
ThreeAssistant.say('Welcome to the spring sale!'); // opens the widget and speaks the line aloud
ThreeAssistant.setMode('speak'); // or 'chat' (only when the widget was mounted with mode "both")
ThreeAssistant.destroy();
```

Host pages can observe the widget through a single DOM event:

```js
window.addEventListener('three-assistant', (e) => {
  // e.detail.type: 'ready' | 'open' | 'close' | 'message' | 'speak:start' | 'speak:end' | 'error'
  if (e.detail.type === 'message') console.log(e.detail.payload.role, e.detail.payload.content);
});
```

## Generate a widget from an AI agent (MCP)

Any MCP-enabled agent (Claude Code, Cursor, Claude Desktop) can design the embed for you through the [`@three-ws/assistant-mcp`](https://www.npmjs.com/package/@three-ws/assistant-mcp) server, published to the official registry as `io.github.nirholas/assistant-widget`. It is free, needs no key, and runs offline (snippet generation is pure).

Add it to your MCP client config:

```json
{
  "mcpServers": {
    "assistant-widget": {
      "command": "npx",
      "args": ["-y", "@three-ws/assistant-mcp"]
    }
  }
}
```

Two tools:

- **`list_assistant_options`** returns everything you can configure: the built-in avatars, the background presets and grammar, the modes, the chat lanes, and the full `data-*` attribute reference.
- **`build_assistant_widget`** turns a config (avatar, background, mode, name, greeting, context, accent, position) into a paste-ready `<script>` snippet, a standalone frame URL, an equivalent `ThreeAssistant.init({...})` call, and the builder link. Every field is validated and clamped, so a bad value falls back to a safe default and the generated HTML is always well-formed.

Ask your agent something like "build a 3D assistant widget named Aria with an ocean background for my site" and paste the snippet it returns. The server is one of the [three.ws MCP servers](./mcp.md); find it in the registry at [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io/?q=io.github.nirholas).

## How it works

- The launcher and panel are plain DOM injected by [`public/assistant/v1.js`](https://github.com/nirholas/three.ws/blob/main/public/assistant/v1.js), the minified build of the [`@three-ws/assistant`](https://github.com/nirholas/three.ws/tree/main/assistant-sdk) loader (no dependencies, idempotent). The avatar, chat, and speech run inside an iframe on `https://three.ws/assistant-frame`, so your page never sees model keys and the frame never sees your DOM.
- The frame ([`src/assistant-frame.js`](https://github.com/nirholas/three.ws/blob/main/src/assistant-frame.js)) renders the avatar with Three.js, retargets the platform's canonical animation clips onto it (idle, wave greeting, a talking loop while speaking), and anchors the speech bubble to the avatar's head projection every frame.
- Free-lane chat posts to `POST /api/chat` (SSE stream, anonymous access, server-side rate limits and moderation). BYOK chat streams directly from the visitor's browser to Groq or OpenRouter with their key; the key lives in `localStorage` on the three.ws origin and is never sent to three.ws servers or the host page.
- Speak mode and spoken chat replies use the Web Speech API (`speechSynthesis`). Voice pick persists per browser. When the browser has no TTS or voice is muted, the bubble and talking animation still run for the estimated duration, so the widget never silently stalls.
- Every config param is re-validated inside the frame by [`src/assistant-widget-core.js`](https://github.com/nirholas/three.ws/blob/main/src/assistant-widget-core.js) (strict background/color grammars, length clamps, avatar host allow-list), so a hostile embedding page cannot inject CSS or URLs into the frame.

## Related surfaces

- [Build a 3D assistant, step by step](./tutorials/add-a-3d-assistant.md), the tutorial
- [Concierge](./concierge.md), the page-grounded support-chat widget with a lipsyncing face
- [three.ws MCP servers](./mcp.md), the full free and paid tool catalog
- [Share and embed](./share-and-embed.md), the `<three-d>` model embeds
- [/walk-embed](https://three.ws/walk-embed), the walking-avatar iframe embed
- [/forge](https://three.ws/forge), generate an avatar to use in the widget

## Packages

| Package | What it is |
| --- | --- |
| [`@three-ws/assistant`](https://github.com/nirholas/three.ws/tree/main/assistant-sdk) | The widget loader (npm + the one-tag CDN build at `/assistant/v1.js`). |
| [`@three-ws/assistant-mcp`](https://github.com/nirholas/three.ws/tree/main/packages/assistant-mcp) | The MCP server (`io.github.nirholas/assistant-widget`) that generates embeds for AI agents. |
