# Task 37 — Walk Mini-Map: Top-Down View of the Environment

## Priority: LOW

## Objective
Add a small mini-map overlay to the walk page showing a top-down view of the environment, the player's position/heading, and any NPCs or other players (multiplayer, task 17).

## Scope
- Module: `src/walk-minimap.js`
- 160×160 px square in top-right HUD corner; rounded, semi-transparent dark background
- Renders via a second Three.js scene/camera (orthographic, top-down, framed on a 40×40m area centered on player)
- Same scene meshes, just rendered from above with simplified shading (basic material, flat color per object class)
- Player: green arrow pointing in heading direction, always centered
- NPCs: blue dots
- Other multiplayer players: orange dots with name label on hover
- Environment landmarks (loaded from env metadata `landmarks: [{ name, pos }]`): white dots with label on hover
- Click on mini-map → trigger click-to-walk (task 35) to that world position
- Zoom: scroll over minimap → adjusts ortho frustum (10m–80m radius range)

## Definition of Done
- Walk page shows minimap in top-right
- Player dot rotates with avatar heading
- NPCs and multiplayer players appear and update in real time
- Click on minimap walks avatar to that location
- Scroll zoom works
- No console errors, no significant FPS impact

## Rules
Complete 100%. No stubs. No fake data. Real second-camera render, real interactions. Wire end-to-end.
