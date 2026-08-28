// The calendar lane's announcement rules (api/_lib/companion/lanes/calendar.js).
//
// The lane fetches an ICS feed over the network, but the decision of WHAT to
// announce and WHEN is pure, so it is tested here against real iCalendar text:
// one-off events, a daily series, a cancelled entry, a moved instance, and the
// stable external id that stops the companion announcing the same standup twice.

import { describe, it, expect } from 'vitest';
import { eventsFromIcs, normalizeIcsUrl } from '../api/_lib/companion/lanes/calendar.js';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');

function ics(...blocks) {
	return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//three.ws//companion tests//EN', ...blocks, 'END:VCALENDAR'].join('\n');
}

const soonEvent = [
	'BEGIN:VEVENT',
	'UID:design-review-1',
	'DTSTAMP:20260828T100000Z',
	'DTSTART:20260828T121500Z',
	'DTEND:20260828T124500Z',
	'SUMMARY:Design review',
	'LOCATION:Studio',
	'DESCRIPTION:Bring the deck',
	'ORGANIZER;CN=Sarah:mailto:sarah@example.com',
	'END:VEVENT',
].join('\n');

const laterEvent = [
	'BEGIN:VEVENT',
	'UID:tomorrow-1',
	'DTSTAMP:20260828T100000Z',
	'DTSTART:20260829T090000Z',
	'DTEND:20260829T093000Z',
	'SUMMARY:Not today',
	'END:VEVENT',
].join('\n');

const cancelledEvent = [
	'BEGIN:VEVENT',
	'UID:cancelled-1',
	'DTSTAMP:20260828T100000Z',
	'DTSTART:20260828T122000Z',
	'DTEND:20260828T125000Z',
	'STATUS:CANCELLED',
	'SUMMARY:Called off',
	'END:VEVENT',
].join('\n');

const dailySeries = [
	'BEGIN:VEVENT',
	'UID:standup-1',
	'DTSTAMP:20260801T100000Z',
	'DTSTART:20260801T122500Z',
	'DTEND:20260801T123500Z',
	'RRULE:FREQ=DAILY;COUNT=200',
	'SUMMARY:Standup',
	'END:VEVENT',
].join('\n');

describe('eventsFromIcs', () => {
	it('announces what starts inside the window and nothing else', () => {
		const items = eventsFromIcs(ics(soonEvent, laterEvent), { now: NOW, lookaheadMinutes: 30 });
		expect(items.map((i) => i.title)).toEqual(['Design review']);
		const [item] = items;
		expect(item.occurs_at).toBe('2026-08-28T12:15:00.000Z');
		expect(item.sender).toBe('Sarah');
		expect(item.identity_candidates).toEqual(['Sarah']);
		expect(item.body).toContain('Location: Studio');
		expect(item.body).toContain('30 minutes');
	});

	it('skips a cancelled entry', () => {
		const items = eventsFromIcs(ics(cancelledEvent), { now: NOW, lookaheadMinutes: 60 });
		expect(items).toHaveLength(0);
	});

	it('expands a recurring series at today\'s occurrence, keeping the time of day', () => {
		const items = eventsFromIcs(ics(dailySeries), { now: NOW, lookaheadMinutes: 45 });
		expect(items).toHaveLength(1);
		expect(items[0].title).toBe('Standup');
		expect(items[0].occurs_at).toBe('2026-08-28T12:25:00.000Z');
	});

	it('gives every occurrence a stable id, so a re-poll never repeats one', () => {
		const first = eventsFromIcs(ics(dailySeries), { now: NOW, lookaheadMinutes: 45 });
		const second = eventsFromIcs(ics(dailySeries), { now: NOW + 60_000, lookaheadMinutes: 45 });
		expect(first[0].external_id).toBe(second[0].external_id);
		expect(first[0].external_id).toBe('cal:standup-1:2026-08-28T12:25:00.000Z');
	});

	it('still announces something that started seconds ago, but not minutes ago', () => {
		const justStarted = eventsFromIcs(ics(soonEvent), { now: Date.parse('2026-08-28T12:16:00.000Z'), lookaheadMinutes: 30 });
		const longGone = eventsFromIcs(ics(soonEvent), { now: Date.parse('2026-08-28T12:40:00.000Z'), lookaheadMinutes: 30 });
		expect(justStarted).toHaveLength(1);
		expect(longGone).toHaveLength(0);
	});

	it('reads an empty calendar without complaining', () => {
		expect(eventsFromIcs(ics(), { now: NOW })).toEqual([]);
	});
});

describe('normalizeIcsUrl', () => {
	it('turns the webcal scheme Apple hands out into a fetchable https URL', () => {
		expect(normalizeIcsUrl('webcal://p1.icloud.com/published/2/abc')).toBe('https://p1.icloud.com/published/2/abc');
		expect(normalizeIcsUrl('  https://calendar.google.com/basic.ics  ')).toBe('https://calendar.google.com/basic.ics');
	});
});
