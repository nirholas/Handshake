# @three-ws/concierge

An AI concierge for any website, with a face.

One tag adds a floating chat widget where a **rigged 3D avatar** blinks, idles, and **lipsyncs** while it answers visitors. Answers **stream** in over SSE, are **grounded in the live page** (no crawler, no vector DB, no setup), and speak aloud with browser-native TTS. Push-to-talk voice input included where the browser supports it.

Live demo: [three.ws/concierge](https://three.ws/concierge) (the widget on that page is this package answering questions about itself).

- Docs: [three.ws/docs/concierge](https://three.ws/docs/concierge)
- Tutorial (how it is built): [three.ws/docs/tutorials/build-a-site-concierge](https://three.ws/docs/tutorials/build-a-site-concierge)
- Examples: [examples/](./examples), one-tag, web component, imperative, custom avatar, React, self-hosted backend
- Use it from an AI agent: [`@three-ws/concierge-mcp`](https://www.npmjs.com/package/@three-ws/concierge-mcp) (Model Context Protocol server)
- Sibling packages: [`@three-ws/walk`](https://www.npmjs.com/package/@three-ws/walk) (walking page companion), [`@three-ws/page-agent`](https://www.npmjs.com/package/@three-ws/page-agent) (narrating page guide), [`@three-ws/tour`](https://www.npmjs.com/package/@three-ws/tour) (guided site tours)
- Want a guided **tour** *and* live support Q&A on one site? Run this alongside `@three-ws/tour` and hand off from the tour's completion CTA to `concierge.open()`. See the tour README's "Tour + support Q&A on one site" section and its `examples/shopify-tour-plus-concierge.html`.

## Install

### 1. One tag (no build, no account)

```html
<script type="module"
        src="https://three.ws/concierge/concierge.global.js"
        data-concierge
        data-site-name="Acme"
        data-accent="#f97316"
        data-suggestions="What is Acme?|What does it cost?"></script>
```

Also served from npm CDNs after install: `https://unpkg.com/@three-ws/concierge/dist/concierge.global.js`.

### 2. npm

```bash
npm install @three-ws/concierge three
```

`three` is a peer dependency for the module build; the `.global.js` build inlines it.

### 3. Web component

```html
<script type="module">import '@three-ws/concierge';</script>

<three-concierge
    site-name="Acme"
    accent="#f97316"
    knowledge="Pro plan is $20/month. Support: help@acme.com."
    suggestions="What is Acme?|What does it cost?">
</three-concierge>
```

### 4. Imperative

```js
import { Concierge } from '@three-ws/concierge';

const concierge = new Concierge({
	siteName: 'Acme',
	accent: '#f97316',
	knowledge: FAQ_TEXT,
	persona: 'warm, playful, concise',
});

concierge.on('message', ({ role, content }) => analytics.track('concierge', { role }));
await concierge.ask('What does the Pro plan cost?');
```

## How answers stay accurate

There is no crawler and no index to keep fresh. At **ask-time** the widget snapshots the live DOM (title, meta description, headings, nav labels, main content, all capped) and merges in your curated `knowledge` string. The backend builds a grounded system prompt from that snapshot and instructs the model to refuse to invent anything it cannot see. Whatever your page says today is what the concierge knows today.

Add `data-concierge-ignore` to any element you never want harvested.

## Shopping mode (Shopify)

On a Shopify store the concierge becomes a full shopping assistant: it reads your **live catalog** and helps visitors find the right product, compare options, and check shipping and returns, then shows real **product cards** (image, live price, link, add-to-cart) for what it recommends.

There is still no crawler, no index, and no product feed to maintain. Shopify serves every storefront's catalog and policies as public endpoints, and the widget reads them at ask-time:

- `GET /products.json` — the live catalog (variants, prices, images, tags, type)
- `GET /collections.json` — the collections
- `GET /policies/shipping-policy`, `/policies/refund-policy`, … — shipping/returns/privacy/terms

It fetches these once (same-origin on the store, so no CORS wall), caches them for the session, then for each question runs a small keyword retrieval to pick the handful of products the shopper actually asked about. Only that handful plus a compact store summary is sent to the answer endpoint, and the cards are rendered from that same set, so **prices and links are always real, never model-invented**. No embeddings service, no vector DB.

**Install** is the same one tag, dropped into `theme.liquid` before `</body>`:

```html
<script type="module"
        src="https://three.ws/concierge/concierge.global.js"
        data-concierge
        data-site-name="Larkspur Supply"
        data-avatar="nova"
        data-accent="#3f7d5b"></script>
```

Shopping mode turns on automatically because the widget detects the Shopify storefront (`window.Shopify`). Force it, target a specific store, or set the currency with `data-shopping="true"`, `data-shop="your-store.myshopify.com"`, and `data-currency="GBP"`.

**Add-to-cart** works when the widget runs on the store itself: the button posts to Shopify's public `/cart/add.js` and fires a `cart:refresh` event so themes update their cart count. Off-store, cards show a **View** link to the product page.

Handles price intent too (`"a gift under $75"`, `"cheapest hoodie"`, `"anything on sale?"`) and grounds shipping/returns answers in your published policies. See [`examples/shopify.html`](./examples/shopify.html) and the tutorial: [three.ws/docs/tutorials/shopify-shopping-assistant](https://three.ws/docs/tutorials/shopify-shopping-assistant).

## Options

Constructor config / element attributes / `data-*` script attributes are the same set:

| Config (`camelCase`) | Attribute (`kebab-case`) | Default | What it does |
| --- | --- | --- | --- |
| `endpoint` | `endpoint` | `https://three.ws/api/concierge` | Answer API. Any server speaking the same wire format works. |
| `avatar` | `avatar` | visitor's saved pick, else `sol` | Initial catalog avatar: `sol`, `nova`, `vera`, `atlas`, `echo`. |
| `avatars` | `avatars` | all | Comma-separated allow-list for the picker. |
| `customAvatar` | `custom-avatar` | none | URL of your own rigged GLB (replaces the catalog + picker). |
| `assetBase` | `asset-base` | `https://three.ws/avatars/` | Self-host the catalog GLBs. |
| `name` | `name` | avatar's name | Display name in the header. |
| `siteName` | `site-name` | `og:site_name` else hostname | Used in the greeting and grounding. |
| `greeting` | `greeting` | generated | Empty-state + teaser line. |
| `suggestions` | `suggestions` | generated | Prompt chips. Pipe-separated in attributes, max 4. |
| `knowledge` | `knowledge` | none | Curated facts (FAQ, policies, pricing). Leads the grounding. |
| `shop` | `shop` | auto-detected | Shopify store domain. Turns on shopping mode (catalog + product cards). |
| `shopping` | `shopping` | auto on a store | Force shopping mode on (`true`) or off (`false`). |
| `currency` | `currency` | store's / `USD` | ISO code for product prices. |
| `maxProducts` | `max-products` | `4` | Product cards recommended per answer (1–8). |
| `persona` | `persona` | none | One-line tone instruction for the model. |
| `accent` | `accent` | indigo | Any CSS color; restyles the whole widget. |
| `position` | `position` | `bottom-right` | Or `bottom-left`. |
| `theme` | `theme` | `auto` | `auto` follows `prefers-color-scheme`; or pin `dark` / `light`. |
| `open` | `open` | `false` | Start with the panel open. |
| `muted` | `muted` | `false` | Start with voice off (remembered per visitor). |
| `picker` | `no-picker` | on | Avatar picker. |
| `teaser` | `no-teaser` | on | Proactive greeting bubble (once per session, dismissable). |
| `zIndex` | `z-index` | `2147482800` | Stacking override. |
| `lang` | `lang` | browser language | BCP-47 hint for voice in/out and replies. |

## API

```js
const c = new Concierge(config);
c.ask(text)            // Promise<string>: renders, streams, speaks; resolves to the answer
c.setOpen(true|false)  // open/close the panel
c.toggle()
c.setAvatar('nova')    // hot-swap the rig
c.setMuted(true)
c.reset()              // clear the conversation
c.dispose()
c.on(event, fn)        // 'ready' | 'open' | 'close' | 'message' | 'agentchange'
                       // | 'catalog' (store catalog loaded) | 'addtocart' | 'error'
```

`<three-concierge>` proxies the same methods and re-dispatches events as DOM CustomEvents (`three-concierge:message` etc., bubbling + composed).

Lower-level building blocks are exported too: `AvatarStage` (the 3D bust renderer), `SpeechNarrator` (TTS + viseme sync), `createLipsync` / `buildMorphMap`, `harvestSiteContext` / `buildSitePayload`, `askConcierge` (the SSE client), `renderMarkdown` / `stripMarkdown`, and `createMic`.

## The wire format (bring your own backend)

The default endpoint is free and anonymous, hosted by three.ws. To run your own, accept this POST and stream this SSE:

```
→ POST { message, history: [{role, content}], site: {url, name, title,
         description, headings[], nav[], knowledge, content}, persona?, lang? }

← data: { "type": "chunk", "text": "..." }     (repeated)
← data: { "type": "done", "provider": "...", "model": "..." }
← data: { "type": "error", "code": "...", "message": "..." }
```

Point the widget at it with `endpoint` / `data-endpoint`. The reference implementation is [`api/concierge.js`](https://github.com/nirholas/three.ws/blob/main/api/concierge.js) in the three.ws repo.

## Behavior details worth knowing

- **Zero cost while closed.** The WebGL stage, GLB download, and speech engines initialize on first open, not on page load.
- **Speaks while streaming.** Completed sentences are handed to the speech engine as they arrive; the mouth morphs are driven by a text-to-viseme timeline synced to the utterance.
- **Degrades deliberately.** No WebGL → the avatar stage hides, chat keeps working. No `SpeechRecognition` → the mic button never renders. TTS missing or muted → captions + lipsync still play. Endpoint down → a friendly error bubble with a working retry.
- **Persists sensibly.** Conversation per tab session (`sessionStorage`), avatar choice + mute per visitor (`localStorage`).
- **Accessible.** Dialog semantics, focus management, `aria-live` streaming region, Escape to close, full keyboard path, `prefers-reduced-motion` respected.
- **Safe rendering.** Model output renders through a strict markdown-lite renderer: everything is escaped first, links are restricted to http(s)/mailto and hardened with `rel="noopener noreferrer"`.

## Develop

```bash
npm install        # in this directory, or use the monorepo root
npm test           # node --test, no browser needed
npm run build      # dist/concierge.mjs + dist/concierge.global.js + dist/concierge.css
```

## License

Proprietary. See [LICENSE](./LICENSE). Free to embed on any site via the published builds.
