# 04 — Notification center

Read `prompts/user-value/_shared.md` first. It is binding. Can run concurrently with wave 2
siblings; consumes event shapes documented by `02-activity-feed.md` and `03-social-graph.md` if
they've shipped, otherwise define the shape yourself and note it in your report.

## Why this matters

DMs, remixes, royalty payouts, and quest completions already happen server-side with zero way
for a user to learn about them without polling every page manually. `notifications` doesn't
appear anywhere in `data/pages.json`. This is a pure retention gap: real value already being
created (someone remixed your model, you earned a royalty) is currently invisible.

## Mission

Ship a real notification system: a bell/inbox UI reachable from every logged-in page, backed by
a real notification store, populated by real platform events.

## Tasks

1. **Audit existing event sources.** Find every place the platform already knows something
   notification-worthy happened but doesn't tell the user: remix events (`api/remix-feed.js`),
   royalty payouts, DM receipt (`src/friends.js`/`src/social/`), quest/leaderboard milestones,
   coin launch fills, follow events (from `03-social-graph.md`). List them precisely in your
   report before building.
2. **Storage.** A `notifications` table/API: recipient, type, actor, target, read/unread state,
   created_at. Check for an existing partial implementation before creating a new table — search
   for `notification` across `api/` and any `.sql`/migration files first.
3. **Write path.** Wire each real event source from task 1 to insert a notification. Don't build
   a generic "emit anything" bus if the codebase has no event bus already — direct inserts at
   the point each event already happens are fine and simpler.
4. **Read path + UI.** A bell icon with unread count in the site's persistent nav (find the
   shared header/nav component — do not duplicate it per-page), opening a dropdown or dedicated
   `pages/notifications.html` listing recent notifications, each linking to its target (the
   remix, the DM thread, the profile that followed you). Mark-as-read on view/click.
5. **Delivery cadence.** In-app is required. If the codebase already has an email or push
   channel wired anywhere (check for existing transactional email usage), route high-value
   notification types (royalty payout, remix) through it too — don't build a new delivery
   channel from scratch if this is a nice-to-have without existing infra; note the gap in your
   report instead.
6. **Preferences.** At minimum a per-type mute toggle so notification volume doesn't become
   noise — store it, respect it in the write path.

## Done checklist

- [ ] Triggering a real event (e.g. a real remix, a real follow from `03-social-graph.md`)
      produces a real notification visible in the bell UI within a reasonable delay.
- [ ] Unread count is accurate and clears on read.
- [ ] `pages/notifications.html` (or equivalent) registered in `data/pages.json`.
- [ ] Mute preference persists and is respected.
- [ ] Report which event sources from task 1 got wired and which didn't (with reasons).
