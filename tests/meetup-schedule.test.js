import { describe, it, expect } from 'vitest';
import {
	parseEvent, eventState, formatCountdown, fireworkPlan, applyPreviewOverride,
	PHASE, SOON_MS, PRESHOW_MS, AFTERGLOW_MS, BUCKET_MS,
} from '../src/game/meetup-schedule.js';

const START = Date.parse('2026-08-07T17:00:00Z');

// The flat /event.json shape shared with src/game/event-countdown.js.
const DOC = {
	id: 'three-first-meetup',
	name: '$THREE First Holders Meetup',
	tagline: 'The first live gathering in the world',
	startsAt: '2026-08-07T17:00:00Z',
	endsAt: '2026-08-07T19:00:00Z',
	agenda: [
		{ atMin: 0, title: 'Doors open', icon: '👋' },
		{ atMin: 20, title: 'King of the Totem showdown', icon: '👑' },
		{ atMin: 45, title: 'Wheel hour', icon: '🎡' },
		{ atMin: 105, title: 'Fireworks finale', icon: '🎆' },
	],
};

describe('parseEvent', () => {
	it('parses the flat event.json shape', () => {
		const ev = parseEvent(DOC);
		expect(ev.id).toBe('three-first-meetup');
		expect(ev.title).toBe('$THREE First Holders Meetup');
		expect(ev.subtitle).toContain('first live gathering');
		expect(ev.startsAt).toBe(START);
		expect(ev.endsAt).toBe(START + 120 * 60000);
		expect(ev.agenda).toHaveLength(4);
	});

	it('sorts an out-of-order agenda and drops invalid segments', () => {
		const ev = parseEvent({
			startsAt: '2026-08-07T17:00:00Z',
			agenda: [
				{ atMin: 30, title: 'B' },
				{ atMin: 0, title: 'A' },
				{ atMin: 'nope', title: 'bad' },
				{ atMin: 5, title: '' },
			],
		});
		expect(ev.agenda.map((s) => s.title)).toEqual(['A', 'B']);
	});

	it('returns null for empty, malformed, or dateless docs', () => {
		expect(parseEvent(null)).toBeNull();
		expect(parseEvent({})).toBeNull();
		expect(parseEvent({ startsAt: 'not a date' })).toBeNull();
	});

	it('defaults a missing or inverted end to 6 hours after start', () => {
		const noEnd = parseEvent({ startsAt: '2026-08-07T17:00:00Z' });
		expect(noEnd.endsAt - noEnd.startsAt).toBe(6 * 3600 * 1000);
		const inverted = parseEvent({ startsAt: '2026-08-07T17:00:00Z', endsAt: '2026-08-07T16:00:00Z' });
		expect(inverted.endsAt - inverted.startsAt).toBe(6 * 3600 * 1000);
	});
});

describe('eventState phases', () => {
	const ev = parseEvent(DOC);

	it('walks through every phase in order', () => {
		expect(eventState(ev, START - SOON_MS - 1).phase).toBe(PHASE.FAR);
		expect(eventState(ev, START - SOON_MS + 1).phase).toBe(PHASE.UPCOMING);
		expect(eventState(ev, START - PRESHOW_MS + 1).phase).toBe(PHASE.PRESHOW);
		expect(eventState(ev, START).phase).toBe(PHASE.LIVE);
		expect(eventState(ev, ev.endsAt - 1).phase).toBe(PHASE.LIVE);
		expect(eventState(ev, ev.endsAt + 1).phase).toBe(PHASE.AFTERGLOW);
		expect(eventState(ev, ev.endsAt + AFTERGLOW_MS + 1).phase).toBe(PHASE.ENDED);
	});

	it('handles a null event as ended', () => {
		expect(eventState(null, START).phase).toBe(PHASE.ENDED);
	});

	it('counts down to start', () => {
		const s = eventState(ev, START - 90_000);
		expect(s.msToStart).toBe(90_000);
		expect(s.next.title).toBe('Doors open');
	});

	it('tracks the active and next segments while live', () => {
		const s = eventState(ev, START + 21 * 60000);
		expect(s.active.title).toBe('King of the Totem showdown');
		expect(s.next.title).toBe('Wheel hour');
		expect(s.msToNext).toBe((45 - 21) * 60000);
	});

	it('has no next segment after the last one', () => {
		const s = eventState(ev, START + 110 * 60000);
		expect(s.active.title).toBe('Fireworks finale');
		expect(s.next).toBeNull();
	});

	it('reports live progress', () => {
		const s = eventState(ev, START + 60 * 60000);
		expect(s.progress).toBeCloseTo(0.5, 5);
	});
});

describe('applyPreviewOverride', () => {
	const ev = parseEvent(DOC);

	it('shifts the window to now + 20s for ?meetup=now, preserving duration', () => {
		const now = 1_000_000_000;
		const shifted = applyPreviewOverride(ev, '?meetup=now', now);
		expect(shifted.startsAt).toBe(now + 20_000);
		expect(shifted.endsAt - shifted.startsAt).toBe(ev.endsAt - ev.startsAt);
		expect(shifted.agenda).toBe(ev.agenda);
	});

	it('shifts to an explicit ISO instant', () => {
		const shifted = applyPreviewOverride(ev, '?meetup=2026-08-07T12:00:00Z');
		expect(shifted.startsAt).toBe(Date.parse('2026-08-07T12:00:00Z'));
	});

	it('leaves the event alone without an override or with a bad one', () => {
		expect(applyPreviewOverride(ev, '')).toBe(ev);
		expect(applyPreviewOverride(ev, '?coin=abc')).toBe(ev);
		expect(applyPreviewOverride(ev, '?meetup=garbage')).toBe(ev);
		expect(applyPreviewOverride(null, '?meetup=now')).toBeNull();
	});
});

describe('formatCountdown', () => {
	it('formats each distance naturally', () => {
		expect(formatCountdown(2 * 3600000 + 14 * 60000)).toBe('2h 14m');
		expect(formatCountdown(14 * 60000 + 9000)).toBe('14m');
		expect(formatCountdown(4 * 60000 + 9000)).toBe('4m 09s');
		expect(formatCountdown(7000)).toBe('0:07');
		expect(formatCountdown(0)).toBe('0:00');
		expect(formatCountdown(-500)).toBe('0:00');
	});
});

describe('fireworkPlan', () => {
	it('is deterministic for the same event and bucket', () => {
		const a = fireworkPlan('three-first-meetup', 1_000_000);
		const b = fireworkPlan('three-first-meetup', 1_000_000);
		expect(a).toEqual(b);
	});

	it('differs across buckets and events', () => {
		const base = JSON.stringify(fireworkPlan('ev', 0, { intensity: 2 }));
		expect(JSON.stringify(fireworkPlan('ev', BUCKET_MS, { intensity: 2 }))).not.toBe(base);
		expect(JSON.stringify(fireworkPlan('other', 0, { intensity: 2 }))).not.toBe(base);
	});

	it('always launches at least one burst at full intensity', () => {
		for (let i = 0; i < 20; i++) {
			expect(fireworkPlan('ev', i * BUCKET_MS, { intensity: 1 }).length).toBeGreaterThan(0);
		}
	});

	it('keeps launches inside their bucket window', () => {
		for (const l of fireworkPlan('ev', 8 * BUCKET_MS, { intensity: 3 })) {
			expect(l.atMs).toBeGreaterThanOrEqual(8 * BUCKET_MS);
			expect(l.atMs).toBeLessThan(9 * BUCKET_MS);
			expect(l.apex).toBeGreaterThan(10);
		}
	});
});
