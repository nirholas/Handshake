# Walk Leaderboard

Every step your avatar takes on three.ws is measured, rolled up, and ranked. The **Walk Leaderboard** is the public board for it: walkers ordered by **distance walked**, **sites visited**, or **time on their feet**, over **today**, **this week**, or **all time**. Signed-in accounts and anonymous walkers compete on the same board, and your own row is always pinned to the bottom of the page even when your rank is off-screen.

Live at `three.ws/walk-leaderboard`. Backed by one endpoint, `GET /api/walk/leaderboard`, over the `walk_metrics` rollup that `POST /api/walk/metrics` writes.

Code: [pages/walk-leaderboard.html](../pages/walk-leaderboard.html) (page and its inline module), [api/walk/leaderboard.js](../api/walk/leaderboard.js) (ranking), [api/walk/metrics.js](../api/walk/metrics.js) (ingest), [src/walk.js](../src/walk.js) (the accumulator in the walk runtime), [api/\_lib/migrations/20260621140000\_walk\_metrics.sql](../api/_lib/migrations/20260621140000_walk_metrics.sql) (schema).

---

## What is measured

Three metrics, all derived from the same rollup table. Pick one with the **Distance / Sites / Time** control; it becomes the ranked column.

| Metric | Column and aggregate | What it actually counts |
| --- | --- | --- |
| `distance` | `sum(distance_meters)` | Metres the avatar moved horizontally in the 3D scene, integrated per frame from the controller's resolved displacement. Rendered as metres under 1 km, kilometres above. |
| `time` | `sum(duration_sec)` | Seconds spent *moving*. Idle time is not counted (see the motion gate below). Rendered as seconds, minutes, or hours. |
| `sites` | `count(distinct coalesce(embed_origin, site_hostname))`, non-null only | Distinct third-party hosts the avatar walked on. `embed_origin` is derived server-side from the request's `Origin` or `Referer`; `site_hostname` is the host an external pilot (such as a browser extension) reports. |

Two consequences of how `sites` is defined, stated plainly because they are easy to misread:

- **three.ws itself never counts as a site.** `deriveEmbedOrigin()` returns `null` for `three.ws`, `www.three.ws`, and `localhost`, so a walk on the platform's own pages adds distance and time but contributes nothing to the sites metric. That is deliberate: "unique sites" is meant to measure reach across the web, not our own surfaces.
- **A row only reaches the sites metric if a client supplies one of those two dimensions.** The metric is a real query over real columns, so as soon as an off-platform embed or pilot posts from its own host, its walkers rank on it. In the current tree the only client that flushes metrics is the walk runtime served from three.ws, so the sites column is sparse in practice while distance and time are fully populated.

Values are rounded to two decimals in the response. A walker with a zero (or absent) value for the selected metric and window is excluded from the ranking entirely (`having <aggregate> > 0`), which is why the daily board is short early in a UTC day.

### The delta column

Every row carries `deltaFromYesterday`: the same metric earned **today** minus the same metric earned **yesterday**, both as UTC days. It is momentum, not a total, and it is computed identically for all three time windows, so the "vs. yesterday" column means the same thing whether you are looking at the daily, weekly, or all-time board. Zero renders as a neutral dash rather than `+0`.

---

## The three views

`?period=` selects the window, all boundaries in UTC:

| View | `period` | Window |
| --- | --- | --- |
| Today | `daily` | Rows whose `day` is the current UTC date. |
| This Week | `weekly` (default) | The current UTC date and the previous 6 days, so a rolling 7 days rather than a calendar week. |
| All Time | `all-time` | No lower bound. |

The page defaults to **This Week / Distance**. Switching either control refetches from offset 0. Both control groups are ARIA tablists with left and right arrow-key navigation, and the board sets `aria-busy` while loading.

Ranking rules:

- Walkers are sorted by the window value descending, with ties broken deterministically by walker key (`u:<userId>` or `a:<anonId>`), so equal totals never shuffle between requests.
- Ranks are sequential positions in that sorted list (1, 2, 3, ...). The top three render medals instead of a number.
- `total` is the count of all qualifying walkers, not the page size, so `hasMore` is exact.
- Pagination is `limit` (1 to 100, default 50) and `offset`. **Show more** appends the next page in place.

### Identity on the board

- **Signed-in walkers** show `@username` (or their display name when no username is set), link to `/u/<username>`, and carry an avatar thumbnail: the most recently created non-deleted avatar the account owns that has a thumbnail, which is not necessarily the avatar they walked with.
- **Anonymous walkers** rank too, under a derived handle: `walker-` plus the last four alphanumeric characters of their anonymous id. No profile link, and an initial-letter fallback tile instead of a thumbnail.
- **Your own row** is resolved from a session cookie, a bearer token, or the `anonId` query parameter, and returned as `me` even when it falls outside the requested page. `me.onPage` tells the client whether it is already visible above. A walker with an identity but no qualifying metrics in the window comes back as `me` with `rank: null`, `value: 0`, and `unranked: true`, which the page renders as a dash rather than hiding you.

The page reads `localStorage['twx_walk_anon']` to pass `anonId`. It only reads, never creates, that key: the walk runtime is what mints it. So the pinned row appears for anonymous walkers who have actually walked, and simply does not appear for a first-time visitor.

---

## How a walk session is counted

The board never talks to the walk runtime directly. One ingest feeds it.

**1. Per-frame accumulation.** `accumulateWalkMetrics(dt)` runs once per rendered frame in the walk runtime. It takes the horizontal displacement between this frame's avatar position and the last one (`hypot(dx, dz)`) and adds it to a pending distance, plus `dt` to a pending duration, but only when all three of these hold:

- the step is larger than 0.001 m, so a standing avatar accrues no phantom distance from float jitter;
- the step is smaller than 5 m, so a teleport, a spawn, or a world swap is discarded rather than banked as a sprint;
- the controller's motion state is `walk` or `run`, so time only accrues while actually moving.

**2. Session counting.** The first qualifying movement flips a `counted` flag. The first flush that carries it sends `sessions: 1`, and a `sessionFlushed` flag makes sure the same page load never counts a second session. So a session is "one page load in which the avatar genuinely moved", not a timer and not a page view.

**3. Flush cadence.** Batches go to `POST /api/walk/metrics` every 60 s via `fetch` with `keepalive`, and once more on `pagehide` or on `visibilitychange` to hidden via `navigator.sendBeacon`, so the final partial minute survives a tab close or an app backgrounding. Pending counters reset on dispatch. A flush with nothing to report is skipped entirely, and a failed flush is swallowed: metrics never surface an error to the walker.

**4. Rollup on the server.** Each batch UPSERTs into a per-`(walker, UTC day, environment, embed origin, avatar)` row in `walk_metrics`, adding its increments onto whatever is there. The unique index is over the COALESCE'd dimension tuple (Postgres treats NULLs as distinct, which would otherwise spawn a new row per batch and break the rollup). An hour of walking is therefore a handful of rows, not thousands, and the leaderboard aggregates over a compact indexed table.

**5. Attribution.** A signed-in session or bearer wins and the batch is keyed to `user_id`. Otherwise it is keyed to the client's `anonId`, a stable id persisted in `localStorage` (or a per-page id when storage is blocked). A batch with neither identity is accepted with `202` and explicitly not recorded.

The same batch also carries any achievement thresholds the runtime crossed this session. The ingest persists them once each into `walk_achievements` under a per-`(walker, code)` unique index, from an allowlist of four codes: `distance_1km`, `distance_5km`, `sites_10`, and `all_environments`. The walk runtime currently fires three of them (1 km walked, 5 km walked, and all six environments in one session), each with a toast; `sites_10` is accepted by the ingest but has no client that fires it. And for signed-in walkers a batch with real metrics counts as a qualifying daily activity for the cross-surface streak.

### What feeds the board today

Only the walk runtime in [src/walk.js](../src/walk.js) flushes metrics, so the board is fed by the pages that load it: `/temporary` (including the `/wk/:avatar` short link, which redirects there) and `/marketplace-walk`. The chrome-less embed runtime, [src/walk-embed.js](../src/walk-embed.js), is a deliberate fork of the same engine for iframes and does not currently flush, so `/walk/app` and the iframe embeds on the `/walk` landing page do not accrue leaderboard distance.

---

## What prevents trivially faking distance

As coded, in layers. Each one bounds a different kind of nonsense:

| Guard | Where | Effect |
| --- | --- | --- |
| Teleport rejection: a single frame moving 5 m or more is discarded | `accumulateWalkMetrics` in [src/walk.js](../src/walk.js) | A world swap, respawn, or position restore cannot be laundered into distance. |
| Jitter floor: steps at or below 0.001 m are ignored | same | A parked avatar earns nothing, so leaving a tab open all day adds zero distance. |
| Motion gate: only `walk` and `run` states accumulate | same | Idle, gesture, and cutscene time do not count toward the time metric. |
| Per-batch ceilings: `distanceMeters` at most 50000, `durationSec` at most 86400, `sessions` at most 50 | zod schema in [api/walk/metrics.js](../api/walk/metrics.js) | A batch claiming an implausible jump is rejected outright with `400 validation_error`, not clamped and stored. A brisk walk is about 1.4 m/s, so even a ten-minute batch is well under a kilometre. |
| Strict schema | same | Unknown fields are rejected (`.strict()`), so the ingest has no room for extra dimensions a caller might invent. |
| Server-derived origin | `deriveEmbedOrigin()` in [api/walk/metrics.js](../api/walk/metrics.js) | `embedOrigin` is accepted in the schema for forward compatibility and then ignored: the stored value always comes from the request's `Origin` or `Referer`. A caller cannot attribute walks to a host it does not control, so the sites metric cannot be inflated with invented hostnames. |
| Identity requirement | same | A batch with neither a session nor an `anonId` is a no-op `202`. Nothing anonymous-and-unkeyed can enter the rollup. |
| Rate limit: 60 requests per minute per IP | `limits.irlInteractIp` | Matches the roughly one-per-minute flush cadence plus retries, and caps how many batches one address can land. |
| Achievement allowlist | same | Only the four known codes persist, and each unlocks once per walker, so badges cannot be farmed by replaying a batch. |
| Idempotent rollup | unique index in [the migration](../api/_lib/migrations/20260621140000_walk_metrics.sql) | Batches merge into one row per dimension tuple per day, so the table cannot be flooded into a different shape. |

**What these guards do and do not claim.** `POST /api/walk/metrics` is a public, open-CORS ingest keyed on a client-supplied anonymous id, because embeds post from third-party hosts and anonymous walkers are first-class on the board. The guards above bound the size, rate, and attribution of any single claim; they do not cryptographically prove that a walk happened. There is no cross-batch plausibility check (for example, distance against elapsed duration) and no server-side replay of the controller. Treat the board as a gamified activity ranking, not as an audited measurement. If you need a movement claim that a third party can verify, that is a different product: [World Lines](./world-lines.md) issue agent-signed proofs of physical presence with server-derived co-location.

---

## API

### `GET /api/walk/leaderboard`

Public. Open CORS (`GET`, `OPTIONS`). Rate limited at 240 requests per minute per IP. Cached at the edge with `public, max-age=15, s-maxage=30, stale-while-revalidate=60`, so the board is live without every switch of a control hitting the database.

| Parameter | Values | Default |
| --- | --- | --- |
| `period` | `daily` \| `weekly` \| `all-time` | `weekly` |
| `metric` | `distance` \| `sites` \| `time` | `distance` |
| `limit` | 1 to 100 | 50 |
| `offset` | 0 or greater | 0 |
| `anonId` | a stable anonymous walker id, to pin that walker's row | none |

Identity for the pinned `me` row comes from an `Authorization: Bearer` token, the session cookie, or `anonId`, in that order.

```bash
curl -s 'https://three.ws/api/walk/leaderboard?period=weekly&metric=distance&limit=3'
```

```json
{
  "period": "weekly",
  "metric": "distance",
  "total": 128,
  "limit": 3,
  "offset": 0,
  "hasMore": true,
  "rows": [
    {
      "rank": 1,
      "key": "u:8f14e45f-ceea-467a-9c4b-2b0a1d5f7c31",
      "userId": "8f14e45f-ceea-467a-9c4b-2b0a1d5f7c31",
      "anonId": null,
      "username": "ada",
      "handle": "@ada",
      "profileUrl": "/u/ada",
      "avatarId": "c9d2a71e-3b44-4f88-9a01-6de5f2b7c410",
      "avatar": "https://<avatar-cdn-domain>/u/8f14e45f-ceea-467a-9c4b-2b0a1d5f7c31/thumb.webp",
      "value": 18452.31,
      "deltaFromYesterday": 1240.5
    },
    {
      "rank": 2,
      "key": "a:anon_4f6c2b19-77d3-4a2e-9b58-0c1e7a3d55e2",
      "userId": null,
      "anonId": "anon_4f6c2b19-77d3-4a2e-9b58-0c1e7a3d55e2",
      "username": null,
      "handle": "walker-55e2",
      "profileUrl": null,
      "avatarId": null,
      "avatar": null,
      "value": 15990.08,
      "deltaFromYesterday": -320.75
    },
    {
      "rank": 3,
      "key": "u:2b6f0cc9-04e0-4b1f-9c8a-77d5b2e13a90",
      "userId": "2b6f0cc9-04e0-4b1f-9c8a-77d5b2e13a90",
      "anonId": null,
      "username": null,
      "handle": "three.ws walker",
      "profileUrl": null,
      "avatarId": null,
      "avatar": null,
      "value": 14201.4,
      "deltaFromYesterday": 0
    }
  ],
  "me": null
}
```

Pin an anonymous walker's own row:

```bash
curl -s 'https://three.ws/api/walk/leaderboard?period=daily&metric=time&limit=1&anonId=anon_4f6c2b19-77d3-4a2e-9b58-0c1e7a3d55e2'
```

```json
{
  "period": "daily",
  "metric": "time",
  "total": 41,
  "limit": 1,
  "offset": 0,
  "hasMore": true,
  "rows": [
    {
      "rank": 1,
      "key": "u:8f14e45f-ceea-467a-9c4b-2b0a1d5f7c31",
      "userId": "8f14e45f-ceea-467a-9c4b-2b0a1d5f7c31",
      "anonId": null,
      "username": "ada",
      "handle": "@ada",
      "profileUrl": "/u/ada",
      "avatarId": "c9d2a71e-3b44-4f88-9a01-6de5f2b7c410",
      "avatar": "https://<avatar-cdn-domain>/u/8f14e45f-ceea-467a-9c4b-2b0a1d5f7c31/thumb.webp",
      "value": 5402.7,
      "deltaFromYesterday": 900.1
    }
  ],
  "me": {
    "rank": 7,
    "key": "a:anon_4f6c2b19-77d3-4a2e-9b58-0c1e7a3d55e2",
    "userId": null,
    "anonId": "anon_4f6c2b19-77d3-4a2e-9b58-0c1e7a3d55e2",
    "username": null,
    "handle": "walker-55e2",
    "profileUrl": null,
    "avatarId": null,
    "avatar": null,
    "value": 1843.2,
    "deltaFromYesterday": 612.4,
    "onPage": false
  }
}
```

Errors: `400 bad_period`, `400 bad_metric`, `429` when the public per-IP limit trips. Out-of-range `limit` and `offset` are clamped rather than rejected.

### `POST /api/walk/metrics` (the ingest)

The board's write side, shared with the per-creator embed analytics dashboard. Open CORS so third-party embeds can post. Body fields relevant to the leaderboard:

| Field | Type | Notes |
| --- | --- | --- |
| `distanceMeters` | number, 0 to 50000 | Increment since the last flush. |
| `durationSec` | number, 0 to 86400 | Increment since the last flush. |
| `sessions` | integer, 0 to 50 | Send `1` once per page load that produced real movement. |
| `anonId` | string, 8 to 64 chars | Required when there is no session or bearer. |
| `envId` | string | Walk environment name, a rollup dimension. |
| `avatarId` | uuid | The avatar being walked, a rollup dimension. |
| `siteHostname` | string | The host an external pilot reports, feeding the sites metric. |
| `achievements` | array, up to 8 | Codes from the allowlist; anything else is dropped. |
| `eventName`, `value` | string, number | Creator-defined conversion event for the analytics funnel, not the leaderboard. |
| `embedOrigin` | string | Accepted and ignored; the stored origin is always server-derived. |

```bash
curl -s https://three.ws/api/walk/metrics \
  -H 'content-type: application/json' \
  -d '{"distanceMeters":412.5,"durationSec":295.4,"sessions":1,"envId":"park","anonId":"anon_4f6c2b19-77d3-4a2e-9b58-0c1e7a3d55e2"}'
```

```json
{ "ok": true, "recorded": true }
```

A batch with no identity returns `202` with `{ "ok": false, "reason": "no walker identity", "recorded": false }`. A batch that violates a ceiling returns `400 validation_error` naming the field.

---

## Privacy and identity

No geolocation is involved anywhere on this surface. Distance is virtual-world displacement in a 3D scene, not GPS, so nothing here touches the presence machinery that gates the real-world features. What the board stores about a walker is an account id or a client-generated anonymous id, plus per-day totals and rollup dimensions.

The anonymous id is generated and persisted by the walk runtime in `localStorage` under `twx_walk_anon` and is the only thing linking an anonymous walker's rows across visits. Clearing site data ends that continuity: the old rows stay on the board under their old derived handle and a new id starts from zero. Public rows expose only the derived `walker-xxxx` handle, never the full id, and never an IP.

---

## Related

- [Add the Walk Companion to your site](./tutorials/walk-companion.md), the hands-on path from a copy-paste iframe to the `@three-ws/walk` package, including the surfaces that produce the metrics ranked here.
- The walk documentation set on the site, served from `public/docs/walk/`: `/docs/walk` (index), `/docs/walk/walk-page`, `/docs/walk/embed-iframe`, `/docs/walk/embed-sdk`, `/docs/walk/companion-mode`, `/docs/walk/chrome-extension`, `/docs/walk/postmessage-events`, and `/docs/walk/analytics`, which covers the per-creator dashboard fed by the same ingest.
- The creator-side view of this data: `three.ws/walk-analytics`, backed by `GET /api/walk/analytics`.
- [World Lines](./world-lines.md), for movement claims that carry a verifiable agent signature rather than a leaderboard rank.
