import { describe, it, expect } from 'vitest';
import {
	parseEvent, eventState, formatCountdown, fireworkPlan,
	PHASE, SOON_MS, PRESHOW_MS, AFTERGLOW_MS, BUCKET_MS,
} from '../src/game/meetup-schedule.js';

const START = Date.parse('2026-08-07T17:00:00Z');

const DOC = {
	events: [{
		id: 'three-first-meetup',
		title: '$THREE First Holders Meetup',
		subtitle: 'The first live gathering in the world',
		startsAt: '2026-08-07T17:00:00Z',
		durationMin: 90,
		agenda: [
			{ atMin: 0, title: 'Welcome to the plaza', icon: '👋' },
			{ atMin: 15, title: 'King of the Totem showdown', icon: '👑', x: 10, z: -5 },
			{ atMin: 40, title: 'Wheel hour', icon: '🎡' },
			{ atMin: 75, title: 'Fireworks finale', icon: '🎆' },
		],
	}],
};

describe('parseEvent', () => {
	it('parses a valid event with sorted agenda and computed end', () => {
		const ev = parseEvent(DOC);
		expect(ev.id).toBe('three-first-meetup');
		expect(ev.startsAt).toBe(START);
		expect(ev.endsAt).toBe(START + 90 * 60000);
		expect(ev.agenda).toHaveLength(4);
		expect(ev.agenda[1].x).toBe(10);
		expect(ev.agenda[0].x).toBeNull();
	});

	it('sorts an out-of-order agenda and drops invalid segments', () => {
		const ev = parseEvent({
			events: [{
				startsAt: '2026-08-07T17:00:00Z',
				agenda: [
					{ atMin: 30, title: 'B' },
					{ atMin: 0, title: 'A' },
					{ atMin: 'nope', title: 'bad' },
					{ atMin: 5, title: '' },
				],
			}],
		});
		expect(ev.agenda.map((s) => s.title)).toEqual(['A', 'B']);
	});

	it('returns null for empty, malformed, or dateless docs', () => {
		expect(parseEvent(null)).toBeNull();
		expect(parseEvent({})).toBeNull();
		expect(parseEvent({ events: [] })).toBeNull();
		expect(parseEvent({ events: [{ startsAt: 'not a date' }] })).toBeNull();
	});

	it('defaults duration to 60 minutes when missing or invalid', () => {
		const ev = parseEvent({ events: [{ startsAt: '2026-08-07T17:00:00Z', durationMin: -3 }] });
		expect(ev.endsAt - ev.startsAt).toBe(60 * 60000);
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
		expect(s.next.title).toBe('Welcome to the plaza');
	});

	it('tracks the active and next segments while live', () => {
		const s = eventState(ev, START + 16 * 60000);
		expect(s.active.title).toBe('King of the Totem showdown');
		expect(s.next.title).toBe('Wheel hour');
		expect(s.msToNext).toBe((40 - 16) * 60000);
	});

	it('has no next segment after the last one', () => {
		const s = eventState(ev, START + 80 * 60000);
		expect(s.active.title).toBe('Fireworks finale');
		expect(s.next).toBeNull();
	});

	it('reports live progress', () => {
		const s = eventState(ev, START + 45 * 60000);
		expect(s.progress).toBeCloseTo(0.5, 5);
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
