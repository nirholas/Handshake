# 02 — Fix homepage gallery thumbnails blocked by Opaque Response Blocking

## Mission

Five `*.r2.dev/thumb/*.png` requests on the homepage (`/`) are blocked by Chrome's Opaque
Response Blocking (`net::ERR_BLOCKED_BY_ORB`) — the browser refuses to render them cross-origin
because the response's declared `Content-Type` doesn't match what's actually served. Every
visitor to the homepage sees broken/missing thumbnails in the forge gallery strip. Fix the
`Content-Type` at the source so Chrome trusts the response, and verify against production.

## Context (from the audit's static trace — re-verify against the live tree, it may have moved)

- The homepage forge-gallery strip is driven by `src/home-forge.js` — thumbnails are set via
  `img.src = job.preview_image_url` (around line 486) and `job.preview_image_url` resolves to an
  R2-hosted PNG (`*.r2.dev/thumb/...`).
- R2 uploads go through `api/_lib/r2.js`: `putObject({ key, body, contentType })` (server-side
  upload — the likely path for generated thumbnails) and `presignUpload({ key, contentType })`
  (browser-direct signed PUT). Both explicitly set `ContentType` in the S3 `PutObjectCommand` —
  so the bug is almost certainly in the **caller** passing a wrong/missing `contentType` for
  thumbnail PNGs, not in `r2.js` itself.
- Trace where thumbnail PNGs for forge jobs actually get written to R2 — search the forge
  pipeline (`api/forge.js`, `api/_lib/forge-store.js`, and whatever renders the PNG — check
  `api/_lib/render-glb.js` and any `api/_lib/*bake*`/`*thumbnail*` helper) for the `putObject`
  or `presignUpload` call that writes the `thumb/` key, and confirm what `contentType` value it
  passes. Common failure modes to check for: a hardcoded/wrong MIME string, a `contentType`
  derived from the wrong source file (e.g. copying the GLB's `model/gltf-binary` instead of the
  thumbnail's own type), or a presigned-upload path where the browser's actual `fetch(url, {put})`
  doesn't send a `Content-Type` header matching what was signed (R2/S3 requires the signed and
  sent headers to match or the object gets stored without the intended metadata).
- Confirm live: `curl -sI https://<bucket>.r2.dev/thumb/<a-real-key>.png` — check the
  `content-type` response header. It should read `image/png` (or `image/webp` if that's the
  actual format — `src/home-forge.js` comments mention thumbnails are stored as WebP for size;
  if so the URL should reflect `.webp` and the content-type must say `image/webp`, not `.png`
  with a mismatched type).

## Tasks

1. **Find the exact write path.** Grep the forge pipeline for every `putObject(` /
   `presignUpload(` call that touches a `thumb/` R2 key. Read the contentType value each one
   passes.
2. **Reproduce.** Pull a live thumbnail URL from `https://three.ws/` (view source or the
   `/api/forge/*` job list) and `curl -sI` it. Confirm the `content-type` header is wrong or
   missing — that's the smoking gun before you change anything.
3. **Fix the content-type at the write site** so it matches the actual bytes being stored
   (`image/png` or `image/webp`, matched to what the encoder actually produces). If the format
   is genuinely WebP but the key/URL says `.png`, prefer fixing the extension too so the
   filename and content-type agree (avoids a second ORB-adjacent trust issue).
4. **Backfill existing objects if needed.** If existing R2 objects already have the wrong
   `Content-Type` stored (S3 `Content-Type` is set at write time and doesn't retroactively fix
   itself), either: (a) accept that only new thumbnails are fixed and old ones self-heal as jobs
   regenerate, or (b) if the volume is small and a re-`putObject` with a `CopyObjectCommand` +
   corrected `ContentType` is cheap, do a one-off backfill script in `scripts/` (not committed to
   the root — see repo hygiene rules) for the affected keys. Default to (a) unless the audit or a
   quick R2 listing shows this is a small, boundable set.
5. **Verify against production** (see below) before reporting done.

## Verification (must all pass)

- [ ] `curl -sI` on a freshly generated thumbnail's R2 URL shows the correct `content-type`.
- [ ] Load `https://three.ws/` in a real Chromium browser (or `scripts/page-audit.mjs` scoped
      to `/`), open DevTools console/network — zero `ERR_BLOCKED_BY_ORB` entries for
      `*.r2.dev/thumb/*`.
- [ ] The homepage forge gallery strip visibly renders thumbnail images, not broken-image icons
      or blank tiles.
- [ ] No regression to the GLB/model side of the same pipeline (models still load; you only
      touched the thumbnail image content-type).

## Do not

- Do not route thumbnails through `api/img.js` (the IPFS/cross-origin image proxy used
  elsewhere) as a workaround — these are first-party R2 assets; fixing the `Content-Type` at
  the source is the correct, permanent fix, not a proxy indirection.
