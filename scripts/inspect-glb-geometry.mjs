#!/usr/bin/env node
/**
 * Geometry and container inspector for GLB files.
 *
 * scripts/inspect-glb-materials.mjs and scripts/inspect-pbr-channels.mjs both
 * answer questions about surfaces. This one answers questions about the mesh
 * underneath: what the meshes are called, which vertex attributes each
 * primitive actually carries, how those attributes are stored, and which
 * container extensions the file declares.
 *
 * That matters in three places on this platform:
 *
 *   - A primitive with no NORMAL renders flat-shaded, and a primitive with no
 *     TEXCOORD_0 cannot receive any texture a forge lane derives for it, so a
 *     "the model came back untextured" report is often an attribute problem
 *     rather than a texture problem.
 *   - POSITION stored as anything but FLOAT means the mesh is quantized
 *     (KHR_mesh_quantization, usually alongside EXT_meshopt_compression). Most
 *     three.ws avatars are, which is exactly why every mesh-consuming worker
 *     has to decode before it reads (see gltf_meshopt.decode_if_meshopt).
 *   - Mesh and node names are what a rig mapper matches on, so an avatar whose
 *     skeleton will not drive the shared clip library is diagnosed here first.
 *
 *   node scripts/inspect-glb-geometry.mjs public/avatars/default.glb
 *   node scripts/inspect-glb-geometry.mjs public/avatars/     # a whole directory
 *   node scripts/inspect-glb-geometry.mjs --json a.glb b.glb
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, resolve, join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const MODEL_EXTENSIONS = new Set(['.glb', '.gltf']);

// glTF accessor componentType enums. POSITION is FLOAT in an unquantized mesh;
// anything else here means the geometry was compressed on the way in.
const COMPONENT_TYPES = {
	5120: 'BYTE',
	5121: 'UNSIGNED_BYTE',
	5122: 'SHORT',
	5123: 'UNSIGNED_SHORT',
	5125: 'UNSIGNED_INT',
	5126: 'FLOAT',
};

function parseArgs(argv) {
	const args = { inputs: [], json: false };
	for (const raw of argv) {
		if (raw === '--json') args.json = true;
		else if (raw.startsWith('--')) throw new Error(`unknown flag ${raw}`);
		else args.inputs.push(raw);
	}
	return args;
}

async function expand(input) {
	if (/^https?:\/\//i.test(input)) return [input];
	const info = await stat(resolve(input));
	if (!info.isDirectory()) return [input];
	const names = await readdir(resolve(input));
	return names
		.filter((n) => MODEL_EXTENSIONS.has(extname(n).toLowerCase()))
		.sort()
		.map((n) => join(input, n));
}

async function loadBytes(source) {
	if (/^https?:\/\//i.test(source)) {
		const res = await fetch(source, { redirect: 'follow' });
		if (!res.ok) throw new Error(`${source} returned HTTP ${res.status}`);
		return new Uint8Array(await res.arrayBuffer());
	}
	return new Uint8Array(await readFile(resolve(source)));
}

async function makeIO() {
	await MeshoptDecoder.ready;
	return new NodeIO()
		.registerExtensions(ALL_EXTENSIONS)
		.registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
}

export async function inspectGeometry(source) {
	const bytes = await loadBytes(source);
	const io = await makeIO();
	const doc = await io.readBinary(bytes);
	const root = doc.getRoot();

	const meshes = root.listMeshes().map((mesh) => ({
		name: mesh.getName() || '(unnamed)',
		primitives: mesh.listPrimitives().map((prim) => {
			const position = prim.getAttribute('POSITION');
			const indices = prim.getIndices();
			return {
				semantics: prim.listSemantics().sort(),
				vertexCount: position ? position.getCount() : 0,
				indexCount: indices ? indices.getCount() : 0,
				positionComponentType: position
					? COMPONENT_TYPES[position.getComponentType()] || String(position.getComponentType())
					: null,
				positionNormalized: position ? position.getNormalized() : false,
				material: prim.getMaterial()?.getName() || null,
			};
		}),
	}));

	const skins = root.listSkins().map((skin) => ({
		name: skin.getName() || '(unnamed)',
		jointCount: skin.listJoints().length,
	}));

	return {
		source,
		bytes: bytes.byteLength,
		extensionsUsed: root.listExtensionsUsed().map((e) => e.extensionName).sort(),
		extensionsRequired: root.listExtensionsRequired().map((e) => e.extensionName).sort(),
		meshCount: meshes.length,
		// A skin is what makes an avatar drivable by the shared clip library; a
		// mesh with none falls back to the default rig rather than animating.
		skins,
		animations: root.listAnimations().map((a) => a.getName() || '(unnamed)'),
		meshes,
	};
}

function printReport(r) {
	console.log(`\n${r.source}`);
	console.log(`  ${(r.bytes / 1024).toFixed(1)} KiB, ${r.meshCount} mesh(es), ${r.skins.length} skin(s), ${r.animations.length} animation(s)`);
	console.log(`  extensionsUsed      ${r.extensionsUsed.join(', ') || '(none)'}`);
	if (r.extensionsRequired.length) console.log(`  extensionsRequired  ${r.extensionsRequired.join(', ')}`);
	for (const skin of r.skins) console.log(`  skin "${skin.name}"  ${skin.jointCount} joints`);
	if (r.animations.length) console.log(`  animations          ${r.animations.join(', ')}`);
	for (const mesh of r.meshes) {
		console.log(`  mesh "${mesh.name}"`);
		for (const p of mesh.primitives) {
			const quantized = p.positionComponentType && p.positionComponentType !== 'FLOAT';
			console.log(
				`    ${String(p.vertexCount).padStart(7)} verts  ${String(p.indexCount).padStart(7)} indices  POSITION=${p.positionComponentType || 'MISSING'}${quantized ? ' (quantized)' : ''}`,
			);
			console.log(`      attributes  ${p.semantics.join(', ')}`);
			const missing = ['NORMAL', 'TEXCOORD_0'].filter((s) => !p.semantics.includes(s));
			if (missing.length) console.log(`      MISSING     ${missing.join(', ')}`);
			if (p.material) console.log(`      material    ${p.material}`);
		}
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.inputs.length === 0) {
		console.error('usage: node scripts/inspect-glb-geometry.mjs [--json] <glb path, directory, or url>...');
		process.exit(2);
	}

	const sources = [];
	for (const input of args.inputs) sources.push(...(await expand(input)));
	if (sources.length === 0) {
		console.error(`no .glb or .gltf files found in: ${args.inputs.join(', ')}`);
		process.exit(2);
	}

	const reports = [];
	let failures = 0;
	for (const source of sources) {
		try {
			reports.push(await inspectGeometry(source));
		} catch (err) {
			failures++;
			reports.push({ source, error: String(err.message || err) });
		}
	}

	if (args.json) {
		console.log(JSON.stringify({ generatedAt: new Date().toISOString(), models: reports }, null, 2));
	} else {
		for (const r of reports) {
			if (r.error) console.error(`\n${basename(r.source)}\n  ERROR ${r.error}`);
			else printReport(r);
		}
	}
	if (failures > 0) process.exit(2);
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
	main().catch((err) => {
		console.error(err);
		process.exit(2);
	});
}
