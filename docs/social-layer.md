# The social layer: feed, follows, notifications, rankings, portfolios

Shipped in July 2026, the social layer connects every creation surface on
three.ws (forge, dioramas, agents, coin launches, walking) into one graph:
you follow creators, their work shows up in your feed, milestones ring your
notification bell, and everyone's output rolls up into portfolios and a
cross-surface leaderboard. This page maps the whole layer: the pages, the
APIs, and how the pieces feed each other.

There is no separate "social events" database to drift out of sync. The feed,
portfolios, rankings, and search all read from the same records the rest of
the platform already writes (`forge_creations`, `dioramas`, `pump_agent_mints`,
`user_follows`, `walk_metrics`).

| Piece | Page | API |
|---|---|---|
| Activity feed | [/feed](https://three.ws/feed), [/community](https://three.ws/community) | `GET /api/users/me/feed` |
| Follow graph | Follow buttons on `/u/:username` | `GET|POST|DELETE /api/users/:username/follow` |
| Notification bell | Bell in the header, preferences in `/dashboard/settings` | `GET /api/notifications` + `/preferences` |
| Leaderboard, streaks, badges | [/rankings](https://three.ws/rankings) | `GET /api/leaderboard/unified` |
| Creator portfolio | `/u/:username` | `GET /api/users/:username/creations` |
| Cross-entity search | [/search](https://three.ws/search) | `GET /api/search` |
| Onboarding tour | [/start](https://three.ws/start) | `GET /api/me` (`show_onboarding_tour`) |

How they interconnect:

- **Follow feeds everything.** A new follow edge fires a bell notification for
  the followed user, unlocks the `scope=following` feed for the follower,
  boosts the followed creator in search ranking, and counts toward the
  `followers` leaderboard metric.
- **Every feed item links to a portfolio.** Feed cards deep-link to
  `/u/:username`, where the same records render as that creator's portfolio.
- **Creating anything advances your streak.** Forging a model, saving a world,
  or walking while signed in calls the streak engine, which in turn awards the
  badges shown on `/rankings` and your profile.

---

## Activity feed: `/feed` and `/community`

`/feed` is your personal feed (accounts you follow). `/community` leads with
the same API in platform-wide mode, so it doubles as the feed for first-time
visitors with no follows yet.

```
GET /api/users/me/feed?scope=following|all&limit=30&before=<iso>
```

- `scope=following` (default) needs a session; anonymous callers get a 401 so
  the client can route to sign-in.
- `scope=all` is public: platform-wide recent activity.
- `limit` is 1..50 (default 30); `before` is an ISO-timestamp cursor (pass the
  last item's `created_at` back for infinite scroll).

Every item is
`{ kind, id, created_at, actor, title, subtitle?, href, image?, external?, isRemix? }`
where `actor` is `{ username, display_name, avatar_url }`. Items of
`kind: "follow"` additionally carry a `target` shaped like `actor`.
`actor.username` is `null` for creations made while signed out; the client
renders those without a profile link rather than inventing one.

Item kinds: avatar, agent, coin, model, and world creations, plus `follow`
events. They are merged live from `forge_creations`, `dioramas`, and
`user_follows` at read time.

> Source: [api/users/me/feed.js](../api/users/me/feed.js). Not to be confused
> with `GET /api/feed`, the public Money Pulse ticker backed by Redis; see
> [Money Feed](./money-feed.md) for that one.

## Follow graph

The social-graph edge behind everything above.

```
GET    /api/users/:username/follow    → { following, followed_by, followers_count, following_count }
POST   /api/users/:username/follow    → follow   (idempotent)
DELETE /api/users/:username/follow    → unfollow (idempotent)
```

- `following` = does the signed-in viewer follow this user; `followed_by` =
  do they follow the viewer back. Both `false` for anonymous viewers; the GET
  is never cached (viewer-specific).
- POST/DELETE require a session + CSRF token, return the same envelope as GET
  (one round-trip updates the button and the counts), block self-follows
  (400), and 401 for anonymous callers.
- A genuinely new edge (insert with `ON CONFLICT DO NOTHING`) publishes a
  `follow` user event, so the followed user's bell rings exactly once no
  matter how many times the button is clicked.

```
GET /api/users/:username/follows?type=followers|following&limit=50&offset=0
```

Lists either side of the graph (limit 1..100); each row carries
`is_following` so the client can render its own follow-back buttons.

> Source: [api/users/[username]/follow.js](../api/users/%5Busername%5D/follow.js),
> [api/users/[username]/follows.js](../api/users/%5Busername%5D/follows.js),
> table `user_follows`. Tests: [tests/api/users-follow.test.js](../tests/api/users-follow.test.js).

## Notification bell

The header bell is an inbox over `user_notifications`, fed by the per-user
event vocabulary in [api/_lib/feed.js](../api/_lib/feed.js)
(`USER_EVENT_TYPES` → `publishUserEvent()` → `insertNotification`). Recent
additions to the vocabulary:

| Event | Fired from |
|---|---|
| `remix` (someone remixed your model) | [api/x402/remix-asset.js](../api/x402/remix-asset.js) |
| `dm_received` | [api/friends/messages.js](../api/friends/messages.js) |
| `pump_launch_filled` (your coin graduated its bonding curve) | the pump cron in [api/cron/[name].js](../api/cron/%5Bname%5D.js) |
| `follow` | the follow endpoint above |

Endpoints:

```
GET   /api/notifications?limit=…        → the inbox, newest first
POST  /api/notifications/:id/read      → mark one read
POST  /api/notifications/read-all      → mark everything read
POST  /api/notifications/track         → delivery/click tracking
GET   /api/notifications/preferences   → the preference matrix
PATCH /api/notifications/preferences   → update it
```

Preferences are a category × channel matrix
([api/_lib/notify-prefs.js](../api/_lib/notify-prefs.js)): categories are
sales, purchases, social, IRL, market, and account; channels are `in_app`,
`push`, `email`, and `telegram`. The in-app channel is always on (the bell
never goes silent); the other channels are per-category opt-outs, edited from
the Notifications panel in `/dashboard/settings`
([src/dashboard-next/pages/settings.js](../src/dashboard-next/pages/settings.js)).
Bell client: [src/notifications.js](../src/notifications.js).

## Leaderboard, streaks, and badges: `/rankings`

One leaderboard across every surface, plus daily streaks and badges.

```
GET /api/leaderboard/unified?metric=creations&limit=50&offset=0
```

`metric` is one of `creations`, `remixes_received`, `launches`, `followers`,
`walk_distance` (limit 1..100, default 50). Sending the request with a session
or Bearer token pins your own row into the response even when you are outside
the page window.

The streak engine ([api/_lib/streaks.js](../api/_lib/streaks.js),
`recordDailyActivity()`) is called from sign-in, forge saves, diorama saves,
and walk metrics, and writes `user_streaks` / `user_badges`. A daily rollup
cron ([api/cron/leaderboard-rollup.js](../api/cron/leaderboard-rollup.js))
sweeps badge awards. Badges and streaks also render on profile pages.

> Page: [pages/rankings.html](../pages/rankings.html).
> Source: [api/leaderboard/unified.js](../api/leaderboard/unified.js).

## Creator portfolio: `/u/:username`

Every forge model and saved world a creator makes while signed in is
attributed to them at create time (`user_id` on `forge_creations` and
`dioramas`) and aggregates onto their public profile.

```
GET /api/users/:username            → public profile
GET /api/users/:username/creations  → cursor-paginated portfolio items
```

Attribution links point back here from the diorama viewer and gallery and
from the forge result bar, so any model you encounter on the platform is one
click from the person who made it.

> Page: [pages/profile.html](../pages/profile.html) (also serves `/profile`
> for self-view; signed-out visitors get a claim-your-handle CTA, not a
> sign-in wall). Source: [api/users/[username].js](../api/users/%5Busername%5D.js),
> [api/users/[username]/creations.js](../api/users/%5Busername%5D/creations.js).

## Cross-entity search: `/search`

One query across everything creatable on the platform.

```
GET /api/search?q=<text>&type=all|avatar|agent|model|world|coin&limit=18
```

Five sources are queried in parallel
([api/_lib/cross-search.js](../api/_lib/cross-search.js)): avatars, on-chain
and Solana agents, forged models, worlds, and coins (platform launches first,
then external token search). Ranking is recency first, boosted by follower,
remix, and view signals. `limit` is 4..48 (default 18); a scoped `type` search
gives the full limit to that one source.

Model results carry a `remix` block wired to `POST /api/x402/remix-asset`;
other types deliberately do not get a fake Remix button.

> Page: [pages/search.html](../pages/search.html), client
> [src/search-page.js](../src/search-page.js). Source: [api/search.js](../api/search.js).

## Onboarding tour: `/start`

A self-referential guided tour that chains the platform's own surfaces:
selfie-to-avatar → build a world → markets → create an agent (skippable) →
your profile. The curriculum lives in
[public/tour/curriculum.json](../public/tour/curriculum.json) (built by
[scripts/build-tour.mjs](../scripts/build-tour.mjs)); the engine is
[src/feature-tour/](../src/feature-tour/).

First-visit targeting: `GET /api/me` returns `show_onboarding_tour`, backed by
`users.onboarding_tour_seen_at` / `onboarding_tour_completed_at`. The tour can
be replayed any time from the getting-started page.

---

## Related pages

- [Money Feed](./money-feed.md): the value-movement ticker (`GET /api/feed`),
  a different feed from the activity feed documented here.
- [Remix economy](./remix.md): what happens after someone finds your model in
  the feed or search.
- [API reference: Social & Community](./api-reference.md#social--community-api)
  for the full request/response contracts.
