# Widget Types

A widget is a saved, shareable 3D experience you can embed on any web page. Instead of wiring up a viewer from scratch, you pick a widget type, configure it in the no-code [Widget Studio](https://three.ws/studio), and paste one line of HTML wherever you want it to appear — a blog post, a product page, a Notion doc, a CMS.

Each widget bundles three things: an avatar or 3D model (a `.glb` file stored in the cloud), a **widget type** that controls the runtime behavior, and **brand config** (background color, accent, caption, camera position, environment). Change the config in Studio and every embed updates automatically.

```html
<!-- The simplest possible embed — drop this anywhere -->
<iframe
  src="https://three.ws/widget#widget=wdgt_abc123def456&kiosk=true"
  width="600"
  height="600"
  style="border:0;border-radius:12px"
  allow="autoplay; xr-spatial-tracking; clipboard-write"
  loading="lazy"
></iframe>
```

---

## The five widget types

| Type | Label | Best for | Default size | Status |
|------|-------|----------|--------------|--------|
| `turntable` | Turntable Showcase | Hero banners, product display | 600 × 600 | Ready |
| `animation-gallery` | Animation Gallery | Rigged avatar animation libraries | 720 × 720 | Ready |
| `talking-agent` | Talking Agent | Embodied chat on your site | 420 × 600 | Ready |
| `passport` | ERC-8004 Passport | On-chain agent identity cards | 480 × 560 | Ready |
| `hotspot-tour` | Hotspot Tour | Annotated 3D scenes with guided points of interest | 800 × 600 | Coming soon |

Every widget also inherits a set of **brand options** that apply to all types:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `background` | hex color | `#0a0a0a` | Canvas background color |
| `accent` | hex color | `#8b5cf6` | UI accent color (buttons, highlights) |
| `caption` | string (max 280 chars) | — | Overlay text displayed on the canvas |
| `showControls` | boolean | `true` | Show orbit/pan controls |
| `autoRotate` | boolean | `true` | Auto-rotate the model |
| `envPreset` | string | `neutral` | Environment map. One of: `none`, `neutral`, `venice-sunset`, `footprint-court` |
| `cameraPosition` | `[x, y, z]` or null | `null` | Override camera start position |

---

## 2.1 Turntable

**Use case:** Product display, portfolio hero, landing page feature section.

The Turntable widget auto-rotates a 3D model around its vertical axis, like a product on a display stand. There is no interactive UI — just the model, the environment, and an optional caption overlay. Visitors can click and drag to rotate manually; the auto-rotation pauses while they interact and resumes afterward.

This is the lightest widget to embed. It loads fast and looks great at any size from a 300px thumbnail to a full-bleed hero.

**Configuration:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `rotationSpeed` | number (0–10) | `0.5` | Auto-rotate speed. Higher = faster. |

All [brand options](#the-five-widget-types) apply (background, accent, caption, envPreset, cameraPosition).

**Embed example:**

```html
<iframe
  src="https://three.ws/widget#widget=wdgt_abc123def456&kiosk=true"
  width="600"
  height="600"
  style="border:0;border-radius:12px;max-width:100%"
  allow="autoplay; xr-spatial-tracking"
  loading="lazy"
></iframe>
```

**What it looks like:** A dark canvas with the 3D model centered and slowly rotating. No buttons or panels — just the model and the environment lighting. If a caption is set, it appears as a short text overlay beneath the model.

**Best for:** Marketing pages, product listings, app store previews, conference slide decks with embedded 3D.

---

## 2.2 Animation Gallery

**Use case:** Showcasing every animation clip in a rigged character GLB — letting visitors browse and preview motion without any coding.

The Animation Gallery widget reads all animation clips baked into the loaded GLB and presents them as a keyboard-navigable list panel. Clicking or pressing Enter on a clip name immediately plays that animation on the 3D avatar. The panel docks to the top-right on desktop and snaps to the bottom on narrow mobile viewports.

This is the go-to widget for animators and riggers who want to show off a character's full motion library: idle cycles, attack animations, emotes, locomotion states, facial expressions — whatever is in the file.

**Configuration:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultClip` | string | `''` | Name of the clip to autoplay on load. Falls back to the first clip if the name doesn't match. |
| `loopAll` | boolean | `false` | When `true`, clips play once then automatically advance to the next, wrapping back to the first. |
| `showClipPicker` | boolean | `true` | Show the clip list panel. Set to `false` to hide the UI and drive playback externally via `postMessage`. |

All brand options apply.

**Keyboard shortcuts:** Arrow keys or `j` / `k` to move up/down the list. `Home` / `End` to jump to first/last. `Enter` or `Space` to (re)play the highlighted clip.

**Driving playback from the parent page:**

```js
const iframe = document.querySelector('iframe');
iframe.contentWindow.postMessage(
  { type: 'widget:command', command: 'play_clip', args: { name: 'Wave' } },
  'https://three.ws/'
);
```

**What it looks like:** The 3D avatar fills the canvas (auto-rotating if `autoRotate` is on). In the top-right corner, a frosted-glass panel labeled "Clips (N)" lists every animation name. The active clip is highlighted with a purple left-border accent. On mobile, the panel slides to the bottom of the screen.

**Best for:** Animation portfolios, character demo reels, rigging showcases, game asset storefronts.

---

## 2.3 Talking Agent

**Use case:** An AI-powered 3D character embedded on your site — a customer support bot, product guide, or AI companion with a visible avatar.

The Talking Agent widget combines a 3D avatar with a live chat interface. The avatar uses the Empathy Layer — a continuous emotion blend system that animates facial expressions and head movement in response to what the agent is saying. Responses come from an LLM (Anthropic by default, or a custom proxy endpoint). Voice input and TTS output are supported where the browser allows.

This is the most configurable widget type. You can control the AI behavior (system prompt, temperature, turn limits), the avatar mode (full 3D embed or chat-only with no canvas), the chat panel position, available skills, and rate limits for visitor messages.

**Configuration:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentName` | string (max 80) | `''` | Display name shown in the chat header. |
| `agentTitle` | string (max 80) | `'AI Agent'` | Subtitle under the agent name. |
| `avatar` | `embedded` or `chat-only` | `embedded` | `embedded` shows the 3D canvas. `chat-only` renders text chat only. |
| `brainProvider` | `none`, `anthropic`, `custom` | `anthropic` | LLM backend. `none` disables AI responses. |
| `proxyURL` | HTTPS URL | `''` | Required when `brainProvider` is `custom`. Your endpoint handles the LLM call. |
| `systemPrompt` | string (max 4000) | `''` | System instructions for the LLM. |
| `greeting` | string (max 280) | `'Hi! Ask me anything.'` | First message the agent sends on load. |
| `temperature` | number (0–1) | `0.7` | LLM sampling temperature. |
| `maxTurns` | integer (1–100) | `20` | Maximum conversation turns before the chat resets. |
| `skills.speak` | boolean | `true` | Agent can speak responses aloud (TTS). |
| `skills.wave` | boolean | `true` | Agent can wave as a greeting gesture. |
| `skills.lookAt` | boolean | `true` | Agent can direct gaze toward the camera or model. |
| `skills.playClip` | boolean | `true` | Agent can trigger named animations on itself. |
| `skills.remember` | boolean | `false` | Agent can store and recall memories across sessions. |
| `showChatHistory` | boolean | `true` | Show previous messages in the chat panel. |
| `voiceInput` | boolean | `true` | Show microphone button for speech-to-text input. |
| `voiceOutput` | boolean | `true` | Read agent responses aloud via TTS. |
| `chatPosition` | `right`, `bottom`, `overlay` | `right` | Where the chat panel appears relative to the canvas. |
| `poweredByBadge` | boolean | `true` | Show "powered by 3dagent" attribution link. |
| `visitorRateLimit.msgsPerMinute` | integer (1–60) | `8` | Max messages a visitor can send per minute. |
| `visitorRateLimit.msgsPerSession` | integer (1–500) | `50` | Max messages per session before the chat locks. |

All brand options apply.

**Embed example (portrait, chat on the right):**

```html
<iframe
  src="https://three.ws/widget#widget=wdgt_abc123def456&kiosk=true"
  width="420"
  height="600"
  style="border:0;border-radius:16px"
  allow="autoplay; xr-spatial-tracking; microphone"
  loading="lazy"
></iframe>
```

**What it looks like:** The 3D avatar occupies the left portion of the embed (or the full canvas in `chat-only` mode). The chat panel appears on the right with a scrolling message history, a text input at the bottom, and an optional microphone button. The avatar animates reactively — nodding, expressing concern, or smiling — based on what it says.

**Note on iOS Safari:** The browser may require a user gesture before `speechSynthesis.getVoices()` returns voices. Voice output will work correctly after the first user interaction.

**Best for:** Customer support bots on product pages, AI companions in games or apps, interactive product configurators, onboarding guides.

---

## 2.4 ERC-8004 Passport

**Use case:** A read-only on-chain identity card for any agent registered in the ERC-8004 IdentityRegistry — think of it as an NFT trading card for AI agents.

The Passport widget resolves an agent's on-chain identity by reading from the ERC-8004 IdentityRegistry smart contract deployed on any supported chain. It displays the agent's name, owning wallet address (truncated, copyable), chain, reputation score, recent feedback from the ReputationRegistry, and a link to the agent's registration JSON. The 3D avatar rotates in the background behind the card UI.

No wallet connection is required — the widget is purely read-only. Data is cached in localStorage for 24 hours with automatic refresh based on `refreshIntervalSec`.

**Supported chains:**

| Slug | Chain ID | Network |
|------|----------|---------|
| `ethereum` | 1 | Ethereum Mainnet |
| `base` | 8453 | Base |
| `optimism` | 10 | Optimism |
| `arbitrum` | 42161 | Arbitrum One |
| `polygon` | 137 | Polygon |
| `base-sepolia` | 84532 | Base Sepolia (testnet, default) |
| `sepolia` | 11155111 | Ethereum Sepolia |

**Configuration:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentId` | string (uint256) | required | The token ID of the registered agent. Must be a numeric string, e.g. `"42"`. |
| `chain` | string | `'base-sepolia'` | Chain slug (see table above) or numeric chain ID as a string. |
| `rpcURL` | HTTPS URL | — | Override the public RPC endpoint. Must be HTTPS. |
| `layout` | `portrait`, `landscape`, or `badge` | `portrait` | Card layout. `badge` is a minimal single-line chip. |
| `badgeSize` | `small`, `medium`, or `large` | `medium` | Size of the badge variant. |
| `rotationSpeed` | number (0–10) | `0.6` | Speed of the background avatar rotation. |
| `showReputation` | boolean | `true` | Show the average reputation score and review count. |
| `showRecentFeedback` | boolean | `true` | Show the last 5 feedback comments from the ReputationRegistry. |
| `showValidation` | boolean | `false` | Show validation proof row (ValidationRegistry). |
| `showRegistrationJSON` | boolean | `true` | Show a "View passport JSON ↗" link to the agent's tokenURI. |
| `refreshIntervalSec` | integer (0–3600) | `60` | How often to re-read from the chain. `0` disables polling. |
| `showPoweredBy` | boolean | `true` | Show "3dagent" attribution link. |

All brand options apply.

**Embed example:**

```html
<iframe
  src="https://three.ws/widget#widget=wdgt_abc123def456&kiosk=true"
  width="480"
  height="560"
  style="border:0;border-radius:16px"
  allow="autoplay; xr-spatial-tracking; clipboard-write"
  loading="lazy"
></iframe>
```

**What it looks like:** A dark card overlaid on the rotating avatar. At the top: the agent's name and a green ✓ badge confirming on-chain registration. Below: the numeric agent ID and chain name, the owning wallet address (click to copy), and a star rating with review count. Recent feedback comments appear as a small list. A "View passport JSON ↗" link opens the raw registration data.

**Using a custom RPC:** If your embed is on a site with strict CSP, or you want to avoid rate limits on public RPC endpoints, configure `rpcURL` with your own HTTPS endpoint. Non-HTTPS URLs are rejected.

**Best for:** NFT project pages, DAO governance dashboards, agent marketplaces, developer portfolios with on-chain credentials.

---

## 2.5 Hotspot Tour *(coming soon)*

**Use case:** A guided tour of a 3D scene with annotated click targets — architecture walkthroughs, product feature tours, museum exhibit navigation.

The Hotspot Tour widget is currently in development. It saves its configuration and renders a "coming soon" placeholder when embedded. Configuring it now ensures you'll be first in line when the runtime ships.

**What it will do:**
- Display numbered hotspot pins at configured positions in the 3D scene
- Animate the camera smoothly to a preset viewpoint when a hotspot is clicked
- Show an overlay card with title and description for each hotspot
- Support sequential "Next / Prev" navigation
- Emit `widget:hotspot:open` postMessage events to the parent page

**Configuration (saved now, active on launch):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `hotspots` | array (max 40) | `[]` | Array of hotspot objects (see schema below). |

**Hotspot object schema:**

```json
{
  "id": "lobby",
  "label": "Main Lobby",
  "position": [0, 0.5, 2],
  "body": "The main entrance. Check in here to receive your visitor badge."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string (max 40) | yes | Unique identifier for this hotspot. |
| `label` | string (max 120) | yes | Name shown on the pin and overlay card. |
| `position` | `[x, y, z]` | yes | World-space position for the pin in the scene. |
| `body` | string (max 2000) | no | Description text shown in the overlay card. |

All brand options apply.

**Best for:** Architecture visualizations, virtual showrooms, museum-style exhibits, product feature walkthroughs, educational 3D content.

---

## Widget Studio (no-code builder)

The fastest way to create a widget is [Widget Studio](https://three.ws/studio):

1. Sign in at [three.ws](https://three.ws/).
2. Open [Studio](https://three.ws/studio).
3. Upload a `.glb` file or paste a public URL to an existing model.
4. Select a widget type from the five options.
5. Use the form to configure brand options and type-specific settings.
6. Preview the result live in the Studio canvas.
7. Click **Generate Embed** to get your snippet.

The Studio sends live `widget:config` postMessages to the preview iframe as you change settings, so you see every color, speed, and layout change instantly without a page reload.

---

## Getting an embed snippet

After creating a widget, copy the iframe snippet from Studio or construct it manually using the widget ID (format: `wdgt_` + 12 characters):

```html
<!-- iframe embed (recommended) -->
<iframe
  src="https://three.ws/widget#widget=wdgt_abc123def456&kiosk=true"
  width="600"
  height="600"
  style="border:0;border-radius:12px;max-width:100%"
  allow="autoplay; xr-spatial-tracking; clipboard-write"
  loading="lazy"
></iframe>

<!-- Script embed (auto-sizes, no iframe overhead) -->
<script async src="https://three.ws/embed.js" data-widget="wdgt_abc123def456"></script>
```

The **script embed** injects a sandboxed iframe at the script tag's location and handles auto-resize. Use it when you want the widget to grow and shrink with its container. Use a raw **iframe** when you need full control over dimensions.

**Size guidance by type:**

| Type | Recommended size | Notes |
|------|-----------------|-------|
| Turntable | 1:1 or 4:3 | Give the model room to breathe. |
| Animation Gallery | 1:1 or wider | Picker needs horizontal space on desktop. |
| Talking Agent | 7:10 portrait | Chat history needs vertical room. |
| Passport | 360 × 480 minimum | Portrait layout fits most card-sized slots. |
| Hotspot Tour | 4:3 or wider | Landscape gives the scene more canvas. |

**Hash parameters** you can append to the embed URL:

| Parameter | Type | Description |
|-----------|------|-------------|
| `kiosk` | boolean | Hide header chrome for clean embeds. Always set this to `true` in iframes. |
| `preset` | string | Override the environment map preset (`neutral`, `venice-sunset`, `footprint-court`). |
| `cameraPosition` | `x,y,z` | Comma-separated camera position override. |

---

## Publishing widgets

Widgets have a visibility setting controlled by the `is_public` flag:

- **Private** (`is_public: false`) — only accessible by the creator. Embed links still work for the signed-in owner but won't appear in public listings.
- **Public** (`is_public: true`) — accessible by anyone with the embed URL and listed in the [widget gallery](https://three.ws/widgets).

Set visibility in Widget Studio using the toggle before saving, or update it at any time via the Widget API.

---

## oEmbed support

All public widgets support [oEmbed](https://oembed.com), which enables automatic rich previews in Notion, Ghost, Substack, WordPress, Discord, and other platforms that follow the oEmbed spec.

**To use oEmbed in a supported CMS:** paste a share URL (`https://three.ws/w/<id>`) on its own line. The editor detects the oEmbed endpoint automatically and replaces the URL with a live embed.

**To query oEmbed manually:**

```
GET https://three.ws/api/widgets/oembed?url=https://three.ws/w/wdgt_abc123def456&format=json
```

Response:

```json
{
  "type": "rich",
  "version": "1.0",
  "provider_name": "three.ws",
  "provider_url": "https://three.ws/",
  "title": "My Widget",
  "html": "<iframe …></iframe>",
  "width": 600,
  "height": 600,
  "thumbnail_url": "https://three.ws/api/widgets/wdgt_abc123def456/og",
  "thumbnail_width": 1200,
  "thumbnail_height": 630
}
```

The `/w/<id>`, `/widget#widget=<id>`, and legacy `/app#widget=<id>` URL forms are all accepted. Use `maxwidth` and `maxheight` query params to clamp the returned iframe dimensions.

---

## Widget API

Widgets have a full REST CRUD API. All write endpoints require authentication (session cookie or bearer token with `avatars:write` scope).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/widgets` | List the current user's widgets. |
| `POST` | `/api/widgets` | Create a new widget. |
| `GET` | `/api/widgets/:id` | Get a single widget (public or owned). |
| `PATCH` | `/api/widgets/:id` | Update name, config, or visibility. |
| `DELETE` | `/api/widgets/:id` | Soft-delete a widget. |

**Create a widget:**

```bash
curl -X POST https://three.ws/api/widgets \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "turntable",
    "name": "Product Hero",
    "avatar_id": "a1b2c3d4-...",
    "config": { "rotationSpeed": 0.8, "background": "#111111" },
    "is_public": true
  }'
```

The `config` object is validated against the type's schema (see [widget-types.js](../src/widget-types.js)). Invalid fields return `400 validation_error`.

**Widget share URL:** Every widget has a canonical share URL at `https://three.ws/w/<id>`. This URL is server-rendered with Open Graph metadata and a 1200×630 preview image, making it safe to post in Slack, Discord, X, or any link-preview-aware surface.

For the full API reference including request/response shapes, error codes, and pagination, see [api-reference.md](./api-reference.md).

---

## postMessage API

Widgets communicate with the embedding page using `window.postMessage`. Always verify the origin before trusting any incoming message.

**Events from the iframe to your page:**

```js
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://three.ws/') return;

  switch (e.data?.type) {
    case 'widget:ready':
      // { id, type } — widget runtime has booted
      break;
    case 'widget:load':
      // { id, model_url } — GLB loaded successfully
      break;
    case 'widget:load:error':
      // { id, error } — GLB or config failed to load
      break;
    case 'widget:chat:message':
      // { role, content } — talking-agent only: a new chat turn
      break;
    case 'widget:hotspot:open':
      // { id, label } — hotspot-tour only: visitor opened a POI
      break;
  }
});
```

**Commands from your page to the iframe:**

```js
const iframe = document.querySelector('iframe');

// Live-update brand config (same options as the config object above)
iframe.contentWindow.postMessage(
  { type: 'widget:config', config: { background: '#ff00aa', accent: '#ffffff' } },
  'https://three.ws/'
);

// Trigger a runtime action (animation-gallery and talking-agent)
iframe.contentWindow.postMessage(
  { type: 'widget:command', command: 'play_clip', args: { name: 'Wave' } },
  'https://three.ws/'
);
```

---

## CSP and CORS

If your site uses a Content Security Policy, add these directives:

```
frame-src https://three.ws/;
img-src https://three.ws/ data:;
```

The required `allow` attributes for the iframe are:

| Attribute | Required by |
|-----------|-------------|
| `autoplay` | All widgets (ambient animations) |
| `xr-spatial-tracking` | Future WebXR support |
| `clipboard-write` | Passport widget (copy wallet address) |
| `microphone` | Talking Agent with `voiceInput: true` |

---

## Privacy

Each widget load records one minimal analytics event:

| Field | Value |
|-------|-------|
| `widget_id` | The widget being loaded |
| `type` | Widget type |
| `country` | Country from the Vercel edge header |
| `referer_host` | Hostname of the embedding page (no path, no query string) |
| `created_at` | Timestamp |

No IP addresses, no user-agent strings, no cookies, no chat message content. The widget owner can see aggregated view counts in their [Dashboard](https://three.ws/dashboard).

---

## Programmatic control

Need to drive a widget from the parent page — change the camera, play an animation, grab a screenshot? See the [Widget API (JSON-RPC)](./widget-api.md) reference. The `ThreeWidget` SDK lives at `/widget-client.js` and works with any iframe pointing at `/widget`.
