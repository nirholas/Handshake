# Feature 19: forge 3D props live inside build mode

The platform's headline capability is text to 3D, and the world's build mode can now use it: the prop palette has a Forge form (and chat takes `/forge <prompt>`), `src/game/forge-prop.js` drives the free draft lane, and the finished GLB rides the uploaded-prop pipeline so everyone in the world sees it and the room persists it ([docs/play-forge-in-world.md](../play-forge-in-world.md)). What shipped is the pipeline; what is still open is the placement-first hologram, the size ceiling, and the server-side abuse limits below. At a live event this is the demo moment, and the size ceiling is what keeps it from becoming the iOS crash.

## Where the code lives

- Forge lane: `api/forge.js` (`POST /api/forge` submits, `GET /api/forge?job=` polls, `POST /api/forge?action=rig` auto-rigs; there is no separate rig handler) and siblings (`api/forge-gameready.js`, which now also accepts a settled forge purchase and echoes only its own payment error codes, and `api/forge-remesh.js`); in-world client `src/game/forge-prop.js` (submit, poll every 2.5 s, up to 6 minutes for a cold GPU start, reference photos via `/api/forge-upload` capped at 8 MB, keyed to the same `forge:cid` handle the /forge page uses so in-world forges land in the same history); page precedents in `src/forge.js` / `src/forge-studio/`. Use the platform's free text-to-3D lane and its existing rate limits; do not add a new paid dependency
- Prop plumbing (already networked and persistent): `src/game/world-objects.js` (`registerUploadedProp`, mirrors the server `objects` MapSchema), `src/game/avatar-upload.js` (`uploadPropModel`, presigned upload), the `_uploadProp` flow in `src/game/coincommunities.js`, persistence via `src/game/world-persist.js`
- Prop palette UI: the props panel in `src/game/coincommunities-ui.js` (the gallery tab still fetches `/api/avatars/public`; the Forge form is `forgeBtn` / `toggleForge()` reporting through the shared status strip, and the game side is `_forgeProp` in `src/game/coincommunities.js`), styles in `src/game/coincommunities.css`
- The mobile lesson: `src/game/ambient-crowd.js` documents how uncapped user models killed iOS tabs, and its `CROWD_BUDGET` tiers are the sizing precedent
- Generation ground truth when debugging: the `forge_creations` table carries per-generation backend, status, error, and prompt

## What to build

1. **A Forge tab in the prop palette.** Shipped as the Forge form in the props panel (prompt or reference photo, one forge at a time, progress in the status strip) plus the `/forge <prompt>` chat command, which opens build mode with the result armed. Still open: a short history of this session's generations, and guidance text that sets expectations honestly (the lane comment says draft-tier generations land in about 30 to 60 s; quote observed behavior, not a made-up number).
2. **Placement-first flow.** Still open. Today the prop is armed as a ghost only after the GLB lands and the next click places it. Build the other order: the player aims and places a hologram placeholder immediately (ghost shell in the build style, clearly "generating", using the real async state, never a fake progress bar). When the GLB lands, it swaps in place with a brief materialize effect. On failure the hologram becomes a designed error marker with retry and dismiss.
3. **The full prop pipeline, not a side door.** Shipped: `_forgeProp` hands the finished GLB to `registerUploadedProp` and the normal `obj:spawn` placement, so it is networked to every player, persists like any other build, respects the per-player build budget, and is undoable with the existing Ctrl+Z stack. Verify a result that comes back with `durable: false` (temporary storage the server's asset allow-list may refuse) surfaces its warning and never leaves a phantom in the palette.
4. **Size discipline.** Still open, and the one that matters most. `forge-prop.js` enforces no triangle or file-size ceiling and never routes through the gameready/remesh path. Run generations through it so what enters the world is capped: enforce a hard triangle and file-size ceiling in the spirit of `CROWD_BUDGET` before a model is ever registered. An oversized result is decimated or rejected with a clear message, never placed raw. This is the difference between a demo moment and a repeat of the iOS crash.
5. **Abuse limits.** Still open beyond the lane's own rate limits and the client's one-forge-at-a-time guard. Per-player generation cooldown and a per-world concurrent-generation cap, enforced server-side on the endpoint, with the client showing queue position honestly.

## Verify

- On `npm run dev` with a second browser: generate a prop from a prompt, see the hologram, see the swap, confirm the second browser renders it live and after a reload (persistence).
- Failure path exercised (kill the request in devtools): error marker, retry works, dismiss cleans up, budget not consumed by the failure.
- Generate an intentionally heavy prompt and confirm the size ceiling triggers with its designed message.
- Mobile emulation: the Forge tab is usable with the touch keyboard and the placed result stays within the memory budget. `npm test` green.

## Report format

Files shipped, the size ceiling values and where they are enforced, the rate-limit shape, average observed generation time during verification, and the `data/changelog.json` entry.
