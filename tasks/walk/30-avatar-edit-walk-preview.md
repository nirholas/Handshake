# Task 30 — Avatar Editor: Live Walk Preview

## Priority: MEDIUM

## Objective
In the avatar editor (`pages/avatar-edit.html`, `src/avatar-edit/`), add a "Walk Preview" tab so creators can test how their avatar looks while walking — not just standing in a T-pose or A-pose.

## Scope
- Files: `pages/avatar-edit.html`, `src/avatar-edit/` (locate editor entry)
- Add a third preview mode tab alongside existing (likely Idle / Pose): "Walk"
- When selected:
  - Camera switches to third-person follow
  - Avatar walks in a circle around the editor stage (radius 1.5m, speed 1 m/s)
  - WASD enabled in the preview so creator can drive avatar around
  - Optional: load any of the environments from task 18 via a small dropdown in the preview pane (default: void)
- Bone/blendshape edits in the editor reflect instantly on the walking preview (rig hot-reload)
- "Open in Walk page" button: deep-links to `/walk?avatar=<draftId>&preview=true` — uses the in-progress draft, not the saved version (requires draft preview endpoint at `/api/avatars/draft/<id>` if not present — build it real)
- Performance: preview canvas at 30 FPS to keep editor responsive

## Definition of Done
- Open avatar editor → switch to Walk preview → avatar walks
- Edit a blendshape (e.g., smile) → walking avatar reflects change in real time
- Drive avatar with WASD inside preview pane
- "Open in Walk page" opens a full walk experience with the draft avatar
- No console errors

## Rules
Complete 100%. No stubs. No fake data. Real draft endpoint if missing — build it. Real rig hot-reload. Wire end-to-end.
