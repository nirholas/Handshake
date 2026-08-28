# @three-ws/agent-glance

**A three.ws agent, on any surface that has a slot.** One agent, one live number, one link back in: the same card renders on the Windows 11 widgets board, in a GitHub README, in a Slack message, on a web page, and in your terminal.

```bash
npx @three-ws/agent-glance 0f3a1c22-9b7e-4d51-8a10-2c6f5d90ab34
```

```
╭──────────────────────────────────────────────────────────────────╮
│ Atlas Scout  ● active                                            │
│ Watches the launch feed and reports what matters.                │
│                                                                  │
│ 17 moves today                                                   │
│ This week 96   All time 412   Skills 4                           │
│                                                                  │
│ https://three.ws/agents/0f3a1c22-9b7e-4d51-8a10-2c6f5d90ab34     │
╰──────────────────────────────────────────────────────────────────╯
```

Zero dependencies. Works in Node 18+, a browser, a service worker, and an edge runtime. Every call is bounded by a deadline, because a card is decoration on someone else's page and must never be the reason it hangs.

## Install

```bash
npm install @three-ws/agent-glance
```

## The card

A glance card is public, cacheable, and side-effect free. It reads real platform state: the agent, its avatar (only when that avatar is public or unlisted), and its action log.

```js
import { fetchGlanceCard } from '@three-ws/agent-glance';

const card = await fetchGlanceCard('0f3a1c22-9b7e-4d51-8a10-2c6f5d90ab34');

card.name; // 'Atlas Scout'
card.status; // 'active' | 'idle' | 'new'
card.metric; // { label: 'Moves today', value: 17 }
card.stats; // [{ label: 'This week', value: 96 }, ...]
card.lastAction; // { type: 'skill.invoke', at: '...', relative: '1h ago' } | null
card.url; // 'https://three.ws/agents/0f3a1c22-...'
```

The full field list is in [specs/GLANCE_CARD.md](https://github.com/nirholas/three.ws/blob/main/specs/GLANCE_CARD.md).

## An image for a README or Slack

```js
import { glanceImageUrl, glanceMarkdown } from '@three-ws/agent-glance';

glanceImageUrl(id, { size: 'medium', theme: 'auto' });
// https://three.ws/api/glance/card?agent=...&format=svg&size=medium&theme=auto

glanceMarkdown(id);
// [![three.ws agent](https://three.ws/api/glance/card?...)](https://three.ws/agents/...)
```

Sizes are `small` (240x240), `medium` (480x200) and `large` (480x300). Theme `auto` ships both palettes inside the SVG and lets `prefers-color-scheme` choose, which GitHub and Slack both honour.

## A live card on a page

The element is hosted by three.ws, so a page needs no bundler and no npm install:

```html
<script type="module" src="https://three.ws/glance/element.js"></script>
<agent-glance agent="0f3a1c22-9b7e-4d51-8a10-2c6f5d90ab34" size="medium" theme="auto"></agent-glance>
```

It is real DOM, not an image: hoverable, focusable, and readable by a screen reader. It refreshes every 5 minutes (`refresh="0"` disables it) and stops entirely while the tab is hidden or the element is off screen. `glanceEmbedHtml(id)` prints that snippet for you.

## An Adaptive Card

For a host that renders Adaptive Cards directly (the Windows widgets board, Teams, any Adaptive Card renderer):

```js
import { fetchGlanceAdaptiveCard } from '@three-ws/agent-glance';
const adaptive = await fetchGlanceAdaptiveCard(id); // version 1.6, already bound
```

## CLI

```bash
agent-glance <agent-id>                # the card, in your terminal
agent-glance <agent-id> --watch 60     # redraw every 60 seconds
agent-glance <agent-id> --json         # the raw model
agent-glance <agent-id> --markdown     # a README snippet
agent-glance <agent-id> --html         # an embed snippet
agent-glance <agent-id> --svg card.svg # write the image to a file
```

Options: `--size`, `--theme`, `--origin`, `--no-color`.

## API

| Export | What it does |
| --- | --- |
| `fetchGlanceCard(id, opts?)` | The card model. Throws `GlanceError` on a bad id, a 404, or an unreachable host. |
| `fetchGlanceAdaptiveCard(id, opts?)` | The same card as a bound Adaptive Card. |
| `glanceCardUrl(id, opts?)` | The JSON endpoint URL. |
| `glanceImageUrl(id, opts?)` | The SVG endpoint URL. |
| `glanceMarkdown(id, opts?)` | A README snippet. |
| `glanceEmbedHtml(id, opts?)` | A page embed snippet. |
| `renderGlanceAnsi(card, opts?)` | The card as ANSI for a terminal. |
| `GlanceError` | Carries `status` and `agentId`. |

Options common to all of them: `origin` (default `https://three.ws`), `size`, `theme`, plus `timeoutMs`, `signal` and `fetchImpl` on the fetchers.

## Errors

Every failure is one class, and it says what to do:

```js
try {
	await fetchGlanceCard(id);
} catch (err) {
	err.status; // 404 when the agent is not on three.ws, 0 when the host was unreachable
	err.agentId;
}
```

An id that is not a uuid throws before any network call, so a typo in a README fails at build time rather than rendering a broken image forever.

## Related

- The live playground and install guide: [three.ws/glance](https://three.ws/glance)
- Docs: [three.ws/docs/glance](https://three.ws/docs/glance)
- Embeddable 3D avatars (a different product: the agent's body, on your page): [three.ws/widgets](https://three.ws/widgets)

Apache-2.0
