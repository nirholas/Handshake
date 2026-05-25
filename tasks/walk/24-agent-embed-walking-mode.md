# Task 24 — Agent Embed: Walking Avatar Mode for Embedded Agents

## Priority: HIGH

## Objective
Extend `pages/agent-embed.html` (the embeddable agent widget) so the agent appears as a walking avatar — not just a chat box. Customers embedding an agent on their site get a live, walking, conversational character instead of a flat chat bubble.

## Scope
- Files: `pages/agent-embed.html`, `src/agent-embed-modal.js`
- Add a `mode=walking` query param to the embed page
- When `mode=walking`:
  - Render the walking avatar canvas (reuses `src/walk.js` core)
  - Render a chat input below the avatar (single-line, expands on focus)
  - User types → send to existing agent chat API → response → `walk.say(reply, { voice: true })` (task 15)
  - Avatar plays `talking` gesture during reply
  - Idle behavior: wanders subtly within a 2m radius (uses NPC wander AI from task 19, scoped)
- Custom domain support: if embedded under a customer's domain via the agent embed allowlist, keep working (no CORS issues — verify with real cross-origin test)
- Backward compatible: existing embeds without `mode=walking` continue to work as before

## Definition of Done
- `<iframe src="https://three.ws/agent-embed?agent=<id>&mode=walking">` renders a walking avatar with chat
- Type a message → avatar responds in voice + bubble + talking gesture
- Idle wander does not feel jittery
- Works on a foreign origin (test with a static HTML file served from a different localhost port)
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real chat backend, real TTS, real avatar. Wire end-to-end.
