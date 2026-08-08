// Live-event window, the server's own read of public/event.json.
//
// The countdown pill, the in-world meetup layer and the /play agenda all derive
// their timing from ONE config file (public/event.json). The event quest line and
// its leaderboard have to be gated on exactly the same window, and that gate must
// be server-side: a client that lies about the clock still gets an empty board.
//
// This process ships without the repo's `public/` directory (multiplayer/Dockerfile
// copies only src/), so the config is read over HTTP from the site that serves it
//, the same origin persistence.js and quest-notify.js already talk to. The times
// are never transcribed into code here: parse what the file says, or run nothing.
//
// Failure is CLOSED. A missing, unreachable or malformed config means "there is no
// event", which hides the event jobs and their payouts rather than opening them on
// a bad read. The last good config is cached for CACHE_TTL_MS so the hot path
// (every board read, every mission accept) is a synchronous Map lookup, and a
// refresh in flight never blocks gameplay.

const API_BASE = (process.env.WORLD_API_BASE || 'https://three.ws').replace(/\/$/, '');
const CONFIG_PATH = '/event.json';
const CACHE_TTL_MS = 60_000;      // re-read the config at most once a minute
const FETCH_TIMEOUT_MS = 6000;

// Parse the event config into the minimal window this server cares about. Mirrors
// the client's parseEvent (src/game/meetup-schedule.js) on the fields that matter
// for gating: same id, same start, same "missing end = 6h" default. Returns null
// for anything unusable, so callers treat "no event" and "bad config" identically.
export function parseEventWindow(doc) {
	if (!doc || typeof doc !== 'object') return null;
	const startsAt = Date.parse(doc.startsAt);
	if (!Number.isFinite(startsAt)) return null;
	const rawEnd = Date.parse(doc.endsAt);
	const endsAt = Number.isFinite(rawEnd) && rawEnd > startsAt ? rawEnd : startsAt + 6 * 3600 * 1000;
	return {
		id: String(doc.id || 'event').slice(0, 64),
		name: String(doc.name || 'Community event').slice(0, 120),
		startsAt,
		endsAt,
	};
}

// Is `now` inside the event's live window? Half-open [startsAt, endsAt) so the
// final millisecond can't pay out twice under a clock that lands exactly on the end.
export function isEventLive(win, now = Date.now()) {
	if (!win) return false;
	const t = Number(now);
	if (!Number.isFinite(t)) return false;
	return t >= win.startsAt && t < win.endsAt;
}

let _cached = null;      // the last successfully parsed window (may be a past event)
let _fetchedAt = 0;      // when the config was last read (ok or not)
let _inFlight = null;    // dedupe concurrent refreshes across rooms

async function readConfig() {
	const res = await fetch(`${API_BASE}${CONFIG_PATH}`, {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

// Refresh the cached window if it's stale. Never throws and never rejects: a failed
// read leaves the previous cache in place (and leaves it null on a cold start, which
// is the closed gate). Call from the room's periodic tick or await it when you want
// the freshest answer.
export async function refreshEventWindow(now = Date.now()) {
	if (_inFlight) return _inFlight;
	if (_cached !== null && now - _fetchedAt < CACHE_TTL_MS) return _cached;
	_inFlight = readConfig()
		.then((doc) => {
			_cached = parseEventWindow(doc);
			_fetchedAt = Date.now();
			return _cached;
		})
		.catch((err) => {
			_fetchedAt = Date.now();
			console.warn(`[event-window] ${API_BASE}${CONFIG_PATH} unreadable: ${err?.message || err}`);
			return _cached;
		})
		.finally(() => { _inFlight = null; });
	return _inFlight;
}

// The cached window, synchronously. Kicks off a background refresh when stale so the
// caller never waits on the network mid-gameplay; the answer it gets is at most
// CACHE_TTL_MS old, which is far finer than an event window measured in hours.
export function eventWindow(now = Date.now()) {
	if (now - _fetchedAt >= CACHE_TTL_MS) refreshEventWindow(now).catch(() => {});
	return _cached;
}

// The one question the quest engine asks: is the event running right now?
export function eventLiveNow(now = Date.now()) {
	return isEventLive(eventWindow(now), now);
}

// Test seam: drop the cache so a suite can prime it with its own config instead of
// hitting the network. Not used by the running server.
export function __setEventWindowCache(win, fetchedAt = Date.now()) {
	_cached = win;
	_fetchedAt = fetchedAt;
}
