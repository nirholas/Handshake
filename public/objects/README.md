# CC0 Object Library

Free, commercial-OK 3D objects and props, hosted for use across three.ws (worlds,
scenes, the model marketplace). Everything here is **CC0 (public domain)** — free
to use commercially, no attribution required.

Browse at **[/objects](https://three.ws/objects)**.

## Sources

| Source | License | Count | Notes |
|---|---|---|---|
| [Poly Haven](https://polyhaven.com) | CC0 | ~520 | Elite PBR props (furniture, lighting, electronics, decor) |

More CC0 sources (Smithsonian Open Access, Poly Pizza `license=CC0`) drop into
the same pipeline as additional adapters.

## Where the assets live

GLBs are large, so they live on the R2 CDN (not git); only `<source>/catalog.json`
(the build ledger) is tracked.

| Asset | R2 key prefix |
|---|---|
| Web GLB | `objects/<source>/glb/<slug>.glb` |
| Poster thumbnail | `objects/<source>/thumbs/<slug>.png` |
| Library manifest | `objects/library/manifest.json` (served by `GET /api/objects/library`) |

## Pipeline (resumable, mirrors the Mixamo character pipeline)

```sh
# 1. Pull the source → pack multi-file glTF into one GLB (@gltf-transform) → R2.
node scripts/fetch-polyhaven-objects.mjs --concurrency=5

# 2. Render a poster for each GLB (headless model-viewer) → R2.
#    (feed it {glbKey,thumbKey} jobs derived from the catalog)
node scripts/render-glb-thumbnails.mjs --manifest=jobs.json --concurrency=4

# 3. Publish the manifest → R2 (objects/library/manifest.json).
node scripts/build-object-library.mjs
```

`catalog.json` accumulates per-model state (`status`, `glb_file`, `glb_bytes`,
`categories`, `license`, `source`), so any step re-runs idempotently.

## Surfaces

- **`/objects`** — the gallery ([pages/objects.html](../../pages/objects.html) +
  [src/objects-library.js](../../src/objects-library.js)). Live `<model-viewer>`
  cards, category chips, search/sort. Each card previews in the 3D viewer
  (`/app#model=`) and downloads the GLB directly (CC0).
- **`GET /api/objects/library`** — [api/objects/library.js](../../api/objects/library.js).
  Proxies the R2 manifest with an edge cache; `{ objects, total, generated_at }`,
  paged with `?limit=` + `?offset=`.
