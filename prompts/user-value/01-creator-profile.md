# 01 — Human creator profile / portfolio

Read `prompts/user-value/_shared.md` first. It is binding.

## Why this is first

Everything downstream (feed, social graph, discovery, leaderboard) needs a canonical "this is a
person and here's what they made" surface to point at. It's also the cheapest win available:
`pages/profile.html` and `pages/handle.html` are already built and routed — they're just scoped
to agent identities, not human creators, and `profile.html` is missing from `data/pages.json`
entirely.

## Mission

Give every three.ws user a portfolio page showing everything they've created across the
platform, and register it properly.

## Tasks

1. **Audit current scope.** Read `pages/profile.html` and `pages/handle.html` in full. Determine
   exactly what identity model they render (ERC-8004 agent only, or does it already resolve a
   human wallet/handle too?). Read the API routes they call to confirm the data source.
2. **Build the aggregation.** Add (or extend, if one already partially exists — check
   `api/remix-feed.js`, `api/_lib/avatar-thumbs.js`, `api/_lib/tokenize-3d.js` for reusable
   queries first) an endpoint that returns one user's full creation history: forged 3D
   models/avatars, dioramas/worlds (Scene Studio), material restyles, launched coins
   (pump-launch), and any agents they own. Query real tables — do not invent schema; if a
   creation type isn't tracked anywhere yet (e.g. dioramas), find its actual storage (check
   `api/diorama*.js`, the Scene MCP plugin backend) before assuming it needs a new table.
3. **Extend the profile UI.** Add a "Creations" section/tab to `pages/profile.html` (or
   `handle.html`, whichever is the canonical per-user page — decide from task 1's audit and
   document the choice) rendering the aggregation from task 2: grid of cards (thumbnail, type
   badge, created date, link to the live viewer). Paginate for users with 100+ creations.
4. **Wire discoverability.** Link to a user's profile from every surface that already shows
   attribution — forge results, diorama viewer, marketplace listings, launch records. Audit for
   dead-end creation views that don't currently link back to their creator.
5. **Design every state.** Empty (zero creations — tell them how to make their first thing, link
   to `/create`), loading (skeleton grid), error, populated, overflow.
6. **Register in `data/pages.json`** if not already present (`/profile` currently is not —
   confirm and fix). Add `added: 2026-07-12`.

## Done checklist (beyond `_shared.md`'s)

- [ ] A user with real creations across ≥2 types (e.g. an avatar and a diorama) sees both on
      their profile, each linking to the live asset.
- [ ] A brand-new user sees a designed empty state, not a blank page.
- [ ] `data/pages.json` validated via `npm run build:pages`.
- [ ] At least 3 existing surfaces (forge result, diorama viewer, marketplace listing) link to
      the creator's profile where they didn't before, or already did (state which).
- [ ] Report which page (`profile.html` vs `handle.html`) is now the canonical human portfolio,
      and why.
