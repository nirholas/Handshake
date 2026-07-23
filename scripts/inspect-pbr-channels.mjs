#!/usr/bin/env node
/**
 * PBR channel matrix — audits which physically-based material channels a GLB
 * actually carries: baseColor/albedo, normal, metallicRoughness, occlusion
 * (packed or standalone), emissive, and the real-material KHR extensions
 * (clearcoat, transmission, sheen, IOR, anisotropy, volume).
 *
 * This is prompt 04's audit tool ("build a small scripts/ inspection tool"):
 * point it at any local file or public https URL and it prints, per material,
 * which channels exist as textures vs. flat factors vs. missing entirely —
 * the ground truth for "does this forge lane emit a full PBR set or just
 * albedo" without opening the GLB in a 3D editor by hand.
 *
 * Usage:
 *   node scripts/inspect-pbr-channels.mjs <path-or-url> [<path-or-url> ...]
 *   node scripts/inspect-pbr-channels.mjs --json <path-or-url>   # machine-readable
 *
 * Examples:
 *   node scripts/inspect-pbr-channels.mjs public/avatars/fox.glb
 *   node scripts/inspect-pbr-channels.mjs https://storage.googleapis.com/three-ws-avatar-reconstructions/mesh.glb
 */
import { readFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

async function makeIO() {
	await MeshoptDecoder.ready;
	return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
}

const KHR_EXTENSION_LABELS = {
	KHR_materials_clearcoat: 'clearcoat',
	KHR_materials_transmission: 'transmission',
	KHR_materials_sheen: 'sheen',
	KHR_materials_ior: 'ior',
	KHR_materials_anisotropy: 'anisotropy',
	KHR_materials_volume: 'volume',
	KHR_materials_specular: 'specular',
	KHR_materials_emissive_strength: 'emissiveStrength',
	KHR_materials_unlit: 'unlit',
};

async function loadBytes(source) {
	if (/^https?:\/\//i.test(source)) {
		const resp = await fetch(source);
		if (!resp.ok) throw new Error(`fetch ${source} failed: ${resp.status}`);
		return new Uint8Array(await resp.arrayBuffer());
	}
	return new Uint8Array(readFileSync(source));
}

function textureLabel(tex) {
	if (!tex) return null;
	const size = tex.getSize();
	const mime = tex.getMimeType();
	return `${size ? `${size[0]}x${size[1]}` : '?'} ${mime || ''}`.trim();
}

async function inspect(source) {
	const bytes = await loadBytes(source);
	const io = await makeIO();
	const doc = await io.readBinary(bytes);
	const root = doc.getRoot();
	const materials = root.listMaterials();

	const report = {
		source,
		bytes: bytes.byteLength,
		materialCount: materials.length,
		textureCount: root.listTextures().length,
		materials: [],
	};

	for (const mat of materials) {
		const channels = {
			baseColor: mat.getBaseColorTexture()
				? { kind: 'texture', detail: textureLabel(mat.getBaseColorTexture()) }
				: { kind: 'factor', detail: mat.getBaseColorFactor() },
			metallicRoughness: mat.getMetallicRoughnessTexture()
				? { kind: 'texture', detail: textureLabel(mat.getMetallicRoughnessTexture()) }
				: { kind: 'factor', detail: { metallic: mat.getMetallicFactor(), roughness: mat.getRoughnessFactor() } },
			normal: mat.getNormalTexture() ? { kind: 'texture', detail: textureLabel(mat.getNormalTexture()) } : { kind: 'missing' },
			occlusion: mat.getOcclusionTexture()
				? {
						kind: 'texture',
						// glTF packs AO in the metallicRoughness texture's R channel by
						// convention when the two textures are the same image.
						packed: mat.getOcclusionTexture() === mat.getMetallicRoughnessTexture(),
						detail: textureLabel(mat.getOcclusionTexture()),
					}
				: { kind: 'missing' },
			emissive: mat.getEmissiveTexture()
				? { kind: 'texture', detail: textureLabel(mat.getEmissiveTexture()) }
				: { kind: 'factor', detail: mat.getEmissiveFactor() },
		};

		const extensions = {};
		for (const [name, label] of Object.entries(KHR_EXTENSION_LABELS)) {
			const ext = mat.getExtension(name);
			if (ext) extensions[label] = true;
		}

		report.materials.push({
			name: mat.getName() || '(unnamed)',
			channels,
			extensions,
		});
	}

	return report;
}

function fmtChannel(ch) {
	if (ch.kind === 'missing') return 'MISSING';
	if (ch.kind === 'texture') return `tex(${ch.detail})${ch.packed ? ' [packed w/ metallicRoughness]' : ''}`;
	return `factor(${JSON.stringify(ch.detail)})`;
}

function printHuman(report) {
	console.log(`\n${report.source}`);
	console.log(`  ${report.bytes.toLocaleString()} bytes, ${report.materialCount} material(s), ${report.textureCount} texture(s)`);
	for (const mat of report.materials) {
		console.log(`  material "${mat.name}"`);
		for (const [ch, val] of Object.entries(mat.channels)) {
			console.log(`    ${ch.padEnd(18)} ${fmtChannel(val)}`);
		}
		const extNames = Object.keys(mat.extensions);
		console.log(`    ${'extensions'.padEnd(18)} ${extNames.length ? extNames.join(', ') : 'none'}`);
	}
}

async function main() {
	const args = process.argv.slice(2);
	const jsonMode = args.includes('--json');
	const sources = args.filter((a) => a !== '--json');
	if (!sources.length) {
		console.error('usage: node scripts/inspect-pbr-channels.mjs [--json] <path-or-url> [...]');
		process.exit(1);
	}

	const reports = [];
	for (const source of sources) {
		try {
			reports.push(await inspect(source));
		} catch (err) {
			reports.push({ source, error: err.message });
		}
	}

	if (jsonMode) {
		console.log(JSON.stringify(reports, null, 2));
		return;
	}
	for (const report of reports) {
		if (report.error) {
			console.error(`\n${report.source}\n  ERROR: ${report.error}`);
			continue;
		}
		printHuman(report);
	}
}

main();
