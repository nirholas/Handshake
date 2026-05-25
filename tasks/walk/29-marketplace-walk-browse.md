# Task 29 — Marketplace: Walk-Browse Mode

## Priority: MEDIUM

## Objective
Add a "Walk-Browse" mode to the marketplace (`pages/marketplace.html`, `public/bazaar.html`) where the user's avatar walks through a 3D gallery of agents/avatars/skills — each listing rendered as a stage in a procedurally generated hall.

## Scope
- File: new `pages/marketplace-walk.html` linked from marketplace toggle button
- Reuses walk engine from task 1–18
- Procedurally generates a corridor with listing "plinths" every 4 meters:
  - Each plinth shows the agent/avatar/skill artwork on a vertical billboard
  - Title + price floating above
  - Walk close (within 2m) → details panel slides in from the right with full listing info
  - Press `E` (or tap) → opens that listing's detail page
- Pull listings from existing marketplace API endpoint (search `api/marketplace/` or `api/bazaar/`)
- Pagination: corridor extends as you walk; loads next page when user is within 20m of the end (infinite hallway pattern)
- Filter chips at top: All / Agents / Avatars / Skills — re-generates corridor with filtered listings
- Persist `?env=gallery` as default environment

## Definition of Done
- Open `/marketplace-walk` → walk into a hallway of real listings
- Approaching a plinth shows real listing data
- `E` opens the correct detail page
- Infinite scroll into next page works smoothly
- Filter chips work and re-generate
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real listings from real API. Wire end-to-end.
