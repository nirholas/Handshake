# 03 — Site-wide follow graph

Read `prompts/user-value/_shared.md` first. It is binding. Depends on wave 1
(`01-creator-profile.md`) for the canonical profile page to attach follow UI to.

## Why this matters

`/play` and `/walk` already have a proven social layer — `src/friends.js`, `friends-panel.js`,
`friends-panel.css`, `src/social/` implement DMs and presence. That infrastructure is real and
live, just scoped to one surface. There is no way to follow a creator and see their new drops
site-wide. This prompt extends what exists rather than inventing a parallel system.

## Mission

Ship a site-wide follow graph: any user can follow another user/creator, see their followers/
following counts and lists on their profile, and (feeding wave 2's `02-activity-feed.md`) get a
"people I follow" activity filter that actually works.

## Tasks

1. **Audit `src/friends.js` and `src/social/` fully.** Determine the current data model (is it
   mutual "friends," one-directional "follow," presence-only?), storage (which table/API), and
   scope (is it truly `/play`-only, or already partially general?). Do not assume — read the
   code.
2. **Decide: extend vs. new.** If the friends system's data model can support one-directional
   follow with minimal change, extend it. If it's fundamentally mutual-friendship-shaped and
   follow needs to be one-directional and asymmetric (the correct model for a creator-following
   use case — you don't need mutual consent to follow a public creator), build a parallel
   `follows` table/API and document why extension wasn't viable.
3. **API.** `POST/DELETE /api/follow` (or matching existing route conventions), `GET
   /api/follows/:handle` (followers + following lists, paginated), follower/following counts
   exposed wherever profile data is fetched.
4. **UI.** Follow/unfollow button on `01-creator-profile.md`'s profile page (real-time state,
   optimistic update, proper logged-out state — prompt to sign in, don't silently no-op).
   Followers/following lists as tabs or modals on the profile.
5. **Feed integration.** Emit a follow event in the same shape `02-activity-feed.md` consumes
   (coordinate the event shape; if that prompt runs concurrently, define the shape here and note
   it in your report so the feed prompt can consume it either order).
6. **Notification hook.** Emit a "X followed you" event in whatever shape
   `04-notifications.md` will consume — define and document the event shape even if that
   prompt hasn't shipped yet.

## Done checklist

- [ ] Two real accounts can follow/unfollow each other; state persists across reload.
- [ ] Profile page shows accurate follower/following counts and lists.
- [ ] Logged-out follow attempt prompts sign-in, doesn't fail silently or 500.
- [ ] Follow and unfollow events are emitted in a documented shape for the feed/notification
      prompts to consume.
- [ ] Report the extend-vs-new decision from task 2 and why.
