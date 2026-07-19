# Mixamo Character Library

106 professionally rigged humanoid characters (Adobe Mixamo base characters:
Y Bot, X Bot, Warrok, Remy, Vanguard, knights, zombies, soldiers, dancers, …).
Each is a skinned, textured GLB with a full skeleton, so it drives the entire
three.ws animation library out of the box (idle / walk / run / wave / dance) via
the canonical-clip retargeting stack ([src/animation-retarget.js](../../../src/animation-retarget.js),
[src/glb-canonicalize.js](../../../src/glb-canonicalize.js)).

Browse them at **[/character-library](https://three.ws/character-library)**.

## Where the assets live

The GLBs are large (~3 GB total) so they are **not** committed — they live on the
R2 CDN, exactly like the 2,453-clip animation library. Only this folder's
`catalog.json` (the build ledger) is tracked in git.

| Asset | R2 key prefix | Notes |
|---|---|---|
| Source FBX (with skin) | `avatars/mixamo/<slug>.fbx` | Raw Mixamo export, kept for re-conversion |
| Web GLB | `avatars/mixamo/glb/<slug>.glb` | What the site loads; skeleton + skin + textures |
| Poster thumbnail | `avatars/mixamo/thumbs/<slug>.png` | Mixamo's neutral-background product shot |
| Library manifest | `avatars/library/manifest.json` | Served by `GET /api/avatars/library` |

Public CDN base: `S3_PUBLIC_DOMAIN` (the `chatty-storage` bucket's `*.r2.dev`
domain). R2 CORS is already configured for three.ws origins, so `<model-viewer>`
and the pose studio load these GLBs directly.

## The pipeline (all scripts are resumable)

Everything reads R2 creds (`S3_ENDPOINT`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_PUBLIC_DOMAIN`) from `.env.local`.

```sh
# 1. Auth: get a Mixamo session token (headless Adobe login → .env.local).
#    Needs ADOBE_EMAIL / ADOBE_PASSWORD in .env.local; enter the emailed code
#    at the prompt (or write it to .mixamo-otp when running non-interactively).
node scripts/get-mixamo-token.mjs

# 2. Download every Mixamo character as skinned FBX → R2 (avatars/mixamo/*.fbx).
#    Catalog listing needs no token; the export/download phase needs MIXAMO_TOKEN.
node scripts/fetch-mixamo-avatars.mjs --download --concurrency=2

# 3. Convert each FBX → web GLB (FBX2glTF; skeleton + skin + textures preserved)
#    → R2 (avatars/mixamo/glb/*.glb). Streams from R2, converts, uploads back.
node scripts/convert-mixamo-avatars.mjs --concurrency=3

# 4. Capture each character's poster thumbnail → R2 (avatars/mixamo/thumbs/*.png).
node scripts/fetch-mixamo-avatar-thumbnails.mjs

# 5. Publish the library manifest → R2 (avatars/library/manifest.json),
#    which GET /api/avatars/library serves to the /character-library gallery.
node scripts/build-mixamo-avatar-library.mjs
```

`catalog.json` accumulates per-character state across all five steps
(`status`, `file`, `glb_file`, `glb_bytes`, `glb_skins`, `thumb_file`, …), so any
step can be re-run and it only does the missing work.

### How the character export actually works

Mixamo has no "download this character's mesh" endpoint (`/characters/export`
404s). The mechanism the mixamo.com frontend uses — and what
`fetch-mixamo-avatars.mjs` replicates — is to export a **reference motion**
("Standing Idle") *targeted at the character* through `/animations/export` with
`skin: 'true'`. That bundles the character's own skinned, textured mesh into the
exported FBX. Two gotchas the script handles: the export's `gms_hash.params` must
be flattened to a comma-joined string (raw arrays queue but then fail async), and
job status is polled from the per-character monitor (`/characters/<id>/monitor`).

## Surfaces

- **`/character-library`** — the gallery ([pages/character-library.html](../../../pages/character-library.html) +
  [src/character-library.js](../../../src/character-library.js)). Live `<model-viewer>` cards, client-side
  search/sort, and three deep-links per character:
  - Preview → `/app#model=<glb>` (3D viewer)
  - Use → `/studio?model=<glb>` (Widget Studio)
  - Animate → `/pose?src=<glb>` (Animation Studio)
- **`GET /api/avatars/library`** — [api/avatars/library.js](../../../api/avatars/library.js). Proxies the R2
  manifest with an edge cache; returns `{ avatars, total, generated_at }`, or a
  paged slice with `?limit=` + `?offset=`. Degrades to an empty library if the
  manifest is missing, so the UI feature-detects by emptiness.

## Licensing

These are Adobe Mixamo base characters, free to use under the Mixamo license.
They are hosted as a runtime asset library (R2), not redistributed in the repo.
