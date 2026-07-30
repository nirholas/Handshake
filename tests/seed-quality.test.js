// The catalog quality gate: the code that decides whether a platform-generated
// asset is allowed into the public catalog at /characters and /objects.
//
// It shipped wired into api/cron/forge-seed-cron.js and running in production
// with no tests, which is a bad place to have none: every rejection is content a
// visitor never sees, and every false accept is a blob on the storefront. The
// module is deliberately built so the decisions are pure (its own words: "unit
// testable without a GPU, a browser, or a model"), so there is no excuse.
//
// Fixtures are REAL binary glTF 2.0, built the same way tests/glb-quality.test.js
// builds them, not mocks: the gate reads accessor counts, POSITION bounds and
// material/texture presence straight out of the JSON chunk, so a hand-built GLB
// exercises the actual code path. Only the vision transport is substituted, and
// only because the alternative is calling a paid model from a unit test.

import { describe, it, expect } from 'vitest';
import {
	gateMesh,
	decideVisionVerdict,
	scoreMean,
	evaluateSeedAsset,
	buildRigReadinessPrompt,
	SEED_MESH_BOUNDS,
	SEED_JUDGE_THRESHOLDS,
	SEED_GATE_VERSION,
} from '../api/_lib/seed-quality.js';

// Minimal-but-valid binary glTF. The JSON chunk carries everything the gate
// reads; the BIN chunk only exists to give the file a realistic byte size.
function buildGlb(gltf, { binBytes = 0 } = {}) {
	const json = Buffer.from(JSON.stringify(gltf), 'utf8');
	const jsonPad = (4 - (json.length % 4)) % 4;
	const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
	const binPad = (4 - (binBytes % 4)) % 4;
	const binChunk = binBytes ? Buffer.alloc(binBytes + binPad, 0) : Buffer.alloc(0);

	const headerLen = 12;
	const total = headerLen + (8 + jsonChunk.length) + (binBytes ? 8 + binChunk.length : 0);
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

/** The shape a healthy Forge avatar takes: dense, indexed, textured, one mesh. */
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

const healthyGlb = (opts, glbOpts) => buildGlb(healthyGltf(opts), { binBytes: 60_000, ...glbOpts });

describe('gateMesh: the free, deterministic first stage', () => {
	it('accepts a dense, textured, single-mesh avatar', () => {
		const v = gateMesh(healthyGlb());
		expect(v.pass, `unexpected reasons: ${v.reasons.join(', ')}`).toBe(true);
		expect(v.reasons).toEqual([]);
		expect(v.metrics.vertexCount).toBe(12_000);
	});

	it('rejects bytes that are not a glTF at all, without throwing', () => {
		const v = gateMesh(Buffer.from('this is a PNG, not a mesh'));
		expect(v.pass).toBe(false);
		expect(v.reasons).toContain('not_valid_glb');
	});

	it('rejects a mesh under the vertex floor', () => {
		const v = gateMesh(healthyGlb({ verts: SEED_MESH_BOUNDS.minVertices - 1 }));
		expect(v.pass).toBe(false);
		expect(v.reasons).toContain('vertices_below_floor');
	});

	it('rejects an untextured asset while the texture requirement is on', () => {
		// Catalog content is stricter than the interactive flow on purpose: a flat
		// grey mesh is a legitimate user result but a poor storefront entry.
		expect(SEED_MESH_BOUNDS.requireTexture).toBe(true);
		const v = gateMesh(healthyGlb({ textured: false }));
		expect(v.pass).toBe(false);
		expect(v.reasons).toContain('no_textures');
	});

	it('rejects a collapsed bounding box that would render as a speck', () => {
		const v = gateMesh(healthyGlb({ bbox: [0, 0] }));
		expect(v.pass).toBe(false);
		expect(v.reasons).toContain('zero_volume');
	});

	it('rejects a scene-like pile of meshes as an avatar but allows it as an accessory', () => {
		const glb = healthyGlb({ meshes: 12 });
		expect(gateMesh(glb, { category: 'avatar' }).reasons).toContain('too_many_meshes_for_a_character');
		// A prop may legitimately be a loose collection of parts.
		expect(gateMesh(glb, { category: 'accessory' }).reasons).not.toContain('too_many_meshes_for_a_character');
	});

	it('rejects a file below the byte floor even when the mesh JSON looks fine', () => {
		const v = gateMesh(buildGlb(healthyGltf(), { binBytes: 0 }));
		expect(v.pass).toBe(false);
		expect(v.reasons).toContain('file_too_small');
	});

	it('collects every failure at once rather than stopping at the first', () => {
		// One pass over the asset should tell a tuner everything that is wrong.
		const v = gateMesh(buildGlb(healthyGltf({ verts: 10, textured: false }), { binBytes: 0 }));
		expect(v.pass).toBe(false);
		expect(v.reasons).toEqual(expect.arrayContaining(['vertices_below_floor', 'no_textures', 'file_too_small']));
	});
});

describe('decideVisionVerdict: the judge replies turned into a decision', () => {
	const goodRealism = { photorealism: 7, geometryIntegrity: 7, textureFidelity: 7, promptAdherence: 7 };
	const goodRig = { subjectPresent: true, singleSubject: true, complete: true, limbsSeparated: true, blob: false };

	it('accepts a clean pair of replies', () => {
		const v = decideVisionVerdict({ realism: goodRealism, rigReadiness: goodRig, category: 'avatar' });
		expect(v.pass).toBe(true);
		expect(v.reasons).toEqual([]);
		expect(v.mean).toBe(7);
	});

	it.each([
		['blob', { blob: true }, 'vision_blob'],
		['a missing subject', { subjectPresent: false }, 'vision_subject_missing'],
		['a crowd', { singleSubject: false }, 'vision_multiple_subjects'],
		['a bust', { complete: false }, 'vision_incomplete_body'],
		['fused limbs', { limbsSeparated: false }, 'vision_fused_limbs'],
	])('rejects %s', (_label, patch, reason) => {
		const v = decideVisionVerdict({ realism: goodRealism, rigReadiness: { ...goodRig, ...patch }, category: 'avatar' });
		expect(v.pass).toBe(false);
		expect(v.reasons).toContain(reason);
	});

	it('does not apply the separated-limbs rule to an accessory', () => {
		// A sword has no limbs; failing it for fused ones would reject every prop.
		const rig = { ...goodRig, limbsSeparated: false };
		expect(decideVisionVerdict({ realism: goodRealism, rigReadiness: rig, category: 'accessory' }).reasons).not.toContain(
			'vision_fused_limbs',
		);
	});

	it('rejects below each score floor, naming which floor failed', () => {
		const t = SEED_JUDGE_THRESHOLDS;
		const geo = decideVisionVerdict({
			realism: { ...goodRealism, geometryIntegrity: t.minGeometryIntegrity - 1 },
			rigReadiness: goodRig,
			category: 'avatar',
		});
		expect(geo.reasons).toContain('geometry_below_floor');

		const adherence = decideVisionVerdict({
			realism: { ...goodRealism, promptAdherence: t.minPromptAdherence - 1 },
			rigReadiness: goodRig,
			category: 'avatar',
		});
		expect(adherence.reasons).toContain('prompt_adherence_below_floor');

		// Sits exactly ON the geometry and adherence floors, so the mean is the only
		// thing that can fail: an asset can be structurally sound and prompt-faithful
		// and still be too poor overall to earn a catalog slot.
		const low = { photorealism: 1, geometryIntegrity: t.minGeometryIntegrity, textureFidelity: 1, promptAdherence: t.minPromptAdherence };
		const mean = decideVisionVerdict({ realism: low, rigReadiness: goodRig, category: 'avatar' });
		expect(scoreMean(low)).toBeLessThan(t.minMean);
		expect(mean.reasons).toEqual(['mean_score_below_floor']);
	});

	it('passes when neither reply arrived, so a silent judge cannot reject content', () => {
		// The caller decides what an unavailable judge means; this function must not
		// invent a rejection out of missing data.
		const v = decideVisionVerdict({ realism: null, rigReadiness: null, category: 'avatar' });
		expect(v.pass).toBe(true);
		expect(v.mean).toBeNull();
	});
});

describe('scoreMean', () => {
	it('averages the four judged dimensions', () => {
		expect(scoreMean({ photorealism: 8, geometryIntegrity: 6, textureFidelity: 4, promptAdherence: 2 })).toBe(5);
	});

	it('treats a missing dimension as zero rather than NaN', () => {
		expect(scoreMean({ photorealism: 8 })).toBe(2);
		expect(scoreMean(null)).toBe(0);
	});
});

describe('evaluateSeedAsset: mesh fails closed, vision fails soft', () => {
	const okTransport = (overrides = {}) => ({
		name: 'test',
		render: async () => Buffer.from('png'),
		judgeRealism: async () => ({ photorealism: 8, geometryIntegrity: 8, textureFidelity: 8, promptAdherence: 8 }),
		judgeRigReadiness: async () => ({
			subjectPresent: true, singleSubject: true, complete: true, limbsSeparated: true, blob: false,
		}),
		...overrides,
	});

	it('never renders or judges an asset the mesh stage already rejected', async () => {
		let rendered = false;
		const v = await evaluateSeedAsset({
			glbBuffer: Buffer.from('not a glb'),
			glbUrl: 'https://cdn.example/a.glb',
			prompt: 'a knight',
			transport: okTransport({ render: async () => { rendered = true; return Buffer.from('png'); } }),
		});
		expect(v.accepted).toBe(false);
		// The whole point of ordering the stages: a blob must not cost a model call.
		expect(rendered).toBe(false);
		expect(v.vision.status).toBe('skipped');
		expect(v.gateVersion).toBe(SEED_GATE_VERSION);
	});

	it('accepts a clean asset through both stages', async () => {
		const v = await evaluateSeedAsset({
			glbBuffer: healthyGlb(),
			glbUrl: 'https://cdn.example/a.glb',
			prompt: 'a knight in plate armour',
			transport: okTransport(),
		});
		expect(v.accepted).toBe(true);
		expect(v.vision.status).toBe('judged');
		expect(v.vision.mean).toBe(8);
		expect(v.transport).toBe('test');
	});

	it('publishes a mesh-clean asset when the judge is unreachable, and says so', async () => {
		// An infrastructure outage must never be recorded as a quality rejection,
		// or the accept-rate statistics quietly become fiction.
		const v = await evaluateSeedAsset({
			glbBuffer: healthyGlb(),
			glbUrl: 'https://cdn.example/a.glb',
			prompt: 'a knight',
			transport: okTransport({ render: async () => { throw new Error('vertex 429 quota'); } }),
		});
		expect(v.accepted).toBe(true);
		expect(v.vision.status).toBe('unavailable');
		expect(v.vision.error).toMatch(/vertex 429 quota/);
		expect(v.reasons).toEqual([]);
	});

	it('marks vision unavailable when there is no public URL to render', async () => {
		const v = await evaluateSeedAsset({
			glbBuffer: healthyGlb(),
			glbUrl: null,
			prompt: 'a knight',
			transport: okTransport(),
		});
		expect(v.accepted).toBe(true);
		expect(v.vision.status).toBe('unavailable');
		expect(v.vision.error).toMatch(/no public glb url/);
	});

	it('runs mesh-only with no transport at all (the cron default)', async () => {
		const v = await evaluateSeedAsset({ glbBuffer: healthyGlb(), prompt: 'a knight' });
		expect(v.accepted).toBe(true);
		expect(v.vision.status).toBe('skipped');
		expect(v.transport).toBeNull();
	});

	it('rejects on the vision verdict and reports the reason', async () => {
		const v = await evaluateSeedAsset({
			glbBuffer: healthyGlb(),
			glbUrl: 'https://cdn.example/a.glb',
			prompt: 'a knight',
			transport: okTransport({
				judgeRigReadiness: async () => ({
					subjectPresent: true, singleSubject: true, complete: false, limbsSeparated: true, blob: false,
				}),
			}),
		});
		expect(v.accepted).toBe(false);
		expect(v.reasons).toContain('vision_incomplete_body');
		expect(v.mesh.pass).toBe(true);
	});
});

describe('buildRigReadinessPrompt', () => {
	it('asks for a whole humanoid for an avatar', () => {
		const p = buildRigReadinessPrompt({ prompt: 'a knight', category: 'avatar' });
		expect(p).toMatch(/exactly one complete humanoid character/);
		expect(p).toMatch(/a knight/);
		expect(p).toMatch(/ONLY a JSON object/);
	});

	it('asks for an object, not a character, for an accessory', () => {
		const p = buildRigReadinessPrompt({ prompt: 'a bronze sword', category: 'accessory' });
		expect(p).toMatch(/NOT a character/);
	});
});
