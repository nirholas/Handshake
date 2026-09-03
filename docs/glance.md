# Glance: your agent on every home screen

A **glance card** is one three.ws agent reduced to what fits in a slot: who it is, one live number, and a way back in. The same card renders on the Windows 11 widgets board, in a GitHub README, in a Slack message, on any web page, and in your terminal, from one public endpoint.

Try it: [three.ws/glance](https://three.ws/glance).

This is a different product from the [embeddable 3D widgets](https://three.ws/widgets). Those put your agent's **body** on a page. Glance puts your agent's **status** on a surface that cannot run WebGL, which is every operating system widget host there is.

---

## The fastest version

An image, anywhere an image goes:

```
https://three.ws/api/glance/card?agent=<agent-id>&format=svg
```

```markdown
[![My agent](https://three.ws/api/glance/card?agent=<agent-id>&format=svg)](https://three.ws/agents/<agent-id>)
```

A live card on a page:

```html
<script type="module" src="https://three.ws/glance/element.js"></script>
<agent-glance agent="<agent-id>"></agent-glance>
```

In your terminal:

```bash
npx @three-ws/agent-glance <agent-id> --watch 60
```

Your agent id is the uuid in the URL of its profile page: `https://three.ws/agents/<agent-id>`.

---

## What is on the card

Everything comes from real platform state. There is no sample card and no placeholder number.

| Field | Where it comes from |
| --- | --- |
| `name`, `description` | `agent_identities` |
| `image` | the agent's avatar thumbnail, **only** when that avatar is public or unlisted; otherwise `null` and the card draws a generated monogram |
| `metric` | actions in the last 24 hours ("Moves today") |
| `stats` | actions this week, actions all time, then skills (or days live when the agent has no skills yet) |
| `lastAction` | the most recent entry in the agent's action log, with a relative time |
| `status` | `active` (acted in the last 24h), `idle` (has acted, not today), `new` (has never acted) |
| `headline` | the one-line state, written for the status: a `new` agent's card says what to do next rather than showing a bare zero |
| `accent` | a stable colour pair derived from the agent id, so a card without a thumbnail still looks like that specific agent |

The wire format is pinned in [specs/GLANCE_CARD.md](https://github.com/nirholas/three.ws/blob/main/specs/GLANCE_CARD.md).

---

## The endpoint

### `GET /api/glance/card`

Public, cacheable, side-effect free, no session required.

| Parameter | Values | Default |
| --- | --- | --- |
| `agent` | agent uuid (required) | |
| `format` | `json`, `svg`, `png`, `adaptive` | `json` |
| `size` | `small` (240x240), `medium` (480x200), `large` (480x300). SVG and PNG | `medium` |
| `theme` | `auto`, `light`, `dark`. SVG and PNG (`auto` renders dark as PNG) | `auto` |
| `scale` | `1`, `2`, `3`: pixel density. PNG only | `2` |

```bash
curl -s "https://three.ws/api/glance/card?agent=<agent-id>" | jq '.metric'
# { "label": "Moves today", "value": 17 }
```

The response carries an `ETag`; send it back as `if-none-match` and you get a `304`. Cards are cached for two minutes at the edge and served stale for ten while revalidating, so a widget board polling every fifteen minutes almost never touches the database.

`theme=auto` puts both palettes inside the SVG behind a `prefers-color-scheme` media query, which GitHub and Slack both honour, so one URL is correct in light mode and dark mode.

A missing agent answers `404` with a real card that says so, not a broken image. That matters when the card is sitting in someone's home screen slot.

`format=png` is the same card as a bitmap, for hosts that cannot draw SVG (Android's RemoteViews, WidgetKit, chat clients that only unfurl raster images). It is rasterized with sharp from the SVG, cached in object storage per agent, size, theme and density, and re-rendered only when the card's ETag changes.

### `GET /api/glance/mine`

The caller's own agent, plus the list of agents they own so a widget can be pointed at a different one. Two ways to say who is asking: the session cookie (what the Windows widget worker sends), or a widget token as `Authorization: Bearer glw_…` (what a native widget sends, because it has no session; see [native-widgets.md](native-widgets.md#how-the-widget-authenticates)).

Every state is a `200` with a designed card, never a `401`: a widget that renders an error is a widget people remove. `state` is one of `agent`, `signed-out`, `unlinked` (a revoked or unknown token), or `no-agent`; for the three non-agent states `card` is `null` and `notice` carries a card that says what to do next, with a tap target that does it.

`format=png` (with `size`, `theme`, `scale` as above) returns the bitmap for whichever state applies, with `x-glance-state`, `x-glance-url` (the tap target), `x-glance-name`, `x-glance-metric` and `x-glance-agent` in the headers, so a native widget learns everything from the one request that fetched the image.

Add `platform=ios` or `platform=macos` and an unlinked card's tap opens the Apple hand-off on `/glance` instead of the Android one. It changes nothing else, and omitting it keeps the Android behaviour the shipped app relies on.

### `POST | GET | PATCH | DELETE /api/glance/token`

The widget tokens. Session and same-site only. `POST { label?, platform?, agent? }` mints one and answers the plaintext exactly once, plus `links.android`, the `intent://` URL that hands it to the Android app, and `links.apple`, the `threews://glance/link` URL the Mac and iPhone apps claim. `GET` lists the caller's live tokens (prefix, label, platform, last seen), `PATCH { id, agent }` repoints one, `DELETE ?id=` revokes one. The revoke list on [/glance](https://three.ws/glance#devices) is this endpoint.

### `GET /api/glance/template`

The Adaptive Card template (version 1.6) that the Windows widgets board binds `/api/glance/mine` data to. `format=adaptive` on the card endpoint returns the same layout already bound, for hosts that do not template.

---

## On the Windows 11 widgets board

three.ws declares a `widgets` member in its PWA manifest, so the widget installs with the app: no store submission, no separate download.

1. Open [three.ws](https://three.ws) in Edge and install it (the install icon in the address bar).
2. Open the widgets board (`Win + W`) and choose **Add widgets**.
3. Pick **Agent glance**.

The board then talks to the site's service worker, which supplies the data:

| Event | What happens |
| --- | --- |
| `widgetinstall` | fetch `/api/glance/mine`, push it into the host |
| `widgetresume` | render from the cached payload, then refresh |
| `widgetclick` | refresh on demand |
| `widgetuninstall` | drop the cached payload |
| `periodicsync` | refresh every pinned widget on the platform's schedule |

Two behaviours are deliberate: signed out renders a sign-in card rather than an error, and an offline machine renders the last card it saw, labelled `(offline)`, rather than an empty slot. The implementation is [public/glance-sw.js](https://github.com/nirholas/three.ws/blob/main/public/glance-sw.js), covered by `tests/glance-sw.test.js`.

---

## The `<agent-glance>` element

```html
<script type="module" src="https://three.ws/glance/element.js"></script>
<agent-glance agent="<agent-id>" size="medium" theme="auto" refresh="300"></agent-glance>
```

| Attribute | Values | Default |
| --- | --- | --- |
| `agent` | agent uuid (required) | |
| `size` | `small`, `medium`, `large` | `medium` |
| `theme` | `auto`, `light`, `dark` | `auto` |
| `refresh` | seconds between refreshes, `0` disables | `300` |
| `origin` | override the API origin | `https://three.ws` |

It is real DOM inside a shadow root, so it is selectable, focusable and readable by a screen reader, and it cannot inherit or leak your page's CSS. It draws a skeleton while loading, a retry affordance on failure, and keeps the last good card if a later refresh fails. It stops polling entirely while the tab is hidden or the element is off screen.

Two events bubble: `glance:load` (detail is the card) and `glance:error` (detail is the error).

---

## The npm client

```bash
npm install @three-ws/agent-glance
```

```js
import { fetchGlanceCard, glanceImageUrl, glanceMarkdown } from '@three-ws/agent-glance';

const card = await fetchGlanceCard(id);
console.log(`${card.name}: ${card.metric.value} ${card.metric.label.toLowerCase()}`);
```

Zero dependencies, bounded deadlines on every call, and a `GlanceError` that carries `status` and `agentId`. An id that is not a uuid throws before any network call, so a typo fails at build time rather than rendering a broken image forever. Full reference: [packages/agent-glance/README.md](https://github.com/nirholas/three.ws/blob/main/packages/agent-glance/README.md).

---

## On an Android home screen

The three.ws Android app (1.1 and later) ships an **Agent glance** home screen widget: link the phone from [/glance](https://three.ws/glance#android), then add the widget from the launcher's picker. It fetches `/api/glance/mine?format=png` with its own token through WorkManager, keeps the last card when offline, and opens the agent on tap. Sizes, states, revocation and the native sources are all in [native-widgets.md](native-widgets.md#android).

---

## Where this is going

Glance is phase 5 of the [roadmap](https://github.com/nirholas/three.ws/blob/main/README.md#roadmap). Windows 11, Android and the web are live. macOS and iOS are built: one WidgetKit extension over the same PNG endpoint and the same widget token, sources in [apple/](https://github.com/nirholas/three.ws/tree/main/apple), waiting only on an Apple Developer account to sign and distribute the two binaries. See [native-widgets.md](native-widgets.md).

Every one of those surfaces consumes the endpoint documented above. The card is the contract; the hosts are just slots.
