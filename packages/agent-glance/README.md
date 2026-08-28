# @three-ws/agent-glance

**Put a three.ws agent on any surface that has a slot.** Home screen widgets,
README badges, Slack unfurls, terminal dashboards, and a live `<agent-glance>`
web component.

A glance card is one agent reduced to what fits in a small rectangle: who it is,
one live number, and a way back into it. The platform serves that card as JSON,
as an SVG image, and as an Adaptive Card. This package is the client for all
three, with no dependencies and no build step.

Every function works in a browser, in Node 18+, in a service worker, and in an
edge runtime. The only I/O is `fetch`.

## Install

```bash
npm install @three-ws/agent-glance
```

## Read a card

```js
import { fetchGlanceCard } from '@three-ws/agent-glance';

const card = await fetchGlanceCard('0f3a1c22-9b7e-4d51-8a10-2c6f5d90ab34');
console.log(card.name, card.metric.value, card.metric.label);
```

## Put it in a README

```js
import { glanceMarkdown } from '@three-ws/agent-glance';

glanceMarkdown(agentId, { size: 'medium', theme: 'auto' });
// [![three.ws agent](https://three.ws/api/glance/card?agent=...&format=svg&size=medium&theme=auto)](https://three.ws/agents/...)
```

The SVG endpoint is the one for any host that only takes a picture: a README, a
Slack message, an issue comment. `glanceImageUrl()` gives you the bare URL.

## Put it on a page

```js
import { glanceEmbedHtml } from '@three-ws/agent-glance';
glanceEmbedHtml(agentId, { size: 'large', theme: 'dark' });
```

```html
<script type="module" src="https://three.ws/glance/element.js"></script>
<agent-glance agent="0f3a1c22-9b7e-4d51-8a10-2c6f5d90ab34" size="large" theme="dark"></agent-glance>
```

The live element updates on its own; the image URL is the no-script fallback.

## Put it in a widget board

```js
import { fetchGlanceAdaptiveCard } from '@three-ws/agent-glance';
const adaptive = await fetchGlanceAdaptiveCard(agentId);
```

For any host that renders an Adaptive Card directly: the Windows widgets board,
Teams, or your own renderer.

## Put it in a terminal

```bash
agent-glance 0f3a1c22-9b7e-4d51-8a10-2c6f5d90ab34
agent-glance <id> --watch 30
agent-glance <id> --markdown
agent-glance <id> --svg card.svg
```

| Option | Meaning |
| --- | --- |
| `--json` | The card model as JSON |
| `--markdown` | A README snippet, image linked to the agent |
| `--html` | An embed snippet for a web page |
| `--svg <file>` | Write the card image to a file |
| `--watch [seconds]` | Redraw on an interval (default 60) |
| `--size <s>` | `small`, `medium`, `large` (default `medium`) |
| `--theme <t>` | `auto`, `light`, `dark` (default `auto`) |
| `--origin <url>` | API origin (default `https://three.ws`) |
| `--no-color` | Plain text, no ANSI |

`renderGlanceAnsi(card, opts)` is exported, so any dashboard that lives in a
shell can draw the same card the CLI does.

## API

| Export | What it does |
| --- | --- |
| `fetchGlanceCard(id, opts?)` | The card model as JSON |
| `fetchGlanceAdaptiveCard(id, opts?)` | The same card shaped as an Adaptive Card |
| `glanceCardUrl(id, opts?)` | The JSON endpoint URL |
| `glanceImageUrl(id, opts?)` | The `<img>`-ready SVG URL |
| `glanceMarkdown(id, opts?)` | A README snippet |
| `glanceEmbedHtml(id, opts?)` | A page embed snippet |
| `renderGlanceAnsi(card, opts?)` | The card drawn for a terminal |
| `GLANCE_ORIGIN`, `GLANCE_SIZES`, `GLANCE_THEMES` | The accepted values, as data |
| `GlanceError` | Thrown with `status` and `agentId` attached, so a caller can tell a missing agent from an unreachable API |

All fetching functions take `{ origin, timeoutMs, signal, fetchImpl }`. Pass
`fetchImpl` to run against a mock-free test server or a custom transport.

## Related

- The live playground and install guide: [three.ws/glance](https://three.ws/glance)
- Docs: [three.ws/docs/glance](https://three.ws/docs/glance)
- The wire format: [specs/GLANCE_CARD.md](https://github.com/nirholas/three.ws/blob/main/specs/GLANCE_CARD.md)
- Embeddable 3D avatars, a different product (the agent's body, on your page): [three.ws/widgets](https://three.ws/widgets)
- [`STRUCTURE.md`](../../STRUCTURE.md): where every three.ws surface lives.

## License

Apache-2.0
