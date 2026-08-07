// The live event's config, read from the repo's own public/event.json.
//
// public/event.json is the single source of truth for the platform event: the
// countdown pill, the in-world meetup layer, the game server's quest gate
// (multiplayer/src/event-window.js, which reads the same file over HTTP because its
// container ships without public/) and now the leaderboard endpoints. The API
// process serves that file from disk, so it reads it from disk — no HTTP hop to
// itself, and no second copy of the times anywhere.
//
// Parsing is delegated to parseEventWindow so the API and the game server agree on
// what "the event" is down to the millisecond, including the "missing endsAt means
// six hours" default.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEventWindow, isEventLive } from '../../multiplayer/src/event-window.js';

const CACHE_TTL_MS = 60_000;

let _cached = null;
let _readAt = 0;

/**
 * The current event window ({ id, name, startsAt, endsAt }) or null when the config
 * is absent or malformed. Cached for a minute; a deploy replaces the file, and an
 * event window is measured in hours, so a minute of staleness is invisible.
 */
export function eventConfig(now = Date.now()) {
	if (_cached !== null && now - _readAt < CACHE_TTL_MS) return _cached;
	try {
		const raw = readFileSync(resolve(process.cwd(), 'public/event.json'), 'utf8');
		_cached = parseEventWindow(JSON.parse(raw));
	} catch (err) {
		console.warn('[event-config] public/event.json unreadable:', err?.message || err);
		_cached = null;
	}
	_readAt = now;
	return _cached;
}

/** Is the configured event running right now? */
export function eventLiveNow(now = Date.now()) {
	return isEventLive(eventConfig(now), now);
}

/** The configured event's id, or null. The leaderboard is keyed by it. */
export function eventId(now = Date.now()) {
	return eventConfig(now)?.id || null;
}
