---
name: author-game-levels
description: Author or revise readable, flat-world Three.js game levels. Use for movement and camera routes, collision and navigation, encounter zones, landmarks, objectives, pickups, motivated lighting, visibility, deterministic level data, or desktop and mobile playthrough verification.
---

# Author Game Levels

Treat architecture as gameplay communication. Every route, arena, gate, prop, and light must help the player read movement, threats, objectives, or state.

## Enforce one gameplay plane

Keep all collision, navigation, encounter routes, objectives, pickups, and player movement on one accessible plane.

- Do not add stairs, ramps, raised platforms, drop-offs, cliffs, bridges, ledges, pits, or vertical traversal.
- Do not change gameplay elevation for shortcuts, arenas, hazards, rewards, or visual variety.
- If visual height is requested later, keep it non-walkable background dressing. It must not alter navigation, camera occlusion, threat visibility, targetability, or player movement.

## Separate level systems

Maintain explicit, independently testable layers for:

- authored level data and stable zone/anchor IDs;
- visual geometry and non-walkable background dressing;
- simplified collision geometry;
- flat navigation data and movement clearance;
- encounter, enemy, gate, reset, pickup, objective, and exit zones.

Share stable IDs and transforms between layers, but never infer collision, navigation, or encounter boundaries from decoration alone.

## Lay out readable play

1. Define the architectural purpose of each space: traversal, orientation, combat, recovery, reward, transition, or objective.
2. Preserve clear movement, camera, and dodge corridors at the intended play distance.
3. Keep threats, pickups, exits, gates, and interaction targets visible before commitment.
4. Telegraph encounters through visible arena shape, approach, state change, and stable zone anchors.
5. Deliberately place arenas, gates, checkpoints, retry spawns, and reset paths. Prevent soft locks, duplicate rewards, hidden re-entry, and enemies pursuing through unrelated zones.
6. Use landmarks, lighting, contrast, and composition to guide without hiding hazards or making the route ambiguous.

## Motivate every local light

Attach every local torch, lantern, brazier, or similar light spatially to a visible emitter. Its position, range, color, intensity, shadowing, and occlusion behavior must match what that emitter appears able to produce.

- Forbid unexplained floating local lights.
- Keep a source-to-light inventory with emitter ID, light ID, attachment transform, type, range, color/intensity, occlusion intent, enabled state, and fallback behavior.
- Move the light with a moving emitter. Disable or remove its local contribution when the emitter is disabled, hidden, destroyed, or unloaded.
- Document ambient or world lighting separately. Use it for deliberate global visibility or mood, never to fake a torch or other local source.

## Validate data and geometry

- Assert that all walkable collision, navigation vertices/links, encounter anchors, gates, objectives, pickups, exits, and reset points remain on the configured gameplay plane within a small tolerance.
- Reject walkable slopes, out-of-plane links, vertical shortcuts, elevated spawn points, and level data that implies height-changing traversal.
- Check collision/nav agreement, route clearance, zone containment, deterministic gate/reset behavior, stable anchor references, and persistence of level progress.
- Validate source-to-light inventory completeness, emitter/light attachment, range/color intent, and moving or disabled emitter state transitions.

## Prove traversal in the browser

Run deterministic route, collision, navigation, encounter, reset, and lighting fixtures, then traverse every critical and optional route in the repository-approved browser.

- On desktop and mobile, verify uninterrupted flat movement, dodge clearance, camera framing, threat/pickup/exit visibility, encounter telegraphs, gates, retry paths, and touch controls.
- Exercise moving and disabled emitter cases and confirm no light remains detached or unexplained.
- Inspect dense views for occlusion, console health, frame time, draw calls, memory stability, and long-session lighting cost.
- Report new failures separately from existing baseline issues.
