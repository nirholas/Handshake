// IRL visit links (src/irl/visit-link.js).
//
// A sign at a real spot carries one URL. Everything a stranger sees after scanning
// it (which agent they came to meet, whether their phone opens Quick Look or the
// server AR launcher, what the banner tells them before the agent is in range)
// follows from these rules, so they are pinned here.

import { describe, it, expect } from 'vitest';

import {
	normalizePinId,
	parseVisitTarget,
	buildVisitUrl,
	buildSignUrl,
	discoveredArLaunch,
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

describe('discoveredArLaunch', () => {
	const glb = 'https://cdn.three.ws/avatars/abc.glb';
	it('opens Quick Look in place on iOS', () => {
		expect(discoveredArLaunch({ avatarUrl: glb, name: 'Mira', ios: true })).toEqual({ mode: 'quicklook', src: glb });
	});
	it('routes everyone else through the server AR launcher with the living-agent kind', () => {
		const r = discoveredArLaunch({ avatarUrl: glb, name: 'Mira', ios: false });
		expect(r.mode).toBe('link');
		const u = new URL(r.url, 'https://three.ws');
		expect(u.pathname).toBe('/api/ar');
		expect(u.searchParams.get('src')).toBe(glb);
		expect(u.searchParams.get('kind')).toBe('avatar');
		expect(u.searchParams.get('title')).toBe('Mira');
	});
	it('hides the action for a pin with no https model', () => {
		expect(discoveredArLaunch({ avatarUrl: '/api/avatars/x/glb', ios: true })).toEqual({ mode: 'none' });
		expect(discoveredArLaunch({ avatarUrl: 'blob:https://three.ws/1', ios: false })).toEqual({ mode: 'none' });
		expect(discoveredArLaunch({})).toEqual({ mode: 'none' });
	});
	it('clamps a runaway name so the title never bloats the URL', () => {
		const r = discoveredArLaunch({ avatarUrl: glb, name: 'n'.repeat(400), ios: false });
		expect(new URL(r.url, 'https://three.ws').searchParams.get('title')).toHaveLength(120);
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
