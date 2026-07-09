# Avatar thumbnails

Every avatar on three.ws should have a small, fast-loading image the galleries can
show instead of downloading a multi-megabyte GLB. This page explains where those
images come from, the one rule every code path must obey, and how to operate the
backfill.

## The rule

> **A `thumbnail_key` is only ever persisted after the object behind it has been
> confirmed to exist in R2.**

This is not style advice. `avatars.thumbnail_key` is turned into a public URL by
`publicUrl()` and handed to the browser inside an `<img>`. If the key points at an
object that was never written, R2 answers `404` with a `text/plain` body. Chrome's
Opaque Response Blocking then refuses the response — because a `text/plain` body is
not a valid image — and logs:

```
GET https://<bucket>.r2.dev/thumb/<avatarId>.png net::ERR_BLOCKED_BY_ORB
```

The homepage shipped exactly that bug: it *guessed* `thumb/<avatarId>.png` whenever
the API honestly reported "no thumbnail", producing five blocked requests on every
visit. The APIs were already correct — `/api/explore` returns `image: null` and
`/api/marketplace` returns `thumbnail_url: null` — so the fix was to stop guessing
and render the designed initial-letter placeholder instead.

**Never synthesise a thumbnail URL on the client.** If the API gives you `null`,
that avatar has no thumbnail; show a placeholder.

## Where a thumbnail comes from

`avatars.thumbnail_key` holds a **relative** R2 key. An absolute URL in that column
is treated as missing everywhere (`api/explore.js` drops it; the backfill replaces
it), because `publicUrl()` passes absolute values through untouched and they resolve
against an origin where no object lives.

There are three writers, cheapest first.

### 1. Forge preview adoption (free)

An avatar forged from a `forge_creations` row can point straight at that creation's
already-uploaded preview image (`forge_creations.preview_key`). The object exists,
its `Content-Type` is already correct, and `/forge`'s own gallery has always
rendered it. Adoption costs zero bytes and zero render time.

This happens automatically at insert time in
[`api/cron/forge-seed-cron.js`](../api/cron/forge-seed-cron.js), and retroactively
via `adoptForgePreviews()` in the backfill.

### 2. Client capture (`POST /api/avatars/thumbnail`)

The browser captures the live viewer's canvas and uploads a PNG. Stored at
`thumb/<avatarId>.png` with `Content-Type: image/png`. Owner or admin only.

### 3. Server render (headless chromium)

Everything else — studio avatars, uploads, forge rows older than preview capture —
is rendered server-side: the GLB is presigned, loaded into a headless chromium
running a three.js viewer, and screenshotted to a 768×768 PNG, which is uploaded to
`thumb/<avatarId>.png`. Costs ~3–6s per model, so it always runs in bounded batches.

All of this lives in [`api/_lib/avatar-thumbs.js`](../api/_lib/avatar-thumbs.js),
the single owner of the invariant above.

## The three crons

| Cron | Schedule | Job |
|---|---|---|
| [`avatar-thumbnail-render`](../api/cron/avatar-thumbnail-render.js) | `*/10 * * * *` | Re-renders **stale** thumbnails for marketplace listings, driven by the x402 spend loop. |
| [`avatar-thumbnail-backfill`](../api/cron/avatar-thumbnail-backfill.js) | `*/5 * * * *` | Fills in **absent** thumbnails: adopts forge previews, then renders whatever is left. |
| [`agent-avatar-backfill`](../api/cron/agent-avatar-backfill.js) | `*/10 * * * *` | Assigns a 3D body to any **agent with no avatar** (`agent_identities.avatar_id IS NULL` or dangling): clones a random public, thumbnailed humanoid from the gallery into the agent owner's account (`api/_lib/agent-avatars.js`, reusing circulation's `cloneAvatarFor`). Pure DB work — the clone shares the source's `storage_key` and `thumbnail_key`, so the agent card has a preview immediately. Batch via `AGENT_AVATAR_BACKFILL_BATCH` (default 100). |

Together the last two make "every agent card shows a real preview" an invariant:
one guarantees the agent has an avatar, the other guarantees the avatar has a
thumbnail. Creation paths keep the gap from reopening — `createAvatar` accepts an
internal `thumbnail_key` seed, auto-rig siblings inherit their source's thumbnail,
and the forge/avatar seed crons adopt the forge preview at insert.

They share the `thumb/<avatarId>.png` key space and each is a no-op on the other's
rows. The backfill drains most-visible-first — `featured`, then public, then
`view_count`, then newest — so the surfaces users actually look at heal first.

Tuning (env, on the Cloud Run service):

| Var | Default | Meaning |
|---|---|---|
| `THUMBNAIL_BACKFILL_RENDER_BATCH` | `8` | Models rendered per tick. |
| `THUMBNAIL_BACKFILL_ADOPT_BATCH` | `200` | Forge previews adopted per tick. |
| `THUMBNAIL_BACKFILL_CONCURRENCY` | `2` | Parallel renders (one shared chromium). |

## Bounded retries

A GLB that cannot be rendered — corrupt bytes, over the 25 MB cap, or a
`storage_key` whose object has been deleted — would otherwise sit at the head of the
priority order and burn every tick forever. The `avatar_thumbnail_backfill` table is
a claim + retry ledger:

- One row per attempted avatar. `claimed_at` is a 15-minute lease, so a run that
  dies mid-render releases its claim.
- Rows are **deleted** on success (the avatar now has a `thumbnail_key`, so it drops
  out of the candidate set on its own).
- On failure `attempts` is bumped and `last_error` recorded. After 3 failures the
  avatar is retired and never claimed again.

Claim selection and the claim write are a single SQL statement using
`FOR UPDATE … SKIP LOCKED`, so the cron and an operator's bulk run can execute at
the same time without ever claiming the same avatar.

### Blame the browser, not the model

Retiring an avatar after 3 failures is only safe if those failures are the *model's*
fault. Chromium is the first process the OOM killer reaps on a memory-tight
container, and it dies exactly when a long batch render is under way. Once it does,
every remaining render fails in milliseconds with `Connection closed.`

So the runner distinguishes the two:

- **Model failure** (`glb fetch failed: …`, `render failed: …`) — charge the
  attempt, record `last_error`, keep going.
- **Infrastructure failure** (`Connection closed.`, `Target closed`, `Protocol
  error`, …) — the model is blameless. Roll the attempt back, roll back every
  claim the aborted batch never reached, and **stop the batch**. `renderBatch()`
  returns `aborted: "<reason>"`; the cron logs `backfill_browser_died` and the next
  tick retries the same avatars on a fresh container.

`isBrowserInfrastructureError()` in
[`api/_lib/render-glb.js`](../api/_lib/render-glb.js) is the classifier, and the
cached browser now evicts itself on `disconnected` so the next render relaunches
instead of reusing a corpse.

This is not hypothetical: before the classifier existed, one OOM-killed chromium
retired **1,283 perfectly renderable avatars** in a single run. If you ever suspect
that happened again:

```bash
node --env-file=.env.local scripts/backfill-avatar-thumbnails.mjs --reset-infra
```

It deletes every ledger row whose `last_error` is an infrastructure error, returning
those avatars to the candidate set. Rows recording a model-attributable error are
left retired. Safe to run at any time.

Running more than one bulk backfill at once is what causes the OOM in the first
place. The claim ledger makes it *correct*, but not *free* — one runner at
`--concurrency=2..3` beats three runners fighting for RAM.

## Operating the backfill

[`scripts/backfill-avatar-thumbnails.mjs`](../scripts/backfill-avatar-thumbnails.mjs)
is the bulk counterpart. It talks to Postgres and R2 directly — no admin token, no
running server — and shares the same claim ledger, so it is safe to run while the
cron is live.

```bash
# How much coverage do we have?
node --env-file=.env.local scripts/backfill-avatar-thumbnails.mjs --status

# Free phase only: adopt every forge preview, never boot chromium.
node --env-file=.env.local scripts/backfill-avatar-thumbnails.mjs --adopt-only

# Render 50 avatars, 3 at a time.
node --env-file=.env.local scripts/backfill-avatar-thumbnails.mjs --limit=50 --concurrency=3

# Clear a large backlog: keep refilling the budget until nothing is left to claim.
node --env-file=.env.local scripts/backfill-avatar-thumbnails.mjs --limit=2000 --concurrency=4 --loop
```

Requires `DATABASE_URL` and the `S3_*` credentials, both of which live in
`.env.local`.

## Rendering a thumbnail yourself

```js
import { renderThumbnail, coverage } from './api/_lib/avatar-thumbs.js';

const { url, bytes, ms } = await renderThumbnail({
  id: 'a4bad2f5-8a07-43cf-82e5-b6ba1314441e',
  storage_key: 'u/<ownerId>/model.glb',
});
console.log(url, bytes, ms); // https://<cdn>/thumb/<id>.png 104356 5182

console.log(await coverage());
// { total: 12754, covered: 2988, missing: 9766, exhausted: 0 }
```

`renderThumbnail()` uploads the PNG **before** it writes the key, so a failed upload
can never leave a `thumbnail_key` pointing at nothing. That ordering is pinned by
[`tests/avatar-thumbs.test.js`](../tests/avatar-thumbs.test.js), alongside the rule
that adoption HEAD-checks the preview object before persisting it.

## Related

- [`tests/home-thumbnail-orb.test.js`](../tests/home-thumbnail-orb.test.js) — guards
  the homepage against ever re-introducing a fabricated thumbnail URL.
- [`api/_lib/r2.js`](../api/_lib/r2.js) — `publicUrl()`, `headObject()`, and
  `isLegacyOgThumbnailKey()`.
- [STRUCTURE.md](../STRUCTURE.md) — where every product surface lives.
