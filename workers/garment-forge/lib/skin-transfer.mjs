// Garment skinning — TEST-HARNESS / REFERENCE implementation.
//
// NOT the production skinning lane. The bake-off of 2026-07-25 (same shirt,
// parametric base, canonical walk.json, scripts/garment-rig-bakeoff.mjs)
// measured cloth-to-body deviation across the gait:
//
//     rig-worker lane (production, main.py rig_composite):  mean 2.87 cm, p95  6.36 cm
//     this proximity lane:                                  mean 5.88 cm, p95 13.06 cm
//
// The rig-worker path won decisively and the worker uses it exclusively. This
// module is retained for one purpose: tests/garment-forge-skin-transfer.test.js
// builds synthetic wearables with it offline (no GPU, no network) to prove the
// runtime binder (src/avatar-garment.js attachGarment) accepts any conforming
// `three.ws-canonical-v1` garment at MIN_BIND_COVERAGE. If the contract test
// gains a committed fixture from the production lane, delete this file.
//
// Pure module: operates on @gltf-transform Documents — fully unit-testable.

import { canonicalizeBoneName } from '../../../src/glb-canonicalize.js';
import { REGION_BONES, BODY_REGIONS } from '../../../src/garment-taxonomy.js';

/** Which body regions each slot dresses — drives both placement and the
 *  default `occludes` floor. Over-covering is safe; under-covering shows skin. */
export const SLOT_REGIONS = Object.freeze({
	top: ['torso', 'upperArms'],
	outerwear: ['torso', 'upperArms', 'lowerArms'],
	bottom: ['hips', 'upperLegs'],
	footwear: ['feet'],
	hair: ['scalp'],
	headwear: ['scalp'],
	glasses: [],
	accessory: [],
});

/* ── body analysis ───────────────────────────────────────────────────────── */

/** The body's skinned mesh node + skin (the only skinned mesh in the base). */
export function findBodyMesh(doc) {
	for (const node of doc.getRoot().listNodes()) {
		if (node.getSkin() && node.getMesh()) return node;
	}
	return null;
}

/** joint index → canonical bone name for a skin. */
function canonicalJointNames(skin) {
	return skin.listJoints().map((j) => canonicalizeBoneName(j.getName() || '') || '');
}

/**
 * Per-region axis-aligned bounds of the body's vertices, assigned by dominant
 * joint weight. Used to place a garment over the region it dresses.
 * @returns {Map<string, {min: number[], max: number[]}>}
 */
export function regionBounds(bodyDoc) {
	const node = findBodyMesh(bodyDoc);
	if (!node) return new Map();
	const names = canonicalJointNames(node.getSkin());
	const boneRegion = new Map(); // canonical bone → region
	for (const [region, bones] of Object.entries(REGION_BONES)) {
		for (const b of bones) boneRegion.set(b, region);
	}

	const out = new Map();
	for (const prim of node.getMesh().listPrimitives()) {
		const pos = prim.getAttribute('POSITION')?.getArray();
		const joints = prim.getAttribute('JOINTS_0')?.getArray();
		const weights = prim.getAttribute('WEIGHTS_0')?.getArray();
		if (!pos || !joints || !weights) continue;
		const count = pos.length / 3;
		for (let v = 0; v < count; v++) {
			// dominant influence decides the vertex's region
			let bestC = 0;
			for (let c = 1; c < 4; c++) {
				if (weights[v * 4 + c] > weights[v * 4 + bestC]) bestC = c;
			}
			const region = boneRegion.get(names[joints[v * 4 + bestC]]);
			if (!region) continue;
			let box = out.get(region);
			if (!box) {
				box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
				out.set(region, box);
			}
			for (let a = 0; a < 3; a++) {
				const p = pos[v * 3 + a];
				if (p < box.min[a]) box.min[a] = p;
				if (p > box.max[a]) box.max[a] = p;
			}
		}
	}
	return out;
}

function unionBounds(boxes) {
	const out = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
	for (const b of boxes) {
		for (let a = 0; a < 3; a++) {
			if (b.min[a] < out.min[a]) out.min[a] = b.min[a];
			if (b.max[a] > out.max[a]) out.max[a] = b.max[a];
		}
	}
	return out;
}

function meshBounds(mesh) {
	const out = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
	for (const prim of mesh.listPrimitives()) {
		const pos = prim.getAttribute('POSITION')?.getArray();
		if (!pos) continue;
		for (let i = 0; i < pos.length; i += 3) {
			for (let a = 0; a < 3; a++) {
				const p = pos[i + a];
				if (p < out.min[a]) out.min[a] = p;
				if (p > out.max[a]) out.max[a] = p;
			}
		}
	}
	return out;
}

/* ── fit ─────────────────────────────────────────────────────────────────── */

/**
 * Uniformly scale + translate the garment mesh so its bounds sit over the
 * slot's body regions, with breathing room so cloth wraps outside the body
 * instead of intersecting it. Mutates POSITION accessors in place (bakes the
 * transform — the emitted GLB must be correct with an identity node transform,
 * since glTF ignores skinned-node transforms).
 *
 * @returns {{ scale: number, offset: number[] }} applied transform (for logs)
 */
export function fitGarmentToBody(garmentMesh, bodyDoc, slot, opts = {}) {
	const pad = opts.pad ?? 1.06; // garments sit slightly proud of the skin
	const regions = SLOT_REGIONS[slot]?.length ? SLOT_REGIONS[slot] : ['torso'];
	const bounds = regionBounds(bodyDoc);
	const targets = regions.map((r) => bounds.get(r)).filter(Boolean);
	if (!targets.length) throw new Error(`body has no vertices in regions for slot "${slot}"`);
	const target = unionBounds(targets);
	const source = meshBounds(garmentMesh);

	const sizeOf = (b) => [0, 1, 2].map((a) => Math.max(b.max[a] - b.min[a], 1e-6));
	const tSize = sizeOf(target);
	const sSize = sizeOf(source);
	// One uniform scale, chosen so the garment covers the target in every axis
	// (max ratio, not min — mild oversize beats poking skin).
	const scale = Math.max(tSize[0] / sSize[0], tSize[1] / sSize[1], tSize[2] / sSize[2]) * pad;

	const centreOf = (b) => [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2);
	const tC = centreOf(target);
	const sC = centreOf(source);
	const offset = [0, 1, 2].map((a) => tC[a] - sC[a] * scale);

	for (const prim of garmentMesh.listPrimitives()) {
		const posAccessor = prim.getAttribute('POSITION');
		const pos = posAccessor?.getArray();
		if (!pos) continue;
		const out = new Float32Array(pos.length);
		for (let i = 0; i < pos.length; i += 3) {
			for (let a = 0; a < 3; a++) out[i + a] = pos[i + a] * scale + offset[a];
		}
		posAccessor.setArray(out);
	}
	return { scale, offset };
}

/* ── proximity weight transfer ───────────────────────────────────────────── */

/** Spatial hash over the body's vertices for near-neighbour lookup. */
class VertexGrid {
	constructor(positions, cellSize) {
		this.pos = positions;
		this.cell = cellSize;
		this.map = new Map();
		for (let v = 0; v < positions.length / 3; v++) {
			this.map.get(this._key(
				positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2],
			))?.push(v) ?? this.map.set(this._key(
				positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2],
			), [v]);
		}
	}

	_key(x, y, z) {
		return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)},${Math.floor(z / this.cell)}`;
	}

	/** Index of the nearest body vertex; expands the search ring until found. */
	nearest(x, y, z) {
		const cx = Math.floor(x / this.cell);
		const cy = Math.floor(y / this.cell);
		const cz = Math.floor(z / this.cell);
		for (let ring = 0; ring < 64; ring++) {
			let best = -1;
			let bestD = Infinity;
			for (let dx = -ring; dx <= ring; dx++) {
				for (let dy = -ring; dy <= ring; dy++) {
					for (let dz = -ring; dz <= ring; dz++) {
						if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
						const bucket = this.map.get(`${cx + dx},${cy + dy},${cz + dz}`);
						if (!bucket) continue;
						for (const v of bucket) {
							const ddx = this.pos[v * 3] - x;
							const ddy = this.pos[v * 3 + 1] - y;
							const ddz = this.pos[v * 3 + 2] - z;
							const d = ddx * ddx + ddy * ddy + ddz * ddz;
							if (d < bestD) { bestD = d; best = v; }
						}
					}
				}
			}
			// A hit on ring N can still be beaten by ring N+1 (cell corners), so
			// confirm with one extra ring before returning.
			if (best >= 0) {
				const confirmRing = ring + 1;
				for (let dx = -confirmRing; dx <= confirmRing; dx++) {
					for (let dy = -confirmRing; dy <= confirmRing; dy++) {
						for (let dz = -confirmRing; dz <= confirmRing; dz++) {
							if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== confirmRing) continue;
							const bucket = this.map.get(`${cx + dx},${cy + dy},${cz + dz}`);
							if (!bucket) continue;
							for (const v of bucket) {
								const ddx = this.pos[v * 3] - x;
								const ddy = this.pos[v * 3 + 1] - y;
								const ddz = this.pos[v * 3 + 2] - z;
								const d = ddx * ddx + ddy * ddy + ddz * ddz;
								if (d < bestD) { bestD = d; best = v; }
							}
						}
					}
				}
				return best;
			}
		}
		return -1;
	}
}

/** Closest point on triangle (a,b,c) to p — Ericson, Real-Time Collision
 *  Detection §5.1.5 — returned as clamped barycentric (u,v,w) for a,b,c. */
function closestPointBary(px, py, pz, a, b, c) {
	const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
	const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
	const apx = px - a[0], apy = py - a[1], apz = pz - a[2];
	const d1 = abx * apx + aby * apy + abz * apz;
	const d2 = acx * apx + acy * apy + acz * apz;
	if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
	const bpx = px - b[0], bpy = py - b[1], bpz = pz - b[2];
	const d3 = abx * bpx + aby * bpy + abz * bpz;
	const d4 = acx * bpx + acy * bpy + acz * bpz;
	if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
	const vc = d1 * d4 - d3 * d2;
	if (vc <= 0 && d1 >= 0 && d3 <= 0) {
		const t = d1 / (d1 - d3);
		return [1 - t, t, 0];
	}
	const cpx = px - c[0], cpy = py - c[1], cpz = pz - c[2];
	const d5 = abx * cpx + aby * cpy + abz * cpz;
	const d6 = acx * cpx + acy * cpy + acz * cpz;
	if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
	const vb = d5 * d2 - d1 * d6;
	if (vb <= 0 && d2 >= 0 && d6 <= 0) {
		const t = d2 / (d2 - d6);
		return [1 - t, 0, t];
	}
	const va = d3 * d6 - d5 * d4;
	if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
		const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
		return [0, 1 - t, t];
	}
	const denom = 1 / (va + vb + vc);
	const v = vb * denom;
	const w = vc * denom;
	return [1 - v - w, v, w];
}

/** Reduce an influence Map(joint → weight) to the top-4, renormalised. */
function top4(influences, outJ, outW, offset) {
	const entries = [...influences.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
	let sum = 0;
	for (const [, w] of entries) sum += w;
	for (let c = 0; c < 4; c++) {
		outJ[offset + c] = entries[c] ? entries[c][0] : 0;
		outW[offset + c] = entries[c] && sum > 0 ? entries[c][1] / sum : 0;
	}
}

/**
 * Give every garment vertex skin influences interpolated from the nearest
 * point on the body SURFACE (closest triangle, clamped barycentric blend of
 * its three corners), then smooth once over the garment's own topology.
 *
 * Surface interpolation is what removes the candy-wrapper pinch a plain
 * nearest-VERTEX snap produces at armpits and shoulders: a garment vertex
 * midway between two body vertices gets the midway weights, not a coin flip.
 * The smoothing pass then guarantees neighbouring cloth vertices never carry
 * discontinuous influences, which is what shows up as creasing under motion.
 *
 * @param {object} garmentMesh  gltf-transform Mesh (already fitted to the body)
 * @param {object} bodyDoc      the canonical body document
 * @param {object} doc          the OUTPUT document that owns garmentMesh (for accessor creation)
 * @returns {{ transferred: number }}
 */
export function transferSkinWeights(garmentMesh, bodyDoc, doc) {
	const bodyNode = findBodyMesh(bodyDoc);
	if (!bodyNode) throw new Error('canonical body has no skinned mesh');

	// Flatten body vertices + skin attributes + triangles into parallel arrays.
	const bPos = [];
	const bJoints = [];
	const bWeights = [];
	const bTris = [];
	for (const prim of bodyNode.getMesh().listPrimitives()) {
		const pos = prim.getAttribute('POSITION')?.getArray();
		const joints = prim.getAttribute('JOINTS_0')?.getArray();
		const weights = prim.getAttribute('WEIGHTS_0')?.getArray();
		if (!pos || !joints || !weights) continue;
		const base = bPos.length / 3;
		for (let i = 0; i < pos.length; i++) bPos.push(pos[i]);
		for (let i = 0; i < joints.length; i++) { bJoints.push(joints[i]); bWeights.push(weights[i]); }
		const index = prim.getIndices()?.getArray();
		if (index) {
			for (let i = 0; i < index.length; i++) bTris.push(base + index[i]);
		} else {
			for (let v = 0; v < pos.length / 3; v++) bTris.push(base + v);
		}
	}
	if (!bPos.length) throw new Error('canonical body mesh has no skinned vertices');

	const bounds = meshBounds(bodyNode.getMesh());
	const diag = Math.hypot(
		bounds.max[0] - bounds.min[0],
		bounds.max[1] - bounds.min[1],
		bounds.max[2] - bounds.min[2],
	);
	const cell = Math.max(diag / 40, 1e-4);

	// Grid over triangle CENTROIDS. A centroid hit on ring N can hide a closer
	// surface point on ring N+1, so nearestTri scans two confirm rings past the
	// first non-empty one before answering.
	const triCount = bTris.length / 3;
	const centroids = new Float32Array(triCount * 3);
	for (let t = 0; t < triCount; t++) {
		for (let a = 0; a < 3; a++) {
			centroids[t * 3 + a] = (
				bPos[bTris[t * 3] * 3 + a] + bPos[bTris[t * 3 + 1] * 3 + a] + bPos[bTris[t * 3 + 2] * 3 + a]
			) / 3;
		}
	}
	const grid = new VertexGrid(centroids, cell);

	const corner = (t, k) => {
		const vi = bTris[t * 3 + k];
		return [bPos[vi * 3], bPos[vi * 3 + 1], bPos[vi * 3 + 2]];
	};

	/** Nearest surface point: best clamped-barycentric hit over candidate tris. */
	const nearestSurface = (x, y, z) => {
		const seed = grid.nearest(x, y, z);
		if (seed < 0) return null;
		// Candidate set: every triangle whose centroid lies within the ring that
		// produced the seed plus two rings — cheap because rings are tiny.
		const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
		const sx = Math.floor(centroids[seed * 3] / cell);
		const ringOfSeed = Math.max(Math.abs(sx - cx), Math.abs(Math.floor(centroids[seed * 3 + 1] / cell) - cy), Math.abs(Math.floor(centroids[seed * 3 + 2] / cell) - cz));
		const reach = ringOfSeed + 2;
		let best = null;
		let bestD = Infinity;
		for (let dx = -reach; dx <= reach; dx++) {
			for (let dy = -reach; dy <= reach; dy++) {
				for (let dz = -reach; dz <= reach; dz++) {
					const bucket = grid.map.get(`${cx + dx},${cy + dy},${cz + dz}`);
					if (!bucket) continue;
					for (const t of bucket) {
						const a = corner(t, 0), b = corner(t, 1), c = corner(t, 2);
						const bary = closestPointBary(x, y, z, a, b, c);
						const qx = a[0] * bary[0] + b[0] * bary[1] + c[0] * bary[2];
						const qy = a[1] * bary[0] + b[1] * bary[1] + c[1] * bary[2];
						const qz = a[2] * bary[0] + b[2] * bary[1] + c[2] * bary[2];
						const d = (qx - x) ** 2 + (qy - y) ** 2 + (qz - z) ** 2;
						if (d < bestD) { bestD = d; best = { t, bary }; }
					}
				}
			}
		}
		return best;
	};

	const buffer = doc.getRoot().listBuffers()[0] || doc.createBuffer();
	let transferred = 0;

	for (const prim of garmentMesh.listPrimitives()) {
		const pos = prim.getAttribute('POSITION')?.getArray();
		if (!pos) continue;
		const count = pos.length / 3;

		// Pass 1 — barycentric influence blend per vertex.
		const influences = new Array(count);
		for (let v = 0; v < count; v++) {
			const hit = nearestSurface(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
			if (!hit) { influences[v] = new Map(); continue; }
			const map = new Map();
			for (let k = 0; k < 3; k++) {
				const share = hit.bary[k];
				if (share <= 0) continue;
				const vi = bTris[hit.t * 3 + k];
				for (let c = 0; c < 4; c++) {
					const w = bWeights[vi * 4 + c] * share;
					if (w <= 0) continue;
					const j = bJoints[vi * 4 + c];
					map.set(j, (map.get(j) || 0) + w);
				}
			}
			influences[v] = map;
			transferred++;
		}

		// Pass 2 — one smoothing iteration over the garment's own edges, so
		// adjacent cloth vertices never carry discontinuous influences.
		const index = prim.getIndices()?.getArray();
		if (index) {
			const neighbours = new Array(count);
			for (let i = 0; i < index.length; i += 3) {
				for (let e = 0; e < 3; e++) {
					const a = index[i + e];
					const b = index[i + ((e + 1) % 3)];
					(neighbours[a] ||= new Set()).add(b);
					(neighbours[b] ||= new Set()).add(a);
				}
			}
			const smoothed = new Array(count);
			for (let v = 0; v < count; v++) {
				const own = influences[v];
				const ns = neighbours[v];
				if (!ns || !ns.size || !own.size) { smoothed[v] = own; continue; }
				const acc = new Map();
				for (const [j, w] of own) acc.set(j, w * 0.5);
				const share = 0.5 / ns.size;
				for (const n of ns) {
					for (const [j, w] of influences[n]) acc.set(j, (acc.get(j) || 0) + w * share);
				}
				smoothed[v] = acc;
			}
			for (let v = 0; v < count; v++) influences[v] = smoothed[v];
		}

		const outJ = new Uint16Array(count * 4);
		const outW = new Float32Array(count * 4);
		for (let v = 0; v < count; v++) top4(influences[v], outJ, outW, v * 4);

		prim.setAttribute(
			'JOINTS_0',
			doc.createAccessor().setType('VEC4').setArray(outJ).setBuffer(buffer),
		);
		prim.setAttribute(
			'WEIGHTS_0',
			doc.createAccessor().setType('VEC4').setArray(outW).setBuffer(buffer),
		);
	}
	return { transferred };
}

/* ── occludes derivation ─────────────────────────────────────────────────── */

/** Mirror of SLOT_OCCLUDABLE in garment_glb.py: regions a slot may hide at
 *  all. Evidence decides within this set — a top can never hide feet. */
export const SLOT_OCCLUDABLE = Object.freeze({
	top: ['torso', 'upperArms', 'lowerArms', 'neck', 'hips', 'upperLegs'],
	outerwear: ['torso', 'upperArms', 'lowerArms', 'neck', 'hips', 'upperLegs'],
	bottom: ['hips', 'upperLegs', 'lowerLegs'],
	footwear: ['feet', 'lowerLegs'],
	hair: ['scalp'],
	headwear: ['scalp'],
	glasses: [],
	accessory: [],
});

/**
 * Which body regions this garment covers, measured from where its transferred
 * skin weight actually landed. Two gates, matching garment_glb.py: evidence
 * (≥ threshold of total weight — 10%, because a waistband graze at a few
 * percent must not amputate the pelvis) and per-slot plausibility.
 */
export function deriveOccludes(garmentMesh, skin, slot, threshold = 0.1) {
	const names = canonicalJointNames(skin);
	const regionOf = new Map();
	for (const [region, bones] of Object.entries(REGION_BONES)) {
		for (const b of bones) regionOf.set(b, region);
	}

	const perRegion = new Map();
	let total = 0;
	for (const prim of garmentMesh.listPrimitives()) {
		const joints = prim.getAttribute('JOINTS_0')?.getArray();
		const weights = prim.getAttribute('WEIGHTS_0')?.getArray();
		if (!joints || !weights) continue;
		for (let i = 0; i < weights.length; i++) {
			const w = weights[i];
			if (w <= 0) continue;
			total += w;
			const region = regionOf.get(names[joints[i]]);
			if (region) perRegion.set(region, (perRegion.get(region) || 0) + w);
		}
	}

	const allowed = new Set(SLOT_OCCLUDABLE[slot] || BODY_REGIONS);
	const out = new Set(SLOT_REGIONS[slot] || []);
	if (total > 0) {
		for (const [region, w] of perRegion) {
			if (w / total >= threshold) out.add(region);
		}
	}
	return BODY_REGIONS.filter((r) => out.has(r) && allowed.has(r));
}
