// Web optimization, locally.
//
// The report tells a developer what is wrong with a model; this acts on it. The
// same glTF-Transform passes the three.ws asset pipeline runs on every avatar it
// serves (dedup, prune, weld, resample, optional quantize, meshopt) run in the
// extension host and write a sibling file, so a 40 MB export becomes something a
// phone can load without the file ever leaving the machine.

import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, quantize, resample, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { inspectModel } from '../../../src/gltf-inspect.js';

/** The two presets offered in the editor. */
export const PRESETS = Object.freeze({
	balanced: {
		label: 'Balanced',
		detail: 'Dedup, prune, weld, resample animations, meshopt compression. Geometry keeps full precision.',
		quantize: false,
	},
	compact: {
		label: 'Compact',
		detail: 'Everything in Balanced plus vertex quantization (KHR_mesh_quantization): smallest files, tiny precision loss.',
		quantize: true,
	},
});

async function createIO() {
	await MeshoptDecoder.ready;
	await MeshoptEncoder.ready;
	return new WebIO()
		.registerExtensions(ALL_EXTENSIONS)
		.registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

/**
 * @param {Uint8Array} bytes
 * @param {{ preset?: keyof typeof PRESETS }} [opts]
 * @returns {Promise<{ bytes: Uint8Array, before: Summary, after: Summary }>}
 * @typedef {{ fileSize: number, vertices: number, triangles: number, extensions: string[] }} Summary
 */
export async function optimizeGlb(bytes, { preset = 'balanced' } = {}) {
	const settings = PRESETS[preset] || PRESETS.balanced;
	const io = await createIO();
	const doc = await io.readBinary(bytes);
	const passes = [dedup(), prune(), weld(), resample()];
	if (settings.quantize) passes.push(quantize());
	passes.push(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
	await doc.transform(...passes);
	const out = await io.writeBinary(doc);
	const [before, after] = await Promise.all([summarize(bytes), summarize(out)]);
	return { bytes: out, before, after };
}

async function summarize(bytes) {
	const info = await inspectModel(bytes, { fileSize: bytes.byteLength });
	return {
		fileSize: bytes.byteLength,
		vertices: info.counts.totalVertices,
		triangles: info.counts.totalTriangles,
		extensions: info.extensionsUsed,
	};
}

/** One line for the notification: "12.4 MB → 3.1 MB (−75%), 210k → 98k vertices". */
export function describeSavings(before, after) {
	const pct = before.fileSize ? Math.round((1 - after.fileSize / before.fileSize) * 100) : 0;
	const size = `${mb(before.fileSize)} → ${mb(after.fileSize)} (${pct >= 0 ? '−' : '+'}${Math.abs(pct)}%)`;
	const verts =
		before.vertices !== after.vertices
			? `, ${k(before.vertices)} → ${k(after.vertices)} vertices`
			: '';
	return size + verts;
}

function mb(n) {
	return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function k(n) {
	return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}
