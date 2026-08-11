# Avatar asset orphans

An avatar row and the files it points at can drift apart: the row survives, the
model or thumbnail in the bucket does not. This is the runbook for finding those
rows, repairing what can be repaired, and the incident that created the first
batch.

## Why they exist

A copy, remix or forge variant does not duplicate the source avatar's bytes. It
reuses the source's `storage_key` and `thumbnail_key`, so one object in R2 is
routinely addressed by several `avatars` rows: 18,753 live rows share about
17,139 distinct thumbnail keys.

`deleteAvatar` in [api/_lib/avatars.js](../../api/_lib/avatars.js) used to soft
delete the row and then delete both objects by key, unconditionally. Deleting
any one member of a shared group therefore removed the file out from under every
other member that was still live. Those avatars kept rendering, kept appearing in
the gallery, on `/pulse`, on agent cards, and served a 404 for their model and
their picture.

Measured on 2026-08-11: 38 live rows shared a key with a soft-deleted row, and
45 of their objects were already gone (32 models, 33 thumbnails). The first
symptom anyone saw was a single blocked thumbnail request on `/pulse`.

`deleteAvatar` now reference-counts against live rows before it touches the
bucket, and keeps every object when that check itself fails. No new orphan can
be created this way; the repair below is for the ones already on disk.

## Finding and repairing them

```bash
# Report only (default): probes the rows that share a key with a deleted row.
node --env-file=.env scripts/repair-orphaned-avatar-assets.mjs

# Clear dangling thumbnail keys so the thumbnail backfill re-renders them.
node --env-file=.env scripts/repair-orphaned-avatar-assets.mjs --apply

# Widen the probe past the shared-key population.
node --env-file=.env scripts/repair-orphaned-avatar-assets.mjs --all --limit=2000
```

Every candidate object is probed with a credentialed `HEAD` against the bucket,
not a guess at its public URL, so an object behind a private visibility still
reads correctly. Keys that are already absolute URLs (first-party
`/avatars/*.glb`, externally hosted models) live outside the bucket and are
skipped rather than reported missing.

`--apply` writes exactly one thing: it nulls a `thumbnail_key` whose object is
gone. That is a repair rather than a loss. A null thumbnail key is precisely
what [api/_lib/avatar-thumbs.js](../../api/_lib/avatar-thumbs.js) claims, so the
thumbnail cron re-renders the poster from the GLB on its next pass, and until it
does the avatar falls back to its initial instead of requesting a dead URL.

## What the script will not do

A dangling `storage_key` (the model itself) is reported and never written. The
bytes are unrecoverable from here, and whether such a row should be retired,
re-uploaded by its owner, or left alone is an owner decision, not the script's.
Rows in that state still carry their name, tags and history.

For a row whose model is also gone, clearing the thumbnail still stops the
broken-image request, but the thumbnail cron cannot re-render it. It will claim
the avatar, fail to load the GLB, and retire it after `MAX_ATTEMPTS`, which is
bounded and self-limiting.

## Related

- [db-retention.md](db-retention.md): what else grows and what gets pruned.
- [page-audit.md](page-audit.md): the sweep that surfaced the first dead
  thumbnail, on `/pulse`.
