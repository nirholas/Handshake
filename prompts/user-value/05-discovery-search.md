# 05 — Cross-entity discovery / search

Read `prompts/user-value/_shared.md` first. It is binding. Depends on wave 1
(`01-creator-profile.md`) for creator links and benefits from wave 2's activity data for
ranking, but does not hard-block on it — build with what's available, wire in feed/social
signals if they've landed.

## Why this matters

Avatars, worlds, coins, and agents each have their own siloed browse surface (`/discover`,
`/gallery`, `/marketplace`, `/launches` and similar). There's no single place to search "things
like this" across all of them, and the remix-royalty economy that already exists in the backend
(referenced in `01-creator-profile.md`'s ground truth) has no discovery UI surfacing "remix this"
prominently.

## Mission

Ship one search/discovery surface that queries across creation types (avatars, models, worlds,
coins, agents) and surfaces remixable items clearly.

## Tasks

1. **Audit existing browse surfaces.** List every current discovery page (`/discover`,
   `pages/gallery-picker.html`, `pages/marketplace.html`, `pages/marketplace-walk.html`,
   `pages/marketplace-analytics.html`, launch feeds) and what each queries. Determine whether
   they already share a data layer or are fully independent silos.
2. **Decide: unify or federate.** Either build one true cross-entity search endpoint
   (`GET /api/search?q=&type=`) that queries all creation types and merges results by relevance/
   recency, or — if the underlying data stores are too heterogeneous to merge cheaply — build a
   federated search UI that fans out to each existing endpoint client-side and presents unified
   results. Justify the choice in your report; don't default to the harder option if the simpler
   one is honest.
3. **Ranking signals.** Recency, and if wave 2 has shipped: follower count of creator, remix
   count, activity feed engagement. Don't fake signals that don't exist yet — rank on what's
   real and note what's missing.
4. **Remix surfacing.** Every result card for a remixable asset shows a visible "Remix" action
   wired to the real remix flow (find it — likely adjacent to `api/remix-feed.js` or the forge/
   diorama pipelines) rather than only being reachable from inside an asset's own detail page.
5. **UI.** One search bar, type filters (avatar/model/world/coin/agent), result cards linking to
   the live asset and its creator's profile.
6. **Empty/error states.** No-results state suggests broadening the query or creating something
   matching the search, not a blank page.

## Done checklist

- [ ] A single query returns results spanning at least 2 creation types.
- [ ] Every result links to both the live asset and the creator's profile.
- [ ] Remix action is one click from a search result, not buried in a detail page only.
- [ ] Report the unify-vs-federate decision and why.
- [ ] `data/pages.json` entry if a new page was added.
