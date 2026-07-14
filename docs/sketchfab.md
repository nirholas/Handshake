# Sketchfab showcase

The best community-made forge models are published to the official three.ws
account on [Sketchfab](https://sketchfab.com), the largest public 3D model
site. Each model page there links back to the creation on three.ws, so the
showcase doubles as a discovery channel: someone browsing Sketchfab finds a
model, follows the link, and can remix it or forge their own.

This is a curated feed, not a mirror. Only models the community has already
validated get pushed, a few per week.

## What gets picked

Selection runs three times a week (Mon/Wed/Fri) and takes up to
`SKETCHFAB_UPLOADS_PER_RUN` models per run (default 2), in this order:

1. **Weekly Forge-Off winners.** The creation crowned by community vote each
   week on the [forge board](/forge) is the strongest curation signal on the
   platform and always goes first.
2. **Top-voted board models.** Anything with at least one community upvote,
   highest votes first. Raw unreviewed output is never pushed.

A model is skipped when its GLB exceeds the Sketchfab upload cap (45 MB
guard), when it was already uploaded, or when it failed three times.

## What an upload looks like

Every published model carries:

- **The generation prompt** at the top of the description, in quotes.
- **AI disclosure**: the `ai-generated` tag plus a plain statement that the
  model was AI-generated on the three.ws Forge. Sketchfab has no dedicated
  AI-content field, so tag + statement is the correct marking.
- **Backlinks with UTM parameters** (`utm_source=sketchfab`,
  `utm_medium=referral`, `utm_campaign=showcase`): one to the creation's
  [share page](/docs/share-and-embed) (`/forge/share/<id>`), one to
  [/forge](/forge). The UTM tags make Sketchfab referrals measurable in
  analytics, which decides whether the cadence goes up or down.
- **Tags**: `ai-generated`, `generative-ai`, `text-to-3d`, `threews`, plus the
  model's category.

Models are published viewable and inspectable but not downloadable: creations
belong to their creators, and the showcase does not relicense them.

## How it runs

`GET /api/cron/sketchfab-showcase` (Cloud Scheduler, `Bearer $CRON_SECRET`):

1. Refreshes the async processing status of recent uploads
   (`uploaded` becomes `live` when Sketchfab finishes processing).
2. Selects candidates and claims each in the `sketchfab_uploads` ledger
   before any network call, so a retried or concurrent run can never
   double-upload.
3. Downloads the stored GLB and posts it to the
   [Sketchfab Data API v3](https://docs.sketchfab.com/data-api/v3/index.html)
   (`POST /v3/models`, multipart).

`?dry_run=1` returns the current selection without uploading anything.

## Configuration

| Env var | Meaning |
|---|---|
| `SKETCHFAB_API_TOKEN` | Data API token of the official account (Sketchfab settings, Password & API). Unset: the cron is dormant and skips cleanly. |
| `SKETCHFAB_UPLOADS_PER_RUN` | Models per run, default 2, clamped 1-5. At the Mon/Wed/Fri schedule the default publishes up to 6 models a week. |

State lives in the `sketchfab_uploads` table (one row per creation:
`pending`, `uploaded`, `live`, or `failed` with the error recorded). Code:
[`api/cron/sketchfab-showcase.js`](https://github.com/nirholas/three.ws/blob/main/api/cron/sketchfab-showcase.js)
and [`api/_lib/sketchfab.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/sketchfab.js).
