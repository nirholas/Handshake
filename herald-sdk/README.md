# @three-ws/herald

**Deliver a message in person.**

A notification is a badge you have to notice, in a tray you have to open,
competing with forty others. This library delivers the ones that matter the way
a colleague would: a 3D character walks into the corner of the page, looks at
the person using it, and tells them, with a link to the thing it is about.

```js
import { createHerald } from '@three-ws/herald';

const herald = createHerald();
herald.announce({ text: 'Deploy is green', importance: 80, url: '/builds' });
```

That is the whole integration. What you get for it is not a toast library, it
is a delivery discipline: importance scoring, an interrupt floor, quiet hours,
a rate limit, dedupe with a TTL, freshness, batching with a collapse line, focus
awareness, an accessible fallback for machines that cannot render 3D, and an
audit trail of every message that did not make it and why.

And from your terminal:

```sh
npx @three-ws/herald watch -- npm test
```

Your build runs. When it finishes, your avatar walks onto the browser tab you
already have open and tells you whether it passed. The exit code is preserved,
so it drops into a pipeline unchanged.

---

## Why

Every alerting surface we have is a queue that competes for the same
half-second of attention: a red dot, a rectangle that slides in, a phone buzz.
They are all the same shape, they are all ignorable, and the important ones
look exactly like the noise.

A person walking up to your desk to tell you something is not ignorable, and
nobody has to design an "unread state" for it. This is that, on the web, for
the handful of events per day that deserve it. The scarcity is the feature:
everything here exists to keep the interruption rare enough to stay effective.

## Install

```sh
npm install @three-ws/herald
# the 3D body is optional, and only needed for the avatar presenter
npm install @three-ws/walk three
```

No build step, no bundler requirement, no CSS to import. The package is plain
ES modules and ships its own styles inline. Node 18+ for the CLI.

Without a bundler:

```html
<script type="module">
  import { createHerald } from 'https://three.ws/herald.js';
  createHerald().announce('Deployed to production');
</script>
```

## Quick start

### 1. Announce something

```js
const herald = createHerald({
  rules: { minImportance: 60 },
  voice: 'auto',
});

herald.announce({
  text: 'Payment received from Acme',
  from: 'Stripe',
  importance: 85,
  url: '/payments/inv_123',
  tone: 'celebrate',
});
```

`announce()` returns the verdict, so nothing is ever mysteriously silent:

```js
const verdict = herald.announce({ text: 'noise', importance: 5 });
// { action: 'drop', reason: 'below-importance-floor', message: {...} }
```

### 2. Point it at a feed

```js
import { createHerald, pollSource, sseSource } from '@three-ws/herald';

const herald = createHerald();

// Any JSON endpoint. It stops polling while the tab is hidden.
herald.source(pollSource({
  url: '/api/alerts',
  intervalMs: 30_000,
  map: (a) => ({ id: a.id, text: a.title, importance: a.severity * 20, url: a.link }),
}));

// Or a stream you already have.
herald.source(sseSource({ url: '/events', events: ['alert'] }));
```

A source is `{ name, start(emit) => stop }`. Anything you can subscribe to in
five lines is a source, and the rules engine normalises whatever shape it
emits, so pointing this at an existing feed rarely needs a mapper at all.

### 3. Teach it what matters

```js
herald.rule((m) => (m.from === 'oncall' ? 100 : undefined));
herald.rule((m) => (/\bfailed\b/i.test(m.text) ? 90 : undefined));
```

A scorer returns 0-100, or `undefined` to abstain. The highest opinion wins, a
scorer that throws is ignored, and the score a message was judged with comes
back in the verdict.

## The rules

Every default is chosen so that dropping this into a page cannot make it
obnoxious. Override what you need.

| Rule | Default | What it does |
| --- | --- | --- |
| `minImportance` | `50` | The interrupt floor. Below it, nothing is shown. |
| `freshnessMs` | `15 min` | Older than this is history, and history belongs in an inbox. |
| `dedupeTtlMs` | `6 h` | The same key is said once, however many times a feed repeats it. |
| `quietHours` | `null` | Local `[start, end)`, wrapping past midnight (`[22, 7]`). |
| `quietHoursMinImportance` | `90` | What still gets through the night. |
| `maxPerWindow` | `4` | Deliveries per rate window. |
| `rateWindowMs` | `60 s` | The window. |
| `focusOnly` | `true` | Hold while the tab is in the background. |
| `batchSize` | `2` | Said per burst, before the rest collapse into one line. |

Anything that cannot be delivered right now is **held**, not lost, and
re-examined when the thing blocking it clears (the window drains, quiet hours
end, the tab comes back). Anything that will never be delivered is **dropped**
with a reason you can read:

```js
herald.stats();
// { received: 12, delivered: 5, dropped: 6, held: 1, spoken: 3,
//   drops: [{ at: 176..., reason: 'duplicate', text: 'Build failed' }, ...] }
```

Reasons are stable strings: `duplicate`, `stale`, `below-importance-floor`,
`muted`, `empty`, and for holds `quiet-hours`, `rate-limited`,
`window-not-focused`, `delivering-another`.

## Presenters

| Presenter | Needs | Used when |
| --- | --- | --- |
| `avatar` | `@three-ws/walk` or the CDN build, WebGL | A body can be rendered |
| `card` | Nothing | Everything else |

`presenter: 'auto'` (the default) tries the avatar and falls back to the card,
per page, once. The card is not a consolation prize: it is theme-aware, honours
`prefers-reduced-motion` and `prefers-color-scheme`, is dismissible with
`Escape`, and lives in an `aria-live` region so a screen reader announces the
line exactly when everyone else hears it.

On a page that already runs a walk companion, the avatar presenter reuses it,
so the person's own character delivers the message instead of a second one
appearing beside it.

## Voice

```js
createHerald({
  voice: 'auto',                       // 'off' (default) | 'auto' | 'always'
  voiceOptions: { endpoint: '/api/tts/speak', voice: 'nova' },
});
```

`auto` speaks only once the browser has seen a real user gesture, which is what
autoplay policy requires and what good manners require anyway. With no endpoint
configured it falls back to the browser's own `speechSynthesis`. If audio is
refused at any point, the text is already on screen: there is no silent failure
and no "click to enable sound" nag.

## The rail: announce from anywhere

Running on three.ws, the SDK can listen to a hosted delivery rail. Anything
that can make an HTTPS request can then reach the browser tab you have open:

```js
import { createHerald, railSource } from '@three-ws/herald';
createHerald({ voice: 'auto' }).source(railSource());
```

```sh
curl -X POST https://three.ws/api/herald/announce \
  -H "Authorization: Bearer $THREE_WS_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"text":"Deploy is green","importance":80,"url":"/dashboard"}'
```

A message is always delivered to the **authenticated caller's own** sessions.
There is no "to" field, so a key can never be used to interrupt somebody else,
and the worst a leaked key can do is annoy the person who leaked it. Keys are
minted at `/dashboard/developers` with the `herald:announce` scope.

## CLI

```sh
npm i -g @three-ws/herald    # or npx @three-ws/herald ...
export THREE_WS_API_KEY=sk_live_...

herald say "Migration finished" --from "db" --url https://three.ws/dashboard
herald watch --from CI -- npm test
herald ping
```

`watch` runs the command with its stdio attached, keeps its exit code, times
it, and announces the result (`passed in 2m` / `failed (exit 1) after 47s`).
Failures arrive at importance 95, so they cut through quiet hours; successes at
60, so they do not.

## Recipes

**Only interrupt for the on-call channel, and never at night:**

```js
const herald = createHerald({
  rules: { minImportance: 70, quietHours: [22, 7], quietHoursMinImportance: 95 },
});
herald.rule((m) => (m.meta?.channel === 'oncall' ? 96 : undefined));
```

**Bridge an existing event bus:**

```js
import { manualSource } from '@three-ws/herald';
const bus = manualSource();
herald.source(bus);
myEmitter.on('alert', (a) => bus.send({ id: a.id, text: a.title, importance: a.level }));
```

**Let the person silence it without losing the message:**

```js
createHerald({
  actionsFor: (m) => [{ label: 'Mute 1h', onClick: () => herald.mute(3_600_000) }],
});
```

**Server-side triage, client-side delivery:** score on your backend, send the
number, and keep the client rules simple.

```js
herald.source(sseSource({ url: '/events', map: (e) => ({ ...e, importance: e.score }) }));
```

## API

```ts
createHerald(options?) => Herald

Herald.announce(message | string) => { action, reason?, message }
Herald.source(source) => stop
Herald.rule(scorer) => Herald
Herald.mute(ms?) => Herald
Herald.unmute() => Herald
Herald.muted: boolean
Herald.rules: Rules
Herald.stats() => { received, delivered, dropped, held, spoken, holding, drops }
Herald.stop() => void
```

A `Message` is `{ id?, key?, text, importance?, from?, url?, at?, tone?, emote?,
meta? }`. Only `text` is required. `tone` is `neutral | alert | celebrate |
error`; `emote` is a gesture name the avatar rig understands (`wave`, `dance`,
`punch`, `backflip`).

The rules engine is exported on its own for anyone who wants the judgement
without the delivery:

```js
import { decide, planBatch, resolveRules } from '@three-ws/herald/rules';
```

## Accessibility and performance

- Every delivery is in a live region, spoken to assistive technology at the
  same moment it is spoken to everyone else.
- `prefers-reduced-motion` removes the entrance animation and the countdown
  bar, not the message.
- The card presenter has a real focus ring, an `Escape` handler, and buttons
  that are buttons.
- Nothing is loaded until it is needed: the 3D body is a dynamic import that
  only happens when an avatar delivery actually occurs.
- Polling sources stop while the tab is hidden.

## License

Apache-2.0. Built by [three.ws](https://three.ws), where it delivers the
platform's own notifications: see [the herald playground](https://three.ws/herald).
