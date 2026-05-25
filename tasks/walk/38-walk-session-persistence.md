# Task 38 — Walk Session Persistence: Resume Where You Left Off

## Priority: MEDIUM

## Objective
Persist walk session state — avatar position, rotation, environment, camera mode, gestures recently used — so that returning to `/walk` resumes from the last known state instead of starting over.

## Scope
- Module: `src/walk-session.js`
- State persisted:
  - Avatar ID, environment, camera mode
  - Position (x, y, z), rotation (yaw)
  - Last 5 gestures used (most recent first; surfaces them in the gesture wheel for quick re-use)
  - Companion preferences (size, walk speed)
  - Multiplayer room code if in multiplayer
- Storage:
  - `localStorage` for unauthenticated sessions
  - `/api/walk/session` PUT/GET endpoint for authenticated users (real, persisted to the existing user database)
- Save triggers:
  - On `beforeunload`: snapshot current state
  - Every 30s while active (throttled): snapshot
- Restore on page load:
  - If state exists and is < 7 days old, restore avatar to last position/rotation, load same environment, restore camera mode
  - Show a small "Welcome back" toast with "Start fresh" button (clears state)
- Cross-device sync: for authed users, latest state syncs across browsers

## Definition of Done
- Walk for 30s, close tab, reopen `/walk` → avatar resumes at last position
- Auth users: walk on laptop, open `/walk` on phone → same state restored
- "Start fresh" toast button wipes state
- No console errors
- State endpoint returns 200 with correct payload (verify with real curl)

## Rules
Complete 100%. No stubs. No fake data. Real DB persistence for authed users. Wire end-to-end.
