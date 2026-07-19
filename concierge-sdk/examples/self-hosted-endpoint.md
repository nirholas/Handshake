# Self-hosted answer backend

The hosted `https://three.ws/api/concierge` endpoint is free, but the wire format is open, run your own backend (to use your own model, your own data, or keep every request on your infrastructure) and point the widget at it with the `endpoint` option.

## The contract

The widget sends **one POST** and reads an **SSE stream** back:

```
→ POST <endpoint>
  Content-Type: application/json
  {
    "message":  "the visitor's question",
    "history":  [ { "role": "user"|"assistant", "content": "..." }, ... ],
    "site":     { "url", "name", "title", "description",
                  "headings": [...], "nav": [...], "knowledge", "content" },
    "persona":  "optional tone instruction",
    "lang":     "optional BCP-47 hint"
  }

← Content-Type: text/event-stream
  data: {"type":"chunk","text":"..."}      (repeated, as tokens arrive)
  data: {"type":"done","provider":"...","model":"..."}
  data: {"type":"error","code":"...","message":"..."}   (on failure)
```

The `site` object is harvested from the live page by the widget at ask-time (plus your curated `knowledge`), so your backend receives everything it needs to ground the answer, no crawler or index on your side.

## A runnable Node backend

This is a complete, dependency-light example using the official Anthropic SDK. It grounds the answer in the harvested `site` payload and streams the reply in the widget's event shape.

```js
// server.mjs, node server.mjs  (npm i @anthropic-ai/sdk)
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

function systemPrompt(site) {
	const name = site.name || site.title || 'this website';
	return [
		`You are the AI concierge for ${name}, embedded on the site.`,
		'Answer only from the SITE INFORMATION below. If it is not there, say so and',
		'point the visitor at the closest nav item. Never invent prices or policies.',
		'--- SITE INFORMATION ---',
		site.title && `Title: ${site.title}`,
		site.nav?.length && `Navigation: ${site.nav.join(' · ')}`,
		site.knowledge && `Curated knowledge:\n${site.knowledge}`,
		site.content && `Page content:\n${site.content}`,
	].filter(Boolean).join('\n');
}

http.createServer(async (req, res) => {
	// CORS, the widget runs on your site's origin; allow it.
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', 'content-type');
	if (req.method === 'OPTIONS') return res.writeHead(204).end();
	if (req.method !== 'POST') return res.writeHead(405).end();

	const body = JSON.parse(await new Promise((r) => {
		let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b));
	}));

	res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
	const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

	try {
		const stream = await client.messages.stream({
			model: 'claude-sonnet-5',
			max_tokens: 700,
			system: systemPrompt(body.site || {}),
			messages: [...(body.history || []), { role: 'user', content: body.message }],
		});
		stream.on('text', (t) => send({ type: 'chunk', text: t }));
		await stream.finalMessage();
		send({ type: 'done', provider: 'anthropic', model: 'claude-sonnet-5' });
	} catch (err) {
		send({ type: 'error', code: 'backend_error', message: err.message });
	}
	res.end();
}).listen(8787, () => console.log('concierge backend on http://localhost:8787'));
```

## Point the widget at it

```html
<three-concierge site-name="Acme" endpoint="https://api.yoursite.com/concierge"></three-concierge>
```

or

```js
new Concierge({ siteName: 'Acme', endpoint: 'https://api.yoursite.com/concierge' });
```

That's the whole integration. Everything else, the 3D avatar, voice, streaming render, grounding harvest, is unchanged; you've only swapped where the answer comes from.
