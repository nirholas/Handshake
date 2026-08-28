// Calendar lane: a private ICS feed, which every major calendar publishes.
//
// Google ("Secret address in iCal format"), Apple iCloud (a shared calendar's
// public link), Outlook/Microsoft 365 ("Publish a calendar"), Fastmail, and
// every CalDAV server expose one. That makes this the one calendar integration
// that needs no OAuth app, no consent screen, and no stored account: the user
// pastes a URL they can revoke at any time.
//
// The feed is a user-supplied URL fetched from our servers, so it goes through
// the shared SSRF guard (scheme allowlist, DNS resolved and pinned on our side,
// redirects re-validated) exactly like any other untrusted fetch target.

import ical from 'node-ical';
import { safeFetchJson } from '../../ssrf.js';
import { shorten } from '../triage.js';

const DEFAULT_LOOKAHEAD_MIN = 30;
// Events that already started are still worth announcing for a moment (a poll
// can land seconds late), but not for long.
const GRACE_MIN = 2;
const MAX_ICS_BYTES = 4_000_000;

export function normalizeIcsUrl(raw) {
	const trimmed = String(raw || '').trim();
	if (/^webcal:\/\//i.test(trimmed)) return `https://${trimmed.slice('webcal://'.length)}`;
	return trimmed;
}

async function fetchIcs(url) {
	const { status, ok, data } = await safeFetchJson(normalizeIcsUrl(url), {
		method: 'GET',
		headers: { accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' },
		timeoutMs: 20_000,
	});
	if (!ok) throw new Error(`calendar feed returned HTTP ${status}`);
	const text = typeof data === 'string' ? data : JSON.stringify(data);
	if (!text.includes('BEGIN:VCALENDAR')) {
		throw new Error('that URL did not return an iCalendar feed');
	}
	if (text.length > MAX_ICS_BYTES) throw new Error('calendar feed is too large to parse');
	return text;
}

// A recurring event's rrule yields occurrence dates; the event's own start
// carries the time of day. Recombine them so a daily 09:00 standup announces at
// 09:00 and not at whatever hour the series happened to begin in.
function occurrencesFor(event, from, to) {
	const out = [];
	const start = event.start instanceof Date ? event.start : new Date(event.start);
	if (!event.rrule) {
		if (start >= from && start <= to) out.push(start);
		return out;
	}
	const excluded = new Set(Object.keys(event.exdate || {}));
	for (const date of event.rrule.between(from, to, true)) {
		const key = date.toISOString().slice(0, 10);
		if (excluded.has(key)) continue;
		// A single moved instance is published as its own VEVENT with
		// RECURRENCE-ID; node-ical hands those back under `recurrences`.
		const override = event.recurrences?.[key];
		out.push(override?.start ? new Date(override.start) : date);
	}
	return out;
}

function durationMinutes(event) {
	if (!event.end || !event.start) return null;
	const mins = (new Date(event.end).getTime() - new Date(event.start).getTime()) / 60000;
	return Number.isFinite(mins) && mins > 0 ? Math.round(mins) : null;
}

/**
 * Everything in the feed that starts inside the window, as lane items.
 * Pure: it takes the ICS text and a clock, so the announcement rules are
 * testable without a network (tests/companion-calendar.test.js).
 *
 * @param {string} text raw iCalendar document
 * @param {{ now?: number, lookaheadMinutes?: number }} [opts]
 */
export function eventsFromIcs(text, { now = Date.now(), lookaheadMinutes = DEFAULT_LOOKAHEAD_MIN } = {}) {
	const parsed = ical.sync.parseICS(text);
	const from = new Date(now - GRACE_MIN * 60_000);
	const to = new Date(now + lookaheadMinutes * 60_000);
	const items = [];

	for (const event of Object.values(parsed)) {
		if (event.type !== 'VEVENT' || !event.start) continue;
		if (String(event.status || '').toUpperCase() === 'CANCELLED') continue;
		for (const occurrence of occurrencesFor(event, from, to)) {
			const uid = event.uid || event.summary || 'event';
			const mins = durationMinutes(event);
			const details = [
				event.location ? `Location: ${event.location}` : null,
				mins ? `${mins} minutes` : null,
				event.description ? shorten(event.description, 300) : null,
			].filter(Boolean).join('. ');
			const organizer = event.organizer?.params?.CN || event.organizer?.val?.replace(/^mailto:/i, '') || null;
			items.push({
				external_id: `cal:${uid}:${occurrence.toISOString()}`,
				sender: organizer || 'Calendar',
				sender_id: organizer,
				identity_candidates: organizer ? [organizer] : [],
				title: event.summary || 'Untitled event',
				body: details || null,
				url: typeof event.url === 'string' ? event.url : null,
				occurs_at: occurrence.toISOString(),
			});
		}
	}
	return items;
}

export async function verifyCalendar(config) {
	const text = await fetchIcs(config.ics_url);
	const parsed = ical.sync.parseICS(text);
	const events = Object.values(parsed).filter((e) => e.type === 'VEVENT');
	const name = Object.values(parsed).find((e) => e.type === 'VCALENDAR')?.['WR-CALNAME'] || null;
	return {
		detail: `Read ${events.length} event${events.length === 1 ? '' : 's'} from ${name || 'the feed'}.`,
		calendar_name: name,
		event_count: events.length,
	};
}

/**
 * Announce anything starting inside the lookahead window.
 * @returns {{ items: Array, cursor: object }}
 */
export async function pollCalendar({ config, cursor = {} }) {
	const lookahead = Math.min(720, Math.max(5, Number(config.lookahead_minutes) || DEFAULT_LOOKAHEAD_MIN));
	const text = await fetchIcs(config.ics_url);
	const items = eventsFromIcs(text, { lookaheadMinutes: lookahead });
	return { items, cursor: { ...cursor, last_fetch: new Date().toISOString(), lookahead_minutes: lookahead } };
}
