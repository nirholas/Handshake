// Signed distance over an arbitrary triangle soup, for the two operations that
// cannot be done with topology alone: reconstructing a solid from a mesh whose
// topology is beyond repair, and eroding a solid to hollow it.
//
// Why a voxel sign instead of ray parity: an AI-generated mesh has holes, and
// ray parity through a hole flips the answer for an entire column of samples,
// which reads as a tunnel bored through the middle of the print. Flood-filling
// the outside instead means a hole smaller than one voxel simply cannot leak,
// and a hole larger than one voxel is a hole the buyer should be told about
// (the analyzer already reports it) rather than one silently sealed.
//
// Cost model, measured on this machine: the distance query is a three-mesh-bvh
// closest-point call (microseconds) and Manifold's level-set evaluates it once
// per grid sample. At the default budget that is ~250k samples and about two
// seconds, so this path stays inside a request; the caller bounds it further by
// passing a smaller `maxSamples`.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

import { boundsOf } from './mesh-io.js';

// Grid ceiling. 2.1M cells is a 128-cube: enough that a 10 cm print resolves
// features under a millimetre, and small enough that the flood fill stays a
// typed-array walk rather than a memory event.
export const MAX_GRID_CELLS = 128 ** 3;
// Sample ceiling for the level-set evaluation itself, which is the wall-clock
// cost the caller actually feels.
export const DEFAULT_MAX_SAMPLES = 400_000;

const OUTSIDE = 1;

/**
 * Build the occupancy grid and flood-fill the outside.
 *
 * Triangles are rasterized conservatively (every cell their bounding box
 * touches is marked as surface), so the fill can never cross the shell through
 * a diagonal gap. What the fill reaches from the padded border is outside;
 * everything else, surface cells included, is inside.
 */
function buildInsideMask(positions, indices, min, size, dims) {
	const [nx, ny, nz] = dims;
	const cell = [size[0] / nx, size[1] / ny, size[2] / nz];
	const mask = new Uint8Array(nx * ny * nz);
	const idx = (x, y, z) => (z * ny + y) * nx + x;

	for (let t = 0; t + 2 < indices.length; t += 3) {
		let lo0 = Infinity, lo1 = Infinity, lo2 = Infinity;
		let hi0 = -Infinity, hi1 = -Infinity, hi2 = -Infinity;
		for (let k = 0; k < 3; k += 1) {
			const v = indices[t + k] * 3;
			const x = positions[v], y = positions[v + 1], z = positions[v + 2];
			if (x < lo0) lo0 = x; if (x > hi0) hi0 = x;
			if (y < lo1) lo1 = y; if (y > hi1) hi1 = y;
			if (z < lo2) lo2 = z; if (z > hi2) hi2 = z;
		}
		const x0 = Math.max(0, Math.floor((lo0 - min[0]) / cell[0]));
		const x1 = Math.min(nx - 1, Math.floor((hi0 - min[0]) / cell[0]));
		const y0 = Math.max(0, Math.floor((lo1 - min[1]) / cell[1]));
		const y1 = Math.min(ny - 1, Math.floor((hi1 - min[1]) / cell[1]));
		const z0 = Math.max(0, Math.floor((lo2 - min[2]) / cell[2]));
		const z1 = Math.min(nz - 1, Math.floor((hi2 - min[2]) / cell[2]));
		for (let z = z0; z <= z1; z += 1) {
			for (let y = y0; y <= y1; y += 1) {
				for (let x = x0; x <= x1; x += 1) mask[idx(x, y, z)] = 2;
			}
		}
	}

	// Flood the outside from every border cell. An explicit stack, not
	// recursion: a 128-cube can queue millions of cells.
	const stack = [];
	for (let z = 0; z < nz; z += 1) {
		for (let y = 0; y < ny; y += 1) {
			for (let x = 0; x < nx; x += 1) {
				const border = x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1;
				if (!border) continue;
				const i = idx(x, y, z);
				if (mask[i] === 0) {
					mask[i] = OUTSIDE;
					stack.push(x, y, z);
				}
			}
		}
	}
	while (stack.length) {
		const z = stack.pop(), y = stack.pop(), x = stack.pop();
		for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
			const a = x + dx, b = y + dy, c = z + dz;
			if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
			const i = idx(a, b, c);
			if (mask[i] !== 0) continue;
			mask[i] = OUTSIDE;
			stack.push(a, b, c);
		}
	}
	return { mask, cell, idx };
}

/**
 * A signed-distance sampler over a triangle soup. Positive inside, which is the
 * convention Manifold's level-set extractor expects (its interior is where the
 * function exceeds the level).
 *
 * @param {Float64Array} positions
 * @param {Uint32Array} indices
 * @param {{ padding?: number, maxCells?: number }} [opts] padding is a fraction
 *   of the longest bounding-box axis; the grid needs at least one empty cell
 *   outside the mesh for the flood fill to start.
 */
export function buildSignedDistance(positions, indices, opts = {}) {
	const bounds = boundsOf(positions);
	if (!bounds) throw new Error('cannot build a distance field for an empty mesh');
	const pad = (opts.padding ?? 0.06) * bounds.longest;
	const min = bounds.min.map((v) => v - pad);
	const size = bounds.size.map((v) => v + pad * 2);
	const maxCells = Math.min(opts.maxCells ?? MAX_GRID_CELLS, MAX_GRID_CELLS);

	// One cell edge for all three axes keeps the distance field isotropic; the
	// per-axis counts then follow the bounding box's own proportions.
	const volume = size[0] * size[1] * size[2];
	let edge = Math.cbrt(volume / maxCells);
	if (!(edge > 0)) edge = bounds.longest / 32;
	const dims = size.map((v) => Math.max(4, Math.min(256, Math.ceil(v / edge))));

	const { mask, cell, idx } = buildInsideMask(positions, indices, min, size, dims);

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(positions), 3));
	geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(indices), 1));
	const bvh = new MeshBVH(geometry);

	const point = new THREE.Vector3();
	const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
	const [nx, ny, nz] = dims;

	function inside(x, y, z) {
		const ix = Math.min(nx - 1, Math.max(0, Math.floor((x - min[0]) / cell[0])));
		const iy = Math.min(ny - 1, Math.max(0, Math.floor((y - min[1]) / cell[1])));
		const iz = Math.min(nz - 1, Math.max(0, Math.floor((z - min[2]) / cell[2])));
		return mask[idx(ix, iy, iz)] !== OUTSIDE;
	}

	function distance(x, y, z) {
		point.set(x, y, z);
		bvh.closestPointToPoint(point, hit);
		return hit.distance;
	}

	return {
		bounds: { min, max: [min[0] + size[0], min[1] + size[1], min[2] + size[2]] },
		dims,
		cellEdge: Math.max(cell[0], cell[1], cell[2]),
		bvh,
		geometry,
		inside,
		distance,
		/** Positive inside, negative outside, in the mesh's own units. */
		sample(x, y, z) {
			const d = distance(x, y, z);
			return inside(x, y, z) ? d : -d;
		},
	};
}

/**
 * Extract a guaranteed-manifold solid from a distance field at the given level.
 * A positive level erodes (the surface moves inward), which is how hollowing
 * finds its inner wall; level 0 reconstructs the original surface.
 *
 * `edgeLength` trades fidelity for triangles and time. It defaults to the
 * field's own cell size, because asking for detail finer than the field
 * resolves only adds triangles that carry no information.
 */
export function extractLevelSet(wasm, field, { level = 0, edgeLength, maxSamples = DEFAULT_MAX_SAMPLES } = {}) {
	const span = [
		field.bounds.max[0] - field.bounds.min[0],
		field.bounds.max[1] - field.bounds.min[1],
		field.bounds.max[2] - field.bounds.min[2],
	];
	let edge = edgeLength || field.cellEdge;
	// Hold the evaluation inside the sample budget: the level-set walks a grid of
	// its own, and its cost is what the caller waits on.
	const budgetEdge = Math.cbrt((span[0] * span[1] * span[2]) / maxSamples);
	if (edge < budgetEdge) edge = budgetEdge;
	const solid = wasm.Manifold.levelSet(
		(p) => field.sample(p[0], p[1], p[2]) - level,
		{ min: field.bounds.min, max: field.bounds.max },
		edge,
	);
	return { solid, edgeLength: edge };
}
