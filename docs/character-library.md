# Character Library: rigged characters, ready to animate

The Character Library is a free, curated gallery of professionally rigged humanoid 3D characters. Every character ships as a web-ready GLB with a full skeleton, skin weights, and textures, so it drives the entire three.ws animation library (idle, walk, run, wave, dance, and the rest of the canonical clip set) out of the box via animation retargeting. No account, no payment, no upload step: browse, preview live, and send any character into a studio in one click.

Page: [/character-library](https://three.ws/character-library) · API: `GET /api/avatars/library`
Source: [`pages/character-library.html`](../pages/character-library.html) · [`src/character-library.js`](../src/character-library.js) · [`api/avatars/library.js`](../api/avatars/library.js)

> This page covers the character gallery and its API. For the motion clips these characters play, see [Animations](./animations.md). For the free prop counterpart to this library, see the [Object Library](./object-library.md).

---

## What is in the library

A hundred-plus professionally rigged Mixamo humanoid characters (Y Bot, X Bot, Warrok, Remy, Vanguard, zombies, knights, and more), staged as optimized GLBs on the R2 CDN. The manifest can also merge additional CC0 characters from other sources (for example Quaternius), so the API's `total` field is the authoritative count. Nothing on the page hard-codes a number: the hero headline and the results counter render `total` from the manifest.

Every entry is animation-ready: the GLB carries a skinned mesh, and the three.ws runtime retargets the canonical clip library onto it automatically (see [Animations](./animations.md) for how retargeting and the clip registry work). There is no per-character allowlist; any character in the library plays any clip.

## Using the gallery

Each card renders the character live in an auto-rotating `<model-viewer>` (with the pre-rendered thumbnail slotted in as a lazy-loaded poster image that fades once the model loads), shows the entry's `source` and file size, and offers three one-click routes. The viewer is control-free (no orbit, no extra tab stop); the whole thumbnail is a link to the preview. A manifest row with no `url` renders as a plain, unlinked tile with no actions.

| Button | Destination | What you get |
|---|---|---|
| **Preview** | `/app#model=<glb-url>` | The full three.js [3D viewer](./viewer.md) |
| **Use** | `/studio?model=<glb-url>` | [Widget Studio](./widget-studio.md): configure and publish an embeddable widget of this character (see the [Embedding Guide](./embedding.md)) |
| **Animate** | `/pose?src=<glb-url>&title=<name>` | [Animation Studio](./animation-studio.md): pose, keyframe, and export motion on this character |

Gallery controls:

- **Search** filters by name; press `/` anywhere on the page to focus the search box.
- **Sort** by name (A to Z, Z to A) or by file size (largest or smallest first). File size is shown on every card.
- The library is small enough that the page fetches the whole manifest once and filters client-side, so search and sort are instant. Search, sort, card copy, and the deep links are pure functions of the manifest in [`src/shared/character-library-view.js`](../src/shared/character-library-view.js), covered by `tests/character-library-view.test.js`.
- Loading shows a skeleton grid; an empty library, an empty search result, and a fetch error each have their own designed state with a recovery action.

## API: `GET /api/avatars/library`

Public, no authentication, `GET` and `OPTIONS` only (`HEAD` is answered like `GET`). Browser `fetch` from a third-party origin is not enabled: the endpoint sends `Access-Control-Allow-Origin` only for three.ws and its partner origins, exactly like the [Object Library API](./object-library.md). Call it server-side, or from a three.ws page. The endpoint proxies a small manifest JSON from the R2 CDN (`avatars/library/manifest.json`) with an edge cache (`Cache-Control: public, s-maxage=300, stale-while-revalidate=3600`). The GLB and thumbnail bytes never pass through the API: every entry carries absolute CDN URLs the browser loads directly.

### Query parameters

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `limit` | integer, 1 to 1000 | none | Opt-in pagination. Omit it to get the entire library in one response. Values are clamped into 1..1000. |
| `offset` | integer, >= 0 | 0 | Only meaningful together with `limit`. |

### Response shape

Without `limit`:

```json
{
  "avatars": [ { "...": "entry, see below" } ],
  "total": 107,
  "generated_at": "2026-07-21T13:39:15.447Z"
}
```

With `limit` (and optional `offset`), the response adds `offset` and `next_offset`. `next_offset` is `null` on the last page, and `total` is always the full library size, not the page size:

```json
{
  "avatars": [ "..." ],
  "total": 107,
  "offset": 0,
  "next_offset": 25,
  "generated_at": "2026-07-21T13:39:15.447Z"
}
```

Each entry in `avatars`:

| Field | Type | Meaning |
|---|---|---|
| `name` | string | URL-safe slug, stable identifier |
| `label` | string | Display name |
| `url` | string | Absolute CDN URL of the GLB |
| `thumb` | string (optional) | Absolute CDN URL of the PNG thumbnail; omitted when no thumbnail rendered |
| `bytes` | number | GLB file size |
| `skins` | number | Skinned mesh count in the GLB |
| `animations` | number | Animation clip count baked into the GLB itself (retargeted library clips come from the runtime, not the file) |
| `source` | string | Where the character came from, e.g. `"mixamo"` or `"quaternius"` |
| `license` | string | License tag for this entry, e.g. `"Mixamo"` or `"CC0"` (see Licensing below) |

Before the manifest is first uploaded, the endpoint returns `{ "avatars": [], "total": 0 }` rather than an error, so consumers feature-detect by emptiness.

### Example

```bash
curl -s 'https://three.ws/api/avatars/library?limit=2&offset=0'
```

Returns the first two characters plus `total`, `offset`, and `next_offset`, each entry with a directly loadable `url` (GLB) and `thumb` (PNG).

## Licensing

Every manifest entry carries a `license` field; read it per character rather than assuming one license for the whole library.

- **`"Mixamo"`**: the character is an Adobe Mixamo character, used under Adobe's Mixamo terms. The manifest records the tag only, it does not restate the terms; consult Adobe's Mixamo licensing FAQ for what those terms permit before redistributing the GLB outside three.ws.
- **`"CC0"`**: public domain. Free for any use, including commercial, with no attribution required.

Using any library character inside three.ws (previewing, animating, publishing a widget or embed) is free.

## How the library is staged (maintainers)

The gallery and API are read-only consumers of a manifest built by a local pipeline. The GLBs total several gigabytes, far too large for the deploy bundle, so all bytes live on the R2 CDN and only the manifest index is published:

1. `scripts/fetch-mixamo-avatars.mjs` downloads the source characters.
2. `scripts/convert-mixamo-avatars.mjs` converts them to web GLB.
3. `scripts/fetch-mixamo-avatar-thumbnails.mjs` stages the PNG thumbnails.
4. `scripts/build-mixamo-avatar-library.mjs` reads `public/avatars/mixamo/catalog.json`, merges the extra CC0 characters from `public/avatars/extra/characters.json`, and PUTs `avatars/library/manifest.json` to R2 (`--dry-run` prints without uploading).

R2 CORS is configured by `scripts/set-r2-cors.mjs` so browsers can GET the GLBs cross-origin. The live bucket policy is an origin allowlist (`three.ws`, `*.vercel.app`, `localhost:3000`) that predates the world-open read rule now in that script, so a GLB loaded straight from the CDN on any other origin fails with no `access-control-allow-origin` header. Measure the live policy with `node scripts/set-r2-cors.mjs --probe`; until it is corrected, embeds on third-party origins should route the GLB through [`/api/glb`](./media-api.md#same-origin-glb-proxy), as [the embed tutorial](./tutorials/character-library-to-embed.md) does.

## Related

- [Animations](./animations.md): the clip library every character drives, and how retargeting works.
- [Animation Studio](./animation-studio.md): the `/pose` surface the Animate button opens.
- [Widget Studio](./widget-studio.md) and the [Embedding Guide](./embedding.md): turn a library character into a live embed on any site.
- [Object Library](./object-library.md): the same free-library pattern for CC0 props and scene objects.
- [Marketplace](./marketplace.md): library characters are free; the marketplace is where priced avatars, agents, and skills are bought and sold.
