<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/mocap</h1>

<p align="center"><strong>Motion capture as an API, turn a webcam or video into face, pose, and hand animation clips you can replay on any avatar.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/mocap"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/mocap?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/mocap"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/mocap?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/mocap?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/mocap?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/mocap` is the official client for the three.ws **mocap clip** store -
> the library behind the in-browser mocap studio. Recording happens in the
> browser: MediaPipe Face Landmarker reads a webcam frame and emits 52 ARKit
> blendshapes plus a head-pose matrix per frame; the runtime smooths and packs
> them into a portable clip. This package is the durable half, it saves that
> clip, lists your library, makes clips public or for-sale, and hands any clip
> back so you can replay it on a different avatar. It wraps the auth'd
> `/api/mocap/clips` endpoints. It pairs with
> [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar) and
> [`@three-ws/walk`](https://www.npmjs.com/package/@three-ws/walk), those *render*
> the avatar, `@three-ws/mocap` *drives its face*.

## Why

Facial mocap in the browser is solved math, but the boring half, persisting a
recording, versioning the wire format, sharing it, replaying it on a *different*
rig: is where projects stall. A blendshape buffer in memory is gone the moment
the tab closes. This package is that half, done once:

- **Capture once, replay anywhere.** A clip is rig-agnostic ARKit blendshapes,
  not baked keyframes, so a face you recorded on one avatar plays on any avatar
  that exposes ARKit morph targets.
- **Versioned wire format.** Every clip carries a format string
  (`three.ws.face-mocap.v1`). The runtime asserts on it before replay, a future
  v2 clip can't silently load on a v1 player and mangle the animation.
- **Library, sharing, marketplace.** Clips are private by default; flip one to
  `public`, attach a `$THREE` price, and it's listed. One field, no new plumbing.
- **Cursor-paginated, owner-scoped.** List your own library or browse the public
  pool with the same call.

## Install

```bash
npm install @three-ws/mocap
```

Zero runtime dependencies. Works in Node 18+ and the browser (uses `fetch`). To
*record* a clip in the browser, use the three.ws mocap runtime; to *render* the
avatar you replay it on, add
[`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar).

## Quick start

Save a recording the browser runtime handed you, then read it back:

```js
import { saveClip, getClip } from '@three-ws/mocap';

// `recording` is the object FaceMocap.getRecording() returns:
//   { format: 'three.ws.face-mocap.v1', duration, frames: [{ t, shapes, mat }] }
const { id, slug } = await saveClip(recording, {
  name: 'Surprised reaction',
  tags: ['emote', 'reaction'],
}, { token: process.env.THREEWS_TOKEN });

const clip = await getClip(id);
console.log(clip.frameCount, 'frames,', clip.duration, 'seconds');
// → drop clip.frames into FaceMocap.play(clip) on any ARKit avatar
```

List your library, then browse the public pool:

```js
import { listClips } from '@three-ws/mocap';

const mine   = await listClips({ token }, { kind: 'face' });
const shared = await listClips({}, { includePublic: true, limit: 100 });
```

## API

The SDK is a thin client over `/api/mocap/clips`. Every write needs a session
cookie or a bearer token with the right scope; reads of public clips are open.

### `saveClip(recording, meta, auth) → Promise<Clip>`

Persist a browser recording. Wraps `POST /api/mocap/clips`. The `recording` is
passed through as the `clip` field; `meta` supplies the library metadata.

**`recording`**: the object the capture runtime returns:

| Field | Type | Notes |
|---|---|---|
| `format` | `string` | One of the [supported formats](#how-it-works). Asserted server-side. |
| `duration` | `number` | Seconds, `0`-`3600`. Stored as `duration_ms`. |
| `frames` | `Frame[]` | `{ t, shapes, mat? }` per frame. Max **18,000** frames, **2 MB** inline. |

A `Frame` is `{ t: number, shapes: Record<string, number>, mat?: number[16] | null }`
- `t` is seconds from clip start, `shapes` maps ARKit blendshape names to scores,
`mat` is the optional 4×4 head-pose matrix.

**`meta`**

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | `string` | - | **Required.** 1-120 chars. |
| `slug` | `string` | auto from `name` | `^[a-z0-9][a-z0-9-]{0,79}$`, unique per owner. |
| `description` | `string` | - | Up to 2000 chars. |
| `tags` | `string[]` | `[]` | Up to 20 tags, ≤40 chars each. |
| `visibility` | `'private' \| 'unlisted' \| 'public'` | `'private'` | |
| `avatarId` | `uuid` | - | Bind the clip to one of your avatars. Must be owned by you. (`avatar_id` is accepted too.) |

Returns the created `Clip` (`201`). `kind` (`face` / `pose` / `hand` / `vmc`) is
derived from `format` server-side.

### `getClip(idOrSlug, auth?) → Promise<Clip>`

Fetch one clip **with its full `frames` array**, ready to replay. Wraps
`GET /api/mocap/clips/:idOrSlug`. Public and unlisted clips need no auth; a
`private` clip resolves only for its owner (otherwise `404`, never a leak). Each
non-owner fetch bumps `play_count`.

A slug is unique per owner, not globally, so a slug lookup resolves to your own
clip when you are authenticated and otherwise to the oldest public clip carrying
it. Pass the `id` when you need to name one exact clip.

### `listClips(auth, opts?) → Promise<{ items, nextCursor }>`

List clips **without frames** (metadata only: cheap). Wraps
`GET /api/mocap/clips`. Cursor-paginated, newest first.

| Option | Type | Default | Notes |
|---|---|---|---|
| `limit` | `number` | `50` | Clamped to `1`-`100`. |
| `cursor` | `string` | - | `nextCursor` from the previous page. |
| `kind` | `'face' \| 'pose' \| 'hand' \| 'vmc'` | - | Filter by clip kind. |
| `includePublic` | `boolean` | `false` | Authed: union your clips with the public pool. |

With no `auth`, you get the public pool only. With `auth`, you get your own
library; add `includePublic: true` to fold in public clips too.

### `updateClip(idOrSlug, patch, auth) → Promise<Clip>`

Edit metadata. Wraps `PATCH /api/mocap/clips/:id` (owner only). Patchable:
`name`, `description`, `tags`, `visibility`, `avatarId`, and `price`. Set
`price: { amount, currency }` to list the clip for sale, or `price: null` to make
it free again. Bearer tokens need the `avatars:write` scope.

### `deleteClip(idOrSlug, auth) → Promise<{ ok: true }>`

Soft-delete a clip you own. Wraps `DELETE /api/mocap/clips/:id`. The row is
tombstoned (`deleted_at`), not destroyed. Bearer tokens need `avatars:delete`.

**`Clip` shape** (returned by every call; `frames` only on `getClip`). The SDK
camelCases the wire row and keeps the untouched original on `raw`:

| Field | Type | Notes |
|---|---|---|
| `id` / `slug` | `string` | Identity. |
| `name` / `description` | `string` | Library metadata. |
| `kind` | `'face' \| 'pose' \| 'hand' \| 'vmc'` | Derived from `format`. |
| `format` | `string` | Wire-format version string. |
| `durationMs` / `duration` | `number` | Milliseconds / seconds. |
| `frameCount` | `number` | Number of frames. |
| `frames` | `Frame[]` | Present only on `getClip`. |
| `tags` | `string[]` | |
| `visibility` | `string` | `private` / `unlisted` / `public`. |
| `avatarId` | `uuid \| null` | Bound avatar, if any. |
| `playCount` | `number` | Non-owner fetches. |
| `price` | `{ amount, currency } \| null` | `null` when free. |
| `owner` | `'self' \| 'other'` | Relative to the caller. |
| `raw` | `unknown` | The untouched wire row (`duration_ms`, `frame_count`, …). |

## How it works

Capture is client-side and free; persistence is this API. The clip is the
contract between them: a portable, versioned blendshape buffer:

```
  webcam / video frame
         │
         ▼
  MediaPipe Face Landmarker      ← in the browser, three.ws mocap runtime
         │  52 ARKit blendshapes + 4×4 head-pose matrix
         ▼
  one-euro smoothing → record buffer
         │
         ▼
  getRecording() ──▶ { format, duration, frames:[{ t, shapes, mat }] }
         │
   saveClip()  │  POST /api/mocap/clips        ← @three-ws/mocap
         ▼
  ┌─────────────────────────────┐
  │  mocap_clips (Postgres)      │  owner-scoped, versioned, taggable, priceable
  └──────────────┬──────────────┘
   getClip()     │  GET /api/mocap/clips/:id
         ▼
  FaceMocap.play(clip) on ANY ARKit avatar   ← @three-ws/avatar / @three-ws/walk
```

Because a clip is rig-agnostic ARKit blendshapes: not baked bone keyframes -
the same recording replays on any avatar that exposes ARKit morph targets. The
`format` string carries the version; the runtime refuses a clip whose format it
doesn't speak rather than mangling the animation.

**Supported formats** (the `format` string a recording must carry):

| `format` | `kind` | Source |
|---|---|---|
| `three.ws.face-mocap.v1` | `face` | Webcam facial blendshapes + head pose. |
| `three.ws.pose-mocap.v1` | `pose` | Body/skeletal pose capture. |
| `three.ws.hand-mocap.v1` | `hand` | Hand/finger tracking. |
| `three.ws.vmc.v1` | `vmc` | VMC-protocol motion stream. |

Frames are stored inline as JSONB up to **2 MB** (≈ a multi-minute 30 Hz face
capture). The runtime caps a single clip at **18,000 frames**; longer captures
should be split.

## Errors & edge cases

The endpoints return structured JSON errors `{ error: { code, message } }`. The
SDK surfaces them as a typed `ThreeWsError` carrying the `code`:

| `code` | HTTP | Meaning | Recovery |
|---|---|---|---|
| `unauthorized` | 401 | Write with no session/token. | Sign in or pass a bearer `token`. |
| `insufficient_scope` | 403 | Token lacks `avatars:write` / `avatars:delete`. | Mint a token with the scope. |
| `validation_error` | 400 | `meta`/`recording` failed schema. | Fix the field named in `message`. |
| `unsupported_format` | 400 | `format` isn't a known wire format. | Use a [supported format](#how-it-works). |
| `payload_too_large` | 413 | Inline frames exceed 2 MB. | Record a shorter clip or split it. |
| `duplicate_slug` | 409 | Slug already used by you. | Omit `slug` (auto), or pick another. |
| `not_found` | 404 | Missing clip, or a `private` clip you don't own. | Check the id/ownership. |
| `invalid_request` | 400 | Bad id, or empty `PATCH`. | Supply a valid id / ≥1 field. |
| `db_error` | 500 | List query failed. | Retry. |

Every state is designed: a `private` clip you don't own returns `404`, not its
contents: non-owners can't even confirm it exists. Mirror that in your UI.

## Examples

**Record in the browser, save to your library:**

```js
import { saveClip } from '@three-ws/mocap';
// faceMocap is the three.ws runtime recorder; recording is its output
const recording = faceMocap.getRecording();
const clip = await saveClip(recording, {
  name: 'Wink + smile',
  tags: ['emote'],
  visibility: 'unlisted',
}, { token });
console.log(`https://three.ws/mocap/${clip.slug}`);
```

**Replay a public clip on a freshly forged avatar:**

```js
import { getClip } from '@three-ws/mocap';
import { forge } from '@three-ws/forge';

const avatar = await forge('a friendly robot, ARKit face');
const clip   = await getClip('surprised-reaction');
// drive avatar's ARKit morph targets from clip.frames in your render loop
```

**List a tag-filtered gallery for a picker:**

```js
import { listClips } from '@three-ws/mocap';

let cursor;
const all = [];
do {
  const page = await listClips({}, { includePublic: true, limit: 100, cursor });
  all.push(...page.items);
  cursor = page.nextCursor;
} while (cursor);
```

## Related

- [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar), render the avatar a mocap clip drives.
- [`@three-ws/walk`](https://www.npmjs.com/package/@three-ws/walk), a rigged avatar as a page companion you can face-animate.
- [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge), generate the ARKit avatar to replay clips on.
- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch), settle payments for priced clips.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
