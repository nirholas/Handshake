# Task 19 — Walk Page: NPC Companion Avatars

## Priority: MEDIUM

## Objective
Populate the walk environment with one or more NPC companion avatars that wander, react to the player, and can be talked to. Makes the walk experience feel alive even when alone.

## Scope
- New module: `src/walk-npcs.js`
- NPC types (each is a real three.ws avatar, fetched from the avatar API):
  - `wanderer` — walks in random directions, idles, then walks again
  - `greeter` — stays near spawn, waves when player approaches within 4m, speaks a greeting via TTS
  - `guide` — walks ahead of the player, slows when player stops, points at things, narrates ("That's the gallery wing.")
- AI driver per NPC type:
  - Simple finite state machine: `idle → wander → approach → speak → idle`
  - Triggers: distance to player, time since last action, line-of-sight raycast
- Each NPC uses:
  - The animation state machine (task 14) for gestures
  - Speech bubbles (task 15) for dialogue
  - TTS for voice (uses real `/api/tts/speak`)
- Dialogue lines are real and contextual to the environment (e.g., greeter on beach says "Welcome to the beach!" — write a small JSON dialogue table at `public/environments/<env>/dialogue.json` per environment)
- Spawn config in environment metadata: `npcs: [{ type: 'greeter', avatarId: '<id>', pos: [x,y,z] }]`
- HUD: optional toggle "NPCs: on/off" in settings overlay

## Definition of Done
- Load `?env=gallery&avatar=<id>` → at least one NPC is present and behaving correctly
- Walk near greeter → it waves and speaks a real TTS line
- Guide NPC actually leads you somewhere coherent (not random)
- NPCs do not collide with player (or do, configurably)
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real avatars for NPCs, real TTS, real dialogue. Wire end-to-end.
