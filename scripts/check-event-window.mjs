#!/usr/bin/env node
// Assert public/event.json describes an event that will actually happen.
//
// One file drives every live-event surface on the platform: the /play lobby
// banner and in-world countdown pill (src/game/event-countdown.js), the home
// page strip (src/home-event-banner.js), the in-world meetup layer with its
// agenda, go-live moments and fireworks (src/game/meetup-event.js), the game
// server's quest gate (multiplayer/src/event-window.js), the leaderboard
// endpoints (api/_lib/event-config.js), and the souvenir grant
// (multiplayer/src/event-drop.js).
//
// Every one of those reads the config the same way, and every one of them
// treats a bad or expired window as "there is no event" and mounts nothing.
// That failure is SILENT and it is total: the page loads, the world runs, and
// the entire event experience is simply absent, with no error anywhere to say
// why. It has already happened once (a rehearsal window was left in the file
// and never reset), which is what this check exists to make impossible.
//
// Assertions, each one a way the event has died or could die quietly:
//   1. The config parses and carries a usable start time.
//   2. The window has not already ended. This is the expired-config bug.
//   3. An explicit end is after the start, and the duration is sane.
//   4. The souvenir names a real catalog cosmetic of tier 'event' (the server
//      refuses anything else and grants nothing, silently).
//   5. The souvenir's art exists on disk, so a granted wearable renders.
//   6. A souvenir event's `link` carries a `coin`, since the grant is scoped to
//      the world that link points at and grants nothing without one.
//   7. Agenda beats are ordered, non-negative, and land inside the window.
//
// There is no event to run? Reset the file to its explicit no-event state
// (`npm run event:schedule -- --clear --apply`). Every surface reads that as
// "no event" and shows nothing, which is exactly right between events, and
// /event.json keeps answering 200 so no visitor console carries a 404 and the
// game server's minutely config poll stays quiet. This check fails on a config
// that is present and broken, and on a missing file, which would resurrect
// those 404s.
//
// Run: node scripts/check-event-window.mjs   (wired as `npm run check:event`)
//      node scripts/check-event-window.mjs --at 2026-08-09T15:30:00Z
//        judges the config against that instant instead of now, so a window can
//        be proved correct for event day before event day.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEventWindow } from '../multiplayer/src/event-window.js';
import { getCosmetic } from '../multiplayer/src/cosmetics-catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(root, 'public/event.json');
const MAX_DURATION_MS = 24 * 3600 * 1000;

// The canonical between-events document. Every reader parses `startsAt: null`
// as "no event" and mounts nothing, while the file's presence keeps /event.json
// answering 200 for the four /play readers and the game server's config poll.
// `npm run event:schedule -- --clear --apply` writes exactly this.
export const NO_EVENT_DOC = {
	id: null,
	name: null,
	tagline: null,
	startsAt: null,
	endsAt: null,
	link: null,
	note: 'No event is scheduled. This file stays in place between events so /event.json answers 200 with an explicit no-event state instead of putting a 404 in every visitor console. Schedule the next event with: npm run event:schedule -- --start <ISO> --duration <minutes> --apply',
};

/**
 * True only for the explicit no-event document: `startsAt` literally null and
 * no event-bearing field carrying anything. A config that nulls the window but
 * keeps a name, link, souvenir or agenda is a broken event, not a resting
 * state, and must keep failing validation loudly.
 */
export function isNoEventSentinel(doc) {
	if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
	return doc.startsAt === null && doc.endsAt == null && doc.id == null
		&& doc.name == null && doc.tagline == null && doc.link == null
		&& doc.souvenir == null && doc.agenda == null;
}

const ZONES = [
	['Pacific', 'America/Los_Angeles'],
	['Eastern', 'America/New_York'],
	['London', 'Europe/London'],
	['Berlin', 'Europe/Berlin'],
];

/** The instant as an ISO string without the noise of trailing milliseconds. */
export const isoOf = (ms) => new Date(ms).toISOString().replace('.000', '');

/**
 * The instant as a human reads it in `tz`, which is what announcement copy quotes.
 *
 * Modern ICU separates the time from AM/PM with a NARROW NO-BREAK SPACE (U+202F)
 * rather than a plain one. These strings exist to be pasted into posts and blog
 * copy, so that invisible character would travel into published announcements and
 * into any search for the time that assumes a normal space. Normalised to ASCII
 * spaces for exactly that reason.
 */
export const clockIn = (ms, tz) =>
	new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' })
		.format(new Date(ms))
		.replace(/[\u202f\u00a0]/g, ' ');

/** One line per announcement timezone, in the order the marketing copy lists them. */
export function zoneLines(ms) {
	return ZONES.map(([label, tz]) => `${clockIn(ms, tz)} ${label}`);
}

/**
 * Judge an event config exactly the way the running platform will.
 *
 * Returns `{ failures, notes, window, state }`. `failures` is the list of ways
 * this config would silently do nothing; empty means the event will actually
 * happen. Exported so `event:schedule` can validate a window it is about to
 * write with the same rules that gate the deploy, rather than a second copy of
 * them that can drift.
 */
export function validateEventConfig(doc, now = Date.now()) {
	const failures = [];
	const notes = [];

	// The canonical parser is the game server's own, so this check and the
	// running platform can never disagree about what the config means.
	const win = parseEventWindow(doc);
	let state = null;

	if (!win) {
		failures.push('startsAt is missing or unparseable, so there is no countdown to run and every surface mounts nothing');
	} else {
		state = now >= win.endsAt ? 'over' : now >= win.startsAt ? 'live' : 'upcoming';

		notes.push(`event "${win.name}" (${win.id})`);
		notes.push(`window ${isoOf(win.startsAt)} to ${isoOf(win.endsAt)} UTC, ${Math.round((win.endsAt - win.startsAt) / 60000)} min long`);
		notes.push(`state at the judged instant: ${state.toUpperCase()}`);
		for (const line of zoneLines(win.startsAt)) notes.push(`  starts ${line}`);

		// The expired-config bug: present, parseable, and completely dead.
		if (state === 'over') {
			const agoH = Math.round((now - win.endsAt) / 3600000);
			failures.push(
				`the event window ENDED ${agoH}h ago (${isoOf(win.endsAt)} UTC), so the countdown, agenda, ` +
				'fireworks, souvenir grant and event leaderboard are all silently dormant. ' +
				'Reschedule with `npm run event:schedule -- --start <ISO> --duration <mins> --apply`, or reset to the no-event state with `npm run event:schedule -- --clear --apply` if the event is done.',
			);
		}

		// An endsAt that does not beat startsAt is dropped by the parser in favour
		// of a silent six-hour default, which is never what the author meant.
		const declaredEnd = Date.parse(doc.endsAt);
		if (doc.endsAt !== undefined && !Number.isFinite(declaredEnd)) {
			failures.push(`endsAt "${doc.endsAt}" is unparseable, so the window silently becomes startsAt + 6h`);
		} else if (Number.isFinite(declaredEnd) && declaredEnd <= win.startsAt) {
			failures.push(`endsAt (${isoOf(declaredEnd)}) is not after startsAt (${isoOf(win.startsAt)}), so the window silently becomes startsAt + 6h`);
		}
		if (win.endsAt - win.startsAt > MAX_DURATION_MS) {
			failures.push(`the window is ${Math.round((win.endsAt - win.startsAt) / 3600000)}h long, which reads like a typo in one of the timestamps`);
		}
	}

	// The souvenir is optional, but a configured one that cannot be granted is
	// worse than none: players are told an event is on and quietly get nothing.
	const souvenir = doc?.souvenir;
	if (souvenir && typeof souvenir === 'object') {
		const id = String(souvenir.cosmeticId || '');
		const item = id ? getCosmetic(id) : null;
		if (!id) {
			failures.push('souvenir is present but names no cosmeticId, so nothing can be granted');
		} else if (!item) {
			failures.push(`souvenir cosmeticId "${id}" is not in multiplayer/src/cosmetics-catalog.js, so the server grants nothing`);
		} else if (item.tier !== 'event') {
			failures.push(`souvenir cosmeticId "${id}" has tier "${item.tier}", but the server only grants tier 'event' items, so nothing is granted`);
		} else {
			for (const asset of [item.visual?.prop, item.thumb].filter(Boolean)) {
				if (!existsSync(path.join(root, 'public', asset.replace(/^\//, '')))) {
					failures.push(`souvenir "${id}" points at ${asset}, which is missing from public/, so the granted wearable renders nothing`);
				}
			}
			notes.push(`souvenir "${item.name}" (${id}) is grantable`);
		}

		// The grant is world-scoped to the coin in `link`; without one it is dead.
		const link = String(doc.link || '');
		const q = link.indexOf('?');
		const coin = q < 0 ? '' : (new URLSearchParams(link.slice(q + 1)).get('coin') || '').trim();
		if (!coin) {
			failures.push('a souvenir is configured but `link` carries no ?coin=, and the grant is scoped to that world, so no one can ever claim it');
		}
	}

	// An agenda beat scheduled past the end never fires, and one out of order
	// makes the "what's next" readout skip backwards.
	if (Array.isArray(doc?.agenda) && win) {
		const durationMin = (win.endsAt - win.startsAt) / 60000;
		let prev = -Infinity;
		doc.agenda.forEach((beat, i) => {
			const at = Number(beat?.atMin);
			const label = beat?.title ? `"${beat.title}"` : `#${i + 1}`;
			if (!Number.isFinite(at) || at < 0) {
				failures.push(`agenda beat ${label} has atMin "${beat?.atMin}", which is not a non-negative number of minutes`);
				return;
			}
			if (at < prev) failures.push(`agenda beat ${label} at ${at}min comes after a later beat at ${prev}min; the agenda must be in order`);
			if (at > durationMin) failures.push(`agenda beat ${label} is ${at}min in, past the ${Math.round(durationMin)}min window, so it never fires`);
			prev = at;
		});
	}

	return { failures, notes, window: win, state };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Guarded so `import`ing the validator above never runs the check or exits.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const atArg = process.argv.indexOf('--at');
	const now = atArg >= 0 ? Date.parse(process.argv[atArg + 1]) : Date.now();
	if (!Number.isFinite(now)) {
		console.error('[check-event] --at needs an ISO-8601 instant, e.g. --at 2026-08-09T15:30:00Z');
		process.exit(2);
	}

	// The file must exist even between events: readers handle absence, but a
	// missing file puts a 404 in every /play visitor's console (four readers
	// fetch it per load) and an unreadable-config warn in the game server's
	// minutely poll. The resting state is the explicit no-event document.
	if (!existsSync(CONFIG_PATH)) {
		console.error('[check-event] public/event.json is MISSING. Between events it must carry the explicit no-event state, not be absent.');
		console.error('[check-event] Restore it: npm run event:schedule -- --clear --apply');
		process.exit(1);
	}

	let doc;
	try {
		doc = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
	} catch (err) {
		console.error(`[check-event] public/event.json is not valid JSON: ${err?.message || err}`);
		console.error('[check-event] Every event surface would mount nothing. Fix the syntax, or reset with `npm run event:schedule -- --clear --apply`.');
		process.exit(1);
	}

	if (isNoEventSentinel(doc)) {
		console.log('[check-event] OK: public/event.json carries the explicit no-event state, so no event is configured (a supported state)');
		process.exit(0);
	}

	const { failures, notes } = validateEventConfig(doc, now);
	for (const n of notes) console.log(`[check-event] ${n}`);

	if (failures.length) {
		console.error(`[check-event] ${failures.length} problem(s) with public/event.json:`);
		for (const f of failures) console.error(`[check-event]   ${f}`);
		process.exit(1);
	}
	console.log('[check-event] OK: the configured event is coherent and has not expired');
}
