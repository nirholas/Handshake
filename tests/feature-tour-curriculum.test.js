/**
 * Feature Tour curriculum + track playlists — unit tests.
 *
 * The tour is driven by a generated curriculum (scripts/build-tour.mjs →
 * public/tour/curriculum.json) and navigated over a *playlist* of stop indices
 * derived per track. These tests pin the two invariants the runtime relies on:
 *   1. The generated curriculum is well-formed — every stop carries a boolean
 *      `highlight`, and the declared `tracks` metadata agrees with the stops.
 *   2. buildPlaylist() yields the right index lists for each track, always
 *      non-empty, and degrades to the full list when a curriculum has no
 *      highlights or an unknown track is requested.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildPlaylist, trackMeta, stopIndexForPath } from '../src/feature-tour/curriculum.js';

const curriculum = JSON.parse(
	readFileSync(resolve(__dirname, '../public/tour/curriculum.json'), 'utf8'),
);

// The general site tour ('full'/'quick') and the onboarding walkthrough share
// one curriculum file but are disjoint by section: everything with
// section === 'onboarding' belongs only to the 'onboarding' track.
const generalStops = curriculum.stops.filter((s) => s.section !== 'onboarding');
const onboardingStops = curriculum.stops.filter((s) => s.section === 'onboarding');

describe('generated curriculum', () => {
	it('has stops, sections, and all three tracks', () => {
		expect(curriculum.stops.length).toBeGreaterThan(0);
		expect(curriculum.sections.length).toBeGreaterThan(0);
		const ids = (curriculum.tracks || []).map((t) => t.id).sort();
		expect(ids).toEqual(['full', 'onboarding', 'quick']);
	});

	it('marks every stop with a boolean highlight flag', () => {
		for (const stop of curriculum.stops) {
			expect(typeof stop.highlight).toBe('boolean');
		}
	});

	it('keeps track metadata consistent with the stops', () => {
		const highlights = generalStops.filter((s) => s.highlight).length;
		expect(trackMeta(curriculum, 'full').stopCount).toBe(generalStops.length);
		expect(trackMeta(curriculum, 'quick').stopCount).toBe(highlights);
		expect(trackMeta(curriculum, 'onboarding').stopCount).toBe(onboardingStops.length);
		// Quick is a true subset and a meaningful sample of the whole.
		expect(highlights).toBeGreaterThan(0);
		expect(highlights).toBeLessThan(generalStops.length);
	});

	it('includes a highlight at the start of every general chapter', () => {
		for (const section of curriculum.sections) {
			if (section.id === 'onboarding') continue;
			const first = curriculum.stops.find((s) => s.section === section.id);
			expect(first.highlight, `first stop of ${section.id} should be a highlight`).toBe(true);
		}
	});

	it('chains a real, ordered onboarding path from avatar to profile', () => {
		expect(onboardingStops.length).toBeGreaterThanOrEqual(5);
		const paths = onboardingStops.map((s) => s.path);
		expect(paths[0]).toBe('/start');
		expect(paths[paths.length - 1]).toBe('/profile');
		expect(paths).toContain('/diorama');
		expect(paths).toContain('/markets');
		// Every onboarding stop is a real, already-shipped page path, and each
		// carries narration (no placeholder copy).
		for (const stop of onboardingStops) {
			expect(stop.narration.length).toBeGreaterThan(20);
		}
	});
});

describe('buildPlaylist', () => {
	it('returns every non-onboarding stop index for the full track', () => {
		const full = buildPlaylist(curriculum, 'full');
		expect(full).toHaveLength(generalStops.length);
		expect(full.every((i) => curriculum.stops[i].section !== 'onboarding')).toBe(true);
	});

	it('returns only highlighted, non-onboarding indices for the quick track', () => {
		const quick = buildPlaylist(curriculum, 'quick');
		expect(quick.length).toBe(generalStops.filter((s) => s.highlight).length);
		expect(quick.every((i) => curriculum.stops[i].highlight)).toBe(true);
		expect(quick.every((i) => curriculum.stops[i].section !== 'onboarding')).toBe(true);
		// Strictly increasing — playlists preserve curriculum order.
		for (let i = 1; i < quick.length; i++) expect(quick[i]).toBeGreaterThan(quick[i - 1]);
	});

	it('returns only the onboarding stops, in order, for the onboarding track', () => {
		const onboarding = buildPlaylist(curriculum, 'onboarding');
		expect(onboarding.length).toBe(onboardingStops.length);
		expect(onboarding.every((i) => curriculum.stops[i].section === 'onboarding')).toBe(true);
		for (let i = 1; i < onboarding.length; i++) expect(onboarding[i]).toBeGreaterThan(onboarding[i - 1]);
	});

	it('defaults to the full (non-onboarding) track for an unknown track id', () => {
		expect(buildPlaylist(curriculum, 'nope')).toHaveLength(generalStops.length);
		expect(buildPlaylist(curriculum)).toHaveLength(generalStops.length);
	});

	it('falls back to the full list when no stops are highlighted', () => {
		const flat = { stops: [{ highlight: false }, { highlight: false }] };
		expect(buildPlaylist(flat, 'quick')).toEqual([0, 1]);
	});
});

describe('stopIndexForPath with a playlist scope', () => {
	it('resolves /markets to the onboarding stop when scoped to the onboarding playlist', () => {
		const onboarding = buildPlaylist(curriculum, 'onboarding');
		const idx = stopIndexForPath(curriculum, '/markets', onboarding);
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(curriculum.stops[idx].section).toBe('onboarding');
	});

	it('resolves /markets to a general stop when scoped to the full playlist', () => {
		const full = buildPlaylist(curriculum, 'full');
		const idx = stopIndexForPath(curriculum, '/markets', full);
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(curriculum.stops[idx].section).not.toBe('onboarding');
	});

	it('falls back to a global search when no playlist is given', () => {
		const idx = stopIndexForPath(curriculum, '/markets');
		expect(idx).toBeGreaterThanOrEqual(0);
	});
});

describe('free-roam activation guard', () => {
	let dom;
	let isInteractiveTarget;

	beforeAll(async () => {
		dom = new JSDOM('<!doctype html><body></body>');
		global.window = dom.window;
		global.document = dom.window.document;
		global.matchMedia = () => ({ matches: false });
		dom.window.matchMedia = global.matchMedia;
		({ isInteractiveTarget } = await import('../src/feature-tour/free-roam.js'));
	});

	afterAll(() => {
		delete global.window;
		delete global.document;
		delete global.matchMedia;
	});

	function make(html) {
		document.body.innerHTML = html;
		return document.body.firstElementChild;
	}

	it('treats links, buttons, inputs and canvases as page interactions', () => {
		expect(isInteractiveTarget(make('<a href="/x">x</a>'))).toBe(true);
		expect(isInteractiveTarget(make('<button>x</button>'))).toBe(true);
		expect(isInteractiveTarget(make('<input>'))).toBe(true);
		expect(isInteractiveTarget(make('<canvas></canvas>'))).toBe(true);
		expect(isInteractiveTarget(make('<div data-walk-block>x</div>'))).toBe(true);
	});

	it('counts a child of an interactive element as interactive', () => {
		const a = make('<a href="/x"><span>deep</span></a>');
		expect(isInteractiveTarget(a.querySelector('span'))).toBe(true);
	});

	it('treats plain empty space as walkable (not interactive)', () => {
		expect(isInteractiveTarget(make('<div><p>just text</p></div>'))).toBe(false);
		expect(isInteractiveTarget(null)).toBe(false);
	});
});
