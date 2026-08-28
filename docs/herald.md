# Herald: deliver a message in person

A notification is a badge you have to notice, in a tray you have to open,
competing with forty others. Herald is the opposite: a 3D character walks into
the corner of the page, looks at the person using it, and tells them, with a
link to the thing it is about.

It ships as four pieces that work independently and compose:

| Piece | Where | What it is |
| --- | --- | --- |
| The library | [`herald-sdk/`](../herald-sdk/README.md), published as `@three-ws/herald` | The rules engine and the presenters. Works on any site, with or without a bundler. |
| The rail | `POST /api/herald/announce`, `GET /api/herald/stream` | Anything that can make an HTTPS request reaches the browser tab you have open. |
| The CLI | `npx @three-ws/herald` | `herald watch -- npm test` announces when your build finishes. |
| The MCP server | [`packages/herald-mcp/`](../packages/herald-mcp/README.md) | An AI agent tells its human something in person. |

Try all of it at [three.ws/herald](https://three.ws/herald), which runs the real
library in your own tab: change the rules, send a message, and watch the engine
decide.

three.ws uses this for its own notifications. The account-wide, per-category
switch for that lives in the preference center, documented in
[Notifications](./notifications.md#the-avatar-channel-delivered-in-person).

---

## The idea

Every alerting surface we have is a queue competing for the same half-second of
attention: a red dot, a rectangle that slides in, a phone buzz. They are the
same shape, they are all ignorable, and the important ones look exactly like the
noise.

A person walking up to your desk is not ignorable, and nobody has to design an
unread state for it. Herald is that, on the web, for the handful of events per
day that deserve it. Everything in the library exists to keep the interruption
rare enough to stay effective, which is why most of this page is about what it
refuses to deliver.

## Quick start

```sh
npm install @three-ws/herald
# optional: the 3D body. Without it, deliveries use the accessible card.
npm install @three-ws/walk three
```

The avatar presenter finds a companion in three places, cheapest first: one you
pass in (`createHerald({ companion })`), one already live on the page
(`window.__walkCompanion`, which is what every three.ws page has), or a module
URL you name (`avatarOptions: { walkModule: '/walk-companion.js' }`). None of
them is a static import, so the optional 3D body can never break a build.

```js
import { createHerald } from '@three-ws/herald';

const herald = createHerald({
  rules: { minImportance: 70, quietHours: [22, 7] },
  voice: 'auto',
});

herald.announce({
  text: 'Payment received from Acme',
  from: 'Stripe',
  importance: 85,
  url: '/payments/inv_123',
});
```

With no bundler at all:

```html
<script type="module">
  import { createHerald } from 'https://three.ws/herald.js';
  createHerald().announce('Deployed to production');
</script>
```

`/herald.js` is served with permissive CORS, exactly like the `<agent-3d>`
bundle, so it can be imported from any origin.

## What it refuses to deliver

`announce()` returns a verdict rather than a promise of delivery, and every
message that does not reach a human comes back with a reason.

```js
herald.announce({ text: 'someone viewed your profile', importance: 10 });
// { action: 'drop', reason: 'below-importance-floor', message: {...} }
```

**Dropped** (will never be delivered): `empty`, `muted`, `duplicate`, `stale`,
`below-importance-floor`.

**Held** (delivered once the thing blocking it clears): `delivering-another`,
`window-not-focused`, `rate-limited`, `quiet-hours`.

Held messages are re-examined when the rate window drains, quiet hours end, or
the tab comes back. A burst past `batchSize` is collapsed: the most important
few are said, and the rest become one "N more messages waiting" line.

| Rule | Default | What it does |
| --- | --- | --- |
| `minImportance` | `50` | The interrupt floor. |
| `freshnessMs` | `15 min` | Older than this is history, and history belongs in an inbox. |
| `dedupeTtlMs` | `6 h` | The same key is said once, however often a feed repeats it. |
| `quietHours` | `null` | Local `[start, end)`, wrapping past midnight. |
| `quietHoursMinImportance` | `90` | What still gets through the night. |
| `maxPerWindow` / `rateWindowMs` | `4` / `60 s` | The rate limit on interruptions. |
| `focusOnly` | `true` | Hold while the tab is in the background. |
| `batchSize` | `2` | Said per burst before the rest collapse. |

Scoring is pluggable, and the highest opinion wins:

```js
herald.rule((m) => (m.from === 'oncall' ? 100 : undefined));
herald.rule((m) => (/\bfailed\b/i.test(m.text) ? 90 : undefined));
```

## Sources

A source is `{ name, start(emit) => stop }`. Three ship with the library, and
writing one for a feed nobody here has heard of is about five lines.

```js
import { createHerald, pollSource, sseSource, railSource } from '@three-ws/herald';

const herald = createHerald();

// Any JSON endpoint. Polling stops while the tab is hidden.
herald.source(pollSource({
  url: '/api/alerts',
  intervalMs: 30_000,
  map: (a) => ({ id: a.id, text: a.title, importance: a.severity * 20, url: a.link }),
}));

// Any EventSource endpoint.
herald.source(sseSource({ url: '/events', events: ['alert'] }));

// The three.ws rail (below).
herald.source(railSource());
```

## The rail

The rail is what lets something with no browser (a deploy script, a cron, a CI
job, an AI agent) reach the browser a person is actually looking at.

### Announce

```http
POST /api/herald/announce
Authorization: Bearer sk_live_...        # or a signed-in session cookie
Content-Type: application/json

{ "text": "Deploy is green", "importance": 80, "url": "/dashboard", "from": "CI" }
```

```json
{
  "queued": true,
  "id": "6a293426-8f48-4254-bc14-cef9ada17680",
  "expires_in": 300,
  "announcement": { "id": "...", "text": "Deploy is green", "importance": 80, "tone": "alert", "at": 1787888380209 }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `text` (or `message`) | string, 1-280 | Required. Written as speech, not as a log line. |
| `from` | string, max 60 | Spoken as attribution. |
| `importance` | int 0-100 | Default 70. The receiving client applies its own floor. |
| `url` | string | Same-origin path or absolute `http(s)`. Anything else is dropped. |
| `tone` | `neutral` \| `alert` \| `celebrate` \| `error` | Default `alert`. |
| `emote` | string | `wave`, `dance`, `punch`, `backflip`. |
| `key` | string, max 120 | Dedupe key: two announcements sharing one are said once. |
| `meta` | object | Returned untouched to the client's callbacks. |

`202` means queued for a live surface, not heard by a human: nothing on the
server can promise the second thing.

**Addressing is the security model.** An announcement always goes to the
authenticated caller's own sessions. There is no recipient field, so a key
cannot be used to interrupt anybody else, and the worst a leaked key can do is
annoy the person who leaked it. Keys are minted at
[/dashboard/developers](https://three.ws/dashboard/developers) with the
`herald:announce` scope and revoked in the same place.

### Listen

```http
GET /api/herald/stream        # session cookie only
```

Server-sent events: `open` once, then one `announce` per queued line, with a
`ping` every 15 seconds. The queue is drained (not broadcast), so a message is
said by exactly one open tab. An undelivered line expires in about five minutes:
this is a live channel, and the durable record is the notification bell.

Rate limits: 60 announces per minute per account, 60 stream connections per five
minutes.

## The CLI

```sh
export THREE_WS_API_KEY=sk_live_...      # herald:announce scope

herald say "Migration finished" --from db --url https://three.ws/dashboard
herald watch --from CI -- npm test
herald ping
```

`watch` runs the command with its stdio attached, keeps its exit code, times it,
and announces the outcome (`CI passed in 2m`, `CI failed (exit 1) after 47s`).
Failures arrive at importance 95 so they cut through quiet hours; successes at
60 so they do not. Because the exit code is preserved, it drops into a pipeline
unchanged:

```sh
herald watch -- npm test && npm run deploy
```

## From an AI agent

```sh
claude mcp add herald -e THREE_WS_API_KEY=sk_live_... -- npx -y @three-ws/herald-mcp
```

Three tools: `announce` (say one line), `announce_result` (report a finished
task, with the urgency chosen from the outcome), and `check_rail` (prove the key
works without interrupting anyone). Full reference in
[packages/herald-mcp](../packages/herald-mcp/README.md).

This is the piece that changes how a long agent run feels: the agent works for
twenty minutes while you do something else, and then your own avatar walks on
and tells you it is done.

## Accessibility

The avatar is the point, but it is never the requirement.

- No WebGL, an iframe, a route that already owns the corner: the card presenter
  takes over. It is theme-aware, honours `prefers-reduced-motion` and
  `prefers-color-scheme`, is dismissible with `Escape`, and has real focus
  rings.
- Both presenters deliver into an `aria-live` region, so assistive technology
  announces the line at the same moment everyone else hears it.
- Audio is opt-in and gesture-gated. `voice: 'auto'` speaks only once the
  browser has seen a real interaction; refused audio degrades to the text that
  is already on screen.

## Where the code is

| Piece | Path |
| --- | --- |
| Rules engine (pure, unit-tested) | [herald-sdk/src/rules.js](../herald-sdk/src/rules.js) |
| Runtime | [herald-sdk/src/index.js](../herald-sdk/src/index.js) |
| Presenters | [herald-sdk/src/presenters/](../herald-sdk/src/presenters) |
| Sources | [herald-sdk/src/sources/index.js](../herald-sdk/src/sources/index.js) |
| CLI | [herald-sdk/bin/herald.mjs](../herald-sdk/bin/herald.mjs) |
| Rail | [api/herald/announce.js](../api/herald/announce.js), [api/herald/stream.js](../api/herald/stream.js), [api/_lib/herald.js](../api/_lib/herald.js) |
| CDN entry | [src/herald-embed.js](../src/herald-embed.js) served at `/herald.js` |
| Playground | [pages/herald.html](../pages/herald.html), [src/herald-page.js](../src/herald-page.js) |
| MCP server | [packages/herald-mcp/](../packages/herald-mcp/README.md) |
| Tests | [tests/herald-rules.test.js](../tests/herald-rules.test.js), [tests/herald-runtime.test.js](../tests/herald-runtime.test.js), [tests/herald-rail.test.js](../tests/herald-rail.test.js), [tests/herald-announce-endpoint.test.js](../tests/herald-announce-endpoint.test.js) |

## Related

- [Notifications](./notifications.md): the bell, the inbox API, and the
  per-category avatar channel that uses this on three.ws itself.
- [walk-sdk](../walk-sdk/README.md): the 3D body, and `control.announce()`, the
  primitive the avatar presenter delivers through.
- [The developer platform](./developer-platform.md): API keys, scopes, and usage.
