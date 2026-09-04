import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	compressGlb,
	COMPRESSION_MODES,
	deliveryCompressionOptions,
	DELIVERY_TEXTURE_MAX_PX,
} from '../api/_lib/glb-compress.js';
import { inspectGlb } from '../api/_lib/glb-inspect.js';

const avatar = (name) => resolve(process.cwd(), 'public/avatars', name);
// A real, bundled static mesh — the honest input for a compression round-trip.
const FIXTURE = ['fox.glb', 'mannequin.glb', 'cesium-man.glb'].map(avatar).find(existsSync);

describe('compressGlb', () => {
	it('rejects an unknown mode', async () => {
		await expect(compressGlb(Buffer.alloc(64), { mode: 'zip' })).rejects.toThrow(/unsupported/);
	});

	it('rejects a non-GLB buffer', async () => {
		await expect(compressGlb(Buffer.from('nope'), { mode: 'meshopt' })).rejects.toThrow();
	});

	it.runIf(FIXTURE)(
		'meshopt produces a valid GLB tagged with EXT_meshopt_compression',
		async () => {
			const src = readFileSync(FIXTURE);
			const r = await compressGlb(src, { mode: 'meshopt' });
			expect(r.mode).toBe('meshopt');
			expect(r.outputBytes).toBeGreaterThan(0);
			expect(r.extensionsUsed).toContain('EXT_meshopt_compression');
			// Still a structurally valid binary glTF 2.0.
			const info = inspectGlb(r.buffer);
			expect(info).toBeTruthy();
			expect(info.meshCount).toBeGreaterThan(0);
		},
		60_000,
	);

	it.runIf(FIXTURE)(
		'draco produces a valid GLB tagged with KHR_draco_mesh_compression',
		async () => {
			const src = readFileSync(FIXTURE);
			const r = await compressGlb(src, { mode: 'draco' });
			expect(r.mode).toBe('draco');
			expect(r.extensionsUsed).toContain('KHR_draco_mesh_compression');
			const info = inspectGlb(r.buffer);
			expect(info).toBeTruthy();
			expect(info.meshCount).toBeGreaterThan(0);
		},
		60_000,
	);

	it('advertises exactly the two supported modes', () => {
		expect(COMPRESSION_MODES).toEqual(['draco', 'meshopt']);
	});

	it('leaves textures alone unless the caller asks for them', async () => {
		// The geometry-only contract is what `output_format: glb-meshopt` promises,
		// and it is also what keeps that request fast: no sharp, no re-encode.
		expect(deliveryCompressionOptions().textures).toBeTruthy();
	});
});

// A textured mesh is where the delivery preset earns its keep: on real forge
// output the embedded PNG skins, not the vertex data, are what push a model past
// what a phone will wait for.
const TEXTURED = ['selfie-girl.glb', 'realistic-male.glb', 'michelle.glb'].map(avatar).find(existsSync);

describe('deliveryCompressionOptions', () => {
	it('is meshopt geometry plus a capped WebP texture pass', () => {
		const opts = deliveryCompressionOptions();
		expect(opts.mode).toBe('meshopt');
		expect(opts.textures.maxSize).toBe(DELIVERY_TEXTURE_MAX_PX);
	});

	it.runIf(TEXTURED)(
		're-encodes textures to WebP and keeps the mesh structurally valid',
		async () => {
			const src = readFileSync(TEXTURED);
			const r = await compressGlb(src, deliveryCompressionOptions());
			expect(r.extensionsUsed).toContain('EXT_meshopt_compression');
			expect(r.extensionsUsed).toContain('EXT_texture_webp');
			expect(r.textures.converted).toBeGreaterThan(0);
			expect(r.outputBytes).toBeLessThan(r.inputBytes);
			const info = inspectGlb(r.buffer);
			expect(info).toBeTruthy();
			expect(info.meshCount).toBeGreaterThan(0);
		},
		180_000,
	);

	it.runIf(TEXTURED)(
		'preserves the skinning and animation a rigged avatar depends on',
		async () => {
			// Losing a skin here would silently un-rig every avatar the delivery
			// path touches, and the loss would only show up as a T-pose in a
			// viewer, so it is pinned on real bytes rather than trusted.
			const { NodeIO } = await import('@gltf-transform/core');
			const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
			const { MeshoptEncoder, MeshoptDecoder } = await import('meshoptimizer');
			await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
			const io = new NodeIO()
				.registerExtensions(ALL_EXTENSIONS)
				.registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
			const count = async (bytes) => {
				const root = (await io.readBinary(new Uint8Array(bytes))).getRoot();
				return {
					skins: root.listSkins().length,
					animations: root.listAnimations().length,
					meshes: root.listMeshes().length,
				};
			};
			const src = readFileSync(TEXTURED);
			const r = await compressGlb(src, deliveryCompressionOptions());
			expect(await count(r.buffer)).toEqual(await count(src));
		},
		180_000,
	);

	it('survives a texture whose header lies about its dimensions', async () => {
		// Three of six production forge meshes sampled on 2026-09-04 carried a PNG
		// that @gltf-transform's header parser read as 65536x4292542531, which made
		// its own `textureCompress({ resize })` throw and took the whole
		// compression pass (geometry win included) down with it. The pass now reads
		// dimensions from the encoder that is about to decode the bytes, and
		// isolates every texture, so a bad skin costs that skin and nothing else.
		const { NodeIO, Document } = await import('@gltf-transform/core');
		const doc = new Document();
		const buffer = doc.createBuffer();
		const position = doc
			.createAccessor()
			.setType('VEC3')
			.setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
			.setBuffer(buffer);
		const texture = doc
			.createTexture('broken')
			.setMimeType('image/png')
			.setImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
		const material = doc.createMaterial('m').setBaseColorTexture(texture);
		const prim = doc.createPrimitive().setAttribute('POSITION', position).setMaterial(material);
		doc.createNode('n').setMesh(doc.createMesh('mesh').addPrimitive(prim));
		doc.createScene().addChild(doc.getRoot().listNodes()[0]);
		const bytes = await new NodeIO().writeBinary(doc);

		const r = await compressGlb(bytes, deliveryCompressionOptions());
		expect(r.textures.skipped).toBeGreaterThan(0);
		expect(r.textures.converted).toBe(0);
		expect(inspectGlb(r.buffer)).toBeTruthy();
	}, 60_000);
});
