# Feature 14: welcome concierge NPC for first-time event visitors

Most event visitors will be first-timers landing from one shared link. The onboarding overlay explains controls, but nobody in the world greets them, answers questions, or shows them where things are. Build a concierge NPC that does.

## Where the code lives

- NPC layer: `src/game/npc/npc.js`, `npc-catalog.js`, `npc-chat.js` (already talks to `/api/brain/chat`), `nav-graph.js` (pathing), `economy-npcs.js` for placement precedent, and `citizens.js` / `world-life.js` (every ambient walker is now a real citizen you can open and talk to; the closest precedent for a greeter that approaches once). Mind the chat gate: `/api/brain/chat` clamps a signed-out caller to the free providers under an anonymous rate limit and answers 401 for the paid first-party models, so the concierge persona must pin a free provider or first-timers get a sign-in wall instead of a welcome
- Onboarding today: `src/game/play-onboard.js` (3-step overlay; its control list is data with an `essential` flag, so a tour stop that teaches a key should reference that list rather than restate it); intro card: `src/game/play-intro.js`
- Landmarks worth touring: the stations from `src/game/play-activities.js`, the chart jumbotron (`chart-screen.js`), the cosmetics boutique, the intel kiosk
- First-visit detection: the same localStorage signals `play-onboard.js` uses

## What to build

1. **The greeter.** A distinct, well-dressed NPC near spawn. For first-time visitors it approaches (or waves and beckons) once, never repeatedly, and never blocks movement. Returning players see it idle at its post; it never re-triggers the greeting.
2. **Real conversation.** Clicking or approaching opens the existing NPC chat with a concierge persona: it knows what this place is ($THREE's world on three.ws), what there is to do (name the actual stations and panels that exist in code, not marketing copy), how to earn and spend, and how to sign in. Ground the persona prompt in the real feature set so it never invents features.
3. **Guided tour.** A "show me around" choice that walks the player (NPC leads using the nav graph, waypoint markers as fallback) through three or four real landmarks with one line at each. Skippable at any point; works with the mobile joystick.
4. **Event awareness.** During the event window (`public/event.json`) the concierge's opening line points at the event: what is happening and where. Outside the window that line does not exist.
5. **Zero-regression mount.** Prefer a self-attaching module in the `ambient-crowd.js` / `event-countdown.js` style. The concierge must never appear in worlds where the NPC layer is disabled, and must cost nothing when idle (no per-frame work while nobody is near).

## Verify

- Fresh profile (cleared localStorage) on `npm run dev`: greeting fires once, tour completes, chat answers "what is this place" and "how do I make money here" sensibly, on desktop and emulated mobile.
- Second visit: no re-greeting. Console clean throughout.
- `npm test` green.

## Report format

Files shipped, the persona prompt location, the tour stops, what the concierge says in its event-window line, and the `data/changelog.json` entry.
