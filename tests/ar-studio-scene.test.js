// AR Studio scene math + persistence (src/ar/studio-scene.js).
//
// The contract pinned here: models always land at a believable size resting ON
// the floor, gestures never wrap the long way round, and NOTHING hostile — a
// corrupt localStorage blob, a javascript: ?src=, a NaN transform — can reach
// the scene as a loadable URL or a non-finite number. Pure math, no DOM/Three.

import { describe, expect, it } from 'vitest';

import {
	AVATAR_TARGET_HEIGHT_M,
	deserializeScene,
	fitTransform,
	MAX_PLACEMENTS,
	normalizeGlbUrl,
	parseSrcParams,
	PROP_TARGET_SIZE_M,
	roomLightFromPixels,
	SCALE_MAX,
	SCALE_MIN,
	sceneFromHashParam,
	sceneToHashParam,
	serializeScene,
	spawnPointInFront,
	studioSceneUrl,
	studioShareUrl,
	touchAngle,
	twistDelta,
} from '../src/ar/studio-scene.js';

const box = (w, h, d, minY = 0) => ({
	min: { x: -w / 2, y: minY, z: -d / 2 },
	max: { x: w / 2, y: minY + h, z: d / 2 },
});

describe('fitTransform', () => {
	it('normalizes a skinned model to standing height', () => {
		const { scale } = fitTransform(box(4, 18, 3), { skinned: true });
		expect(scale * 18).toBeCloseTo(AVATAR_TARGET_HEIGHT_M, 5);
	});

	it('normalizes a giant prop by its longest dimension', () => {
		const { scale } = fitTransform(box(10, 2, 3));
		expect(scale * 10).toBeCloseTo(PROP_TARGET_SIZE_M, 5);
	});

	it('keeps an already real-world-sized model at natural scale', () => {
		// A 1 m crate is within the 0.5–2x band of the 0.75 m target: don't touch it.
		expect(fitTransform(box(1, 1, 1)).scale).toBe(1);
	});

	it('rests the model exactly on the floor after scaling', () => {
		const b = box(10, 2, 3, -4); // lowest point 4 m below origin
		const { scale, yOffset } = fitTransform(b);
		expect(yOffset).toBeCloseTo(4 * scale, 6);
	});

	it('degrades a degenerate or hostile box to identity', () => {
		expect(fitTransform({ min: {}, max: {} })).toEqual({ scale: 1, yOffset: 0 });
		expect(fitTransform(box(0, 0, 0))).toEqual({ scale: 1, yOffset: 0 });
		expect(fitTransform({ min: { x: NaN, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }))
			.toEqual({ scale: 1, yOffset: 0 });
	});
});

describe('spawnPointInFront', () => {
	it('projects the look direction onto the floor at the spawn distance', () => {
		const p = spawnPointInFront({ x: 0, y: 1.5, z: 0 }, { x: 0, y: -0.2, z: -1 }, 2);
		expect(p.x).toBeCloseTo(0, 6);
		expect(p.z).toBeCloseTo(-2, 6);
	});

	it('falls back to straight ahead when looking straight down', () => {
		const p = spawnPointInFront({ x: 3, y: 1.5, z: 5 }, { x: 0, y: -1, z: 0 }, 2);
		expect(p.x).toBeCloseTo(3, 6);
		expect(p.z).toBeCloseTo(3, 6); // -Z heading from the camera position
	});
});

describe('twistDelta / touchAngle', () => {
	it('returns the signed delta for a small twist', () => {
		expect(twistDelta(0.2, 0.5)).toBeCloseTo(0.3, 9);
		expect(twistDelta(0.5, 0.2)).toBeCloseTo(-0.3, 9);
	});

	it('never spins the long way across the ±180° boundary', () => {
		const d = twistDelta(Math.PI - 0.05, -Math.PI + 0.05);
		expect(d).toBeCloseTo(0.1, 9);
	});

	it('collapses non-finite input to no rotation', () => {
		expect(twistDelta(NaN, 1)).toBe(0);
		expect(twistDelta(1, Infinity)).toBe(0);
	});

	it('touchAngle reads the pair orientation', () => {
		const t = [{ clientX: 0, clientY: 0 }, { clientX: 10, clientY: 10 }];
		expect(touchAngle(t)).toBeCloseTo(Math.PI / 4, 9);
	});
});

describe('normalizeGlbUrl', () => {
	it('accepts https URLs and site-relative paths', () => {
		expect(normalizeGlbUrl('https://three.ws/cdn/m.glb')).toBe('https://three.ws/cdn/m.glb');
		expect(normalizeGlbUrl('/avatars/default.glb')).toBe('/avatars/default.glb');
		expect(normalizeGlbUrl('  https://x.co/a.glb  ')).toBe('https://x.co/a.glb');
	});

	it('rejects every non-https scheme and malformed input', () => {
		for (const bad of [
			'http://x.co/a.glb', 'javascript:alert(1)', 'data:model/gltf-binary;base64,AAAA',
			'blob:https://x.co/uuid', '//x.co/a.glb', 'ftp://x.co/a.glb', '', null, undefined, 42,
		]) {
			expect(normalizeGlbUrl(bad)).toBe(null);
		}
	});
});

describe('scene (de)serialization', () => {
	const placement = (over = {}) => ({
		src: 'https://three.ws/cdn/m.glb', title: 'crate', x: 1.5, z: -2, yaw: 0.5, scale: 1.2, ...over,
	});

	it('round-trips a valid scene', () => {
		const out = deserializeScene(serializeScene([placement()]));
		expect(out).toEqual([placement()]);
	});

	it('drops entries with rejected sources on both sides', () => {
		const json = serializeScene([placement(), placement({ src: 'javascript:alert(1)' })]);
		expect(deserializeScene(json)).toHaveLength(1);
		const hostile = JSON.stringify({ v: 1, items: [{ src: 'data:x', x: 0, z: 0 }] });
		expect(deserializeScene(hostile)).toEqual([]);
	});

	it('degrades corrupt/foreign payloads to an empty scene', () => {
		expect(deserializeScene('not json {')).toEqual([]);
		expect(deserializeScene(null)).toEqual([]);
		expect(deserializeScene(JSON.stringify({ v: 99, items: [] }))).toEqual([]);
		expect(deserializeScene(JSON.stringify({ v: 1, items: 'x' }))).toEqual([]);
	});

	it('drops NaN transforms and clamps scale + position', () => {
		const raw = JSON.stringify({
			v: 1,
			items: [
				{ src: 'https://x.co/a.glb', x: 'nope', z: 0 },
				{ src: 'https://x.co/b.glb', x: 999, z: -999, scale: 99, yaw: 'nope' },
			],
		});
		const out = deserializeScene(raw);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ x: 50, z: -50, scale: SCALE_MAX, yaw: 0 });
		expect(out[0].scale).toBeLessThanOrEqual(SCALE_MAX);
		expect(SCALE_MIN).toBeLessThan(SCALE_MAX);
	});

	it('caps the scene at MAX_PLACEMENTS on restore', () => {
		const items = Array.from({ length: MAX_PLACEMENTS + 10 }, (_, i) => ({
			src: `https://x.co/${i}.glb`, x: 0, z: 0,
		}));
		expect(deserializeScene(JSON.stringify({ v: 1, items }))).toHaveLength(MAX_PLACEMENTS);
	});
});

describe('parseSrcParams', () => {
	it('pairs repeated src params with positional titles', () => {
		const q = new URLSearchParams('src=https://x.co/a.glb&title=A&src=https://x.co/b.glb&title=B');
		expect(parseSrcParams(q)).toEqual([
			{ src: 'https://x.co/a.glb', title: 'A' },
			{ src: 'https://x.co/b.glb', title: 'B' },
		]);
	});

	it('skips invalid sources without shifting the rest', () => {
		const q = new URLSearchParams('src=javascript:x&src=https://x.co/b.glb');
		expect(parseSrcParams(q)).toEqual([{ src: 'https://x.co/b.glb', title: '' }]);
	});
});

describe('scene hash (#s=) codec', () => {
	const scene = [
		{ src: 'https://x.co/a.glb', title: 'crate ✦ 沙发', x: 1.25, z: -3.5, yaw: 0.7854, scale: 1.5 },
		{ src: '/avatars/default.glb', title: 'avatar', x: -0.5, z: 2, yaw: -2.1, scale: 0.8 },
	];

	it('round-trips models AND transforms (unicode titles included)', () => {
		const out = sceneFromHashParam(sceneToHashParam(scene));
		expect(out).toEqual(scene);
	});

	it('is URL-safe (no +, /, =, or characters needing escapes)', () => {
		const hash = sceneToHashParam(scene);
		expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('returns "" for an empty or fully-invalid scene', () => {
		expect(sceneToHashParam([])).toBe('');
		expect(sceneToHashParam([{ src: 'javascript:x', x: 0, z: 0 }])).toBe('');
	});

	it('degrades hostile hash input to an empty scene', () => {
		expect(sceneFromHashParam('!!!not-base64!!!')).toEqual([]);
		expect(sceneFromHashParam('aGVsbG8')).toEqual([]); // valid b64, not a scene
		expect(sceneFromHashParam('')).toEqual([]);
		expect(sceneFromHashParam(null)).toEqual([]);
	});

	it('validated exactly like the storage path (bad URLs dropped)', () => {
		const forged = sceneToHashParam([
			...scene,
			{ src: 'https://x.co/ok.glb', title: 'ok', x: 0, z: 0, yaw: 0, scale: 1 },
		]);
		expect(sceneFromHashParam(forged)).toHaveLength(3);
	});
});

describe('studioSceneUrl', () => {
	const scene = [{ src: 'https://x.co/a.glb', title: 'A', x: 1, z: 2, yaw: 0.5, scale: 1.2 }];

	it('appends the arrangement hash to the src-list URL', () => {
		const url = studioSceneUrl('https://three.ws', scene);
		const [base, hash] = url.split('#s=');
		expect(base).toBe(studioShareUrl('https://three.ws', scene));
		expect(sceneFromHashParam(hash)).toEqual(scene);
	});

	it('falls back to the src-only URL when the payload would be QR-hostile', () => {
		const url = studioSceneUrl('https://three.ws', scene, 40);
		expect(url).toBe(studioShareUrl('https://three.ws', scene));
		expect(url).not.toContain('#s=');
	});
});

describe('roomLightFromPixels', () => {
	// Build a downsampled RGBA buffer of a single flat colour.
	const flat = (r, g, b, n = 16) => {
		const a = new Uint8ClampedArray(n * 4);
		for (let i = 0; i < a.length; i += 4) { a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = 255; }
		return a;
	};

	it('reads a dim room as low intensity, a bright room as high', () => {
		expect(roomLightFromPixels(flat(20, 20, 20)).intensity).toBeLessThan(0.6);
		expect(roomLightFromPixels(flat(240, 240, 240)).intensity).toBeGreaterThan(1.2);
	});

	it('clamps intensity to the [0.4, 1.35] band', () => {
		expect(roomLightFromPixels(flat(0, 0, 0)).intensity).toBe(0.4);
		expect(roomLightFromPixels(flat(255, 255, 255)).intensity).toBeLessThanOrEqual(1.35);
	});

	it('stays neutral for grey light (no false tint)', () => {
		const { tint } = roomLightFromPixels(flat(128, 128, 128));
		expect(tint.r).toBeCloseTo(1, 5);
		expect(tint.g).toBeCloseTo(1, 5);
		expect(tint.b).toBeCloseTo(1, 5);
	});

	it('casts warm for a warm-lamp room and cool for daylight', () => {
		const warm = roomLightFromPixels(flat(220, 160, 90)).tint;
		expect(warm.r).toBeGreaterThan(1);
		expect(warm.b).toBeLessThan(1);
		const cool = roomLightFromPixels(flat(120, 150, 210)).tint;
		expect(cool.b).toBeGreaterThan(1);
		expect(cool.r).toBeLessThan(1);
	});

	it('never over-tints — the cast is a partial pull, not a full recolour', () => {
		// Pure red light: a full tint would zero G and B. The 1/3 pull keeps them well above 0.
		const { tint } = roomLightFromPixels(flat(255, 0, 0));
		expect(tint.g).toBeGreaterThan(0.5);
		expect(tint.b).toBeGreaterThan(0.5);
		expect(tint.r).toBeGreaterThan(1);
	});

	it('degrades an empty or near-black frame to neutral', () => {
		expect(roomLightFromPixels(new Uint8ClampedArray(0))).toEqual({ intensity: 0.4, tint: { r: 1, g: 1, b: 1 } });
		expect(roomLightFromPixels(flat(1, 1, 1)).tint).toEqual({ r: 1, g: 1, b: 1 });
	});
});

describe('studioShareUrl', () => {
	it('embeds unique sources up to the cap', () => {
		const url = studioShareUrl('https://three.ws', [
			{ src: 'https://x.co/a.glb', title: 'A' },
			{ src: 'https://x.co/a.glb', title: 'A again' }, // duplicate source
			{ src: 'https://x.co/b.glb', title: 'B' },
		]);
		const q = new URL(url).searchParams;
		expect(q.getAll('src')).toEqual(['https://x.co/a.glb', 'https://x.co/b.glb']);
	});

	it('returns the bare studio URL for an empty or invalid scene', () => {
		expect(studioShareUrl('https://three.ws', [])).toBe('https://three.ws/ar/studio');
		expect(studioShareUrl('https://three.ws', [{ src: 'data:x' }])).toBe('https://three.ws/ar/studio');
	});
});
