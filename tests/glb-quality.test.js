import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	scoreGlbQuality,
	shouldRetryForQuality,
	shouldEscalateToVisionQA,
	QUALITY_THRESHOLDS,
} from '../api/_lib/glb-quality.js';

// Build a minimal-but-valid binary glTF 2.0 from a JS glTF object. We only need
// the JSON chunk to be well-formed — the quality scorer reads accessor counts and
// POSITION bounds from JSON and never decodes the BIN chunk — so an empty BIN
// chunk is sufficient and keeps the fixtures tiny and deterministic.
function buildGlb(gltf, { binBytes = 0 } = {}) {
	const json = Buffer.from(JSON.stringify(gltf), 'utf8');
	const jsonPad = (4 - (json.length % 4)) % 4;
	const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
	const binPad = (4 - (binBytes % 4)) % 4;
	const binChunk = binBytes ? Buffer.alloc(binBytes + binPad, 0) : Buffer.alloc(0);

	const headerLen = 12;
	const jsonHeader = 8 + jsonChunk.length;
	const binHeader = binBytes ? 8 + binChunk.length : 0;
	const total = headerLen + jsonHeader + binHeader;

	const out = Buffer.alloc(total);
	out.writeUInt32LE(0x46546c67, 0); // 'glTF'
	out.writeUInt32LE(2, 4);
	out.writeUInt32LE(total, 8);
	out.writeUInt32LE(jsonChunk.length, 12);
	out.writeUInt32LE(0x4e4f534a, 16); // 'JSON'
	jsonChunk.copy(out, 20);
	if (binBytes) {
		const off = 20 + jsonChunk.length;
		out.writeUInt32LE(binChunk.length, off);
		out.writeUInt32LE(0x004e4942, off + 4); // 'BIN\0'
		binChunk.copy(out, off + 8);
	}
	return out;
}

// A dense, textured, indexed mesh: the shape a healthy Forge output takes.
function healthyGltf() {
	const TRIS = 20_000;
	const VERTS = Math.round(TRIS / 2); // manifold-ish V≈T/2
	return {
		asset: { version: '2.0', generator: 'TRELLIS' },
		accessors: [
			{ componentType: 5126, count: VERTS, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] },
			{ componentType: 5125, count: TRIS * 3, type: 'SCALAR' },
		],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }] }],
		materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
		textures: [{ source: 0 }],
		images: [{ mimeType: 'image/png', bufferView: 0 }],
		nodes: [{ mesh: 0 }],
	};
}

describe('scoreGlbQuality', () => {
	it('scores a dense, textured, indexed mesh as ok with a high score', () => {
		const q = scoreGlbQuality(buildGlb(healthyGltf()));
		expect(q.valid).toBe(true);
		expect(q.flag).toBe('ok');
		expect(q.reasons).toEqual([]);
		expect(q.score).toBeGreaterThan(0.7);
		expect(q.metrics.triangleCount).toBe(20_000);
		expect(q.metrics.hasTextures).toBe(true);
		expect(q.metrics.watertightish).toBe(true);
		expect(shouldRetryForQuality(q)).toBe(false);
	});

	it('flags an empty / no-geometry mesh as degenerate', () => {
		const gltf = healthyGltf();
		gltf.meshes = [];
		const q = scoreGlbQuality(buildGlb(gltf));
		expect(q.flag).toBe('degenerate');
		expect(q.reasons).toContain('no_geometry');
		expect(q.score).toBeLessThanOrEqual(0.1);
		expect(shouldRetryForQuality(q)).toBe(true);
	});

	it('flags a zero-volume (collapsed bbox) mesh as degenerate', () => {
		const gltf = healthyGltf();
		gltf.accessors[0].min = [0, 0, 0];
		gltf.accessors[0].max = [0, 0, 0];
		const q = scoreGlbQuality(buildGlb(gltf));
		expect(q.flag).toBe('degenerate');
		expect(q.reasons).toContain('zero_volume');
		expect(shouldRetryForQuality(q)).toBe(true);
	});

	it('flags a sub-threshold triangle count as degenerate', () => {
		const gltf = healthyGltf();
		const tris = Math.max(1, QUALITY_THRESHOLDS.degenerateTriangles - 10);
		gltf.accessors[0].count = tris * 2;
		gltf.accessors[1].count = tris * 3;
		const q = scoreGlbQuality(buildGlb(gltf));
		expect(q.flag).toBe('degenerate');
		expect(q.reasons).toContain('too_few_triangles');
	});

	it('flags a low-poly mesh as low (renders, but coarse)', () => {
		const gltf = healthyGltf();
		const tris = 300; // above degenerate, below lowTriangles
		gltf.accessors[0].count = Math.round(tris / 2);
		gltf.accessors[1].count = tris * 3;
		const q = scoreGlbQuality(buildGlb(gltf));
		expect(q.flag).toBe('low');
		expect(q.reasons).toContain('low_poly');
		expect(q.score).toBeLessThanOrEqual(0.55);
	});

	it('flags a textureless mesh', () => {
		const gltf = healthyGltf();
		delete gltf.materials;
		delete gltf.textures;
		delete gltf.images;
		const q = scoreGlbQuality(buildGlb(gltf));
		expect(q.metrics.hasTextures).toBe(false);
		expect(q.reasons).toContain('no_materials');
	});

	it('returns invalid (never throws) on a non-GLB buffer', () => {
		const q = scoreGlbQuality(Buffer.from('not a glb at all'));
		expect(q.valid).toBe(false);
		expect(q.flag).toBe('invalid');
		expect(q.score).toBe(0);
		expect(shouldRetryForQuality(q)).toBe(true);
	});

	it('handles null/empty input without throwing', () => {
		expect(() => scoreGlbQuality(null)).not.toThrow();
		expect(scoreGlbQuality(Buffer.alloc(0)).flag).toBe('invalid');
	});

	// Real bundled GLBs must all score valid and non-degenerate — they are shipped
	// production assets, so a degenerate verdict here would mean a scorer bug.
	const avatar = (name) => resolve(process.cwd(), 'public/avatars', name);
	for (const name of ['cesium-man.glb', 'fox.glb', 'mannequin.glb']) {
		const path = avatar(name);
		it.runIf(existsSync(path))(`real asset ${name} scores valid and not degenerate`, () => {
			const q = scoreGlbQuality(readFileSync(path));
			expect(q.valid).toBe(true);
			expect(q.flag).not.toBe('degenerate');
			expect(q.metrics.triangleCount).toBeGreaterThan(0);
		});
	}
});

// The adaptive-gate decision that lets the FREE lanes gain a semantic quality
// floor: a confidently-good cheap score is trusted (skip the costly vision pass),
// everything ambiguous escalates. This is the gate that closes the "valid mesh
// that still looks wrong" hole on the default draft lane.
describe('shouldEscalateToVisionQA', () => {
	it('does NOT escalate a confidently-good mesh (clean, textured, high score)', () => {
		const q = scoreGlbQuality(buildGlb(healthyGltf()));
		expect(q.flag).toBe('ok');
		expect(q.score).toBeGreaterThan(0.6);
		expect(shouldEscalateToVisionQA(q)).toBe(false);
	});

	it('escalates a low-poly (coarse) mesh even though it renders', () => {
		const gltf = healthyGltf();
		gltf.accessors[0].count = 150;
		gltf.accessors[1].count = 300 * 3;
		const q = scoreGlbQuality(buildGlb(gltf));
		expect(q.flag).toBe('low');
		expect(shouldEscalateToVisionQA(q)).toBe(true);
	});

	it('escalates a slab: dense and textured, but with no depth in Y', () => {
		// The failure this exists for. An image-to-3D reconstruction that loses its
		// conditioning returns a full-footprint relief: 30k triangles, PBR textures,
		// a healthy bounding-box diagonal, and a 0.976 score. Every signal the cheap
		// scorer has says "trust me", so only flatness can withhold that trust.
		const gltf = healthyGltf();
		gltf.accessors[0].min = [-1, -0.155, -1];
		gltf.accessors[0].max = [1, 0.155, 1];
		const q = scoreGlbQuality(buildGlb(gltf));
		expect(q.flag).toBe('ok');
		expect(q.score).toBeGreaterThan(0.6);
		expect(q.metrics.thinAxis).toBe('y');
		expect(q.metrics.planar).toBe(true);
		expect(q.reasons).toContain('planar');
		expect(shouldEscalateToVisionQA(q)).toBe(true);
	});

	it('escalates a paper-thin sliver whatever axis it is thin on', () => {
		const gltf = healthyGltf();
		gltf.accessors[0].min = [-1, -1, -0.01];
		gltf.accessors[0].max = [1, 1, 0.01];
		const q = scoreGlbQuality(buildGlb(gltf));
		expect(q.metrics.thinAxis).toBe('z');
		expect(q.metrics.planar).toBe(true);
		expect(shouldEscalateToVisionQA(q)).toBe(true);
	});

	it('does NOT flag a slim upright subject as planar', () => {
		// A standing figure is genuinely narrow front-to-back (measured 0.19 on a
		// live result). Escalating every humanoid would spend vision budget on the
		// lane's most common output, so only a Y-thin pancake trips the wider bar.
		const gltf = healthyGltf();
		gltf.accessors[0].min = [-0.31, -1, -0.19];
		gltf.accessors[0].max = [0.31, 1, 0.19];
		const q = scoreGlbQuality(buildGlb(gltf));
		expect(q.metrics.thinAxis).toBe('z');
		expect(q.metrics.planar).toBe(false);
		expect(q.reasons).not.toContain('planar');
		expect(shouldEscalateToVisionQA(q)).toBe(false);
	});

	it('escalates a degenerate / blob mesh', () => {
		const gltf = healthyGltf();
		gltf.meshes = [];
		expect(shouldEscalateToVisionQA(scoreGlbQuality(buildGlb(gltf)))).toBe(true);
	});

	it('escalates an untextured mesh', () => {
		const gltf = healthyGltf();
		delete gltf.materials;
		delete gltf.textures;
		delete gltf.images;
		const q = scoreGlbQuality(buildGlb(gltf));
		expect(q.metrics.hasTextures).toBe(false);
		expect(shouldEscalateToVisionQA(q)).toBe(true);
	});

	it('escalates an ok-but-mediocre mesh below the trust threshold', () => {
		// A well-scored ok mesh gates through only when its score clears the bar;
		// a caller-supplied stricter threshold forces the escalation.
		const q = scoreGlbQuality(buildGlb(healthyGltf()));
		expect(q.flag).toBe('ok');
		expect(shouldEscalateToVisionQA(q, { minScore: 0.99 })).toBe(true);
		expect(shouldEscalateToVisionQA(q, { minScore: 0.1 })).toBe(false);
	});

	it('escalates when there is no quality signal at all (cannot vouch)', () => {
		expect(shouldEscalateToVisionQA(null)).toBe(true);
		expect(shouldEscalateToVisionQA(undefined)).toBe(true);
		expect(shouldEscalateToVisionQA({})).toBe(true);
	});
});
