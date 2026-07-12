# 02 — Real activity feed

Read `prompts/user-value/_shared.md` first. It is binding. Depends on wave 1
(`01-creator-profile.md`) for the creation-aggregation endpoint — read what it shipped before
starting.

## Why this matters

`pages/community.html` is a static card-link grid with no dynamic content. `pages/feed.html`
exists but its data source needs verification — it may be a genuine half-built start. Neither
gives a user a reason to check back: "what happened since I was last here?" This is the single
biggest lever for daily-return behavior identified in the audit.

## Mission

Turn `feed.html` into a real, live activity feed of platform creation events, and turn
`community.html` from a static link grid into a page that surfaces that activity.

## Tasks

1. **Audit `pages/feed.html` fully** — read all 381 lines, trace what API it calls (if any), and
   determine whether it's dead, partially wired, or fully wired to fake/empty data. Report this
   precisely before changing anything.
2. **Audit `api/remix-feed.js` fully** (196 lines) — it's an existing remix/creation feed
   backend. Determine what events it already emits and whether it can be the feed's data source
   directly, or needs extending to cover more event types (new forges, new dioramas, new
   launches, new avatars — not just remixes).
3. **Build/extend the feed endpoint** to emit a real, paginated, reverse-chronological stream of
   platform events: creation (forge/diorama/restyle), launch, remix, and (once wave 2's
   `03-social-graph.md` ships — coordinate via a shared event shape, don't block on it) follow
   events. Each event: actor (linking to their profile per `01-creator-profile.md`), action,
   target (linking to the live asset), timestamp.
4. **Wire `feed.html`** to render this stream: infinite scroll or paginated, real-time-ish
   (poll or SSE — match whatever real-time pattern already exists elsewhere in the codebase,
   e.g. check `src/social/` or `/play` presence code before inventing a new one).
5. **Rebuild `community.html`** from a static grid into a genuine community page: a trending/
   recent activity module (reuses the feed endpoint), plus whatever the static grid currently
   links to that's still worth keeping (audit its existing links before deleting them).
6. **Filters.** At minimum: all activity vs. "people I follow" (stub gracefully if wave 2's
   social graph hasn't shipped yet — build the filter UI, no-op it to "all" with a visible note
   in the report, not a broken feature).

## Done checklist

- [ ] `feed.html` renders real events from real platform activity, verified by triggering a
      real creation (e.g. forge a test model) and confirming it appears in the feed within a
      reasonable delay.
- [ ] `community.html` no longer static — shows live data.
- [ ] Every event in the feed links to both the actor's profile and the created asset.
- [ ] Designed empty state for a feed with zero events for a new/quiet account.
- [ ] Report exactly what `feed.html`'s prior state was (dead/partial/wired) and what changed.
