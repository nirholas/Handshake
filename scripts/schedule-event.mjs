#!/usr/bin/env node
// Set the live event's window in public/event.json, safely.
//
// public/event.json is the single source of truth for every event surface (see
// scripts/check-event-window.mjs for the full list), which makes hand-editing it
// the highest-leverage two-line edit in the repo: a wrong timestamp silently
// removes the countdown, the agenda, the fireworks, the souvenir grant and the
// event leaderboard from the product, with no error anywhere. Both real failures
// so far were edits by hand:
//
//   • a rehearsal window left in the file after a test run, so the advertised
//     event was already "over" before anyone arrived, and
//   • a config whose clock time disagreed with the time the announcement posts
//     quoted, so holders were counted down to an hour nobody published.
//
// So this script never lets you write a window it cannot defend: it validates
// with the very same rules that gate the deploy (validateEventConfig), refuses
// to write a config that fails them, and prints the window in the exact zones
// the announcement copy quotes so the config and the copy can be checked against
// each other in one glance.
//
// Usage:
//   npm run event:schedule
//       Preview the configured event: window, per-zone clock, agenda, state.
//       Reads only, writes nothing.
//
//   npm run event:schedule -- --start 2026-08-09T17:00Z --duration 150 --apply
//       Move the event to that UTC instant for that many minutes.
//
//   npm run event:schedule -- --rehearse 10 --apply
//       A local dry run: a 60-minute window starting 10 minutes from now, so the
//       live states can be walked in a browser. Prints the revert command,
//       because a rehearsal left behind is the first bug listed above.
//
//   npm run event:schedule -- --clear --apply
//       Reset the file to the explicit no-event state (the between-events
//       resting document). The file is never deleted: absence puts a 404 in
//       every /play visitor's console and a warn in the game server's poll.
//
//   Also: --name "..."  --tagline "..."  --duration <minutes>  --at <ISO>
//   (--at judges the result from that instant instead of now, for proving a
//   future window is correct today.)
//
// Dry run is the default. Nothing is written without --apply.

import { readFileSync, writeFileSync } from 'node:fs';
import {
	validateEventConfig, isNoEventSentinel, NO_EVENT_DOC, CONFIG_PATH, isoOf, zoneLines,
} from './check-event-window.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? (argv[i + 1] ?? '') : null;
};
const has = (name) => argv.includes(`--${name}`);

const apply = has('apply');
const clear = has('clear');
const rehearse = flag('rehearse');
const startArg = flag('start');
const durationArg = flag('duration');
const nameArg = flag('name');
const taglineArg = flag('tagline');
const atArg = flag('at');

const judgeAt = atArg ? Date.parse(atArg) : Date.now();
if (!Number.isFinite(judgeAt)) {
	console.error('[event-schedule] --at needs an ISO-8601 instant, e.g. --at 2026-08-09T17:30:00Z');
	process.exit(2);
}

// --clear needs no readable config: it writes the resting document outright.
if (clear) {
	if (!apply) {
		console.log('[event-schedule] DRY RUN: would reset public/event.json to the explicit no-event state.');
		console.log('[event-schedule] Re-run with --apply to write it.');
		process.exit(0);
	}
	writeFileSync(CONFIG_PATH, JSON.stringify(NO_EVENT_DOC, null, '\t') + '\n', 'utf8');
	console.log('[event-schedule] WROTE public/event.json: the explicit no-event state.');
	console.log('[event-schedule] Every surface now mounts nothing, and /event.json keeps answering 200.');
	process.exit(0);
}

let doc;
try {
	doc = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
	console.error(`[event-schedule] cannot read public/event.json: ${err?.message || err}`);
	console.error('[event-schedule] The file must exist even between events (its absence 404s in every /play console).');
	console.error('[event-schedule] Restore the resting state, then schedule on top of it:');
	console.error('[event-schedule]   npm run event:schedule -- --clear --apply');
	process.exit(1);
}

// Work out the new window, if the caller asked for one. Everything else in the
// file (agenda, souvenir, link, comments) is preserved untouched: agenda beats
// are minutes-after-start, so they follow a reschedule with no edits at all.
let startsAt = null;
let durationMin = null;

if (rehearse !== null) {
	const lead = Number(rehearse || 0);
	if (!Number.isFinite(lead) || lead < 0) {
		console.error('[event-schedule] --rehearse takes the number of minutes from now until the window opens, e.g. --rehearse 10');
		process.exit(2);
	}
	startsAt = Date.now() + lead * 60_000;
	durationMin = Number(durationArg ?? 60);
} else if (startArg) {
	startsAt = Date.parse(startArg);
	if (!Number.isFinite(startsAt)) {
		console.error(`[event-schedule] --start "${startArg}" is not an ISO-8601 instant. Use e.g. --start 2026-08-09T17:00:00Z`);
		process.exit(2);
	}
	const current = Date.parse(doc.startsAt);
	const currentEnd = Date.parse(doc.endsAt);
	const keptMin = Number.isFinite(current) && Number.isFinite(currentEnd) ? (currentEnd - current) / 60_000 : 150;
	durationMin = Number(durationArg ?? keptMin);
} else if (durationArg !== null) {
	startsAt = Date.parse(doc.startsAt);
	durationMin = Number(durationArg);
	if (!Number.isFinite(startsAt)) {
		console.error('[event-schedule] --duration alone needs the config to already carry a valid startsAt');
		process.exit(2);
	}
}

if (startsAt !== null) {
	if (!Number.isFinite(durationMin) || durationMin <= 0) {
		console.error(`[event-schedule] --duration must be a positive number of minutes, got "${durationArg}"`);
		process.exit(2);
	}
	doc.startsAt = isoOf(startsAt);
	doc.endsAt = isoOf(startsAt + durationMin * 60_000);
}
if (nameArg) doc.name = nameArg;
if (taglineArg) doc.tagline = taglineArg;

// Previewing the resting document is not a failure: there is simply no event.
if (startsAt === null && !nameArg && !taglineArg && isNoEventSentinel(doc)) {
	console.log('[event-schedule] no event is scheduled (public/event.json carries the explicit no-event state).');
	console.log('[event-schedule] Schedule one with --start <ISO> --duration <minutes> --apply, or --rehearse 10 --apply for a walkthrough.');
	process.exit(0);
}

// Validate the document as it would actually ship, with the deploy's own rules.
const { failures, notes, window: win, state } = validateEventConfig(doc, judgeAt);

console.log(`[event-schedule] ${startsAt !== null ? 'proposed' : 'current'} configuration:`);
for (const n of notes) console.log(`[event-schedule] ${n}`);

if (win) {
	console.log('[event-schedule]');
	console.log('[event-schedule] announcement clock (quote these, so copy and config agree):');
	for (const line of zoneLines(win.startsAt)) console.log(`[event-schedule]   ${line}`);
	if (Array.isArray(doc.agenda) && doc.agenda.length) {
		console.log('[event-schedule]');
		console.log('[event-schedule] agenda, as players will see it:');
		for (const beat of doc.agenda) {
			const at = win.startsAt + Number(beat.atMin || 0) * 60_000;
			console.log(`[event-schedule]   ${isoOf(at)}  ${beat.icon || ''} ${beat.title || ''}`);
		}
	}
}

if (failures.length) {
	console.error('[event-schedule]');
	console.error(`[event-schedule] ${failures.length} problem(s); refusing to write:`);
	for (const f of failures) console.error(`[event-schedule]   ${f}`);
	process.exit(1);
}

if (startsAt === null) {
	console.log('[event-schedule]');
	console.log('[event-schedule] OK: the configured event is coherent. Pass --start/--duration/--rehearse to change it.');
	process.exit(0);
}

if (!apply) {
	console.log('[event-schedule]');
	console.log('[event-schedule] DRY RUN: nothing written. Re-run with --apply to save this window.');
	process.exit(0);
}

// Rewrite the changed scalars in place rather than re-serialising the document.
// Re-serialising would expand the hand-formatted one-line-per-beat agenda into
// forty lines, turning a two-line reschedule into a whole-file diff that buries
// the only thing that actually changed and collides with every other agent
// editing this file. Only the fields this run set are touched; every byte of
// comment, ordering and spacing around them survives.
const raw = readFileSync(CONFIG_PATH, 'utf8');
const setString = (text, key, value) => {
	// The value is JSON-encoded, so quotes and backslashes in a name are safe.
	// `null` is matched too: the no-event resting document carries every event
	// field as null, and scheduling on top of it fills them in place.
	const pattern = new RegExp(`("${key}"\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|null)`);
	if (!pattern.test(text)) {
		console.error(`[event-schedule] could not find a "${key}" field to update in public/event.json`);
		process.exit(1);
	}
	return text.replace(pattern, (_m, head) => head + JSON.stringify(value));
};

let next = raw;
if (startsAt !== null) {
	next = setString(next, 'startsAt', doc.startsAt);
	next = setString(next, 'endsAt', doc.endsAt);
}
if (nameArg) next = setString(next, 'name', doc.name);
if (taglineArg) next = setString(next, 'tagline', doc.tagline);

// Never write a file we cannot read back as the document we just validated.
try {
	const roundTrip = JSON.parse(next);
	for (const key of ['startsAt', 'endsAt', 'name', 'tagline']) {
		if (doc[key] !== undefined && roundTrip[key] !== doc[key]) {
			throw new Error(`${key} did not survive the in-place edit`);
		}
	}
} catch (err) {
	console.error(`[event-schedule] refusing to write: the edited file would not parse back correctly (${err?.message || err})`);
	process.exit(1);
}
writeFileSync(CONFIG_PATH, next, 'utf8');
console.log('[event-schedule]');
console.log(`[event-schedule] WROTE public/event.json: ${doc.startsAt} to ${doc.endsAt}`);
console.log(`[event-schedule] state at the judged instant: ${String(state).toUpperCase()}`);

if (rehearse !== null) {
	console.log('[event-schedule]');
	console.log('[event-schedule] This is a REHEARSAL window and it must not ship. When the walkthrough is done:');
	console.log('[event-schedule]   git checkout -- public/event.json');
	console.log('[event-schedule] A rehearsal window committed by accident is exactly how a live event went dark before.');
} else {
	console.log('[event-schedule] Commit it: git add public/event.json && git commit');
}
