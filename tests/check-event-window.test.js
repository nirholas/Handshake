import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { validateEventConfig, CONFIG_PATH, isoOf, zoneLines } from '../scripts/check-event-window.mjs';

// The shape of public/event.json, minus the fields the validator ignores. Kept
// close to the real file so a rule that only passes on a toy config fails here.
const BASE = {
	id: 'three-first-meetup',
	name: '$THREE First Holders Meetup',
	startsAt: '2026-08-09T17:00:00Z',
	endsAt: '2026-08-09T19:30:00Z',
	link: '/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&name=three.ws&symbol=three',
	souvenir: { cosmeticId: 'laurel-meetup' },
	agenda: [
		{ atMin: 0, title: 'Doors open in the plaza', icon: '👋' },
		{ atMin: 105, title: 'Fireworks finale', icon: '🎆' },
	],
};

const BEFORE = Date.parse('2026-08-09T12:00:00Z');
const DURING = Date.parse('2026-08-09T18:00:00Z');
const AFTER = Date.parse('2026-08-10T00:00:00Z');

const cfg = (over = {}) => ({ ...BASE, ...over });
const reasons = (doc, now) => validateEventConfig(doc, now).failures.join(' | ');

describe('validateEventConfig', () => {
	it('accepts a coherent upcoming event', () => {
		const { failures, state } = validateEventConfig(cfg(), BEFORE);
		expect(failures).toEqual([]);
		expect(state).toBe('upcoming');
	});

	it('accepts the event while it is running', () => {
		const { failures, state } = validateEventConfig(cfg(), DURING);
		expect(failures).toEqual([]);
		expect(state).toBe('live');
	});

	// The bug this check exists for: a rehearsal window left in the file. Every
	// surface reads it as "no event" and mounts nothing, silently.
	it('rejects a window that has already ended', () => {
		const { failures, state } = validateEventConfig(cfg(), AFTER);
		expect(state).toBe('over');
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatch(/ENDED/);
	});

	it('rejects a config with no usable start time', () => {
		expect(reasons(cfg({ startsAt: 'tomorrow-ish' }), BEFORE)).toMatch(/startsAt/);
		expect(reasons(cfg({ startsAt: undefined }), BEFORE)).toMatch(/startsAt/);
	});

	// An end that loses to the start is dropped by the parser for a silent
	// six-hour default, which is never what whoever typed it meant.
	it('rejects an end that does not beat the start', () => {
		expect(reasons(cfg({ endsAt: '2026-08-09T16:00:00Z' }), BEFORE)).toMatch(/not after startsAt/);
		expect(reasons(cfg({ endsAt: 'never' }), BEFORE)).toMatch(/unparseable/);
	});

	it('rejects a window long enough to be a typo', () => {
		expect(reasons(cfg({ endsAt: '2026-08-19T17:00:00Z' }), BEFORE)).toMatch(/reads like a typo/);
	});

	describe('souvenir', () => {
		it('rejects a cosmetic that is not in the catalog', () => {
			expect(reasons(cfg({ souvenir: { cosmeticId: 'laurel-imaginary' } }), BEFORE)).toMatch(/not in multiplayer/);
		});

		// The server only grants tier 'event', so any other tier grants nothing.
		it('rejects a cosmetic the server would refuse to grant', () => {
			expect(reasons(cfg({ souvenir: { cosmeticId: 'hat-cowboy' } }), BEFORE)).toMatch(/only grants tier 'event'/);
		});

		it('rejects a souvenir with no cosmeticId', () => {
			expect(reasons(cfg({ souvenir: {} }), BEFORE)).toMatch(/names no cosmeticId/);
		});

		// The grant is scoped to the coin world the CTA points at.
		it('rejects a souvenir whose link names no world', () => {
			expect(reasons(cfg({ link: '/play' }), BEFORE)).toMatch(/no \?coin=/);
			expect(reasons(cfg({ link: '' }), BEFORE)).toMatch(/no \?coin=/);
		});

		it('allows an event that grants nothing', () => {
			expect(validateEventConfig(cfg({ souvenir: undefined, link: '/play' }), BEFORE).failures).toEqual([]);
		});
	});

	describe('agenda', () => {
		it('rejects a beat scheduled past the end of the window', () => {
			const late = cfg({ agenda: [{ atMin: 0, title: 'Doors' }, { atMin: 999, title: 'Fireworks finale' }] });
			expect(reasons(late, BEFORE)).toMatch(/never fires/);
		});

		it('rejects beats that run backwards', () => {
			const jumbled = cfg({ agenda: [{ atMin: 45, title: 'Wheel' }, { atMin: 20, title: 'Totem' }] });
			expect(reasons(jumbled, BEFORE)).toMatch(/must be in order/);
		});

		it('rejects a beat with no usable minute offset', () => {
			expect(reasons(cfg({ agenda: [{ atMin: -5, title: 'Doors' }] }), BEFORE)).toMatch(/non-negative/);
			expect(reasons(cfg({ agenda: [{ atMin: 'soon', title: 'Doors' }] }), BEFORE)).toMatch(/non-negative/);
		});
	});

	// The formatters feed the announcement copy, and copy that disagrees with the
	// config is the other way this event has gone wrong.
	describe('clock rendering', () => {
		it('renders the window in the zones the announcements quote', () => {
			const lines = zoneLines(Date.parse('2026-08-09T17:00:00Z'));
			expect(lines).toHaveLength(4);
			expect(lines[0]).toBe('Aug 9, 2026, 10:00 AM Pacific');
			expect(lines[1]).toBe('Aug 9, 2026, 1:00 PM Eastern');
			expect(lines[2]).toBe('Aug 9, 2026, 6:00 PM London');
			expect(lines[3]).toBe('Aug 9, 2026, 7:00 PM Berlin');
		});

		it('writes instants back in the config\'s own format', () => {
			expect(isoOf(Date.parse('2026-08-09T17:00:00Z'))).toBe('2026-08-09T17:00:00Z');
		});
	});
});

// The config that ships is the one that matters; a green suite over fixtures
// while the real file is broken would be the same silent failure in a new place.
// Between events there is no file at all (the documented "no event scheduled"
// state every surface handles), so these run only when one is actually shipping.
// Read inside the tests rather than in the suite body: vitest still collects a
// skipped suite's body, so an eager read would throw with no event scheduled.
const shippedEvent = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

describe.skipIf(!existsSync(CONFIG_PATH))('the configured event that ships', () => {
	it('is coherent when judged at its own start', () => {
		const doc = shippedEvent();
		const { failures } = validateEventConfig(doc, Date.parse(doc.startsAt));
		expect(failures).toEqual([]);
	});

	it('has not already ended', () => {
		expect(Date.parse(shippedEvent().endsAt)).toBeGreaterThan(Date.now());
	});
});
