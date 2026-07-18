# Concierge: an AI chat widget with a 3D face, for any website

Concierge is the three.ws support-chat widget: a floating launcher that opens a chat panel where a rigged 3D avatar blinks, idles, and lipsyncs while it answers visitors. Answers stream in live, are grounded in the page the widget sits on, and speak aloud with the browser's own speech engine. It installs on any site with one tag and costs nothing.

- Live demo and landing: [/concierge](/concierge) (the widget there answers questions about itself)
- Package: [`@three-ws/concierge`](https://www.npmjs.com/package/@three-ws/concierge), source in [`concierge-sdk/`](https://github.com/nirholas/three.ws/tree/main/concierge-sdk)
- Backend: `POST /api/concierge` ([reference implementation](https://github.com/nirholas/three.ws/blob/main/api/concierge.js))
- Tutorial on how it is built: [Build a site concierge](/docs/tutorials/build-a-site-concierge)

---

## Install

The one-tag embed:

```html
<script type="module"
        src="https://three.ws/concierge/concierge.global.js"
        data-concierge
        data-site-name="Acme"
        data-accent="#f97316"
        data-suggestions="What is Acme?|What does it cost?"></script>
```

Or from npm (`npm install @three-ws/concierge three`) as a web component or an imperative API:

```html
<three-concierge site-name="Acme" accent="#f97316"
    knowledge="Pro plan is $20/month. Support: help@acme.com."></three-concierge>
```

```js
import { Concierge } from '@three-ws/concierge';
const c = new Concierge({ siteName: 'Acme', knowledge: FAQ_TEXT });
await c.ask('What does the Pro plan cost?');
```

The full option table (avatars, themes, position, voice, persona, custom GLB avatars, self-hosted assets) lives in the [package README](https://github.com/nirholas/three.ws/tree/main/concierge-sdk#options).

## How it answers accurately with zero setup

Most site chatbots need a crawler, an index, and an onboarding flow. Concierge skips all three:

1. **Harvest at ask-time.** When the visitor asks something, the widget snapshots the live DOM: title, meta description, headings, nav labels, and the main content, each capped to a strict budget. Your curated `knowledge` string (FAQ, pricing, policies) is merged in ahead of the harvested text. Mark any element `data-concierge-ignore` to keep it out.
2. **Ground and stream.** The snapshot, the running conversation, and the question go to `/api/concierge`. The server builds a grounded system prompt that forbids inventing facts, then streams the answer back as SSE from the platform's free-first LLM chain (Groq → Cerebras → OpenRouter → NVIDIA → OVH → Gemini → Vertex, with cooldown-aware failover). The route is anonymous, CORS-open (it must run on third-party origins), rate-limited per IP and globally, and pre-moderated fail-open.
3. **Speak while streaming.** The widget splits the stream into sentences and hands each completed sentence to the Web Speech engine while the rest is still arriving; a text-to-viseme timeline drives the avatar's mouth morphs in sync. Muted or unsupported? Captions and lipsync still play.

Because the page itself is the knowledge source, the concierge is never stale: edit your pricing page and the very next answer reflects it.

## The avatar

The catalog (`sol`, `nova`, `vera`, `atlas`, `echo`) is the same rigged, viseme-capable roster the [page-agent](https://www.npmjs.com/package/@three-ws/page-agent) ships, served from `https://three.ws/avatars/`. Visitors pick their concierge from the built-in picker (their choice persists), or the host pins a single custom rigged GLB with `custom-avatar`. The 3D stage initializes on first open only, so a closed widget costs the host page zero GPU and no GLB download.

## Bring your own backend

The hosted endpoint is free, but the wire format is open. Any server that accepts the POST body and streams the same three SSE event types can be swapped in via the `endpoint` option:

```
→ POST { message, history[], site{url,name,title,description,headings,nav,knowledge,content}, persona?, lang? }
← data: {"type":"chunk","text":"..."}
← data: {"type":"done","provider":"...","model":"..."}
← data: {"type":"error","code":"...","message":"..."}
```

## Limits and safeguards

- Messages are capped at 2,000 characters, history at 20 turns, page content at 6,000 characters, curated knowledge at 8,000.
- The hosted endpoint rate-limits per IP (20/min) and globally (600/min across all embeds), and cools down failing providers so a billing-dead lane is skipped, not re-probed.
- Model output renders through a strict markdown-lite renderer: all text is escaped before markup applies, and links are restricted to http(s)/mailto.
- Only the embedding page's hostname (never the full URL) is recorded in usage telemetry.

## Related surfaces

- [/walk](/walk): the walking page companion the avatar engine grew from
- [Share and embed](./share-and-embed.md): every other way to put a three.ws creation on your site
- [MCP](./mcp.md): drive avatars and generation from agent tooling
