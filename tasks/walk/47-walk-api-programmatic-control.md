# Task 47 — Walk API: Programmatic Control Endpoint

## Priority: MEDIUM

## Objective
Expose a REST + WebSocket API so external systems — other agents, CI bots, webhooks — can programmatically control a running walk session: move the avatar, trigger gestures, speak text, change environments.

## Scope
- New Vercel function group: `api/walk/control/`
  - `POST /api/walk/control/session` — create a named session `{ avatarId, env, roomCode? }` → returns `{ sessionId, controlToken }`
  - `POST /api/walk/control/:sessionId/move` — `{ x, z, speed? }` → avatar walks to that world position
  - `POST /api/walk/control/:sessionId/gesture` — `{ gesture: 'wave' | 'dance' | ... }`
  - `POST /api/walk/control/:sessionId/say` — `{ text, voice?: boolean }`
  - `POST /api/walk/control/:sessionId/env` — `{ env: 'beach' }` swaps environment live
  - `GET  /api/walk/control/:sessionId/state` — returns current position, animation, env
  - All endpoints require `Authorization: Bearer <controlToken>` header
- Wire control commands into the walk page:
  - Walk page polls `GET /api/walk/control/:sessionId/commands?since=<ts>` every 500ms (or uses SSE endpoint for push)
  - Received command → executes against local scene state
- Documentation: `public/docs/walk-api.html` — full API reference with cURL examples, JS fetch examples, WebSocket example
- Rate limits: 60 commands/min per session (enforced with KV or the existing rate-limiter pattern in `api/`)

## Definition of Done
- `curl -X POST /api/walk/control/session -d '{"avatarId":"..."}' -H 'Authorization: Bearer ...'` creates a session
- Follow-up `POST /move` makes the avatar move on the walk page within 1s
- `POST /say` triggers real TTS + bubble
- State endpoint returns live position
- API docs page is complete with working examples
- Rate limiter enforced (verified by sending 61 requests)

## Rules
Complete 100%. No stubs. No fake data. Real REST API, real command execution, real rate limiting. Wire end-to-end.
