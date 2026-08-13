# Object Library: free CC0 3D props for any scene

The Object Library is a free, curated gallery of CC0 3D objects and props: furniture, lighting, electronics, containers, tools, decor. Every object is public domain, free to use commercially with no attribution required. Preview any object live in the browser, place it in your real room with AR, or download the GLB and use it in any engine or tool.

Page: [/objects](https://three.ws/objects) · API: `GET /api/objects/library`
Source: [`pages/objects.html`](../pages/objects.html) · [`src/objects-library.js`](../src/objects-library.js) · [`api/objects/library.js`](../api/objects/library.js)

> This page covers the object gallery and its API. For rigged, animation-ready characters, see the [Character Library](./character-library.md). For how AR placement works on phones and desktops, see [AR & WebXR](./ar.md).

---

## What is in the library

Several hundred CC0 props staged as web-ready GLBs on the R2 CDN, currently sourced from Poly Haven (each entry's `source` field says where it came from). Every entry carries its categories (for the filter chips), free-text tags (searched along with the name), and its file size. The API's `total` field is the authoritative count.

Objects are props, not agents: opening one in the viewer uses object mode, which shows view and modify affordances instead of the agent chat dock.

## Using the gallery

Each card renders the object live in an auto-rotating `<model-viewer>` (with the pre-rendered thumbnail as the poster) and offers three actions:

| Button | Destination | What you get |
|---|---|---|
| **Preview** | `/app#model=<glb-url>&kind=object&title=<name>` | The full three.js [3D viewer](./viewer.md) in object mode (no agent chat; Restyle, AR, and Download affordances instead) |
| **AR** | `/ar/studio?src=<glb-url>&title=<name>` | [AR Studio](./ar-studio.md): place the prop in your real space through the camera (see [AR & WebXR](./ar.md) for how the AR handoff works per device) |
| **Download** | The GLB URL directly | The raw GLB file, CC0, yours to use anywhere |

Gallery controls:

- **Category chips** above the grid filter by category (furniture, lighting, tools, and so on), derived live from the manifest. "All" clears the filter.
- **Search** matches names and tags; press `/` anywhere on the page to focus the search box.
- **Sort** by name (A to Z, Z to A) or by file size (largest or smallest first).
- The whole manifest is fetched once and filtered client-side, so chips, search, and sort are instant.
- Loading shows a skeleton grid; an empty library, an empty search result, and a fetch error each have their own designed state with a recovery action.

## API: `GET /api/objects/library`

Public, no authentication, CORS-open to GET from web origins. The endpoint proxies a small manifest JSON from the R2 CDN (`objects/library/manifest.json`) with an edge cache (`Cache-Control: public, s-maxage=300, stale-while-revalidate=3600`). The GLB and thumbnail bytes never pass through the API: every entry carries absolute CDN URLs the browser loads directly. It mirrors the [Character Library API](./character-library.md) exactly, with `objects` in place of `avatars`.

### Query parameters

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `limit` | integer, 1 to 1000 | none | Opt-in pagination. Omit it to get the entire library in one response. A value above 1000 is clamped to 1000. |
| `offset` | integer, >= 0 | 0 | Requires `limit`; sent on its own it is an error, not a silent no-op. |

Both cursors are validated strictly. Anything that is not a whole decimal number in range (`?limit=abc`, `?limit=0`, `?limit=2.7`, `?offset=-3`, or `?offset=` with no `limit`) returns `400` with a JSON body of `{ "error": "invalid_limit" | "invalid_offset", "error_description": "..." }` and `Cache-Control: no-store`. A bad cursor never degrades into a page you did not ask for.

### Response shape

Without `limit`:

```json
{
  "objects": [ { "...": "entry, see below" } ],
  "total": 511,
  "generated_at": "2026-07-21T13:16:14.305Z"
}
```

With `limit` (and optional `offset`), the response adds `offset` and `next_offset`. `next_offset` is `null` on the last page, and `total` is always the full library size, not the page size.

Each entry in `objects`:

| Field | Type | Meaning |
|---|---|---|
| `name` | string | URL-safe slug, stable identifier |
| `label` | string | Display name |
| `url` | string | Absolute CDN URL of the GLB |
| `thumb` | string (optional) | Absolute CDN URL of the PNG thumbnail; only present when the thumbnail actually rendered, so it is never a broken image link |
| `bytes` | number | GLB file size |
| `categories` | string[] | Categories, used by the gallery's filter chips |
| `tags` | string[] | Free-text tags, searched by the gallery |
| `license` | string | `"CC0"` |
| `source` | string | Origin catalog, e.g. `"polyhaven"` |

Before the manifest is first uploaded, the endpoint returns `{ "objects": [], "total": 0 }` rather than an error, so consumers feature-detect by emptiness. A storage outage degrades the same way, but that response carries `Cache-Control: no-store` instead of the 300s edge cache, so the library reappears the moment storage recovers rather than staying empty for the rest of the cache window.

### Example

```bash
curl -s 'https://three.ws/api/objects/library?limit=2&offset=0'
```

Returns the first two objects plus `total`, `offset`, and `next_offset`, each entry with a directly loadable `url` (GLB) and, when rendered, a `thumb` (PNG).

## Licensing

Every object in the library is CC0 (public domain), and every manifest entry carries `"license": "CC0"`. That means:

- Free for any use, personal or commercial.
- No attribution required (crediting the original authors listed in the source catalogs is appreciated, never required).
- You may download the GLB and use, modify, or redistribute it anywhere, inside or outside three.ws.

## How the library is staged (maintainers)

The gallery and API are read-only consumers of a manifest built by a local pipeline. The GLB bytes live on the R2 CDN; only the manifest index is published:

1. `scripts/fetch-polyhaven-objects.mjs` downloads and converts the source models and writes `public/objects/polyhaven/catalog.json`.
2. `scripts/render-glb-thumbnails.mjs` renders the PNG thumbnails to R2.
3. `scripts/build-object-library.mjs` reads the catalog, keeps only completed models, includes a `thumb` only for thumbnails that actually rendered, and PUTs `objects/library/manifest.json` to R2 (`--dry-run` prints without uploading).

## Related

- [Character Library](./character-library.md): the rigged, animation-ready counterpart to this library.
- [AR & WebXR](./ar.md): the device-by-device AR methods behind the AR button.
- [AR Studio](./ar-studio.md): the `/ar/studio` surface the AR button opens, including multi-object rooms.
- [3D Viewer](./viewer.md): the `/app` engine the Preview button opens in object mode.
