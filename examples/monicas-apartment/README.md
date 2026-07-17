# Monica's Apartment (Friends) - first-person Three.js scene

A single, self-contained HTML file that rebuilds the iconic Monica Geller apartment set from Friends as a walkable first-person 3D scene: purple walls, the purple front door with the yellow peephole frame, teal kitchen cabinets, the mismatched dining chairs, the big living-room window onto a lit-up night skyline with balcony and fire-escape railing, all under warm evening lighting.

It answers the community "single HTML apartment" benchmark that has been going around for coding models: one file, no build step, no assets. Every texture (wood floor, oriental rug, city skyline) is generated procedurally on a canvas at load, so the file has zero external dependencies beyond the Three.js module itself.

## Run it

Open the file directly in a browser; no server needed:

```
open examples/monicas-apartment/index.html
```

Or from the repo dev server (`npm run dev`, port 3000): `http://localhost:3000/examples/monicas-apartment/index.html`.

Three.js 0.184 loads from the jsDelivr CDN via an import map, so the page needs network access on first load.

## Controls

- Click to enter (pointer lock)
- WASD or arrow keys to walk, mouse to look
- Shift to run, Esc to release the pointer

## What's inside (for readers of the code)

- First-person rig: a yaw object containing a pitch object containing the camera; no external controls addon.
- Movement: axis-separated AABB collision so you slide along furniture instead of sticking to it, with a subtle head-bob.
- Walls with openings are assembled from box segments (`wallWithOpenings`), which is how the two windows punch through the north wall.
- Lighting: warm ambient plus five point lights (dining pendant and floor lamp cast shadows) and a cool bluish directional as moonlight through the big window; ACES tone mapping.
- A `window.__scene.snap(x, y, z, yaw, pitch)` hook exists so headless browsers can position the camera for screenshot verification.
