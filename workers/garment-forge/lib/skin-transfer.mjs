// Garment skinning core — fit a generated garment mesh to the canonical body
// and give it skin weights by proximity transfer.
//
// Generated garment meshes arrive unrigged, at arbitrary scale, centred
// arbitrarily. Auto-riggers are the wrong tool here — they predict skeletons
// for BODIES. The correct treatment for a garment is the one clothing tools
// use: place it around the reference body it will be worn on, then copy each
// garment vertex's skin influence from the nearest point on the body surface.
// The result deforms exactly like the flesh underneath it, which is the
// definition of a well-skinned garment.
//
// The reference body is the platform's CC0 parametric base
// (public/avatars/parametric-base.glb, mixamorig 52-bone skeleton — every name
// canonicalizes via src/glb-canonicalize.js, so the emitted garment satisfies
// `rig.skeleton: "three.ws-canonical-v1"` in specs/GARMENT_MANIFEST.md).
//
// Pure module: operates on @gltf-transform Documents, no HTTP, no GCS — fully
// unit-testable (tests/garment-forge-skin-transfer.test.js).

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

/**
 * Give every garment vertex the JOINTS_0/WEIGHTS_0 of its nearest body vertex.
 *
 * @param {object} garmentMesh  gltf-transform Mesh (already fitted to the body)
 * @param {object} bodyDoc      the canonical body document
 * @param {object} doc          the OUTPUT document that owns garmentMesh (for accessor creation)
 * @returns {{ transferred: number }}
 */
export function transferSkinWeights(garmentMesh, bodyDoc, doc) {
	const bodyNode = findBodyMesh(bodyDoc);
	if (!bodyNode) throw new Error('canonical body has no skinned mesh');

	// Flatten the body's vertices + skin attributes into parallel arrays.
	const bPos = [];
	const bJoints = [];
	const bWeights = [];
	for (const prim of bodyNode.getMesh().listPrimitives()) {
		const pos = prim.getAttribute('POSITION')?.getArray();
		const joints = prim.getAttribute('JOINTS_0')?.getArray();
		const weights = prim.getAttribute('WEIGHTS_0')?.getArray();
		if (!pos || !joints || !weights) continue;
		for (let i = 0; i < pos.length; i++) bPos.push(pos[i]);
		for (let i = 0; i < joints.length; i++) { bJoints.push(joints[i]); bWeights.push(weights[i]); }
	}
	if (!bPos.length) throw new Error('canonical body mesh has no skinned vertices');

	const bounds = meshBounds(bodyNode.getMesh());
	const diag = Math.hypot(
		bounds.max[0] - bounds.min[0],
		bounds.max[1] - bounds.min[1],
		bounds.max[2] - bounds.min[2],
	);
	const grid = new VertexGrid(new Float32Array(bPos), Math.max(diag / 40, 1e-4));

	const buffer = doc.getRoot().listBuffers()[0] || doc.createBuffer();
	let transferred = 0;
	for (const prim of garmentMesh.listPrimitives()) {
		const pos = prim.getAttribute('POSITION')?.getArray();
		if (!pos) continue;
		const count = pos.length / 3;
		const outJ = new Uint16Array(count * 4);
		const outW = new Float32Array(count * 4);
		for (let v = 0; v < count; v++) {
			const n = grid.nearest(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
			if (n < 0) continue;
			for (let c = 0; c < 4; c++) {
				outJ[v * 4 + c] = bJoints[n * 4 + c];
				outW[v * 4 + c] = bWeights[n * 4 + c];
			}
			transferred++;
		}
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

/**
 * Which body regions this garment covers, measured from where its transferred
 * skin weight actually landed. A region counts as covered once it carries at
 * least `threshold` of the garment's total weight — deliberately low, because
 * the spec says over-declare (hidden skin is invisible, exposed skin is the
 * artefact). The slot's own regions are always included as a floor.
 */
export function deriveOccludes(garmentMesh, skin, slot, threshold = 0.05) {
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

	const out = new Set(SLOT_REGIONS[slot] || []);
	if (total > 0) {
		for (const [region, w] of perRegion) {
			if (w / total >= threshold) out.add(region);
		}
	}
	return BODY_REGIONS.filter((r) => out.has(r));
}
