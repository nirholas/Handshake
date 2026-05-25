# Task 23 — Agent Detail Page: "Walk With This Agent" Mode

## Priority: HIGH

## Objective
On every agent detail page (`pages/agent-detail.html` and `pages/handle.html`), add a prominent "Walk with this agent" CTA that opens the walk experience with that agent's avatar pre-loaded.

## Scope
- Files: `pages/agent-detail.html`, `src/agent-detail.js`, `pages/handle.html`
- Add CTA button in the hero/profile section, near the existing "Chat" / "Follow" actions
- Click → opens `/walk?avatar=<agent.avatarId>&agent=<agent.id>` in same tab (or new tab if held with modifier)
- On the walk page, if `?agent=<id>` is present, fetch agent metadata (`/api/agents/<id>`) and:
  - Set the avatar's display name pill to the agent's handle
  - Load the agent's persona into the voice chat (task 16) so conversations are in character
  - Use the agent's preferred environment if set in agent meta; else default
- Add a small inline walking-avatar preview card on the agent detail page itself (240×320), reuses `/walk-embed` iframe — shows the agent's avatar walking idly as a teaser
- The preview card has its own "Expand" button → opens full walk page

## Definition of Done
- Visit `https://three.ws/@somehandle` → see the avatar walking in the preview card
- Click "Walk with this agent" → walk page opens with correct avatar and agent persona loaded
- Voice chat in walk mode responds in the agent's persona
- No console errors on agent detail page or walk page

## Rules
Complete 100%. No stubs. No fake data. Real agent fetch, real avatar load, real persona injection. Wire end-to-end.
