// IRL visit links (src/irl/visit-link.js).
//
// A sign at a real spot carries one URL. Everything a stranger sees after scanning
// it (which agent they came to meet, what the banner tells them before the agent
// is in range) follows from these rules, so they are pinned here.

import { describe, it, expect } from 'vitest';

import {
	normalizePinId,
	parseVisitTarget,
	buildVisitUrl,
	buildSignUrl,
	meetBannerCopy,
} from '../src/irl/visit-link.js';

const UUID = '0b9e0f8e-6c9a-4a2f-9a55-2c1d4a1b7e33';

describe('normalizePinId', () => {
	it('accepts uuids and short ids, rejects junk', () => {
		expect(normalizePinId(UUID)).toBe(UUID);
		expect(normalizePinId('  abc123xyz ')).toBe('abc123xyz');
		expect(normalizePinId('a/b')).toBeNull();
		expect(normalizePinId('short')).toBeNull();
		expect(normalizePinId('')).toBeNull();
		expect(normalizePinId(null)).toBeNull();
		expect(normalizePinId('x'.repeat(65))).toBeNull();
	});
});

describe('parseVisitTarget', () => {
	it('reads ?pin= and treats ?highlight= as an alias', () => {
		expect(parseVisitTarget(`?pin=${UUID}`)).toEqual({ pinId: UUID });
		expect(parseVisitTarget(`?highlight=${UUID}`)).toEqual({ pinId: UUID });
	});
	it('prefers ?pin= when both are present', () => {
		expect(parseVisitTarget(`?highlight=other-pin-1&pin=${UUID}`).pinId).toBe(UUID);
	});
	it('yields null with no target or a malformed one', () => {
		expect(parseVisitTarget('')).toEqual({ pinId: null });
		expect(parseVisitTarget('?avatar=abc').pinId).toBeNull();
		expect(parseVisitTarget('?pin=<script>').pinId).toBeNull();
		expect(parseVisitTarget(undefined).pinId).toBeNull();
	});
});

describe('buildVisitUrl / buildSignUrl', () => {
	it('builds absolute links on the given origin, never carrying a coordinate', () => {
		expect(buildVisitUrl(UUID, 'https://three.ws')).toBe(`https://three.ws/irl?pin=${UUID}`);
		expect(buildSignUrl(UUID, 'https://three.ws/')).toBe(`https://three.ws/irl/sign?pin=${UUID}`);
	});
	it('defaults to the production origin', () => {
		expect(buildVisitUrl(UUID)).toBe(`https://three.ws/irl?pin=${UUID}`);
	});
	it('refuses an invalid id at the boundary', () => {
		expect(() => buildVisitUrl('nope')).toThrow(/pin id/);
		expect(() => buildSignUrl('')).toThrow(/pin id/);
	});
});

describe('meetBannerCopy', () => {
	it('names the agent and quotes the real discovery radius while out of range', () => {
		const c = meetBannerCopy({ name: 'Mira', state: 'searching', radiusM: 60 });
		expect(c.title).toBe("You're here to meet Mira");
		expect(c.body).toContain('60 m');
	});
	it('covers found, gone, and no-gps states with a next step each', () => {
		expect(meetBannerCopy({ name: 'Mira', state: 'found' }).title).toBe('Mira is here');
		expect(meetBannerCopy({ name: 'Mira', state: 'gone' }).body).toMatch(/Place your own/);
		expect(meetBannerCopy({ name: 'Mira', state: 'no-gps' }).body).toMatch(/location/i);
	});
	it('falls back to a neutral subject with no name', () => {
		expect(meetBannerCopy({ state: 'searching' }).title).toBe("You're here to meet this agent");
	});
});
