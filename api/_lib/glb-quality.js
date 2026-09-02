// Deterministic GLB quality scoring for the Forge pipeline.
//
// inspectGlb() (glb-inspect.js) answers "is this a valid glTF and does it have a
// rig?". This module answers the harder product question: "is this a GOOD mesh,
// or did the generator hand back a degenerate blob a user shouldn't see?". It
// reads only the glTF JSON chunk — accessor counts and POSITION min/max bounds —
// so it stays fast on large meshes (no BIN decode) while still reasoning about
// geometry density, bounding-box volume, and material/texture presence.
//
// The output is a single, stable quality signal the generation flow attaches to
// metadata and uses to flag low-quality outputs (and auto-retry once before
// returning). It never mutates the mesh and never throws — an unparseable buffer
// scores `invalid` rather than crashing the boundary.

import { inspectGlb } from './glb-inspect.js';

// Thresholds. Tuned for the Forge lanes (TRELLIS / Hunyuan3D / TripoSR), whose
// real outputs land in the tens-of-thousands of triangles with PBR textures. A
// genuinely degenerate output (the failure mode we must catch) is a near-empty
// mesh, a zero-volume bounding box, or a handful of triangles. Overridable via
// env so a deployment can retune without a code change.
function intEnv(name, fallback) {
	const v = typeof process !== 'undefined' ? process.env?.[name] : null;
	const n = v == null || v === '' ? NaN : Number(v);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Same, for a 0..1 ratio threshold that must keep its fractional part.
function ratioEnv(name, fallback) {
	const v = typeof process !== 'undefined' ? process.env?.[name] : null;
	const n = v == null || v === '' ? NaN : Number(v);
	return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

export const QUALITY_THRESHOLDS = Object.freeze({
	// Below this triangle count the mesh is treated as degenerate (effectively empty).
	degenerateTriangles: intEnv('FORGE_QUALITY_MIN_TRIS', 80),
	// Below this it is flagged low (renders, but coarse — a retry usually helps).
	lowTriangles: intEnv('FORGE_QUALITY_LOW_TRIS', 800),
	// A bounding-box diagonal at or below this (in the mesh's own units) is a
	// collapsed / zero-volume result — the classic "black dot" TRELLIS failure.
	minBboxDiagonal: 1e-4,
	// At or below this flatness (thinnest extent / longest extent) the mesh is a
	// slab, not a solid. This is NOT degeneracy on its own: a plate, a coin, a rug
	// and a poster are all legitimately flat. It means the cheap scorer cannot
	// vouch for the result, so the mesh must escalate to vision QA rather than be
	// trusted. See the `planar` note on shouldEscalateToVisionQA.
	planarFlatness: ratioEnv('FORGE_QUALITY_PLANAR_FLATNESS', 0.2),
	// The same test for a mesh thin in X or Z rather than in Y. Upright subjects are
	// legitimately narrow front-to-back (a standing figure runs about 0.19), so this
	// bar is far stricter: only a sliver no solid object could be.
	sliverFlatness: ratioEnv('FORGE_QUALITY_SLIVER_FLATNESS', 0.05),
});

// Pull the per-attribute vertex count and union the POSITION bounding box across
// every primitive of every mesh. glTF accessors carry `count` (element count)
// and, for POSITION, `min`/`max` (3-vectors) — enough to measure geometry
// density and extent without ever touching the binary buffer.
function summarizeGeometry(gltf) {
	const accessors = Array.isArray(gltf.accessors) ? gltf.accessors : [];
	const meshes = Array.isArray(gltf.meshes) ? gltf.meshes : [];
	let vertexCount = 0;
	let triangleCount = 0;
	let primitiveCount = 0;
	let indexedPrimitives = 0;
	let texturedPrimitives = 0;
	let min = [Infinity, Infinity, Infinity];
	let max = [-Infinity, -Infinity, -Infinity];
	let haveBounds = false;

	for (const mesh of meshes) {
		const prims = Array.isArray(mesh.primitives) ? mesh.primitives : [];
		for (const prim of prims) {
			primitiveCount++;
			// mode 4 (TRIANGLES) is the glTF default; only triangle topology
			// contributes to the triangle count. Non-triangle prims still count as
			// geometry but not as renderable surface area.
			const mode = typeof prim.mode === 'number' ? prim.mode : 4;
			const posIdx = prim.attributes?.POSITION;
			const pos = Number.isInteger(posIdx) ? accessors[posIdx] : null;
			if (pos && Number.isFinite(pos.count)) {
				vertexCount += pos.count;
				if (Array.isArray(pos.min) && Array.isArray(pos.max) && pos.min.length >= 3) {
					for (let i = 0; i < 3; i++) {
						if (Number.isFinite(pos.min[i])) min[i] = Math.min(min[i], pos.min[i]);
						if (Number.isFinite(pos.max[i])) max[i] = Math.max(max[i], pos.max[i]);
					}
					haveBounds = true;
				}
			}
			let primTris = 0;
			if (Number.isInteger(prim.indices) && accessors[prim.indices]) {
				indexedPrimitives++;
				const idx = accessors[prim.indices];
				if (mode === 4 && Number.isFinite(idx.count)) primTris = Math.floor(idx.count / 3);
			} else if (pos && mode === 4 && Number.isFinite(pos.count)) {
				primTris = Math.floor(pos.count / 3);
			}
			triangleCount += primTris;
			if (Number.isInteger(prim.material)) texturedPrimitives++;
		}
	}

	const size = haveBounds
		? [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((d) => (Number.isFinite(d) ? Math.abs(d) : 0))
		: [0, 0, 0];
	const bboxDiagonal = Math.sqrt(size[0] ** 2 + size[1] ** 2 + size[2] ** 2);
	// Flatness = thinnest extent / longest extent. 1 is a cube, 0 is a plane.
	// The diagonal above measures how BIG the mesh is; this measures whether it
	// has any depth at all, which is the axis a collapsed reconstruction fails on
	// while staying large enough to look healthy by every other metric.
	const longest = Math.max(size[0], size[1], size[2]);
	const shortest = Math.min(size[0], size[1], size[2]);
	const flatness = haveBounds && longest > 0 ? shortest / longest : null;
	// Which axis is the thin one matters. glTF is Y-up, so a mesh thin in Y is a
	// pancake lying on the ground, while a mesh thin in X or Z is usually just a
	// slim upright subject (a standing figure is genuinely narrow front-to-back).
	const thinAxis = flatness == null ? null : ['x', 'y', 'z'][size.indexOf(shortest)];

	return {
		vertexCount,
		triangleCount,
		primitiveCount,
		indexedPrimitives,
		texturedPrimitives,
		bbox: haveBounds ? { min, max, size } : null,
		bboxDiagonal: Number.isFinite(bboxDiagonal) ? bboxDiagonal : 0,
		flatness: Number.isFinite(flatness) ? flatness : null,
		thinAxis,
	};
}

// Does the asset carry any actual texture data? A textured 3D output should have
// images and at least one material that samples one. We check both the image
// table and material texture references so an embedded-bin texture (the common
// Forge case) and a separate-file texture both register.
function summarizeMaterials(gltf) {
	const materials = Array.isArray(gltf.materials) ? gltf.materials : [];
	const textures = Array.isArray(gltf.textures) ? gltf.textures : [];
	const images = Array.isArray(gltf.images) ? gltf.images : [];
	let materialsWithTexture = 0;
	for (const m of materials) {
		const pbr = m.pbrMetallicRoughness || {};
		const refs = [
			pbr.baseColorTexture,
			pbr.metallicRoughnessTexture,
			m.normalTexture,
			m.occlusionTexture,
			m.emissiveTexture,
		];
		if (refs.some((r) => r && Number.isInteger(r.index))) materialsWithTexture++;
	}
	return {
		materialCount: materials.length,
		textureCount: textures.length,
		imageCount: images.length,
		materialsWithTexture,
		hasTextures: images.length > 0 && textures.length > 0 && materialsWithTexture > 0,
		hasMaterials: materials.length > 0,
	};
}

// Re-parse the JSON chunk for the accessor/material detail inspectGlb() doesn't
// expose. Mirrors inspectGlb's chunk math exactly so the two never disagree on
// what a valid GLB is. Returns the parsed glTF object or null.
function parseGltfJson(buf) {
	if (!buf || typeof buf.byteLength !== 'number' || buf.byteLength < 20) return null;
	const view =
		buf instanceof DataView
			? buf
			: ArrayBuffer.isView(buf)
				? new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
				: new DataView(buf);
	if (view.getUint32(0, true) !== 0x46546c67) return null; // 'glTF'
	if (view.getUint32(16, true) !== 0x4e4f534a) return null; // 'JSON'
	const jsonLen = view.getUint32(12, true);
	if (20 + jsonLen > buf.byteLength) return null;
	const start = (buf.byteOffset || 0) + 20;
	const bytes = buf.buffer
		? new Uint8Array(buf.buffer, start, jsonLen)
		: new Uint8Array(buf, 20, jsonLen);
	try {
		return JSON.parse(new TextDecoder('utf-8').decode(bytes));
	} catch {
		return null;
	}
}

/**
 * Score a generated GLB's quality from its glTF JSON chunk alone.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer|DataView} buf
 * @returns {{
 *   valid: boolean,
 *   flag: 'ok' | 'low' | 'degenerate' | 'invalid',
 *   score: number,            // 0..1 composite
 *   reasons: string[],        // why it was flagged (empty when ok)
 *   metrics: {
 *     sizeBytes: number,
 *     vertexCount: number,
 *     triangleCount: number,
 *     meshCount: number,
 *     primitiveCount: number,
 *     bboxDiagonal: number,
 *     hasMaterials: boolean,
 *     hasTextures: boolean,
 *     materialCount: number,
 *     textureCount: number,
 *     imageCount: number,
 *     isIndexed: boolean,
 *     watertightish: boolean,
 *     generator: string | null,
 *   },
 * }}
 */
export function scoreGlbQuality(buf, { allowPartial = false } = {}) {
	const base = inspectGlb(buf, { allowPartial });
	if (!base) {
		return {
			valid: false,
			flag: 'invalid',
			score: 0,
			reasons: ['not_valid_glb'],
			metrics: {
				sizeBytes: buf && typeof buf.byteLength === 'number' ? buf.byteLength : 0,
				vertexCount: 0,
				triangleCount: 0,
				meshCount: 0,
				primitiveCount: 0,
				bboxDiagonal: 0,
				hasMaterials: false,
				hasTextures: false,
				materialCount: 0,
				textureCount: 0,
				imageCount: 0,
				isIndexed: false,
				watertightish: false,
				generator: null,
			},
		};
	}

	const gltf = parseGltfJson(buf);
	const geo = gltf
		? summarizeGeometry(gltf)
		: { vertexCount: 0, triangleCount: 0, primitiveCount: 0, indexedPrimitives: 0, texturedPrimitives: 0, bbox: null, bboxDiagonal: 0 };
	const mat = gltf
		? summarizeMaterials(gltf)
		: { materialCount: 0, textureCount: 0, imageCount: 0, materialsWithTexture: 0, hasTextures: false, hasMaterials: false };

	const t = QUALITY_THRESHOLDS;
	const reasons = [];

	// "Watertight-ish": an indexed triangle mesh whose vertex:triangle ratio sits
	// in the range a closed surface produces (~V ≈ T/2 for a manifold). A purely
	// heuristic signal — true watertightness needs edge-adjacency analysis over the
	// BIN chunk — but it cheaply separates a clean reconstructed surface from a
	// soup of disconnected triangles.
	const isIndexed = geo.primitiveCount > 0 && geo.indexedPrimitives === geo.primitiveCount;
	const vtRatio = geo.triangleCount > 0 ? geo.vertexCount / geo.triangleCount : 0;
	const watertightish = isIndexed && vtRatio > 0.35 && vtRatio < 0.9;

	// Hard degeneracy checks → flag degenerate.
	let degenerate = false;
	if (base.meshCount === 0 || geo.triangleCount < t.degenerateTriangles) {
		degenerate = true;
		reasons.push(geo.triangleCount === 0 ? 'no_geometry' : 'too_few_triangles');
	}
	if (geo.bbox && geo.bboxDiagonal <= t.minBboxDiagonal) {
		degenerate = true;
		reasons.push('zero_volume');
	}

	// A slab-shaped result: large and dense enough to pass every check above, but
	// with no depth. An image-to-3D reconstruction that loses its conditioning
	// collapses to exactly this (a full-footprint relief), and it is otherwise the
	// highest-confidence output the scorer can produce. Recorded as a signal, not
	// a verdict: legitimately flat subjects exist, so vision QA makes the call.
	// Thin in Y is the shape a lost reconstruction takes (a pancake on the ground).
	// Thin in X or Z is usually a real slim upright subject, so it only counts when
	// it is so extreme that no solid object could have that profile.
	const planar =
		geo.flatness != null &&
		(geo.thinAxis === 'y' ? geo.flatness <= t.planarFlatness : geo.flatness <= t.sliverFlatness);
	if (planar) reasons.push('planar');

	// Soft quality checks → flag low.
	let low = false;
	if (!degenerate && geo.triangleCount < t.lowTriangles) {
		low = true;
		reasons.push('low_poly');
	}
	if (!mat.hasMaterials) {
		low = low || !degenerate;
		reasons.push('no_materials');
	} else if (!mat.hasTextures) {
		low = low || !degenerate;
		reasons.push('no_textures');
	}

	// Composite 0..1 score: geometry density (capped), texture presence, material
	// presence, and the watertight heuristic, each weighted. Degenerate clamps low.
	const densityScore = Math.max(0, Math.min(1, Math.log10(Math.max(geo.triangleCount, 1)) / Math.log10(50_000)));
	const textureScore = mat.hasTextures ? 1 : mat.hasMaterials ? 0.4 : 0;
	const structureScore = watertightish ? 1 : isIndexed ? 0.6 : 0.3;
	let score = 0.5 * densityScore + 0.3 * textureScore + 0.2 * structureScore;
	if (degenerate) score = Math.min(score, 0.1);
	else if (low) score = Math.min(score, 0.55);
	score = Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;

	const flag = degenerate ? 'degenerate' : low ? 'low' : 'ok';

	return {
		valid: true,
		flag,
		score,
		reasons,
		metrics: {
			sizeBytes: base.sizeBytes,
			vertexCount: geo.vertexCount,
			triangleCount: geo.triangleCount,
			meshCount: base.meshCount,
			primitiveCount: geo.primitiveCount,
			bboxDiagonal: Math.round(geo.bboxDiagonal * 1e6) / 1e6,
			flatness: geo.flatness == null ? null : Math.round(geo.flatness * 1e6) / 1e6,
			thinAxis: geo.thinAxis ?? null,
			planar,
			hasMaterials: mat.hasMaterials,
			hasTextures: mat.hasTextures,
			materialCount: mat.materialCount,
			textureCount: mat.textureCount,
			imageCount: mat.imageCount,
			isIndexed,
			watertightish,
			generator: base.generator,
		},
	};
}

// True when a scored result is bad enough to justify the one auto-retry the
// generation flow allows before returning. Degenerate always qualifies; a `low`
// flag qualifies only when the score is in the bottom band, so a merely-coarse
// (but usable) mesh isn't re-paid for needlessly.
export function shouldRetryForQuality(quality) {
	if (!quality) return false;
	if (quality.flag === 'invalid' || quality.flag === 'degenerate') return true;
	return quality.flag === 'low' && quality.score < 0.3;
}

// The confidence threshold at or above which a clean, textured `ok` mesh is
// trusted WITHOUT paying for a vision-QA pass. Env-tunable; 0..1.
const ADAPTIVE_TRUST_SCORE = (() => {
	const v = typeof process !== 'undefined' ? process.env?.FORGE_QUALITY_ADAPTIVE_MIN : null;
	const n = v == null || v === '' ? NaN : Number(v);
	return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.6;
})();

// Adaptive gate decision for the FREE lanes: should this generation escalate
// from the cheap deterministic score to the (slower, credit-spending) vision-QA
// gate + reroll?
//
// The whole point is to keep fast drafts fast. A mesh the cheap scorer can
// confidently vouch for (a valid, textured, `ok`-flagged reconstruction whose
// composite score clears the trust threshold) skips vision entirely and ships
// immediately. Everything the cheap signal CANNOT vouch for escalates:
//   • flag `low`/`degenerate`/`invalid`: coarse, blobby, or untextured, exactly
//     the outputs whose semantic quality a render-based judge should confirm;
//   • an `ok` mesh scoring below the trust threshold: structurally fine but
//     mediocre, the "valid but doesn't look like what I asked for" middle that
//     the structural scorer alone can't catch.
//   • a `planar` mesh: dense, textured and large, but with no depth. An
//     image-to-3D reconstruction that loses its conditioning collapses to a
//     full-footprint slab that scores near the top of this scale (0.976 measured
//     on a live free-lane result), so density and texture presence actively
//     vouch for the one failure they cannot see. Flatness alone cannot convict
//     it either, because plates, coins, rugs and posters are genuinely flat, so
//     the decision belongs to the render-based judge.
// A missing quality signal escalates (we cannot vouch for what we did not score).
//
// This is what lets the free lane gain a semantic quality floor without turning
// every draft into a vision call: only the ambiguous fraction pays the latency.
export function shouldEscalateToVisionQA(quality, { minScore = ADAPTIVE_TRUST_SCORE } = {}) {
	if (!quality || typeof quality !== 'object') return true;
	if (quality.flag !== 'ok') return true;
	if (quality.metrics && quality.metrics.hasTextures === false) return true;
	if (quality.metrics && quality.metrics.planar === true) return true;
	const score = Number(quality.score);
	if (!Number.isFinite(score)) return true;
	return score < minScore;
}
