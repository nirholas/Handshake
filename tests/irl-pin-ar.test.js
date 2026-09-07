// "View in AR" for a discovered pin (src/irl/pin-ar.js).
//
// A visitor who taps somebody else's agent on /irl gets one button that stands
// that agent on their real floor. Which native AR stack answers depends on the
// device, and the GLB has to be handed over as an absolute https URL that Quick
// Look, Scene Viewer and /api/ar all accept. Those rules are pure; pin them here
// so a phone test never has to rediscover them.

import { describe, it, expect } from 'vitest';

import {
	arLaneFor,
	arButtonCopy,
	absoluteGlbUrl,
	arLaunchUrl,
	quickLookBannerFor,
	pinDisplayName,
} from '../src/irl/pin-ar.js';

const ORIGIN = 'https://three.ws';

describe('arLaneFor', () => {
	it('routes each placement capability to its AR lane', () => {
		expect(arLaneFor('quicklook')).toBe('quicklook');
		expect(arLaneFor('webxr')).toBe('webxr');
		expect(arLaneFor('pin')).toBe('link');
	});

	it('falls back to the universal link lane on anything unexpected', () => {
		expect(arLaneFor(undefined)).toBe('link');
		expect(arLaneFor('')).toBe('link');
		expect(arLaneFor('webar')).toBe('link');
	});
});

describe('arButtonCopy', () => {
	it('keeps one visible label and a device-specific accessible name', () => {
		const lanes = ['quicklook', 'webxr', 'link'];
		const labels = new Set(lanes.map((l) => arButtonCopy(l).label));
		expect(labels.size).toBe(1);
		expect(arButtonCopy('quicklook').aria).toMatch(/Quick Look/);
		expect(arButtonCopy('webxr').aria).toMatch(/floor/);
		expect(arButtonCopy('link').aria).toMatch(/viewer/);
	});
});

describe('absoluteGlbUrl', () => {
	it('resolves a site-relative model path against the origin', () => {
		expect(absoluteGlbUrl('/avatars/default.glb', ORIGIN)).toBe('https://three.ws/avatars/default.glb');
	});

	it('passes an absolute CDN URL through untouched', () => {
		const cdn = 'https://three.ws/cdn/models/abc.glb?v=2';
		expect(absoluteGlbUrl(cdn, ORIGIN)).toBe(cdn);
	});

	it('returns null for an empty or non-string model', () => {
		expect(absoluteGlbUrl('', ORIGIN)).toBeNull();
		expect(absoluteGlbUrl('   ', ORIGIN)).toBeNull();
		expect(absoluteGlbUrl(null, ORIGIN)).toBeNull();
	});
});

describe('arLaunchUrl', () => {
	it('builds the device-aware /api/ar link marked as a living avatar', () => {
		const url = arLaunchUrl({ avatar_url: '/avatars/default.glb', avatar_name: 'Nova' }, ORIGIN);
		const u = new URL(url);
		expect(u.origin + u.pathname).toBe('https://three.ws/api/ar');
		expect(u.searchParams.get('src')).toBe('https://three.ws/avatars/default.glb');
		expect(u.searchParams.get('title')).toBe('Nova');
		expect(u.searchParams.get('kind')).toBe('avatar');
	});

	it('refuses a model that cannot be expressed as https (what /api/ar would reject)', () => {
		expect(arLaunchUrl({ avatar_url: '/avatars/default.glb' }, 'http://localhost:3000')).toBeNull();
		expect(arLaunchUrl({ avatar_url: 'blob:https://three.ws/123' }, ORIGIN)).toBeNull();
		expect(arLaunchUrl({ avatar_url: '' }, ORIGIN)).toBeNull();
	});

	it('clamps a runaway name so the title never balloons the URL', () => {
		const long = 'x'.repeat(500);
		const url = arLaunchUrl({ avatar_url: '/a.glb', avatar_name: long }, ORIGIN);
		expect(new URL(url).searchParams.get('title').length).toBeLessThanOrEqual(60);
	});
});

describe('quickLookBannerFor', () => {
	it('names the agent and makes the banner tap a conversation, not a placement', () => {
		const b = quickLookBannerFor({ avatar_name: 'Nova', caption: 'Ask me about the pier' });
		expect(b.title).toBe('Nova');
		expect(b.subtitle).toBe('Ask me about the pier');
		expect(b.callToAction).toBe('Talk to Nova');
	});

	it('falls back to the platform line when the pin has no caption', () => {
		expect(quickLookBannerFor({ avatar_name: 'Nova' }).subtitle).toBe('Living agent on three.ws');
	});
});

describe('pinDisplayName', () => {
	it('defaults to Agent and trims whitespace', () => {
		expect(pinDisplayName({})).toBe('Agent');
		expect(pinDisplayName({ avatar_name: '  Nova ' })).toBe('Nova');
		expect(pinDisplayName(null)).toBe('Agent');
	});
});
