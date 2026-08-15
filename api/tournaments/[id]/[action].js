/**
 * Social Trading Arena — sub-route entry point for /api/tournaments/:id/<action>.
 *
 *   GET  /api/tournaments/:id/stream     → SSE live rank changes
 *   POST /api/tournaments/:id/join       → enter an agent you own
 *   POST /api/tournaments/:id/withdraw   → withdraw an agent you own
 *   POST /api/tournaments/:id/close      → freeze + attest final standings (creator)
 *   POST /api/tournaments/:id/settle     → pay $THREE prizes (creator)
 *
 * Filesystem routing only matches a `[param].js` file on the LAST path segment, so
 * `api/tournaments/[id].js` answered /api/tournaments/:id and nothing beneath it:
 * every action above 404'd, which killed the Arena's Join button and left the live
 * board's EventSource reconnecting against a 404 forever. This file is the segment
 * that makes them reachable. The dispatch itself stays in [id].js, which reads the
 * action off the request path, so there is exactly one copy of the logic.
 */

export { default } from '../[id].js';
