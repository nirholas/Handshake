// The shared catalog bar: api/_lib/seed-mesh-gate.js.
//
// This module is unusual in that it has two consumers with opposite constraints:
// the seeding cron runs it on Cloud Run, and the public inspector at /inspect
// runs it inside a visitor's browser. The whole value of sharing it is that a
// creator's verdict cannot disagree with the catalog's verdict, so the tests
// here defend the two properties that would silently destroy that:
//
//   1. It stays browser-safe. One `node:` import, or one bare `process` /
//      `Buffer` read, and the inspector dies at runtime while every server-side
//      test stays green.
//   2. The explain layer stays complete. A new reason code with no guidance
//      renders as a blank card, so the rule table is checked against the reasons
//      the gate can actually emit, read out of the source rather than restated.
//
// Fixtures are REAL binary glTF 2.0, built the way tests/seed-quality.test.js
// and tests/glb-quality.test.js build them.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	gateMesh,
	explainMeshGate,
	MESH_GATE_RULES,
	SEED_MESH_BOUNDS,
	SEED_GATE_VERSION,
} from '../api/_lib/seed-mesh-gate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function buildGlb(gltf, { binBytes = 0 } = {}) {
	const json = Buffer.from(JSON.stringify(gltf), 'utf8');
	const jsonPad = (4 - (json.length % 4)) % 4;
	const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
	const binPad = (4 - (binBytes % 4)) % 4;
	const binChunk = binBytes ? Buffer.alloc(binBytes + binPad, 0) : Buffer.alloc(0);

	const total = 12 + (8 + jsonChunk.length) + (binBytes ? 8 + binChunk.length : 0);
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

function healthyGltf({ verts = 12_000, meshes = 1, textured = true, bbox = [-1, 1] } = {}) {
	const tris = verts * 2;
	const accessors = [
		{ componentType: 5126, count: verts, type: 'VEC3', min: [bbox[0], bbox[0], bbox[0]], max: [bbox[1], bbox[1], bbox[1]] },
		{ componentType: 5125, count: tris * 3, type: 'SCALAR' },
	];
	const primitive = { attributes: { POSITION: 0 }, indices: 1, mode: 4, ...(textured ? { material: 0 } : {}) };
	return {
		asset: { version: '2.0', generator: 'TRELLIS' },
		accessors,
		meshes: Array.from({ length: meshes }, () => ({ primitives: [primitive] })),
		...(textured
			? {
					materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
					textures: [{ source: 0 }],
					images: [{ mimeType: 'image/png', bufferView: 0 }],
				}
			: { materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }] }),
		nodes: Array.from({ length: meshes }, (_, i) => ({ mesh: i })),
	};
}

const healthy = (opts, glbOpts = { binBytes: 400_000 }) => buildGlb(healthyGltf(opts), glbOpts);

// ── 1. Browser safety ────────────────────────────────────────────────────────

describe('stays runnable in a browser', () => {
	// The gate and everything it reaches. `npm run check:browser-graph` walks the
	// real bundler graph from the HTML entries and would also catch a leak here,
	// but only at build time, and only once the page is wired into an entry.
	// Asserting it at the module level fails the moment the import is added.
	const CHAIN = ['api/_lib/seed-mesh-gate.js', 'api/_lib/glb-quality.js', 'api/_lib/glb-inspect.js'];

	const sourceOf = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

	it.each(CHAIN)('%s imports no Node built-in', (rel) => {
		const src = sourceOf(rel);
		const specifiers = [...src.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
		const builtins = specifiers.filter((s) => s.startsWith('node:'));
		expect(builtins, `${rel} must not import Node built-ins`).toEqual([]);
	});

	it.each(CHAIN)('%s never reads a bare process/Buffer identifier', (rel) => {
		// A browser has no binding for either, and `process?.env` still throws a
		// ReferenceError when `process` was never declared: optional chaining
		// guards a null VALUE, not an undeclared NAME. Only `typeof` is safe.
		//
		// This is a static early-warning, not the proof: the authoritative check is
		// the globals-deleted run below. Scope analysis is out of scope for a regex,
		// so a read counts as guarded when a `typeof <name>` appears close enough
		// above it to be the same function. That covers both real forms in the
		// chain (`typeof x !== 'undefined' ? …` and an early-return guard) while
		// still failing on a fresh unguarded read somewhere new.
		const src = sourceOf(rel)
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:])\/\/.*$/gm, '$1');
		for (const name of ['process', 'Buffer']) {
			for (const m of src.matchAll(new RegExp(`\\b${name}\\b\\s*[?.]`, 'g'))) {
				const before = src.slice(Math.max(0, m.index - 220), m.index);
				expect(
					new RegExp(`typeof\\s+${name}\\b`).test(before),
					`${rel} reads \`${name}\` without a typeof guard near: ${src.slice(Math.max(0, m.index - 60), m.index + 40)}`,
				).toBe(true);
			}
		}
	});

	it('produces a verdict with process and Buffer deleted from globalThis', async () => {
		// The strongest available proof short of a real browser: run the gate with
		// both globals genuinely absent.
		const bytes = new Uint8Array(healthy());
		const realProcess = globalThis.process;
		const realBuffer = globalThis.Buffer;
		// @ts-expect-error deliberately removing a global for the duration
		delete globalThis.process;
		// @ts-expect-error deliberately removing a global for the duration
		delete globalThis.Buffer;
		try {
			const report = explainMeshGate(gateMesh(bytes, { category: 'avatar' }), { category: 'avatar' });
			expect(report.pass).toBe(true);
			expect(report.checks.length).toBeGreaterThan(0);
		} finally {
			globalThis.process = realProcess;
			globalThis.Buffer = realBuffer;
		}
	});

	it('accepts a Uint8Array, which is all a browser can produce from a File', () => {
		const buf = healthy();
		expect(gateMesh(new Uint8Array(buf), { category: 'avatar' }).pass).toBe(true);
	});
});

// ── 2. The explain layer cannot drift from the gate ──────────────────────────

describe('explain layer covers the gate', () => {
	it('has guidance for every reason code the gate can emit', () => {
		// Read the reasons out of the source rather than restating them here: a
		// restated list drifts silently, a derived one fails the moment a new
		// `reasons.push('…')` lands without a rule beside it.
		const src = readFileSync(resolve(ROOT, 'api/_lib/seed-mesh-gate.js'), 'utf8');
		const emitted = new Set(
			[...src.matchAll(/reasons\.push\(\s*'([a-z_]+)'\s*\)/g)].map((m) => m[1]).concat('not_valid_glb'),
		);
		expect(emitted.size).toBeGreaterThan(5);
		for (const reason of emitted) {
			expect(MESH_GATE_RULES, `no guidance for reason "${reason}"`).toHaveProperty(reason);
		}
	});

	it('gives every rule a label, a why and a fix', () => {
		for (const [id, rule] of Object.entries(MESH_GATE_RULES)) {
			expect(rule.label, `${id}.label`).toBeTruthy();
			expect(rule.why.length, `${id}.why`).toBeGreaterThan(20);
			expect(rule.fix.length, `${id}.fix`).toBeGreaterThan(20);
		}
	});

	it('never renders a check without a bound and a measurement', () => {
		const report = explainMeshGate(gateMesh(healthy(), { category: 'avatar' }), { category: 'avatar' });
		for (const c of report.checks) {
			expect(c.actual, c.id).toBeTruthy();
			expect(c.bound, c.id).toBeTruthy();
			expect(['pass', 'fail', 'skipped']).toContain(c.status);
		}
	});

	it('marks exactly the failed reasons as fail and nothing else', () => {
		const verdict = gateMesh(healthy({ verts: 300, textured: false }), { category: 'avatar' });
		const report = explainMeshGate(verdict, { category: 'avatar' });
		const failed = report.checks.filter((c) => c.status === 'fail').map((c) => c.id).sort();
		expect(failed).toEqual([...verdict.reasons].sort());
	});
});

// ── 3. The verdict a person reads ────────────────────────────────────────────

describe('explainMeshGate', () => {
	it('reports headroom on a pass, not just a boolean', () => {
		const report = explainMeshGate(gateMesh(healthy({ verts: 12_000 }), { category: 'avatar' }), { category: 'avatar' });
		expect(report.pass).toBe(true);
		expect(report.headline).toBe('Clears the catalog bar');
		const density = report.checks.find((c) => c.id === 'vertex_count');
		expect(density.actual).toBe('12,000 vertices');
		expect(density.bound).toBe(
			`${SEED_MESH_BOUNDS.minVertices.toLocaleString('en-US')} to ${SEED_MESH_BOUNDS.maxVertices.toLocaleString('en-US')}`,
		);
	});

	it('collapses a floor/ceiling pair into one row instead of two identical ones', () => {
		// Vertex count is one measurement. Showing it twice (once against the floor,
		// once against the ceiling) put the same number on screen twice.
		const report = explainMeshGate(gateMesh(healthy(), { category: 'avatar' }), { category: 'avatar' });
		const labels = report.checks.map((c) => c.label);
		expect(new Set(labels).size, `duplicate rows: ${labels.join(', ')}`).toBe(labels.length);
	});

	it('adopts the breached end of a range, and only that end', () => {
		const thin = explainMeshGate(gateMesh(healthy({ verts: 300 }), {}), {});
		const row = thin.checks.find((c) => c.label === 'Geometry density');
		expect(row.id).toBe('vertices_below_floor');
		expect(row.status).toBe('fail');
		expect(row.bound).toBe(`at least ${SEED_MESH_BOUNDS.minVertices.toLocaleString('en-US')}`);
	});

	it('stamps the gate version so a verdict is comparable only within one', () => {
		const report = explainMeshGate(gateMesh(healthy(), {}), {});
		expect(report.gateVersion).toBe(SEED_GATE_VERSION);
	});

	it('reports only the parse failure when the file is not a GLB, claiming nothing else', () => {
		// Every other measurement is meaningless once parsing failed. Listing the
		// remaining checks as passed would be a lie by omission.
		const report = explainMeshGate(gateMesh(Buffer.from('this is a PNG, actually'), {}), {});
		expect(report.pass).toBe(false);
		expect(report.checks).toHaveLength(1);
		expect(report.checks[0].id).toBe('not_valid_glb');
		expect(report.headline).toBe('Not a readable .glb');
	});

	it('counts the failures in the headline', () => {
		const report = explainMeshGate(
			gateMesh(healthy({ verts: 300, textured: false }), { category: 'avatar' }),
			{ category: 'avatar' },
		);
		const failures = report.checks.filter((c) => c.status === 'fail').length;
		expect(report.headline).toBe(`${failures} checks short of the catalog bar`);
	});

	it('says "1 check" rather than "1 checks"', () => {
		const report = explainMeshGate(gateMesh(healthy({ textured: false }), { category: 'avatar' }), { category: 'avatar' });
		expect(report.headline).toBe('1 check short of the catalog bar');
	});

	it('skips the character-only mesh rule for a prop rather than passing it', () => {
		// "Skipped" and "passed" are different claims. A prop with 22 meshes did
		// not satisfy the rule, the rule did not apply.
		const bytes = healthy({ meshes: 22 });
		const avatar = explainMeshGate(gateMesh(bytes, { category: 'avatar' }), { category: 'avatar' });
		const prop = explainMeshGate(gateMesh(bytes, { category: 'accessory' }), { category: 'accessory' });

		expect(avatar.checks.find((c) => c.id === 'too_many_meshes_for_a_character').status).toBe('fail');
		expect(prop.checks.find((c) => c.id === 'too_many_meshes_for_a_character').status).toBe('skipped');
		expect(avatar.pass).toBe(false);
		expect(prop.pass).toBe(true);
	});

	it('formats bytes and counts for a human, not in raw units', () => {
		const report = explainMeshGate(gateMesh(healthy({}, { binBytes: 2_500_000 }), {}), {});
		const size = report.checks.find((c) => c.id === 'file_weight');
		expect(size.actual).toMatch(/^2\.\d MB$/);
		expect(size.bound).toBe('20 KB to 80.0 MB');
	});

	it('reports the bounding box at a precision that reads, without implying a unit', () => {
		// Submissions arrive in metres and in centimetres, so a raw float like
		// 88387.306 is noise on a check that only asks "does it have extent".
		const big = explainMeshGate(gateMesh(healthy({ bbox: [-50_000, 50_000] }), {}), {});
		expect(big.checks.find((c) => c.id === 'zero_volume').actual).toMatch(/^[\d,]+ units across$/);

		const small = explainMeshGate(gateMesh(healthy({ bbox: [-1, 1] }), {}), {});
		expect(small.checks.find((c) => c.id === 'zero_volume').actual).toBe('3.46 units across');
	});

	it('says a collapsed box is collapsed rather than printing 0.000', () => {
		const report = explainMeshGate(gateMesh(healthy({ bbox: [0, 0] }), {}), {});
		const row = report.checks.find((c) => c.id === 'zero_volume');
		expect(row.status).toBe('fail');
		expect(row.actual).toBe('collapsed to a point');
	});

	it('names the failing checks in the summary so the reason is visible unopened', () => {
		const report = explainMeshGate(gateMesh(healthy({ textured: false }), {}), {});
		expect(report.summary).toContain('Surface texture');
	});
});

// ── 4. Against the real library ──────────────────────────────────────────────

describe('the models this site actually serves', () => {
	// The /inspect page ships these as its samples. If a preset's verdict changes,
	// the page starts teaching the wrong lesson, so the presets are pinned here.
	const read = (name) => readFileSync(resolve(ROOT, 'public/avatars', name));

	it('michelle.glb clears the bar (the page presents it as a clean pass)', () => {
		const v = gateMesh(read('michelle.glb'), { category: 'avatar' });
		expect(v.pass).toBe(true);
		expect(v.rigged).toBe(true);
	});

	it('fox.glb clears the bar close to the density floor', () => {
		const v = gateMesh(read('fox.glb'), { category: 'avatar' });
		expect(v.pass).toBe(true);
		expect(v.metrics.vertexCount).toBeGreaterThanOrEqual(SEED_MESH_BOUNDS.minVertices);
		expect(v.metrics.vertexCount).toBeLessThan(SEED_MESH_BOUNDS.minVertices * 2);
	});

	it('xbot.glb fails on texture alone', () => {
		expect(gateMesh(read('xbot.glb'), { category: 'avatar' }).reasons).toEqual(['no_textures']);
	});

	it('mannequin.glb fails two rules, one of which a prop would not be held to', () => {
		const asAvatar = gateMesh(read('mannequin.glb'), { category: 'avatar' });
		expect([...asAvatar.reasons].sort()).toEqual(['no_textures', 'too_many_meshes_for_a_character']);
		expect(gateMesh(read('mannequin.glb'), { category: 'accessory' }).reasons).toEqual(['no_textures']);
	});
});
