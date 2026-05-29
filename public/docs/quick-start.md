# Quick Start — three.ws

Get a live three.ws on your page in under 10 minutes.

---

## Prerequisites

- **Browser:** Chrome 90+, Firefox 89+, or Safari 15+ (WebGL 2.0 required)
- **A 3D model:** GLB/glTF file. No model yet? Use the sample avatar below.
- **Node.js 24.x:** Only needed if you're running the dev server or building from source.

---

## Option A — CDN Drop-In (zero build step)

The fastest path. No npm, no bundler, no build step.

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>My three.ws</title>
  <style>
    agent-3d { width: 400px; height: 500px; display: block; }
  </style>
</head>
<body>
  <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
  <agent-3d body="https://cdn.three.ws/models/sample-avatar.glb"></agent-3d>
</body>
</html>
```

**What each part does:**

- `<script type="module">` — loads the self-contained ES module bundle. It registers the `<agent-3d>` custom element and bundles Three.js, so no other dependencies are required.
- `body="..."` — the URL of your GLB file. This is the 3D model the agent displays.
- The `width` and `height` CSS on `agent-3d` control the canvas size. The element is `display: block` by default at full container width.

**Lazy loading:** The component uses `IntersectionObserver` internally. The 3D scene doesn't boot until the element scrolls into view, so placing it below the fold has zero impact on initial page load. Add `eager` if you want it to start loading immediately:

```html
<agent-3d eager body="./avatar.glb"></agent-3d>
```

---

## Option B — npm Install

For projects that have a build step (Vite, Webpack, Create React App, Next.js, etc.):

```bash
npm install @three-ws/sdk
```

### Plain JS / Vite

```js
import '@three-ws/sdk'; // registers <agent-3d> as a side effect

// The custom element is now available in HTML, or create it programmatically:
const agent = document.createElement('agent-3d');
agent.setAttribute('body', './avatar.glb');
agent.style.cssText = 'width:400px;height:500px;display:block';
document.body.appendChild(agent);
```

### React / Next.js

```jsx
import '@three-ws/sdk';

export function AgentWidget() {
  return (
    <agent-3d
      body="/avatar.glb"
      style={{ width: '400px', height: '500px', display: 'block' }}
    />
  );
}
```

React passes unknown attributes to native elements as-is, so all `<agent-3d>` attributes work without wrappers. In Next.js App Router, mark the importing module as a client component (`'use client'`).

> Other published SDKs you may want alongside `@three-ws/sdk`:
>
> - `@three-ws/agent-ui` — pre-built chat panel, voice button, accessory dock
> - `@three-ws/avatar` — programmatic avatar loader and animator (Node + browser)
> - `@three-ws/solana-agent` — Solana identity + Metaplex Core helpers
> - `@3d-agent/mcp-server` — MCP server you point Claude Desktop, Cursor, or Claude Code at

---

## Loading Your Own Model

### Accepted formats

| Format | Notes |
|--------|-------|
| **GLB** (binary glTF) | Recommended. Single file, no external dependencies. |
| **glTF 2.0** (JSON + assets) | Supported; all referenced files must be accessible. |
| **Draco-compressed meshes** | Supported — decoder loads automatically on first use. |
| **KTX2 compressed textures** | Supported — reduces GPU memory on compatible hardware. |

GLB is the best choice for embeds: one file, no CORS complexity, maximum compatibility.

### Pointing at a local file

```html
<!-- Relative path — works when serving from the same origin -->
<agent-3d body="./models/my-character.glb"></agent-3d>

<!-- Absolute URL — the server must send permissive CORS headers -->
<agent-3d body="https://assets.example.com/my-character.glb"></agent-3d>
```

See the [CORS gotcha](#cors) below if your GLB is on a different domain.

---

## Adding an AI Brain

The `brain` attribute turns the 3D viewer into a conversational agent:

```html
<agent-3d
  body="./avatar.glb"
  brain="claude-sonnet-4-6"
  instructions="You are a friendly product guide. Help visitors find what they need."
  mode="inline"
></agent-3d>
```

**Attribute reference:**

| Attribute | What it does |
|-----------|--------------|
| `brain` | LLM model ID. Anthropic: `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`. OpenAI: `gpt-4o`, `gpt-4o-mini`. Omit for a viewer-only display with no AI. |
| `instructions` | System prompt for the agent's personality and role. |
| `mode` | Layout mode: `inline` (flows with page content), `floating` (fixed bubble in a corner), `fullscreen`, or `section`. Default: `inline`. |

The chat input and microphone button appear automatically when `brain` is set. The agent can play animations, look at the camera, and respond to voice input.

### Loading a named agent by ID

If you've registered an agent on the platform, load it by its UUID instead:

```html
<agent-3d agent-id="a1b2c3d4-e5f6-7890-abcd-ef1234567890"></agent-3d>
```

The element fetches the agent manifest — which includes the model URL, instructions, skills, and memory configuration — from the API. No other attributes needed.

---

## Using a Pre-Built Widget

The fastest path to an embeddable 3D experience is an iframe widget. Build one in [Widget Studio](https://three.ws/studio), then embed the snippet:

```html
<iframe
  src="https://three.ws/app#widget=wdgt_YOUR_ID&kiosk=true"
  width="600"
  height="600"
  style="border:0;border-radius:12px;max-width:100%"
  allow="autoplay; xr-spatial-tracking; clipboard-write"
  loading="lazy"
></iframe>
```

### Widget types

| Type | Best for |
|------|----------|
| `turntable` | Hero banners, product showcases. Auto-rotate, no UI chrome. |
| `animation-gallery` | Showcasing a rigged avatar's full animation library. |
| `talking-agent` | Embodied chat — your agent on your site. |
| `passport` | On-chain identity card backed by ERC-8004. |
| `hotspot-tour` | Annotated 3D scenes with clickable points of interest. |

For the full widget API including `postMessage` events, see the [Widget docs](./widgets.md).

---

## Running the Dev Server

For contributors or self-hosters:

```bash
git clone https://github.com/nirholas/three.ws.git
cd three.ws
npm install
cp .env.example .env        # fill in your API keys (see below)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Required vs. optional env vars

Copy `.env.example` to `.env` and fill in:

| Variable | Required? | What it does |
|----------|-----------|--------------|
| `DATABASE_URL` | Required | Postgres connection string (Neon serverless recommended). |
| `JWT_SECRET` | Required | Signs auth tokens. Generate with `openssl rand -base64 64`. |
| `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_BUCKET` | Required for uploads | S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2). |
| `ANTHROPIC_API_KEY` | Required for AI chat | LLM backend. Without it, the agent falls back to pattern matching. |
| `VITE_PRIVY_APP_ID` | Optional | Wallet auth via [Privy](https://privy.io). Needed for on-chain identity. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Optional | Distributed rate limiting. Falls back to in-memory without it. |
| `VITE_CHARACTER_STUDIO_URL` | Optional | Origin where the [Character Studio](https://github.com/m3-org/CharacterStudio) avatar builder iframe is hosted. Defaults to `http://localhost:5173` in dev. |
| `AVATURN_API_KEY` | Optional | Photo-to-avatar pipeline via [Avaturn](https://avaturn.me). |
| `PINATA_JWT` | Optional | IPFS pinning for on-chain agent registration. |

For a local-only dev environment with no uploads or on-chain features, only `DATABASE_URL`, `JWT_SECRET`, and `ANTHROPIC_API_KEY` are strictly needed.

---

## First Steps After Loading

Once your agent is running:

1. **Orbit the model** — click and drag to rotate. Scroll to zoom. Right-click to pan.
2. **Play animations** — if your GLB has animation clips, open the Animations tab in the GUI panel (top-right corner in the app). Click any clip to play it.
3. **Edit materials** — the Material editor lets you adjust roughness, metalness, and color without touching code.
4. **Talk to the agent** — type in the chat input at the bottom, or click the microphone button and speak (HTTPS required for mic access).
5. **Link a wallet** — click the identity card to connect a wallet and create an on-chain identity for the agent.

---

## Common Gotchas

### CORS

If your GLB is hosted on a different origin than your page, the server must send:

```
Access-Control-Allow-Origin: *
```

Without this, the browser will block the fetch and the viewer will show a load error. Solutions:
- Serve GLBs from the same origin as your page.
- Use a CDN that sends permissive CORS headers (Cloudflare R2, AWS S3 with a CORS rule).
- Use the platform's hosted storage — uploads via the Studio are CORS-configured automatically.

### File size

GLB files over ~50MB will load slowly on typical connections. Use [Draco compression](https://github.com/google/draco) to shrink geometry by 10–15×:

```bash
# Via gltf-transform CLI
npx gltf-transform draco input.glb output.glb
```

### HTTPS for voice

The browser's `getUserMedia` API (microphone access for push-to-talk) requires HTTPS. Localhost is exempt. If you're testing voice on a remote server, you must serve over HTTPS.

### CSP (Content Security Policy)

If your page has a strict `Content-Security-Policy`, the script embed needs:

```
script-src 'self' https://three.ws;
connect-src 'self' https://three.ws https://cdn.three.ws;
```

If you're embedding inside a sandboxed iframe, make sure the parent grants `allow-scripts allow-same-origin`. For sandboxed environments where the script embed won't work, use the iframe widget instead — it runs in its own browsing context and is unaffected by the parent CSP.

### Model doesn't appear

- Open the browser console. A CORS or 404 error will be logged with the URL.
- Confirm the file is valid GLB by dragging it into [the app](https://three.ws/) — it runs the full glTF-Validator.
- Very large or complex scenes may exceed mobile GPU limits. Test with a simpler model first.

---

## Next Steps

- [Embedding Guide](./embedding.md) — deep dive on attributes, events, and the JS API
- [Widget Types](./widgets.md) — full reference for iframe embeds and postMessage
- [Agent System](./agent-system.md) — how the brain, memory, and skills layers work
- [REST API](./api-reference.md) and [JavaScript API](./js-api.md) — backend and in-browser surfaces
- [SDK Reference](./sdk.md) — `@three-ws/sdk`, `@three-ws/agent-ui`, `@three-ws/avatar`, `@three-ws/solana-agent`
