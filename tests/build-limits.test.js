// P3.2 / P3.3 — the shared build limits both the authoritative room and the /play
// client import. These numbers used to live in two places (the server held the
// only real clear radius; the client defaulted a bare 12 in four spots), so these
// tests lock the single source of truth and the tier progression it encodes.

import { describe, it, expect, afterEach } from 'vitest';
import {
	buildClearRadius, buildTierLabel, normalizePropAssetUrl,
	BUILD_CLEAR_RADIUS_BASE, BUILD_CLEAR_RADIUS_HOLDER, BUILD_CLEAR_RADIUS_CREATOR,
	BUILD_CLEAR_RADIUS_MAX, MAX_WORLD_OBJECTS, MAX_OBJECTS_PER_PLAYER,
	PROP_ASSET_URL_MAX,
} from '../multiplayer/src/build-limits.js';

describe('build radius progression (P3.2)', () => {
	it('gives a plain visitor the base radius', () => {
		expect(buildClearRadius()).toBe(BUILD_CLEAR_RADIUS_BASE);
		expect(buildClearRadius({})).toBe(BUILD_CLEAR_RADIUS_BASE);
		expect(buildClearRadius({ creator: false, holder: false })).toBe(BUILD_CLEAR_RADIUS_BASE);
	});

	it('widens inside a coin holders-tier world', () => {
		expect(buildClearRadius({ holder: true })).toBe(BUILD_CLEAR_RADIUS_HOLDER);
		expect(BUILD_CLEAR_RADIUS_HOLDER).toBeGreaterThan(BUILD_CLEAR_RADIUS_BASE);
	});

	it('widens furthest for the coin creator', () => {
		expect(buildClearRadius({ creator: true })).toBe(BUILD_CLEAR_RADIUS_CREATOR);
		expect(BUILD_CLEAR_RADIUS_CREATOR).toBeGreaterThan(BUILD_CLEAR_RADIUS_HOLDER);
	});

	it('takes the max of the tiers rather than compounding them', () => {
		expect(buildClearRadius({ creator: true, holder: true })).toBe(BUILD_CLEAR_RADIUS_CREATOR);
	});

	it('never exceeds the absolute ceiling', () => {
		for (const standing of [{}, { holder: true }, { creator: true }, { creator: true, holder: true }]) {
			expect(buildClearRadius(standing)).toBeLessThanOrEqual(BUILD_CLEAR_RADIUS_MAX);
		}
	});

	it('labels the tier it granted', () => {
		expect(buildTierLabel({})).toBe('visitor');
		expect(buildTierLabel({ holder: true })).toBe('holder');
		expect(buildTierLabel({ creator: true, holder: true })).toBe('creator');
	});

	it('keeps the object budget bounded and per-player smaller than per-world', () => {
		expect(MAX_OBJECTS_PER_PLAYER).toBeLessThan(MAX_WORLD_OBJECTS);
	});
});

describe('prop asset url allow-list (P3.3)', () => {
	afterEach(() => { delete process.env.WORLD_ASSET_HOSTS; });

	it('accepts a model on our own storage', () => {
		expect(normalizePropAssetUrl('https://pub-test.r2.dev/u/anon/avatar/abc.glb'))
			.toBe('https://pub-test.r2.dev/u/anon/avatar/abc.glb');
		expect(normalizePropAssetUrl('https://three.ws/models/thing.vrm'))
			.toBe('https://three.ws/models/thing.vrm');
	});

	it('strips query and hash so a signed url never gets persisted', () => {
		expect(normalizePropAssetUrl('https://pub-test.r2.dev/a.glb?sig=deadbeef#frag'))
			.toBe('https://pub-test.r2.dev/a.glb');
	});

	it('refuses a third-party host', () => {
		expect(normalizePropAssetUrl('https://evil.example.com/a.glb')).toBeNull();
	});

	it('refuses non-https schemes, including javascript: and data:', () => {
		expect(normalizePropAssetUrl('http://three.ws/a.glb')).toBeNull();
		expect(normalizePropAssetUrl('javascript:alert(1)//a.glb')).toBeNull();
		expect(normalizePropAssetUrl('data:model/gltf-binary;base64,AAAA')).toBeNull();
	});

	it('refuses credentials embedded in the url', () => {
		expect(normalizePropAssetUrl('https://user:pw@three.ws/a.glb')).toBeNull();
	});

	it('refuses a non-model path', () => {
		expect(normalizePropAssetUrl('https://three.ws/a.js')).toBeNull();
		expect(normalizePropAssetUrl('https://three.ws/a.glb.exe')).toBeNull();
	});

	it('refuses junk, empties and over-long strings', () => {
		expect(normalizePropAssetUrl('')).toBeNull();
		expect(normalizePropAssetUrl(null)).toBeNull();
		expect(normalizePropAssetUrl(12)).toBeNull();
		expect(normalizePropAssetUrl('not a url')).toBeNull();
		expect(normalizePropAssetUrl(`https://three.ws/${'a'.repeat(PROP_ASSET_URL_MAX)}.glb`)).toBeNull();
	});

	it('honours a configured host allow-list over the defaults', () => {
		process.env.WORLD_ASSET_HOSTS = 'assets.internal';
		expect(normalizePropAssetUrl('https://assets.internal/a.glb')).toBe('https://assets.internal/a.glb');
		expect(normalizePropAssetUrl('https://three.ws/a.glb')).toBeNull();
	});
});
