# Background generation and completion notifications

Forge generations are server-tracked to completion. You can start a generation
on [/forge](https://three.ws/forge), close the tab, and the platform finishes
the job, saves the model to your gallery, and tells you when it's ready.

## What the user experiences

- **Leave any time.** The generating panel says so explicitly. Navigating away
  or closing the tab does not lose the job.
- **Come back, pick up where you left off.** Returning to `/forge` within 30
  minutes resumes the live progress view for the in-flight job (honest elapsed
  timer included). The finished model also appears in the on-page gallery on
  any later visit.
- **Get notified.** Signed-in creators receive a notification when a
  generation finishes unattended: the bell inbox and Web Push fire with a link
  straight to the model, and an email goes out with a preview image. Failures
  notify too (bell and push only). Every channel has its own switch under the
  **Creations** category in the notification preference center. Anonymous
  users aren't left out: their browser resumes the job from local storage and
  the finished model is waiting in their gallery.

Attended completions never notify. If the result appeared on your screen, the
platform does not also push, email, or badge you about it.

## How it works

Three cooperating pieces:

1. **Client resume** ([src/forge.js](../src/forge.js)): after a job is
   submitted, its signed job token persists in `localStorage`
   (`forge:inflight`). On page load the forge resumes polling that token; all
   real state lives server-side, so a reload costs nothing. The record clears
   on completion, terminal failure, or cancel.

2. **Server-side finalizer** ([api/cron/forge-finalize.js](../api/cron/forge-finalize.js),
   every minute via Cloud Scheduler): sweeps `forge_creations` rows still at
   `status='generating'` after a 2-minute grace period. Rows whose job id is a
   GCP worker envelope (the async self-host lanes: TRELLIS, Hunyuan3D,
   TripoSG sketch) are polled directly on the worker: finished jobs are
   materialized into durable storage with the exact same writer the browser
   poll uses (`materializeCreation`), failed jobs are marked failed. Anything
   non-terminal after 45 minutes is marked failed as timed out, so no row can
   be orphaned at `generating` again.

3. **Notifications** ([api/_lib/forge-notify.js](../api/_lib/forge-notify.js)):
   the finalizer, and only the finalizer, notifies. `forge_complete` and
   `forge_failed` are standard notification types in the `creations`
   preference category (defaults: in-app on, push on, email on for
   completions). Email delivery uses the platform Resend pipeline and skips
   undeliverable placeholder addresses.

## Operational notes

- The finalizer needs `CRON_SECRET` (standard cron auth), `DATABASE_URL`, the
  R2 `S3_*` storage vars, and `GCP_RECONSTRUCTION_KEY` to poll workers. With
  no worker key it still reaps timed-out rows.
- Batch size is 25 per tick (`FORGE_FINALIZE_BATCH` overrides). Ticks are
  idempotent and safe to overlap.
- The response body reports `{ swept, done, failed, timed_out, still_running,
  unpollable }` per tick, so a quick manual hit shows queue health at a
  glance.

Related: [3d-pipeline.md](3d-pipeline.md) for the generation lanes themselves,
and the notification preference model in
[api/_lib/notify-prefs.js](../api/_lib/notify-prefs.js).
