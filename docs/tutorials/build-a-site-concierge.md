# Build a site concierge: how the three.ws chat widget works, end to end

This tutorial walks through how we built [Concierge](/concierge), the embeddable chat widget with a talking 3D avatar, and how to assemble the same thing from the exported building blocks. By the end you will understand every moving part well enough to customize it, extend it, or point it at your own backend.

What you need: a browser with WebGL, any static page to test on, and (only for the custom-backend section) a server that can stream Server-Sent Events.

---

## The shape of the problem

A site chatbot has four jobs, and each maps to one module in [`concierge-sdk/`](https://github.com/nirholas/three.ws/tree/main/concierge-sdk):

| Job | Module | What it does |
| --- | --- | --- |
| Know the site | `src/context.js` | Snapshot the live DOM at ask-time |
| Get an answer | `src/client.js` + `api/concierge.js` | Stream SSE from a grounded LLM prompt |
| Have a face | `src/stage.js` + `src/lipsync.js` + `src/narrator.js` | Rigged GLB bust, blink/idle, viseme lipsync, TTS |
| Be a widget | `src/widget.js` + `src/styles.js` + `src/element.js` | Launcher, panel, thread, mic, themes, persistence |

The 3D pieces are shared lineage with `@three-ws/page-agent` and the rig conventions of `@three-ws/walk`; nothing here was invented twice.

## Step 1: know the site without a crawler

The classic approach (crawl the site, chunk it, embed it, retrieve at query time) needs infrastructure and goes stale. The concierge inverts it: the visitor is already *on* the page, so harvest the DOM at the moment of the question.

```js
import { buildSitePayload } from '@three-ws/concierge';

const site = buildSitePayload(document, {
	knowledge: 'Pro plan is $20/month.',  // curated facts lead
	siteName: 'Acme',
});
// → { url, name, title, description, headings[], nav[], knowledge, content }
```

Three details make this reliable:

- **Noise is stripped before text is read**: `script`, `style`, `[aria-hidden]`, `[hidden]`, iframes, and anything marked `data-concierge-ignore`. The widget's own DOM is excluded too, or it would feed its answers back into its questions.
- **Everything is budgeted.** Page content caps at 6,000 characters, and curated `knowledge` (which is authoritative) eats into that budget first, so the payload can never bloat past what a small prompt affords.
- **It is pure DOM-in / JSON-out**, so it unit-tests with jsdom and no browser.

## Step 2: a grounded, streaming answer

The widget posts `{ message, history, site }` to `/api/concierge`. The server folds the snapshot into a system prompt whose key line is the honesty rule: *ground every claim in the site information; if it is not there, say so and point at the closest nav item instead. Never invent prices, features, or policies.*

The response is Server-Sent Events, one JSON object per frame:

```
data: {"type":"chunk","text":"The Pro plan "}
data: {"type":"chunk","text":"costs $20/month."}
data: {"type":"done","provider":"groq","model":"llama-3.3-70b-versatile"}
```

On the server, the provider list comes from the shared free-first chain (`api/_lib/llm.js`). The handler walks the chain in order, skips lanes in cooldown, marks a lane that answers 401/402/403 with a long auth cooldown (a billing-dead account should not be re-probed on every request), and streams from the first lane that connects. If every lane fails before a byte is sent, the client gets a plain 503 with `Retry-After` and the widget shows a retry bubble.

The client side is ~100 lines (`src/client.js`): a `fetch`, a spec-correct SSE reassembly buffer (frames split on blank lines, tested against one-byte-at-a-time delivery), and an `onChunk` callback.

## Step 3: the face

`AvatarStage` renders a rigged GLB into a transparent canvas, framed as a bust, with three layers of life:

1. **Clip-driven idle** when the GLB ships an idle animation, plus a talk clip crossfaded in while speaking.
2. **Procedural fallback** (breathing, head sway, nod) when it does not, so no avatar is ever a frozen statue.
3. **Blinks**, driven through the standard blink morph targets on a randomized timer.

Lipsync is deliberately *not* audio analysis. `createLipsync` tokenizes the sentence into a timed viseme sequence (`th` → `viseme_TH`, vowels → their shapes, ~80ms per phoneme) and lerps the matching morph-target influences every frame. It is synced to the Web Speech utterance by starting the timeline when the utterance starts. Cheap, dependency-free, and convincing at conversational pace. Rigs with only a `jawOpen` morph get an amplitude envelope instead; rigs with no face morphs carry the talk with body animation.

`SpeechNarrator` queues sentences, picks a voice per avatar profile (name matches first, then language, then any local voice), and always runs the visual timeline even when muted or when the platform has no TTS, so the answer never silently stalls.

The trick that makes the whole thing feel fast: **the widget speaks while the answer still streams**. A small sentence-splitter (`drainSentences`) watches the chunk stream and hands each completed sentence to the narrator immediately.

## Step 4: the widget shell

`Concierge` (in `src/widget.js`) owns the lifecycle. The decisions that matter:

- **Lazy everything.** The WebGL context, GLB download, and speech engines initialize on first open. A closed widget is one button and one stylesheet.
- **Design every state.** Empty state (greeting + suggestion chips), loading (skeleton shimmer behind the stage, typing dots in the thread), streaming (live markdown with a caret), error (friendly bubble + retry that rewinds the failed turn), no-WebGL (stage hides, chat survives), no-mic (button never renders).
- **Persistence with the right scopes.** Conversation per tab (`sessionStorage`), avatar + mute per visitor (`localStorage`), teaser once per session.
- **Safety at the render boundary.** Model output goes through a markdown-lite renderer that escapes first and only then applies markup; `javascript:` URLs never become links.

`<three-concierge>` (`src/element.js`) is a thin attribute-to-config wrapper, and `src/index.js` adds the `data-concierge` script auto-init, which is why the one-tag install needs no JavaScript at all.

## Point it at your own backend

Everything above the wire format is replaceable. Implement one route:

```js
// POST /my/concierge  (Express-flavored sketch)
app.post('/my/concierge', async (req, res) => {
	const { message, history, site } = req.body;
	res.writeHead(200, { 'Content-Type': 'text/event-stream' });
	const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

	const stream = await yourLlm.stream({
		system: `Answer questions about ${site.name} using only:\n${site.knowledge}\n${site.content}`,
		messages: [...history, { role: 'user', content: message }],
	});
	for await (const text of stream) send({ type: 'chunk', text });
	send({ type: 'done', provider: 'yours', model: 'your-model' });
	res.end();
});
```

Then: `<three-concierge endpoint="/my/concierge">`. The production reference, with rate limits, moderation, provider failover, and cooldowns, is [`api/concierge.js`](https://github.com/nirholas/three.ws/blob/main/api/concierge.js).

## Where to go next

- Ship it: the [install options](/concierge#install) on the landing page
- Every attribute and event: the [package README](https://github.com/nirholas/three.ws/tree/main/concierge-sdk#options)
- The launch story: [blog post](/blog/concierge-3d-chat-widget)
- The rig conventions the avatars follow: [`@three-ws/walk`](https://www.npmjs.com/package/@three-ws/walk) and `src/glb-canonicalize.js` in the repo
