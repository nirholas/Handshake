// GLB → flat triangle buffers with a per-triangle tint.
//
// Everything downstream (the rasterizer, the encoders) works on typed arrays:
// one Float32Array of world-space positions (9 floats per triangle), one of
// face normals (3 per triangle), one of linear RGB tints (3 per triangle).
// Node transforms are baked in, so a multi-mesh avatar arrives as one soup.
//
// Colour comes from the material's baseColorFactor and, when a primitive
// carries COLOR_0, the per-vertex colour averaged over the face. Textures are
// not sampled: a terminal cell is far too coarse for texel detail, and a flat
// tint plus lighting reads better at 80 columns than a smeared albedo would.

import { readFile } from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

let ioPromise;

async function getIO() {
	ioPromise ??= (async () => {
		const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
		await MeshoptDecoder.ready;
		const deps = { 'meshopt.decoder': MeshoptDecoder };
		try {
			const draco3d = (await import('draco3dgltf')).default;
			deps['draco3d.decoder'] = await draco3d.createDecoderModule();
		} catch {
			// draco3dgltf is optional: only Draco-compressed inputs need it, and
			// gltf-transform raises its own clear error for those when it is absent.
		}
		return io.registerDependencies(deps);
	})();
	return ioPromise;
}

const TRIANGLES = 4;

/**
 * @typedef {object} Mesh
 * @property {Float32Array} positions  9 floats per triangle, unit-sphere normalised, Y-up
 * @property {Float32Array} normals    3 floats per triangle (face normal)
 * @property {Float32Array} tints      3 floats per triangle, linear RGB in [0,1]
 * @property {number} count            triangle count
 * @property {{ min: number[], max: number[] }} bounds  bounds AFTER normalisation
 * @property {number} sourceCount      triangle count before any stride reduction
 */

/**
 * Parse GLB/glTF bytes into a render-ready mesh.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{ maxTriangles?: number }} [opts]  cap the soup by uniform stride so a
 *   500k-triangle scan still renders at interactive rates; default 240000
 * @returns {Promise<Mesh>}
 */
export async function parseGlb(bytes, { maxTriangles = 240_000 } = {}) {
	const io = await getIO();
	const doc = await io.readBinary(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
	const soup = [];
	const tints = [];
	for (const scene of doc.getRoot().listScenes()) {
		scene.traverse((node) => {
			const mesh = node.getMesh();
			if (!mesh) return;
			const m = node.getWorldMatrix();
			for (const prim of mesh.listPrimitives()) {
				if (prim.getMode() !== TRIANGLES) continue;
				const pos = prim.getAttribute('POSITION');
				if (!pos) continue;
				const col = prim.getAttribute('COLOR_0');
				const base = materialTint(prim.getMaterial());
				const idx = prim.getIndices();
				const count = idx ? idx.getCount() : pos.getCount();
				const p = [];
				const c = [];
				for (let i = 0; i + 2 < count; i += 3) {
					let r = 0, g = 0, b = 0;
					for (let j = 0; j < 3; j++) {
						const vi = idx ? idx.getScalar(i + j) : i + j;
						pos.getElement(vi, p);
						soup.push(
							m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
							m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
							m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
						);
						if (col) {
							col.getElement(vi, c);
							r += c[0]; g += c[1]; b += c[2];
						}
					}
					if (col) tints.push((r / 3) * base[0], (g / 3) * base[1], (b / 3) * base[2]);
					else tints.push(base[0], base[1], base[2]);
				}
			}
		});
	}
	return finishMesh(new Float32Array(soup), new Float32Array(tints), maxTriangles);
}

/**
 * Load a GLB from disk.
 * @param {string} path
 * @param {{ maxTriangles?: number }} [opts]
 */
export async function loadGlbFile(path, opts) {
	return parseGlb(await readFile(path), opts);
}

function materialTint(mat) {
	if (!mat) return [0.82, 0.82, 0.86];
	const f = mat.getBaseColorFactor();
	// A pure-white factor on a textured material carries no colour information;
	// lean on a warm neutral so lit skin and cloth do not read as chalk.
	if (mat.getBaseColorTexture() && f[0] > 0.98 && f[1] > 0.98 && f[2] > 0.98) return [0.86, 0.78, 0.72];
	return [f[0], f[1], f[2]];
}

/**
 * Normalise to the unit sphere, drop to a triangle budget, and compute face
 * normals. Exported so tests can feed a synthetic soup without a GLB.
 *
 * @param {Float32Array} positions 9 floats per triangle
 * @param {Float32Array} tints 3 floats per triangle
 * @param {number} maxTriangles
 * @returns {Mesh}
 */
export function finishMesh(positions, tints, maxTriangles = 240_000) {
	const sourceCount = positions.length / 9;
	let pos = positions;
	let tint = tints;
	if (sourceCount > maxTriangles) {
		const stride = Math.ceil(sourceCount / maxTriangles);
		const keep = Math.floor(sourceCount / stride);
		pos = new Float32Array(keep * 9);
		tint = new Float32Array(keep * 3);
		for (let i = 0; i < keep; i++) {
			pos.set(positions.subarray(i * stride * 9, i * stride * 9 + 9), i * 9);
			tint.set(tints.subarray(i * stride * 3, i * stride * 3 + 3), i * 3);
		}
	}
	const count = pos.length / 9;
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < pos.length; i += 3) {
		for (let a = 0; a < 3; a++) {
			const v = pos[i + a];
			if (v < min[a]) min[a] = v;
			if (v > max[a]) max[a] = v;
		}
	}
	const cx = (min[0] + max[0]) / 2;
	const cy = (min[1] + max[1]) / 2;
	const cz = (min[2] + max[2]) / 2;
	let radius = 0;
	for (let i = 0; i < pos.length; i += 3) {
		const d = Math.hypot(pos[i] - cx, pos[i + 1] - cy, pos[i + 2] - cz);
		if (d > radius) radius = d;
	}
	const s = radius > 1e-9 ? 1 / radius : 1;
	const out = new Float32Array(pos.length);
	for (let i = 0; i < pos.length; i += 3) {
		out[i] = (pos[i] - cx) * s;
		out[i + 1] = (pos[i + 1] - cy) * s;
		out[i + 2] = (pos[i + 2] - cz) * s;
	}
	const normals = new Float32Array(count * 3);
	for (let t = 0; t < count; t++) {
		const o = t * 9;
		const ux = out[o + 3] - out[o], uy = out[o + 4] - out[o + 1], uz = out[o + 5] - out[o + 2];
		const wx = out[o + 6] - out[o], wy = out[o + 7] - out[o + 1], wz = out[o + 8] - out[o + 2];
		let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
		const len = Math.hypot(nx, ny, nz);
		if (len > 1e-12) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 0; nz = 1; }
		normals[t * 3] = nx; normals[t * 3 + 1] = ny; normals[t * 3 + 2] = nz;
	}
	return {
		positions: out,
		normals,
		tints: tint,
		count,
		sourceCount,
		bounds: {
			min: [(min[0] - cx) * s, (min[1] - cy) * s, (min[2] - cz) * s],
			max: [(max[0] - cx) * s, (max[1] - cy) * s, (max[2] - cz) * s],
		},
	};
}
