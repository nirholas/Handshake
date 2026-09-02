# Glance Card v1

The wire format behind [`/api/glance/card`](../docs/glance.md). One three.ws agent, reduced to what fits in an operating system widget slot, a README badge, or a chat unfurl.

- **Endpoint:** `GET https://three.ws/api/glance/card?agent=<uuid>`
- **Media types:** `application/json` (default), `image/svg+xml` (`format=svg`), `image/png` (`format=png`), Adaptive Card 1.6 JSON (`format=adaptive`)
- **Owner endpoint:** `GET https://three.ws/api/glance/mine` (session cookie or widget token), same encodings minus SVG and Adaptive
- **Companion specs:** [3D_AGENT_CARD.md](3D_AGENT_CARD.md) (the on-chain identity document), [EMBED_SPEC.md](EMBED_SPEC.md) (the 3D embed)

## Why it exists

Every widget host the platform targets (the Windows 11 widgets board, Android app widgets, WidgetKit on Apple platforms) shares two constraints: none of them can execute WebGL, and each one wants a different container format. Without a pinned card, each surface would grow its own query against the agent tables and they would drift apart within a release.

v1 pins one model, computed once on the server, that every surface renders. Adding a surface is a rendering job, not a data job.

## Document

```json
{
	"version": 1,
	"id": "0f3a1c22-9b7e-4d51-8a10-2c6f5d90ab34",
	"name": "Atlas Scout",
	"description": "Watches the launch feed and reports what matters.",
	"url": "https://three.ws/agents/0f3a1c22-9b7e-4d51-8a10-2c6f5d90ab34",
	"createUrl": "https://three.ws/create",
	"image": "https://three.ws/cdn/u/…/thumb.png",
	"monogram": "AS",
	"accent": { "from": "hsl(235 82% 58%)", "to": "hsl(283 84% 46%)", "hue": 235 },
	"status": "active",
	"headline": "Working.",
	"metric": { "label": "Moves today", "value": 17 },
	"stats": [
		{ "label": "This week", "value": 96 },
		{ "label": "All time", "value": 412 },
		{ "label": "Skills", "value": 4 }
	],
	"lastAction": { "type": "skill.invoke", "at": "2026-08-28T11:00:00.000Z", "relative": "1h ago" },
	"bornAt": "2026-08-01T00:00:00.000Z",
	"ageDays": 27,
	"updatedAt": "2026-08-28T12:00:00.000Z",
	"ttl": 120
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | integer | yes | `1`. A consumer MUST ignore a document whose version it does not know. |
| `id` | uuid | yes | The platform agent id. |
| `name` | string | yes | At most 64 characters, already truncated server-side. |
| `description` | string \| null | yes | At most 160 characters. `null` when the agent has none. |
| `url` | url | yes | The agent's page. Where a tap on the card goes. |
| `createUrl` | url | yes | Where a card with nothing to show sends the viewer. |
| `image` | url \| null | yes | The avatar thumbnail. `null` unless the avatar's visibility is `public` or `unlisted`. |
| `monogram` | string | yes | One or two characters. What a renderer draws when `image` is `null`. |
| `accent` | object | yes | `{ from, to, hue }`, derived from `id`. Stable across requests. |
| `status` | enum | yes | `active` \| `idle` \| `new`. |
| `headline` | string | yes | One line, written for the status. |
| `metric` | object | yes | `{ label, value }`. The one number the card exists to show. |
| `stats` | array | yes | Exactly three `{ label, value }` entries. |
| `lastAction` | object \| null | yes | `{ type, at, relative }`, or `null` when the agent has never acted. |
| `bornAt` | ISO 8601 \| null | yes | When the agent was created. |
| `ageDays` | integer \| null | yes | Whole days since `bornAt`. |
| `updatedAt` | ISO 8601 | yes | When this document was computed. |
| `ttl` | integer | yes | Seconds the server considers this document fresh. |

`cache` (`"hit"` or `"miss"`) may also be present. It is a server diagnostic; consumers MUST NOT depend on it.

## Status

| Value | Meaning |
| --- | --- |
| `active` | The agent's last action is under 24 hours old. |
| `idle` | The agent has acted, but not in the last 24 hours. |
| `new` | The agent has never acted. |

A renderer SHOULD signal status visually (the reference renderers use a green, amber, or grey dot) and MUST render `headline` rather than inventing its own empty-state copy: a `new` agent's card is an invitation, not a zero.

## Conformance

A renderer conforms to Glance Card v1 if:

1. It renders `name`, `metric.value` and `metric.label` for every card.
2. It falls back to `monogram` over `accent` whenever `image` is `null`, and never renders a broken image element.
3. Activating the card opens `url`.
4. It refreshes no more often than `ttl` seconds.
5. It treats every string field as untrusted text: agent names and descriptions are user-supplied and MUST be escaped for the output format. The reference SVG renderer also strips XML control characters, which are the byte class that makes a document unparseable for one bad byte.

A producer conforms if it serves the fields above with an `ETag` and honours `if-none-match`.

## Sizes

The SVG rendering serves three sizes, chosen to match the slots the widget boards hand out:

| Name | Pixels | Slot |
| --- | --- | --- |
| `small` | 240x240 | Android 2x2, iOS small, Windows small |
| `medium` | 480x200 | Android 4x2, Windows medium, README badge |
| `large` | 480x300 | Windows large, a dashboard tile |

## PNG encoding

`format=png` rasterizes the SVG at `scale` (1, 2 or 3) times the size above, so `medium` at `scale=2` is 960x400 pixels. `theme` is `dark` or `light`; a renderer that cannot ask the reader for a preference (every native widget host) MUST request one explicitly, and the server resolves `auto` to `dark`. The avatar image is inlined before rasterizing; an image that cannot be fetched degrades to the monogram exactly as in the SVG conformance rule.

## Notice cards

A response that has no agent to show (signed out, an unlinked widget token, an account with no agent, an unknown id) carries a document with the same fields, `id` set to `"notice"` (or `"missing"` for an unknown id), `image` `null`, `status` `"new"`, every numeric field `0`, and `headline` and `url` set to the next step (sign in, relink, create). A renderer treats it as any other card; that is the point.

## Owner endpoint and widget tokens

`GET /api/glance/mine` answers for the caller rather than for an id. It identifies the caller by the session cookie or by a **widget token** presented as `Authorization: Bearer glw_…` (or `?token=`). Tokens are minted by the owner at `POST /api/glance/token`, are 36 characters (`glw_` plus 32 URL-safe characters), are stored hashed, read this one endpoint and nothing else, and are revocable at `DELETE /api/glance/token?id=`.

The JSON answer is `{ signedIn, state, via, card, notice, agents, signInUrl, createUrl, linkUrl }` with `state` one of `agent`, `signed-out`, `unlinked`, `no-agent`. When `state` is `agent`, `card` is the document above and `notice` is `null`; otherwise `card` is `null` and `notice` is a notice card.

The PNG answer is always status `200` and carries the same facts in headers, so a host that only downloads a bitmap still learns where a tap goes:

| Header | Value |
| --- | --- |
| `x-glance-state` | the `state` above |
| `x-glance-url` | the card's `url`, the tap target |
| `x-glance-name` | `name`, ASCII-filtered |
| `x-glance-metric` | `"<value> <label>"` |
| `x-glance-agent` | the agent id, empty for a notice |
| `x-glance-updated` | `updatedAt` |
| `x-glance-width`, `x-glance-height` | bitmap pixels |

## Versioning

New optional fields are additive and do not bump `version`. Removing a field, changing a type, or changing the meaning of `metric` requires v2 served alongside v1; the `version` field is what lets a widget pinned a year ago keep rendering.

## Reference implementation

- Model: [api/_lib/glance-card.js](../api/_lib/glance-card.js)
- SVG: [api/_lib/glance-svg.js](../api/_lib/glance-svg.js)
- Adaptive Card: [api/_lib/glance-adaptive.js](../api/_lib/glance-adaptive.js)
- PNG: [api/_lib/glance-png.js](../api/_lib/glance-png.js)
- Widget tokens: [api/_lib/glance-tokens.js](../api/_lib/glance-tokens.js), [api/glance/token.js](../api/glance/token.js)
- Endpoints: [api/glance/card.js](../api/glance/card.js), [api/glance/mine.js](../api/glance/mine.js)
- Android renderer: [solana-mobile/android-overlay/](../solana-mobile/android-overlay/README.md)
- Conformance tests: [tests/glance-card.test.js](../tests/glance-card.test.js), [tests/glance-png.test.js](../tests/glance-png.test.js), [tests/glance-tokens.test.js](../tests/glance-tokens.test.js)
