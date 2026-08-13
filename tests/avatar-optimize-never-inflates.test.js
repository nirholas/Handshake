// /api/avatar/optimize must never hand back more bytes than it was given.
//
// The defect this pins: our stored avatars ship meshopt-compressed, and
// gltf-transform keeps EXT_meshopt_compression attached to the Document after
// reading it. Calling draco() on top re-encoded the meshopt payload AND added
// KHR_draco_mesh_compression beside it, so `?draco=1` returned files 17-19%
// LARGER than the source with no indication that anything had gone wrong.
// Measured on production 2026-08-01: default.glb 748,088 -> 890,160 (+19.0%),
// michelle.glb 849,756 -> 974,036 (+14.6%).
//
// These tests build a real meshopt-compressed GLB in memory and run it through
// the actual pipeline. No network, no fixture files: the source is constructed
// with the same gltf-transform stack the handler uses, so the test reproduces
// the exact "already compressed, now compress it again" shape.

import { describe, expect, it, beforeAll } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { quantize } from '@gltf-transform/functions';

const { optimizeGlb } = await import('../api/avatar/optimize.js');

// A mesh big enough that compression has something to work on. A handful of
// triangles is dominated by JSON overhead and would prove nothing about size.
const GRID = 48;

function buildGrid(doc, scene) {
	const positions = [];
	const normals = [];
	const uvs = [];
	const indices = [];
	for (let y = 0; y <= GRID; y++) {
		for (let x = 0; x <= GRID; x++) {
			// A gentle dome, so normals vary and the data is not trivially
			// compressible into a constant.
			const fx = x / GRID;
			const fy = y / GRID;
			const h = Math.sin(fx * Math.PI) * Math.sin(fy * Math.PI);
			positions.push(fx - 0.5, h * 0.25, fy - 0.5);
			normals.push(0, 1, 0);
			uvs.push(fx, fy);
		}
	}
	for (let y = 0; y < GRID; y++) {
		for (let x = 0; x < GRID; x++) {
			const a = y * (GRID + 1) + x;
			const b = a + 1;
			const c = a + GRID + 1;
			const d = c + 1;
			indices.push(a, c, b, b, c, d);
		}
	}

	const buffer = doc.createBuffer();
	const prim = doc
		.createPrimitive()
		.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer))
		.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(normals)).setBuffer(buffer))
		.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uvs)).setBuffer(buffer))
		.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer))
		.setMaterial(doc.createMaterial('mat').setBaseColorFactor([0.8, 0.8, 0.8, 1]));

	const mesh = doc.createMesh('grid').addPrimitive(prim);
	scene.addChild(doc.createNode('grid').setMesh(mesh));
}

async function meshoptIo() {
	const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
	const meshopt = await import('meshoptimizer');
	const dracoMod = await import('draco3dgltf');
	const draco3d = dracoMod.default ?? dracoMod;
	const [, , decoder, encoder] = await Promise.all([
		meshopt.MeshoptEncoder.ready,
		meshopt.MeshoptDecoder.ready,
		draco3d.createDecoderModule(),
		draco3d.createEncoderModule(),
	]);
	return io.registerDependencies({
		'meshopt.encoder': meshopt.MeshoptEncoder,
		'meshopt.decoder': meshopt.MeshoptDecoder,
		'draco3d.decoder': decoder,
		'draco3d.encoder': encoder,
	});
}

let meshoptSource;
let plainSource;

beforeAll(async () => {
	const io = await meshoptIo();

	const doc = new Document();
	buildGrid(doc, doc.createScene('scene'));
	plainSource = Buffer.from(await io.writeBinary(doc));

	// The same model, quantized and then meshopt-packed: exactly what our stored
	// avatars look like (KHR_mesh_quantization + EXT_meshopt_compression). Both
	// halves matter. Without the quantization the old pipeline happened to shrink
	// this mesh, so a size assertion alone would have passed against the bug;
	// re-quantizing already-quantized attributes is what actually inflates.
	const packed = new Document();
	buildGrid(packed, packed.createScene('scene'));
	await packed.transform(quantize());
	packed
		.createExtension(EXTMeshoptCompression)
		.setRequired(true)
		.setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
	meshoptSource = Buffer.from(await io.writeBinary(packed));
}, 120_000);

describe('optimizeGlb size contract', () => {
	it('builds a genuinely quantized, meshopt-compressed source to work from', () => {
		expect(meshoptSource.byteLength).toBeGreaterThan(0);
		// If either of these stops being true the rest of the file tests nothing:
		// the bug only appears when both are present on the source.
		expect(meshoptSource.includes(Buffer.from('EXT_meshopt_compression'))).toBe(true);
		expect(meshoptSource.includes(Buffer.from('KHR_mesh_quantization'))).toBe(true);
	});

	it('never returns more bytes than it was given for draco=1 on a meshopt source', async () => {
		const { bytes } = await optimizeGlb(meshoptSource, { draco: true });
		expect(bytes.byteLength).toBeLessThanOrEqual(meshoptSource.byteLength);
	});

	it('never returns more bytes than it was given for a plain source', async () => {
		const { bytes } = await optimizeGlb(plainSource, { draco: true });
		expect(bytes.byteLength).toBeLessThanOrEqual(plainSource.byteLength);
	});

	it('emits at most one mesh-compression extension, never draco layered on meshopt', async () => {
		const { bytes } = await optimizeGlb(meshoptSource, { draco: true });
		const hasDraco = bytes.includes(Buffer.from('KHR_draco_mesh_compression'));
		const hasMeshopt = bytes.includes(Buffer.from('EXT_meshopt_compression'));
		expect(hasDraco && hasMeshopt).toBe(false);
	});
});

describe('optimizeGlb reporting contract', () => {
	it('names the scheme the caller actually received', async () => {
		const { scheme } = await optimizeGlb(meshoptSource, { draco: true });
		expect(['draco', 'meshopt', 'none', 'source']).toContain(scheme);
	});

	it('says draco was refused whenever draco was asked for and not applied', async () => {
		const { scheme, refused } = await optimizeGlb(meshoptSource, { draco: true });
		if (scheme === 'draco') {
			expect(refused).toBeNull();
		} else {
			expect(refused).toBe('draco');
		}
	});

	it('never claims a refusal when draco was not requested', async () => {
		const { refused } = await optimizeGlb(meshoptSource, {});
		expect(refused).toBeNull();
	});

	it('reports scheme "source" only when it returns the original bytes untouched', async () => {
		const { bytes, scheme } = await optimizeGlb(meshoptSource, { draco: true });
		if (scheme === 'source') {
			expect(Buffer.from(bytes).equals(meshoptSource)).toBe(true);
		}
	});
});
