// How many concurrent SSE listeners a page may hold against one origin.
//
// A live wall wants a stream per card. A browser will not give it one: over
// HTTP/1.1 it allows six sockets per origin, and an EventSource holds its socket
// for the life of the stream, so the seventh card onward never connects and the
// page's own fetches queue behind the six that did. /agents-live shipped exactly
// that bug: on a 48-card roster, 42 cards sat on "Connecting" forever.
//
// A multiplexed transport (h2 / h3) carries many streams over one connection and
// has no such per-request socket cost, so the ceiling there is about server and
// client resources rather than sockets.
//
// Pure so the ceiling is provable without a browser (tests/agents-live-stream-pool.test.js).

// Chrome/Firefox both cap HTTP/1.1 at 6 sockets per origin. Hold the pool below
// it so the page always has room for its own roster/balance/intent requests.
export const HTTP1_STREAM_POOL = 4;
export const MULTIPLEXED_STREAM_POOL = 12;

const MULTIPLEXED = new Set(['h2', 'h2c', 'h3', 'http/2', 'http/3']);

/**
 * Pool ceiling for an origin, from its real negotiated protocol.
 *
 * @param {string | null | undefined} nextHopProtocol
 *   `PerformanceNavigationTiming.nextHopProtocol` for the document. It is the
 *   empty string on a cache hit and on browsers that withhold it; an unknown
 *   value must fall back to the conservative pool, because guessing h2 on an
 *   HTTP/1.1 origin reintroduces the exact starvation this exists to prevent.
 * @returns {number} maximum concurrent SSE listeners, always at least 1
 */
export function streamPoolSize(nextHopProtocol) {
	const p = String(nextHopProtocol || '').toLowerCase();
	if (MULTIPLEXED.has(p) || p.startsWith('h3-')) return MULTIPLEXED_STREAM_POOL;
	return HTTP1_STREAM_POOL;
}
