// @ts-check
// The catalog bar: stage 1 of the seed quality gate, and the ONLY part of it
// that is safe to run in a browser.
//
// Why this module exists separately from seed-quality.js
// -----------------------------------------------------
// seed-quality.js is the full two-stage gate, and it statically imports Vertex
// Gemini, the headless renderer and the R2 client. None of that can load in a
// browser. But stage 1 — the deterministic structural gate — reads nothing but
// the glTF JSON chunk, so it can run anywhere: the seeding cron, the tests, and
// the public inspector at /inspect.
//
// Splitting it out is what lets the inspector make its central promise: the
// verdict a creator sees in their own browser is produced by the SAME code that
// decides whether a platform-generated asset reaches the public catalog. Not a
// re-implementation, not an approximation of the rules, the module itself. A
// threshold change lands in both places at once because there is only one place.
//
// Two hard constraints on everything in this file, enforced mechanically by
// `npm run check:browser-graph` (it walks the real bundler graph from the HTML
// entries and fails the build the moment a `node:` built-in becomes reachable):
//
//   1. No Node built-ins, transitively. glb-quality.js and glb-inspect.js are
//      both clean, which is why the split stops here.
//   2. No bare `process` / `Buffer` identifier reads. A browser has neither, and
//      optional chaining does NOT save you: `process?.env` still throws a
//      ReferenceError when `process` was never declared. Read them through the
//      guarded helpers below.

import { scoreGlbQuality } from './glb-quality.js';
import { inspectGlb } from './glb-inspect.js';

// Bumped whenever a threshold changes, and stored on every verdict — an accept
// rate is only comparable within one gate version.
export const SEED_GATE_VERSION = 1;

// `typeof` is the only safe way to reach an identifier that may not exist.
function envRaw(name) {
	if (typeof process === 'undefined') return null;
	return process?.env?.[name] ?? null;
}

function numEnv(name, fallback) {
	const raw = envRaw(name);
	const n = raw == null || raw === '' ? NaN : Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Catalog bounds, on top of the forge-wide QUALITY_THRESHOLDS. Deliberately
// stricter than the interactive flow: a user who generates a coarse mesh chose
// to, a catalog entry nobody asked for has to earn its slot.
export const SEED_MESH_BOUNDS = Object.freeze({
	minVertices: numEnv('SEED_GATE_MIN_VERTICES', 1_500),
	maxVertices: numEnv('SEED_GATE_MAX_VERTICES', 1_500_000),
	minBytes: numEnv('SEED_GATE_MIN_BYTES', 20_000),
	// A rigged avatar with blendshapes legitimately runs tens of MB; the ceiling
	// only catches runaway output that would break the viewer's fetch budget.
	maxBytes: numEnv('SEED_GATE_MAX_BYTES', 80 * 1024 * 1024),
	requireTexture: (envRaw('SEED_GATE_REQUIRE_TEXTURE') ?? '1') !== '0',
});

/**
 * Deterministic structural gate over the GLB bytes.
 * @param {Uint8Array|ArrayBuffer|DataView} buf
 * @param {{ category?: string }} [opts]
 */
export function gateMesh(buf, { category = 'avatar' } = {}) {
	const quality = scoreGlbQuality(buf);
	const inspected = inspectGlb(buf);
	const reasons = [];
	const b = SEED_MESH_BOUNDS;

	if (!quality.valid) {
		return {
			pass: false,
			reasons: ['not_valid_glb'],
			quality,
			rigged: false,
			metrics: quality.metrics,
		};
	}
	if (quality.flag === 'degenerate') reasons.push(...quality.reasons);

	const m = quality.metrics;
	if (m.vertexCount < b.minVertices) reasons.push('vertices_below_floor');
	if (m.vertexCount > b.maxVertices) reasons.push('vertices_above_ceiling');
	if (m.sizeBytes < b.minBytes) reasons.push('file_too_small');
	if (m.sizeBytes > b.maxBytes) reasons.push('file_too_large');
	if (b.requireTexture && !m.hasTextures) reasons.push('no_textures');
	// A collapsed bounding box passes triangle counts but renders as a speck.
	if (!(m.bboxDiagonal > 0)) reasons.push('zero_volume');
	// Props may be a loose collection of parts; a catalog avatar that arrives as
	// a dozen disconnected meshes is a scene, not a character.
	if (category === 'avatar' && m.meshCount > 8) reasons.push('too_many_meshes_for_a_character');

	return {
		pass: reasons.length === 0,
		reasons,
		quality,
		rigged: Boolean(inspected?.isRigged),
		jointCount: inspected?.skeletonJointCount ?? 0,
		metrics: m,
	};
}

// ── The explain layer ────────────────────────────────────────────────────────
//
// gateMesh() returns a decision. A decision is all the cron needs, but it is
// useless to a person: `['vertices_below_floor', 'no_textures']` tells a creator
// their model was rejected without telling them what to do about it.
//
// This turns the same verdict into the checks that produced it — what was
// measured, what the bound was, why the bound exists, and the concrete next
// action. It lives beside the gate rather than in the page so the guidance
// cannot drift from the rule it describes, and so a reason code can never ship
// without an explanation (tests/seed-mesh-gate.test.js asserts exactly that).

/** Every reason code gateMesh can emit, with the guidance a creator needs. */
export const MESH_GATE_RULES = Object.freeze({
	not_valid_glb: {
		label: 'Readable glTF 2.0',
		why: 'The file is not a binary glTF. Nothing downstream can open it, so no other check can even run.',
		fix: 'Re-export as .glb (binary glTF 2.0). A .gltf + .bin pair, a .fbx or a .obj renamed to .glb will all land here.',
	},
	degenerate_triangles: {
		label: 'Renderable surface',
		why: 'There is almost no triangle geometry. This renders as nothing at all.',
		fix: 'The generation failed rather than produced a coarse result. Regenerate rather than trying to repair it.',
	},
	zero_volume: {
		label: 'Non-collapsed bounds',
		why: 'The bounding box has no extent, so the mesh draws as a single speck no matter how the camera is framed. It passes triangle counts, which is exactly why it needs its own check.',
		fix: 'Usually a failed generation. Regenerate; if it persists, check the exporter is not writing a zeroed transform.',
	},
	vertices_below_floor: {
		label: 'Geometry density',
		why: 'Too coarse to read as the thing it claims to be once it is on a storefront card next to denser models.',
		fix: 'Regenerate at a higher detail setting, or subdivide and re-bake. Raising the vertex count without adding real detail will not help how it looks.',
	},
	vertices_above_ceiling: {
		label: 'Geometry density',
		why: 'Runaway output. It will stall the viewer on lower-end devices and mobile.',
		fix: 'Decimate the mesh. Above roughly a million vertices there is essentially always a lossless-looking reduction available.',
	},
	file_too_small: {
		label: 'File weight',
		why: 'Structurally empty. A real textured model does not fit in this many bytes.',
		fix: 'Check the export actually embedded its buffers and textures rather than referencing external files.',
	},
	file_too_large: {
		label: 'File weight',
		why: 'Beyond the viewer fetch budget. Visitors on a slow connection will abandon before it appears.',
		fix: 'Compress textures (KTX2/Basis) and apply Draco or meshopt geometry compression. This usually cuts the file by an order of magnitude with no visible loss.',
	},
	no_textures: {
		label: 'Surface texture',
		why: 'Untextured geometry reads as flat grey clay. This bound is stricter than the interactive forge on purpose: a catalog entry is the platform vouching for itself.',
		fix: 'Bake and embed at least a base-colour map before publishing.',
	},
	too_many_meshes_for_a_character: {
		label: 'Single assembled character',
		why: 'A character arriving as a dozen disconnected meshes is a scene, not a character, and it will not rig or animate as one body.',
		fix: 'Join the parts into one mesh, or switch the category to Prop, where loose parts are legitimate and this check does not apply.',
	},
});

const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');

function fmtBytes(n) {
	const b = Number(n || 0);
	if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
	if (b >= 1024) return `${Math.round(b / 1024)} KB`;
	return `${fmtInt(b)} bytes`;
}

/**
 * Expand a gateMesh() verdict into the ordered checks that produced it.
 *
 * Every check reports whether it ran and what it measured, so a passing model
 * is as informative as a failing one: "3,273 vertices, floor is 1,500" tells a
 * creator how much headroom they have, where a bare `pass: true` tells them
 * nothing.
 *
 * @param {ReturnType<typeof gateMesh>} verdict
 * @param {{ category?: string }} [opts]
 */
export function explainMeshGate(verdict, { category = 'avatar' } = {}) {
	const b = SEED_MESH_BOUNDS;
	const m = verdict?.metrics || {};
	const reasons = Array.isArray(verdict?.reasons) ? verdict.reasons : [];
	const failed = new Set(reasons);
	const rule = (id) => MESH_GATE_RULES[id] || { label: id, why: '', fix: '' };

	// The file never parsed, so no measurement below it is meaningful. Reporting
	// the other checks as "passed" here would be a lie by omission.
	if (failed.has('not_valid_glb')) {
		return {
			gateVersion: SEED_GATE_VERSION,
			category,
			pass: false,
			headline: 'Not a readable .glb',
			summary: 'The file could not be parsed as binary glTF 2.0, so none of the other checks could run.',
			checks: [{ id: 'not_valid_glb', status: 'fail', actual: 'unreadable', bound: 'binary glTF 2.0', ...rule('not_valid_glb') }],
			metrics: m,
		};
	}

	const checks = [
		{
			id: 'vertices_below_floor',
			status: failed.has('vertices_below_floor') ? 'fail' : 'pass',
			actual: `${fmtInt(m.vertexCount)} vertices`,
			bound: `at least ${fmtInt(b.minVertices)}`,
			...rule('vertices_below_floor'),
		},
		{
			id: 'vertices_above_ceiling',
			status: failed.has('vertices_above_ceiling') ? 'fail' : 'pass',
			actual: `${fmtInt(m.vertexCount)} vertices`,
			bound: `at most ${fmtInt(b.maxVertices)}`,
			...rule('vertices_above_ceiling'),
		},
		{
			id: 'file_too_small',
			status: failed.has('file_too_small') ? 'fail' : 'pass',
			actual: fmtBytes(m.sizeBytes),
			bound: `at least ${fmtBytes(b.minBytes)}`,
			...rule('file_too_small'),
		},
		{
			id: 'file_too_large',
			status: failed.has('file_too_large') ? 'fail' : 'pass',
			actual: fmtBytes(m.sizeBytes),
			bound: `at most ${fmtBytes(b.maxBytes)}`,
			...rule('file_too_large'),
		},
		{
			id: 'no_textures',
			status: !b.requireTexture ? 'skipped' : failed.has('no_textures') ? 'fail' : 'pass',
			actual: m.hasTextures ? `${fmtInt(m.textureCount)} texture${m.textureCount === 1 ? '' : 's'}` : 'none',
			bound: b.requireTexture ? 'at least 1' : 'not enforced',
			...rule('no_textures'),
		},
		{
			id: 'zero_volume',
			status: failed.has('zero_volume') ? 'fail' : 'pass',
			actual: `${Number(m.bboxDiagonal || 0).toFixed(3)} diagonal`,
			bound: 'greater than 0',
			...rule('zero_volume'),
		},
		{
			id: 'too_many_meshes_for_a_character',
			// Props may legitimately be a loose collection of parts, so the rule
			// genuinely does not apply rather than silently passing.
			status:
				category !== 'avatar'
					? 'skipped'
					: failed.has('too_many_meshes_for_a_character')
						? 'fail'
						: 'pass',
			actual: `${fmtInt(m.meshCount)} mesh${m.meshCount === 1 ? '' : 'es'}`,
			bound: category === 'avatar' ? 'at most 8' : 'props exempt',
			...rule('too_many_meshes_for_a_character'),
		},
	];

	// Degenerate-geometry reasons come from the shared forge scorer rather than
	// from a catalog bound, so they are appended as they arrive instead of being
	// enumerated above. Anything already rendered as a check is not repeated.
	for (const id of reasons) {
		if (checks.some((c) => c.id === id)) continue;
		checks.push({ id, status: 'fail', actual: 'failed', bound: 'forge quality scorer', ...rule(id) });
	}

	const failures = checks.filter((c) => c.status === 'fail');
	return {
		gateVersion: SEED_GATE_VERSION,
		category,
		pass: Boolean(verdict?.pass),
		headline: verdict?.pass
			? 'Clears the catalog bar'
			: `${failures.length} check${failures.length === 1 ? '' : 's'} short of the catalog bar`,
		summary: verdict?.pass
			? 'This model passes every structural check the platform applies to its own catalog entries.'
			: failures.map((c) => c.label).join(' · '),
		checks,
		metrics: m,
	};
}
