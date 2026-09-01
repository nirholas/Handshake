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

### The read side: always `thumbnailUrl()`, never bare `publicUrl()`

The write paths guarantee that a key we store has an object behind it. The read
paths have to survive the keys that predate that guarantee. `publicUrl()` passes an
absolute value straight through, so a legacy `*_og.png` key becomes a URL pointing
at an origin that holds no object — a 404 the browser blocks as ORB.

So every read path goes through one helper in
[`api/_lib/r2.js`](../api/_lib/r2.js):

```js
import { thumbnailUrl } from './_lib/r2.js';

thumbnailUrl(null)                                  // → null
thumbnailUrl('https://three.ws/avatars/x_og.png')   // → null  (legacy, always 404s)
thumbnailUrl('thumb/abc.png')                       // → https://<cdn>/thumb/abc.png
thumbnailUrl('thumb/abc.png')                       // → null  (S3_PUBLIC_DOMAIN unset)
```

That last case is why the helper is built on `publicUrlOrNull()` rather than bare
`publicUrl()`: reading `env.S3_PUBLIC_DOMAIN` throws on a deployment without object
storage, and a single un-renderable key must not take down a whole list response.
It did: `/api/pulse` answered `502 pulse_failed` and `/api/search` answered
`503 not_configured` for every caller until both were pointed at the read-path
helper. Upload paths keep calling `publicUrl()`, where the throw is the correct
signal that there is nowhere to put the bytes.

Return `null` and let the surface render its designed placeholder. There were 43
bare `publicUrl(<thumbnail key>)` call sites across 32 files — agent cards, the
marketplace, explore, user profiles, leaderboards, and the image baked into on-chain
token metadata. All now route through `thumbnailUrl()`, and
[`tests/thumbnail-url-guard.test.js`](../tests/thumbnail-url-guard.test.js) walks
`api/` to fail the build if a new one appears. Three files are allow-listed there,
each for a stated reason (the helper itself, a key published right after its
`putObject` in the same function, and a HEAD-checked vision fetch).

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

### 3. Server render (CPU rasterizer, chromium failover)

Everything else (studio avatars, uploads, forge rows older than preview capture)
is rendered server-side through `renderGlbToPng()` in
[`api/_lib/render-glb.js`](../api/_lib/render-glb.js): the GLB is presigned and
rendered to a 768x768 PNG, which is uploaded to `thumb/<avatarId>.png`. The
renderer tries the in-process software rasterizer first
([`api/_lib/render-cpu.js`](../api/_lib/render-cpu.js), the `@three-ws/render`
package, roughly 200-900 ms and no subprocess) and falls back to headless chromium
running a three.js viewer only for the models the CPU lane cannot decode on its
own (Draco-compressed geometry, KTX2/Basis textures). A CPU miss is logged as
`[render] cpu lane fell back to chromium` and costs latency, never a failed
thumbnail. Set `RENDER_CPU_LANE=off` on the service to pin every render back onto
chromium without a deploy. A chromium render costs 3-15 s per model, so rendering
always runs in bounded batches.

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
  error`, a `spawn EFAULT` / `ENOMEM` / `EAGAIN` launch refusal, or object storage
  answering `Missing required env var: S3_…`, `InvalidAccessKeyId`, `NoSuchBucket`,
  `ECONNREFUSED`, …): the model is blameless. Roll the attempt back, roll back every
  claim the aborted batch never reached, and **stop the batch**. `renderBatch()`
  returns `aborted: "<reason>"`; the cron logs `backfill_browser_died` and the next
  tick retries the same avatars on a fresh container.

Two classifiers decide which side a failure lands on. `isBrowserInfrastructureError()`
in [`api/_lib/render-glb.js`](../api/_lib/render-glb.js) covers the browser (its
`INFRA_ERROR_PATTERN`), and `isStorageInfrastructureError()` in
[`api/_lib/r2.js`](../api/_lib/r2.js) covers object storage (`STORAGE_ERROR_PATTERN`).
Both are exported as pattern strings so the ledger repair below asks the same
question in SQL with `~*` instead of maintaining a drifting copy, and
[`tests/avatar-thumbs.test.js`](../tests/avatar-thumbs.test.js) imports the real
classifiers rather than a stand-in for the same reason. The cached browser evicts
itself on `disconnected` so the next render relaunches instead of reusing a corpse.

Storage is also checked before any claim is made: both thumbnail crons return
`{ ok: false, reason: "object_storage_unconfigured" }` and touch nothing when
`objectStorageConfigured()` in `r2.js` reports the `S3_*` set incomplete, because
three ticks of identical `S3_BUCKET` failures at `*/5` would otherwise retire every
remaining avatar in under fifteen minutes.

This is not hypothetical: before the classifier existed, one OOM-killed chromium
retired **1,283 perfectly renderable avatars** in a single run. If you ever suspect
that happened again:

```bash
node --env-file=.env.local scripts/backfill-avatar-thumbnails.mjs --reset-infra
```

It deletes every ledger row whose `last_error` matches either infrastructure
pattern (browser or storage), returning those avatars to the candidate set. Rows
recording a model-attributable error are left retired. Safe to run at any time.
Add `--repair-only` to run the repair (and any `--restyle`) and stop before anything
touches R2: that mode needs only `DATABASE_URL`, so the undo stays reachable while
object storage is exactly the thing that is broken.

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

# After deploying a renderer change: re-queue up to N posters baked by the older
# renderer (clears only server-rendered thumb/<uuid>.png keys via queueRestyle();
# client snapshots and adopted forge previews are never touched).
node --env-file=.env.local scripts/backfill-avatar-thumbnails.mjs --restyle=200 --limit=200
```

Requires `DATABASE_URL` plus the `S3_*` credentials (`S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_PUBLIC_DOMAIN`);
`--status` and `--repair-only` need `DATABASE_URL` alone. Only `DATABASE_URL` is in
`.env.local`; the authoritative copy of the `S3_*` set lives on the Cloud Run
service, so `--env-file=.env.local` alone exits with `S3_BUCKET is unset` for any
mode that renders or adopts. Export them into the shell first:

```bash
eval "$(gcloud run services describe three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --format=json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s).spec.template.spec.containers[0].env||[])if(e.name.startsWith("S3_")&&e.value)console.log(`export ${e.name}=${JSON.stringify(e.value)}`)})')"
```

Then any of the commands above runs as written.

## Rendering a thumbnail yourself

```js
import { renderThumbnail, coverage } from './api/_lib/avatar-thumbs.js';

const { url, bytes, ms } = await renderThumbnail({
  id: 'a4bad2f5-8a07-43cf-82e5-b6ba1314441e',
  storage_key: 'u/<ownerId>/model.glb',
});
console.log(url, bytes, ms); // https://<cdn>/thumb/<id>.png 104356 5182

console.log(await coverage());
// { total: 26398, covered: 26361, missing: 37, exhausted: 33 }
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
