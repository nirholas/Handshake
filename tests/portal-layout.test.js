// The layout is the reason a shared Portal link opens the world its author
// walked: it is pure, seeded, and identical in the browser, in the server's GLB
// exporter, and in the published package. These tests pin that.
import { describe, it, expect } from 'vitest';
import {
	buildWorld,
	collidersFor,
	districtPosition,
	paletteFor,
	hashSeed,
	seededRandom,
	hslToHex,
	hexToHsl,
	doorSlot,
	METRICS,
	WORLD_VERSION,
} from '../packages/portal/src/layout.js';

const outline = (over = {}) => ({
	version: 1,
	url: 'https://site.test/',
	canonical: 'https://site.test/',
	host: 'site.test',
	title: 'Site',
	description: 'A site',
	siteName: null,
	themeColor: null,
	image: null,
	icon: null,
	lang: 'en',
	words: 120,
	linkCounts: { internal: 1, external: 1 },
	sections: [
		{ id: 'intro', level: 1, heading: 'Intro', summary: 's', words: 100, paragraphs: 4, codeBlocks: 1, links: [{ href: 'https://site.test/a', text: 'a', internal: true }], images: [{ src: 'https://site.test/i.png', alt: 'i' }] },
		{ id: 'more', level: 2, heading: 'More', summary: 's', words: 20, paragraphs: 1, codeBlocks: 0, links: [], images: [] },
	],
	...over,
});

describe('buildWorld', () => {
	it('builds one district and one building per section', () => {
		const w = buildWorld(outline());
		expect(w.version).toBe(WORLD_VERSION);
		expect(w.buildings).toHaveLength(2);
		expect(w.districts).toHaveLength(2);
		expect(w.buildings[0].sectionId).toBe('intro');
	});

	it('is deterministic for the same page', () => {
		expect(JSON.stringify(buildWorld(outline()))).toBe(JSON.stringify(buildWorld(outline())));
	});

	it('gives different sites different cities', () => {
		const a = buildWorld(outline());
		const b = buildWorld(outline({ canonical: 'https://other.test/', host: 'other.test' }));
		expect(a.meta.seed).not.toBe(b.meta.seed);
	});

	it('sizes buildings by what a section says, on a log scale', () => {
		const w = buildWorld(outline());
		const [intro, more] = w.buildings;
		expect(intro.h).toBeGreaterThan(more.h);
		// 5x the words must not mean 5x the height, or one essay dwarfs a city.
		expect(intro.h / more.h).toBeLessThan(3);
		expect(intro.h).toBeLessThanOrEqual(METRICS.maxHeight);
		expect(more.h).toBeGreaterThanOrEqual(METRICS.minHeight);
	});

	it('turns links into doors and images into billboards', () => {
		const w = buildWorld(outline());
		expect(w.doors).toHaveLength(1);
		expect(w.doors[0]).toMatchObject({ href: 'https://site.test/a', internal: true, buildingId: 'b-intro' });
		expect(w.props.filter((p) => p.kind === 'billboard')).toHaveLength(1);
		expect(w.props.filter((p) => p.kind === 'monolith')).toHaveLength(1);
	});

	it('keeps every building inside the ground it draws', () => {
		const many = Array.from({ length: 24 }, (_, i) => ({
			id: `s${i}`, level: 2, heading: `S${i}`, summary: '', words: 50 + i * 40, paragraphs: 3, codeBlocks: 0, links: [], images: [],
		}));
		const w = buildWorld(outline({ sections: many }));
		for (const b of w.buildings) {
			expect(Math.hypot(b.x, b.z) + Math.max(b.w, b.d) / 2).toBeLessThan(w.ground.radius);
		}
	});

	it('never overlaps two districts', () => {
		const many = Array.from({ length: 24 }, (_, i) => ({
			id: `s${i}`, level: 2, heading: `S${i}`, summary: '', words: 900, paragraphs: 12, codeBlocks: 0, links: [], images: [],
		}));
		const w = buildWorld(outline({ sections: many }));
		for (let i = 0; i < w.buildings.length; i++) {
			for (let j = i + 1; j < w.buildings.length; j++) {
				const a = w.buildings[i];
				const b = w.buildings[j];
				const gap = Math.hypot(a.x - b.x, a.z - b.z);
				const halves = Math.max(a.w, a.d) / 2 + Math.max(b.w, b.d) / 2;
				expect(gap).toBeGreaterThan(halves);
			}
		}
	});

	it('spawns the visitor on open ground, not inside anything', () => {
		const w = buildWorld(outline());
		for (const c of collidersFor(w)) {
			expect(Math.hypot(w.spawn.x - c.x, w.spawn.z - c.z)).toBeGreaterThan(c.r);
		}
	});

	it('refuses an input that is not an outline', () => {
		expect(() => buildWorld(null)).toThrow(TypeError);
		expect(() => buildWorld({})).toThrow(TypeError);
	});

	it('handles a page with a single empty section', () => {
		const w = buildWorld(outline({ sections: [{ id: 'only', level: 1, heading: 'Only', summary: '', words: 0, paragraphs: 0, codeBlocks: 0, links: [], images: [] }] }));
		expect(w.buildings).toHaveLength(1);
		expect(w.doors).toHaveLength(0);
		expect(w.ground.radius).toBeGreaterThan(METRICS.plazaRadius);
	});
});

describe('palette', () => {
	it('uses the page theme colour when it has one', () => {
		const w = buildWorld(outline({ themeColor: '#3366ff' }));
		expect(hexToHsl(w.palette.primary).h).toBeCloseTo(hexToHsl('#3366ff').h, 0);
	});

	it('falls back to a stable hue per host', () => {
		expect(paletteFor(outline()).primary).toBe(paletteFor(outline()).primary);
		expect(paletteFor(outline()).primary).not.toBe(paletteFor(outline({ host: 'zzz.test' })).primary);
	});

	it('round-trips hsl and hex', () => {
		const hex = hslToHex(210, 60, 50);
		const hsl = hexToHsl(hex);
		expect(hsl.h).toBeCloseTo(210, 0);
		expect(hsl.s).toBeCloseTo(60, 0);
	});
});

describe('primitives', () => {
	it('hashes and seeds deterministically', () => {
		expect(hashSeed('abc')).toBe(hashSeed('abc'));
		const a = seededRandom(42);
		const b = seededRandom(42);
		expect([a(), a(), a()]).toEqual([b(), b(), b()]);
	});

	it('spreads districts outward without repeating a position', () => {
		const seen = new Set();
		for (let i = 0; i < 24; i++) {
			const p = districtPosition(i);
			seen.add(`${p.x},${p.z}`);
		}
		expect(seen.size).toBe(24);
	});

	it('puts a door on a building wall, never inside it', () => {
		const b = { x: 0, z: 0, w: 6, d: 4, rot: 0 };
		for (let i = 0; i < 6; i++) {
			const slot = doorSlot(b, i, 6);
			const inside = Math.abs(slot.x) < b.w / 2 - 0.01 && Math.abs(slot.z) < b.d / 2 - 0.01;
			expect(inside).toBe(false);
		}
	});
});
