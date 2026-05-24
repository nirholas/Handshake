# Embedding Guide

> **Audience:** Developers and no-code builders who want to add a three.ws to a website, app, or platform.

---

## Choosing your method

| Method | Complexity | Control | Best for |
|--------|-----------|---------|---------|
| [Web component](#web-component) | Low | Full JS API, CSS, events | Your own site; any modern framework |
| [iframe embed](#iframe-embed) | Very low | Limited (postMessage) | Third-party pages, CMS platforms, sandboxed contexts |
| [oEmbed (paste URL)](#oembed) | None | None | Notion, Ghost, Substack, WordPress |
| [Claude Artifact](#claude-artifact) | None | None | AI-generated interactive demos in Claude.ai |

If you control the page, use the web component. If you're pasting into a CMS or embedding in a third-party context, use the iframe. If you just want to share a link and let the platform render it, paste the widget URL and let oEmbed do the rest.

---

## Web component

The `<agent-3d>` custom element is the recommended approach for any page where you can load external scripts.

### Basic setup

```html
<!-- 1. Load the library (pinned version + SRI) -->
<script
  type="module"
  src="https://three.ws/agent-3d/1.5.1/agent-3d.js"
  integrity="sha384-…"
  crossorigin="anonymous"
></script>

<!-- 2. Place the element -->
<agent-3d
  src="agent://base/42"
  style="width: 400px; height: 500px; display: block;"
></agent-3d>
```

That's the full install for most use cases. Everything else is optional.

### Source attributes

The element accepts several ways to point at an agent — pick one:

| Attribute | Example | Notes |
|-----------|---------|-------|
| `src` | `agent://base/42` | On-chain URI — the canonical form |
| `agent-id` + `chain-id` | `agent-id="42" chain-id="8453"` | Numeric token ID + chain ID |
| `agent-id` (CAIP-10) | `agent-id="eip155:8453:0xReg…:42"` | Fully qualified on-chain reference |
| `agent-id` (backend) | `agent-id="a_abc123"` | Legacy backend account ID |
| `manifest` | `ipfs://bafy.../manifest.json` | IPFS or HTTPS manifest URL |
| `body` | `./avatar.glb` | Bare GLB for ad-hoc (vieweronly, no persona) |

When multiple are set, priority is `src` > `agent-id` > `manifest` > `body`.

### Sizing

The element has no intrinsic size — it fills its CSS `width` and `height`. Always set both or the element will collapse to zero.

```css
/* Fixed size */
agent-3d {
  width: 400px;
  height: 500px;
}

/* Responsive full-width */
agent-3d {
  width: 100%;
  height: 60vh;
}

/* 4:5 aspect ratio wrapper */
.agent-wrapper {
  position: relative;
  padding-top: 125%;
}
agent-3d {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
```

### Layout modes

All four modes run the same agent — only the layout differs.

**`inline`** (default) — flows with the document.

```html
<agent-3d src="agent://base/42" style="width: 100%; height: 480px"></agent-3d>
```

**`floating`** — fixed-position bubble; does not affect document flow. Includes minimize-to-pill and expand-to-fullscreen controls.

```html
<agent-3d
  src="agent://base/42"
  mode="floating"
  position="bottom-right"
  offset="24px 24px"
  width="320px"
  height="420px"
></agent-3d>
```

`position` accepts: `bottom-right` (default), `bottom-left`, `top-right`, `top-left`, `bottom-center`.

**`section`** — fills a parent container with aspect-ratio preservation. Ideal for hero sections.

```html
<section class="hero">
  <agent-3d src="..." mode="section"></agent-3d>
</section>
```

**`fullscreen`** — takes over the viewport with a close button. Trigger it programmatically.

```html
<button onclick="document.querySelector('agent-3d').openFullscreen()">Meet the agent</button>
<agent-3d src="..." mode="fullscreen"></agent-3d>
```

### Theming with CSS custom properties

All chrome lives inside the element's shadow DOM. The host page's CSS cannot leak in except through these custom properties:

```css
agent-3d {
  --agent-bubble-radius: 16px;
  --agent-accent: #3b82f6;
  --agent-surface: rgba(17, 24, 39, 0.9);
  --agent-on-surface: #f9fafb;
  --agent-chat-font: system-ui, sans-serif;
  --agent-mic-glow: #22c55e;
  --agent-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}
```

### Slots

Override specific UI regions with your own content:

```html
<agent-3d src="agent://base/42">
  <!-- Shown while model loads -->
  <div slot="poster">
    <img src="./leo.webp" alt="Coach Leo" />
  </div>

  <!-- Shown if loading fails -->
  <div slot="error">Couldn't reach the agent. Try again?</div>

  <!-- Custom AR button -->
  <button slot="ar-button">View in your space</button>
</agent-3d>
```

### JavaScript API

```js
const el = document.querySelector('agent-3d');

// Conversation
await el.say('Hello!');
const reply = await el.ask('What can you help me with?');
el.clearConversation();

// Animations
await el.wave({ style: 'enthusiastic' });
await el.lookAt('user');
await el.play('clip-name');

// Skills
await el.installSkill('ipfs://bafy.../dance/');
el.uninstallSkill('dance');

// Layout
el.setMode('floating');
el.setPosition('bottom-right', '24px 24px');
el.setSize('320px', '420px');

// Lifecycle
el.pause();
el.resume();
el.destroy();
```

### Events

All events bubble with `composed: true` (they cross shadow DOM boundaries).

```js
const el = document.querySelector('agent-3d');

el.addEventListener('agent:ready', e => {
  console.log('Agent loaded:', e.detail.agent);
});

el.addEventListener('brain:message', e => {
  console.log(`${e.detail.role}: ${e.detail.content}`);
});

el.addEventListener('voice:speech-start', e => {
  console.log('Agent speaking:', e.detail.text);
});
```

Key events: `agent:ready`, `agent:load-progress`, `agent:error`, `brain:message`, `brain:thinking`, `voice:speech-start`, `voice:speech-end`, `voice:transcript`, `skill:loaded`, `skill:tool-called`, `memory:write`, `chain:resolved`.

### Performance and lazy loading

The element boots only when scrolled into the viewport (IntersectionObserver). Elements below the fold do not start their GL context until needed. Add `eager` to bypass this:

```html
<agent-3d src="..." eager></agent-3d>
```

The RAF loop pauses when the element is fully off-screen and resumes on re-entry. The mic and LLM stream also suspend when the tab is hidden.

### CDN channels

| URL | Cache | Use when |
|-----|-------|---------|
| `/agent-3d/1.5.1/agent-3d.js` | immutable | **Production** — pin exact bytes |
| `/agent-3d/1.5/agent-3d.js` | 5 min | Follow patch releases automatically |
| `/agent-3d/1/agent-3d.js` | 5 min | Follow minor + patch releases |
| `/agent-3d/latest/agent-3d.js` | 5 min | Demos and prototypes only |

The current SRI hash for each release is at `/agent-3d/<version>/integrity.json`. A UMD build (`agent-3d.umd.cjs`) is available at the same paths for non-ESM environments.

---

## iframe embed

For third-party pages, CMS platforms with strict CSP, or any context where you cannot load external scripts.

### Basic iframe

```html
<iframe
  src="https://three.ws/agent/{agent-id}/embed"
  width="400"
  height="500"
  frameborder="0"
  allow="camera; microphone; xr-spatial-tracking"
  title="three.ws"
></iframe>
```

The `allow` attribute controls browser feature access:
- `camera` — required for AR mode
- `microphone` — required for voice input
- `xr-spatial-tracking` — required for WebXR AR

### Embed URL formats

| Content | URL |
|---------|-----|
| Backend agent | `/agent/{agent-id}/embed` or `/agent-embed.html?id={agent-id}` |
| On-chain agent | `/a/{chainId}/{agentId}/embed` |
| Widget (kiosk) | `/widget#widget={widget-id}&kiosk=true` (slim shell, recommended) or `/app#widget={widget-id}&kiosk=true` (legacy) |
| Model viewer only | `/#model={glb-url}` |

### postMessage protocol

The embed and host page communicate via `window.postMessage`. All messages carry an `agentId` so a host with multiple iframes can route deterministically.

**Host → iframe:**

```js
const iframe = document.getElementById('my-agent-iframe');
const agentId = 'a_abc123'; // must match the id in the iframe src

// Handshake — send once after iframe load
iframe.contentWindow.postMessage(
  { type: 'agent:hello', agentId },
  'https://three.ws/'
);

// Trigger an action
iframe.contentWindow.postMessage(
  { type: 'agent:action', agentId, action: { type: 'speak', text: 'Hello!' } },
  'https://three.ws/'
);

// Liveness probe
iframe.contentWindow.postMessage(
  { type: 'agent:ping', agentId, id: 'probe_1' },
  'https://three.ws/'
);
```

**Iframe → host:**

```js
window.addEventListener('message', e => {
  // Always verify origin before trusting the message
  if (e.origin !== 'https://three.ws/') return;

  const { type, agentId } = e.data;

  switch (type) {
    case 'agent:ready':
      console.log('Agent loaded:', e.data.name, 'capabilities:', e.data.capabilities);
      break;
    case 'agent:action':
      // Mirror of every action emitted inside the iframe
      console.log('Agent emitted:', e.data.action);
      break;
    case 'agent:resize':
      // Preferred iframe height in CSS pixels
      iframe.style.height = e.data.height + 'px';
      break;
    case 'agent:pong':
      console.log('Pong received for probe:', e.data.id);
      break;
    case 'agent:blocked':
      console.warn('Embed policy denied this host for agent:', agentId);
      break;
  }
});
```

The `agent:ready` message is sent once on init and again in response to any `agent:hello` you send.

### Structured host protocol (Claude.ai / LobeHub)

Platforms like Claude.ai and LobeHub use the versioned `EMBED_HOST_PROTOCOL` envelope for richer bidirectional communication:

```json
{ "v": 1, "type": "<direction>.<category>", "id": "<optional>", "payload": { ... } }
```

Direction is `host.*` (platform → embed) or `embed.*` (embed → platform). Key types:

| Type | Direction | Purpose |
|------|-----------|---------|
| `host.hello` | host → embed | Introduce the host (name, version, userId) |
| `host.chat.message` | host → embed | Deliver a user or assistant turn |
| `host.action` | host → embed | Trigger `speak`, `emote.wave`, etc. |
| `host.theme` | host → embed | Switch `dark` / `light` |
| `embed.ready` | embed → host | Agent is live; reports capabilities |
| `embed.event` | embed → host | Lifecycle events (`agent.speaking`, `agent.idle`) |
| `embed.request` | embed → host | Ask host for data; host replies with `host.response` |

Unknown message types must be silently ignored on both sides. Messages missing `v: 1` or `type` are malformed and must be discarded.

---

## Embed policy

By default, any origin can embed any agent. To restrict which domains can embed yours, set an `embedPolicy` in the agent's on-chain manifest metadata:

```json
{
  "embedPolicy": {
    "mode": "allowlist",
    "hosts": [
      "yourwebsite.com",
      "*.yourwebsite.com"
    ]
  }
}
```

| Mode | Behaviour |
|------|-----------|
| `open` (default) | Embeds from any origin are allowed |
| `allowlist` | Only listed hosts can embed |
| `denylist` | All hosts can embed except listed ones |

Wildcard patterns (`*.example.com`) match all subdomains. When the iframe is blocked, it posts `{ type: 'agent:blocked', agentId }` to the parent and shows a link to open the agent directly on `three.ws`.

You can also configure embed policy via Dashboard → Agent Settings → Embed Policy, or via `PUT /api/agents/{id}/embed-policy`.

---

## oEmbed

Many platforms support oEmbed — paste a URL and the platform auto-fetches a rich preview. No code required.

Supported platforms include: Notion, Substack, Ghost, WordPress, Medium, and any platform that implements the oEmbed spec.

### Steps

1. Publish your widget — make it public in Widget Studio.
2. Get the widget's public URL: `https://three.ws/w/{widget-id}`
3. Paste the URL directly into Notion, Substack, etc.
4. The platform fetches the oEmbed endpoint and renders a sandboxed iframe.

### oEmbed endpoint

```
GET https://three.ws/api/widgets/oembed?url={widget-url}
```

Optional parameters: `format=json|xml`, `maxwidth`, `maxheight`.

Returns a `type: rich` payload with an iframe HTML snippet. The iframe is sandboxed with `allow-scripts allow-same-origin allow-popups allow-forms`.

### oEmbed discovery

Widget pages include the oEmbed discovery link tag, so platforms that scan `<head>` find the endpoint automatically:

```html
<link rel="alternate" type="application/json+oembed"
  href="https://three.ws/api/widgets/oembed?url=https://three.ws/w/{id}"
  title="Widget name" />
```

---

## Claude Artifact

three.ws can be embedded inside Claude.ai artifacts for AI-generated interactive 3D demos.

### Using the artifact API

The simplest approach is the hosted artifact endpoint, which returns a complete self-contained HTML document:

```
GET https://three.ws/api/artifact?agent={agent-id}
```

| Parameter | Required | Notes |
|-----------|----------|-------|
| `agent` | one of | Agent ID from your dashboard |
| `model` | one of | HTTPS URL to a GLB file (viewer-only, no persona) |
| `theme` | no | `dark` (default) or `light` |
| `idle` | no | Animation clip name to play on idle |
| `bg` | no | Background hex color (without `#`) |

Exactly one of `agent` or `model` must be provided.

You can reference this URL in an artifact's iframe `src`, or tell Claude to use it when generating an artifact.

### Using the artifact bundle directly

For custom artifact HTML where you want to control the container:

```html
<!-- In a Claude artifact -->
<script src="https://three.ws/dist-lib/agent-3d.umd.cjs"></script>

<div id="agent3d" data-agent-id="your-agent-id"
     style="width: 100%; height: 400px;"></div>

<script src="https://three.ws/src/artifact/entry.js"></script>
```

Or configure via JSON:

```html
<script type="application/json" id="agent3d-config">
{
  "agentId": "your-agent-id",
  "origin": "https://three.ws/"
}
</script>
```

The artifact bundle loads three.js from CDN (`esm.sh`) since Claude artifact sandboxes allow that origin.

### Permissions in artifacts

By default, artifacts run in `permissions="readonly"` mode — delegation status is displayed but redemptions are never initiated. If a skill needs to transact, the artifact HTML must include a `permissions-bearer` token provisioned by the agent owner:

```html
<agent-3d
  src="agent://base/42"
  permissions="relayer"
  permissions-bearer="sk_perm_abc123"
></agent-3d>
```

`permissions="interactive"` (wallet popup) is not supported inside Claude artifact iframes — if set, the embed falls back to `readonly`.

---

## Framework integration

### React

Web components work natively in React, but you need to load the library script and listen to custom events correctly:

```jsx
import { useEffect, useRef } from 'react';

export function AgentEmbed({ agentId }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    const handleReady = e => console.log('Agent ready:', e.detail.agent);
    const handleMessage = e => console.log('Agent said:', e.detail.content);

    el.addEventListener('agent:ready', handleReady);
    el.addEventListener('brain:message', handleMessage);
    return () => {
      el.removeEventListener('agent:ready', handleReady);
      el.removeEventListener('brain:message', handleMessage);
    };
  }, []);

  return (
    <agent-3d
      ref={ref}
      src={`agent://base/${agentId}`}
      style={{ width: '400px', height: '500px', display: 'block' }}
    />
  );
}
```

Load the library script once in your app's `index.html` or root layout:

```html
<script type="module"
  src="https://three.ws/agent-3d/1.5.1/agent-3d.js"
  crossorigin="anonymous">
</script>
```

### Next.js

The web component requires browser APIs and cannot run during server-side rendering. Use `dynamic` with `ssr: false`:

```jsx
// components/AgentEmbed.jsx — the actual component
export function AgentEmbed({ agentId }) {
  return (
    <agent-3d
      src={`agent://base/${agentId}`}
      style={{ width: '400px', height: '500px', display: 'block' }}
    />
  );
}
```

```jsx
// In the page that uses it
import dynamic from 'next/dynamic';

const AgentEmbed = dynamic(
  () => import('../components/AgentEmbed').then(m => m.AgentEmbed),
  { ssr: false }
);
```

Also add the script tag to `pages/_document.js` or your root layout:

```jsx
<Script
  src="https://three.ws/agent-3d/1.5.1/agent-3d.js"
  type="module"
  strategy="beforeInteractive"
/>
```

### Webflow

Use an **Embed** block with the iframe method — Webflow's custom code can load the web component script in Page Settings → Custom Code → `<head>`:

```html
<script type="module"
  src="https://three.ws/agent-3d/1.5.1/agent-3d.js">
</script>
```

Then add an HTML Embed element anywhere on the page:

```html
<agent-3d src="agent://base/42" style="width:100%;height:500px"></agent-3d>
```

### Squarespace

Add the script tag via Settings → Advanced → Code Injection → Header. Place the element in a Code block on any page.

### Framer

Framer supports custom code components — wrap `<agent-3d>` in a code component using the web component approach. Mark it as client-only since Framer also SSRs.

### Shopify

Add the script tag to `theme.liquid` inside `<head>`, then use `<agent-3d>` directly in product page templates or section files.

---

## Performance tips

**One embed per page:** Each `<agent-3d>` element owns a WebGL context. Most browsers cap total contexts at 8–16. If you have multiple embeds on one page, consider using `<agent-stage>` to share a single context, or use iframes (which each have their own context budget).

**Static display (no chat):** Add `kiosk` to hide all UI chrome — chat input, controls, validator overlay. Faster initial render.

```html
<agent-3d src="agent://base/42" kiosk auto-rotate></agent-3d>
```

**Viewer-only (no LLM):** Add `brain="none"` to prevent the LLM client from loading. Use this for pure 3D display embeds.

**Auto-rotate:** Only enable `auto-rotate` for turntable-style static displays. It runs a continuous animation loop and keeps the GPU active.

**Lazy loading:** The element is lazy by default (IntersectionObserver). Don't add `eager` unless the agent needs to be ready before it's visible (e.g., audio that should preload).

---

## Accessibility

**iframes:** Always include a `title` attribute.

```html
<iframe src="..." title="Coach Leo, your fitness guide"></iframe>
```

**Web component:** The canvas has an `aria-label` synthesized from the manifest's `name` and `description`. Override it with `aria-label` on the element itself. The chat surface is a real `<dialog>` with focus trapping; all buttons are keyboard-reachable.

**Reduced motion:** The element respects `prefers-reduced-motion` — floating mode transitions are disabled. For `auto-rotate`, disable it yourself when the user prefers reduced motion:

```js
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const el = document.querySelector('agent-3d');
if (prefersReduced) el.setAttribute('auto-rotate', 'false');
```

**Screen readers:** The 3D canvas is not screen-reader navigable. Provide fallback content for accessibility-sensitive contexts using the progressive enhancement pattern — any children of `<agent-3d>` are shown if JavaScript is unavailable:

```html
<agent-3d src="agent://base/42">
  <img src="./leo-poster.webp" alt="Coach Leo (three.ws, requires JavaScript)" />
</agent-3d>
```

---

## Analytics

The platform records anonymous embed impressions (country, referrer hostname) via `POST /api/widgets/{id}/stats`. No PII is collected — no IP addresses, no cookies, no user IDs. To opt out entirely, self-host the bundle.

---

## See also

- [Architecture Overview](architecture.md)
- [Agent System Overview](agent-system.md)
- [Web Component reference](web-component.md) — full attribute list
- [Widgets](widgets.md) — Widget Studio and widget types
- [specs/EMBED_SPEC.md](../../specs/EMBED_SPEC.md) — authoritative web component spec
- [specs/EMBED_HOST_PROTOCOL.md](../../specs/EMBED_HOST_PROTOCOL.md) — versioned postMessage protocol
