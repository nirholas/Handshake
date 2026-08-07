# Feature 19: forge 3D props live inside build mode

The platform's headline capability is text to 3D, and the world's build mode cannot use it. The prop palette pulls only the public avatar gallery, so building means placing other people's uploads. Wire the Forge lane into build mode: type a prompt, watch the object appear where you pointed, and everyone in the world sees it. At a live event this is the demo moment.

## Where the code lives

- Forge lane: `api/forge.js` and siblings (`api/forge-gameready.js`, `api/forge-remesh.js`, `api/forge-rig.js`); client precedents in `src/forge.js` / `src/forge-studio/`. Use the platform's free text-to-3D lane and its existing rate limits; do not add a new paid dependency
- Prop plumbing (already networked and persistent): `src/game/world-objects.js` (`registerUploadedProp`, mirrors the server `objects` MapSchema), `src/game/avatar-upload.js` (`uploadPropModel`, presigned upload), the `_uploadProp` flow in `src/game/coincommunities.js`, persistence via `src/game/world-persist.js`
- Prop palette UI: the props panel in `src/game/coincommunities-ui.js` (currently fetching `/api/avatars/public`), styles in `src/game/coincommunities.css`
- The mobile lesson: `src/game/ambient-crowd.js` documents how uncapped user models killed iOS tabs, and its `CROWD_BUDGET` tiers are the sizing precedent
- Generation ground truth when debugging: the `forge_creations` table carries per-generation backend, status, error, and prompt

## What to build

1. **A Forge tab in the prop palette.** Prompt field, generate button, and a short history of this session's generations. Guidance text sets expectations honestly (real generation takes real time; say roughly how long from observed lane behavior, not a made-up number).
2. **Placement-first flow.** The player aims and places a hologram placeholder immediately (ghost shell in the build style, clearly "generating", using the real async state, never a fake progress bar). When the GLB lands, it swaps in place with a brief materialize effect. On failure the hologram becomes a designed error marker with retry and dismiss.
3. **The full prop pipeline, not a side door.** The finished GLB goes through `uploadPropModel` and `registerUploadedProp` so it is networked to every player, persists through `world-persist.js`, respects the per-player build budget, and is undoable with the existing Ctrl+Z stack.
4. **Size discipline.** Run generations through the gameready/remesh path so what enters the world is capped: enforce a hard triangle and file-size ceiling in the spirit of `CROWD_BUDGET` before a model is ever registered. An oversized result is decimated or rejected with a clear message, never placed raw. This is the difference between a demo moment and a repeat of the iOS crash.
5. **Abuse limits.** Per-player generation cooldown and a per-world concurrent-generation cap, enforced server-side on the endpoint, with the client showing queue position honestly.

## Verify

- On `npm run dev` with a second browser: generate a prop from a prompt, see the hologram, see the swap, confirm the second browser renders it live and after a reload (persistence).
- Failure path exercised (kill the request in devtools): error marker, retry works, dismiss cleans up, budget not consumed by the failure.
- Generate an intentionally heavy prompt and confirm the size ceiling triggers with its designed message.
- Mobile emulation: the Forge tab is usable with the touch keyboard and the placed result stays within the memory budget. `npm test` green.

## Report format

Files shipped, the size ceiling values and where they are enforced, the rate-limit shape, average observed generation time during verification, and the `data/changelog.json` entry.
