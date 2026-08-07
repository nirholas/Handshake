// The one reader of public/event.json.
//
// The event window lives in exactly one file (`public/event.json`, served at
// `/event.json`) and every countdown surface reads it through here: the `/play`
// lobby banner and in-world pill (src/game/event-countdown.js) and the home page
// strip (src/home-event-banner.js). Two surfaces reading two copies of a start
// time is how a countdown ends up disagreeing with itself on the day, so the
// parsing, the state machine, and the clock formatting are all shared.
//
// Everything here is browser-only and dependency-free.

const CONFIG_URL = '/event.json';

// An event with no (or unparseable) end time stays live for this long.
const DEFAULT_DURATION_MS = 6 * 3600 * 1000;

/**
 * Normalize the raw JSON into a config, or null when there is nothing to show.
 * A missing/malformed start time is the only fatal problem: without it there is
 * no countdown to run, and the page owes the visitor zero pixels.
 */
export function parseEventConfig(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const startsAt = Date.parse(raw.startsAt);
	if (!Number.isFinite(startsAt)) return null;
	const endsAt = Date.parse(raw.endsAt);
	return {
		name: String(raw.name || 'Live event'),
		tagline: raw.tagline ? String(raw.tagline) : '',
		startsAt,
		endsAt: Number.isFinite(endsAt) ? endsAt : startsAt + DEFAULT_DURATION_MS,
		link: raw.link ? String(raw.link) : null,
		linkLabel: raw.linkLabel ? String(raw.linkLabel) : 'Join the event',
	};
}

/**
 * Fetch and parse the event config. Returns null when the file is absent,
 * unreadable, malformed, or describes an event that has already ended, so a
 * caller can treat null as "mount nothing" without a second check.
 */
export async function loadEventConfig(now = Date.now()) {
	let cfg = null;
	try {
		const res = await fetch(CONFIG_URL, { cache: 'no-cache' });
		if (!res.ok) return null;
		cfg = parseEventConfig(await res.json());
	} catch {
		return null;
	}
	if (!cfg || now >= cfg.endsAt) return null;
	return cfg;
}

/** 'upcoming' before the start, 'live' during, 'over' once past the end. */
export function eventState(cfg, now = Date.now()) {
	if (now >= cfg.endsAt) return 'over';
	return now >= cfg.startsAt ? 'live' : 'upcoming';
}

/** Break a millisecond span into whole days, hours, minutes, and seconds. */
export function segments(ms) {
	const s = Math.max(0, Math.floor(ms / 1000));
	return {
		d: Math.floor(s / 86400),
		h: Math.floor((s % 86400) / 3600),
		m: Math.floor((s % 3600) / 60),
		s: s % 60,
	};
}

export function pad(n) {
	return String(n).padStart(2, '0');
}

/** `3d 04:11:07` while a day or more remains, `04:11:07` after that. */
export function clockString(ms) {
	const t = segments(ms);
	return (t.d > 0 ? `${t.d}d ` : '') + `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}`;
}

/** The start time in the visitor's own timezone, named so it cannot be misread. */
export function formatStart(ts) {
	return new Intl.DateTimeFormat(undefined, {
		weekday: 'short', month: 'short', day: 'numeric',
		hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
	}).format(new Date(ts));
}

/**
 * True when the visitor is already standing in the event world, which makes the
 * "join" CTA a link to where they are. Compares the coin param of the event link
 * against the current URL's.
 */
export function alreadyAtEvent(cfg, url = location.href) {
	if (!cfg.link) return false;
	try {
		const here = new URL(url);
		const target = new URL(cfg.link, here.origin);
		const targetCoin = target.searchParams.get('coin');
		return !!targetCoin && targetCoin === here.searchParams.get('coin');
	} catch {
		return false;
	}
}
