# 07. Floorplan authoring and layout persistence

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Order
[06](home-06-3d-home-scene.md) must have landed.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**Nothing in this file is a status claim to trust.** Step 0 re-measures.

---

## Step 0: re-derive the current state

```bash
npm run dev &
curl -s localhost:3000/api/home/<id> -H "cookie: <dev session>" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const g=JSON.parse(s).graph;console.log(g.floors.length,'floors',g.rooms.length,'rooms',g.unassigned.length,'unassigned')})"
ls src/home/                                             # scene.js, scene-model.js from order 06
```

## Why this order exists

Home Assistant knows which room a device is in. It does not know where that room is. Order 06
ships a default arrangement so the scene is useful immediately; this order lets a person make it
their actual house, which is the difference between a diagram and a place.

It is also the fix for the most common real-world state: **a house where nothing is assigned to
an area at all.** That user needs a five-minute path from a pile of entities to a floorplan.

## The model

A layout is per home, authored by a member, versioned, and **never** required. The scene must
work with no layout, a partial layout, and a stale layout (a room that no longer exists).

Schema, one migration:

### `home_layouts`

| Column | Type | Notes |
|---|---|---|
| `home_id` | `uuid primary key references home_connections(id) on delete cascade` | one live layout per home |
| `version` | `integer not null default 1` | bumped on every save, for optimistic concurrency between household members |
| `layout` | `jsonb not null` | the document below |
| `updated_by` | `uuid not null references users(id)` | |
| `updated_at` | `timestamptz not null default now()` | |

The layout document, validated by a schema on write (reuse the repo's existing validation
approach; do not accept arbitrary JSON into a rendering path):

```json
{
  "version": 1,
  "units": "m",
  "floors": [{ "id": "ground_floor", "level": 0 }],
  "rooms": [{
    "areaId": "kitchen",
    "floorId": "ground_floor",
    "x": 0, "y": 0, "w": 4.2, "h": 3.0, "rotation": 0,
    "entities": { "light.kitchen_lights": { "x": 2.1, "y": 1.5 } }
  }]
}
```

Rules the validator enforces: bounded coordinates, a room count cap, a document byte cap, no
unknown top-level keys, and `areaId` values that are strings only. A layout is user-authored
JSON that drives a renderer, so treat it as untrusted input, not as trusted state.

## The editor

A 2D top-down plan, because nobody arranges a floorplan in perspective. The 3D scene updates
live beside it or behind it.

- Drag to move a room, handles to resize, snapping to a grid and to adjacent walls.
- Rooms cannot overlap; the editor prevents it rather than validating it after the fact.
- Undo and redo, keyboard shortcuts included.
- Unassigned entities are a tray. Dragging one into a room **writes the area assignment back to
  Home Assistant** through `config/entity_registry/update`, so the work improves the user's own
  house and not just our picture of it. This is the single most valuable thing in this order.
- Multi-floor: add, name, reorder, set level.
- A "start from my house" path: if the house has areas, seed the plan from them; if it has none,
  the tray is the whole house and the flow is "make a room, drag things in".

## Concurrency

Two household members can edit. Optimistic concurrency on `version`: a save with a stale version
returns 409 with the current document, and the editor offers a real merge choice (keep mine,
take theirs, side by side), never a silent overwrite and never a lost edit.

## Every state

1. No layout: the seeded default, with an obvious way in.
2. No areas at all: the tray-first flow.
3. Editing: live, with the 3D following.
4. Saving: optimistic, with a real failure path.
5. Conflict: the 409 merge choice.
6. Stale layout: a room in the layout no longer exists in Home Assistant. Show it as orphaned and
   offer to drop it; never crash, never silently discard the user's work.
7. New room appeared in Home Assistant since the last save: surfaced in the tray, not hidden.
8. Read-only: a household member without the layout role (order 12) sees the plan and cannot edit.
9. Writing back to Home Assistant failed: the local layout still saves, and the failure is named.

## Tasks

| # | Task | Files |
|---|---|---|
| 1 | Migration and store functions. | `api/_lib/migrations/<ts>_home_layouts.sql`, `api/_lib/home/layout.js` |
| 2 | The layout schema validator, with the caps. | `api/_lib/home/layout-schema.js`, `tests/home-layout-schema.test.js` |
| 3 | `GET`/`PUT /api/home/:id/layout` with optimistic concurrency. | `api/home/[id]/layout.js` |
| 4 | The area write-back to Home Assistant, gated as a normal (ungated) action and logged. | `api/_lib/home/tools.js` or a sibling |
| 5 | The editor. | `src/home/floorplan.js`, styles |
| 6 | Wiring the saved layout into order 06's scene builder. | `src/home/scene-model.js` |
| 7 | e2e: author a plan, reload, and see it persist and render. | `tests/e2e/home-floorplan.spec.js` |

## Definition of done

- [ ] A real house arranged into a real floorplan, screenshotted in the editor and in the 3D scene.
- [ ] Dragging an unassigned entity into a room really changed its area in Home Assistant. Prove it from the Home Assistant side, not from our UI.
- [ ] A malformed layout document (over the cap, unknown keys, non-numeric coordinates) is rejected by the API with a designed error. Four transcripts.
- [ ] Two browser sessions editing the same home produce the 409 merge choice, and no edit is lost. Record the sequence.
- [ ] Deleting an area in Home Assistant puts the layout into state 6 without a crash and without discarding the rest.
- [ ] A house with zero areas can reach a complete floorplan through the tray-first flow in under five minutes. Time it and report the number.
- [ ] Undo and redo work, including across a drag and a resize.
- [ ] Zero console errors or warnings from your code.
- [ ] `npx playwright test tests/e2e/home-floorplan.spec.js` passes.
- [ ] `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| Tempted to auto-generate a floorplan from device positions | There are no device positions. Home Assistant has no geometry. Seed from areas, let the human place. |
| Tempted to make the layout required | Never. Order 06 works without one, and a required setup step before any value is how a feature dies. |
| Overlap prevention is fiddly | Axis-aligned rectangles on a grid. Keep it rectangles in v1; free-form polygons are a later slice and not worth the complexity now. |
| Writing back to Home Assistant feels risky | It is an area assignment, fully reversible in their own UI, and it is the thing that makes this worth doing. Log it, show it, and fail loudly rather than silently. |
| A room in Home Assistant has no entities | Draw it. An empty room is still a room. |

## Report format

1. Editor and scene screenshots of a real arranged house.
2. The Home Assistant-side proof of the area write-back.
3. The four validator rejections.
4. The concurrency sequence.
5. The timed zero-areas walkthrough.
6. Test output.
7. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-07-floorplan-editor.md

Never delete it on a partial.
