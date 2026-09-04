#!/usr/bin/env node
/**
 * PBR channel inspector for GLB files.
 *
 * Answers one question per model: which of the five glTF PBR texture channels
 * does this material actually carry, at what resolution, and which material
 * extensions ride along? A mesh can be geometrically perfect and still read as
 * plastic because the lane that produced it baked a baseColor atlas and nothing
 * else, so every surface reflects the viewer's IBL identically. This script is
 * how that gap is measured rather than guessed.
 *
 *   node scripts/inspect-glb-materials.mjs model.glb
 *   node scripts/inspect-glb-materials.mjs https://.../a.glb https://.../b.glb
 *   node scripts/inspect-glb-materials.mjs --matrix --label=trellis a.glb --label=hunyuan b.glb
 *   node scripts/inspect-glb-materials.mjs --json model.glb > channels.json
 *
 * `--matrix` prints the markdown lane table that lives in
 * workers/texture/README.md; `--json` prints the same data as a machine-readable
 * document for a test or a report to consume. Exit code is 1 when any inspected
 * model is missing a channel that its own materials imply it should have (a
 * metal with no metallicRoughness map, a textured surface with no normal), so
 * this doubles as a regression gate in CI.
 *
 * Reads with @gltf-transform and sharp, both already in the dependency tree.
 */

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

// The five texture slots glTF 2.0 defines on a metallic-roughness material, in
// the order a reader cares about them: what colour is it, what shape is the
// surface, how does it reflect, where is it occluded, does it glow.
export const CHANNELS = Object.freeze([
	{ key: 'baseColor', label: 'baseColor', get: (m) => m.getBaseColorTexture() },
	{ key: 'normal', label: 'normal', get: (m) => m.getNormalTexture() },
	{ key: 'metallicRoughness', label: 'metallicRoughness', get: (m) => m.getMetallicRoughnessTexture() },
	{ key: 'occlusion', label: 'occlusion', get: (m) => m.getOcclusionTexture() },
	{ key: 'emissive', label: 'emissive', get: (m) => m.getEmissiveTexture() },
]);

function parseArgs(argv) {
	const args = { inputs: [], json: false, matrix: false, strict: true };
	let pendingLabel = null;
	for (const raw of argv) {
		if (raw === '--json') args.json = true;
		else if (raw === '--matrix') args.matrix = true;
		else if (raw === '--no-strict') args.strict = false;
		else if (raw.startsWith('--label=')) pendingLabel = raw.slice('--label='.length);
		else if (raw.startsWith('--')) throw new Error(`unknown flag ${raw}`);
		else {
			args.inputs.push({ source: raw, label: pendingLabel || defaultLabel(raw) });
			pendingLabel = null;
		}
	}
	return args;
}

function defaultLabel(source) {
	try {
		if (/^https?:\/\//i.test(source)) return basename(new URL(source).pathname) || source;
	} catch {
		return source;
	}
	return basename(source);
}

/** Fetch a remote GLB or read a local one. Remote failures name the status. */
async function loadBytes(source) {
	if (/^https?:\/\//i.test(source)) {
		const res = await fetch(source, { redirect: 'follow' });
		if (!res.ok) throw new Error(`${source} returned HTTP ${res.status}`);
		return Buffer.from(await res.arrayBuffer());
	}
	return readFile(resolve(source));
}

/**
 * Texture dimensions. glTF stores image bytes without a declared size, so the
 * only honest answer comes from decoding the header; sharp does that without
 * decompressing the pixels.
 */
async function textureInfo(texture) {
	if (!texture) return null;
	const image = texture.getImage();
	const mimeType = texture.getMimeType() || 'unknown';
	const bytes = image ? image.byteLength : 0;
	if (!image) return { present: true, width: null, height: null, mimeType, bytes };
	try {
		const meta = await sharp(Buffer.from(image)).metadata();
		return { present: true, width: meta.width ?? null, height: meta.height ?? null, mimeType, bytes };
	} catch {
		// An encoding sharp cannot parse (KTX2, a truncated buffer) still counts
		// as a present channel; only its resolution is unknown.
		return { present: true, width: null, height: null, mimeType, bytes };
	}
}

function resolutionOf(info) {
	if (!info) return null;
	if (info.width && info.height) return `${info.width}x${info.height}`;
	return 'unknown';
}

/**
 * Channels a material *should* carry, given what it already declares. A flat
 * untextured colour swatch needs nothing; the moment a material carries a
 * baseColor atlas, the absence of a normal map is a real defect rather than a
 * style choice, and a non-zero metalness with no metallicRoughness map means
 * every texel reflects identically.
 */
export function expectedGaps(material, channels) {
	const gaps = [];
	if (!channels.baseColor?.present) return gaps; // untextured material: nothing implied
	if (!channels.normal?.present) gaps.push('normal');
	if (!channels.metallicRoughness?.present) gaps.push('metallicRoughness');
	if (!channels.occlusion?.present) gaps.push('occlusion');
	return gaps;
}

export async function inspectOne({ source, label }) {
	const bytes = await loadBytes(source);
	const io = new NodeIO()
		.registerExtensions(ALL_EXTENSIONS)
		.registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
	await MeshoptDecoder.ready;
	const doc = await io.readBinary(new Uint8Array(bytes));
	const root = doc.getRoot();
	const materials = [];

	for (const material of root.listMaterials()) {
		const channels = {};
		for (const ch of CHANNELS) channels[ch.key] = await textureInfo(ch.get(material));
		materials.push({
			name: material.getName() || '(unnamed)',
			metallicFactor: material.getMetallicFactor(),
			roughnessFactor: material.getRoughnessFactor(),
			alphaMode: material.getAlphaMode(),
			doubleSided: material.getDoubleSided(),
			extensions: material.listExtensions().map((e) => e.extensionName).sort(),
			channels,
			gaps: expectedGaps(material, channels),
		});
	}

	// A primitive with no material takes glTF's default material, whose
	// metallicFactor and roughnessFactor are both 1.0, so it renders as rough bare
	// metal. Counting these separately matters because such a model reports
	// "0 materials" rather than "1 broken material".
	let unmaterialed = 0;
	for (const mesh of root.listMeshes()) {
		for (const prim of mesh.listPrimitives()) if (!prim.getMaterial()) unmaterialed++;
	}

	return {
		label,
		source,
		bytes: bytes.byteLength,
		extensionsUsed: root.listExtensionsUsed().map((e) => e.extensionName).sort(),
		materialCount: materials.length,
		unmaterialedPrimitives: unmaterialed,
		materials,
	};
}

function tick(info) {
	if (!info?.present) return 'no';
	const res = resolutionOf(info);
	return res === 'unknown' ? 'yes' : res;
}

function printReport(report) {
	console.log(`\n${report.label}`);
	console.log('-'.repeat(report.label.length));
	console.log(`  source      ${report.source}`);
	console.log(`  size        ${(report.bytes / 1024).toFixed(1)} KiB`);
	console.log(`  extensions  ${report.extensionsUsed.join(', ') || '(none)'}`);
	if (report.unmaterialedPrimitives > 0) {
		console.log(`  WARNING     ${report.unmaterialedPrimitives} primitive(s) with no material (render as rough metal)`);
	}
	if (report.materialCount === 0) {
		console.log('  materials   (none)');
		return;
	}
	for (const m of report.materials) {
		console.log(`\n  material "${m.name}"`);
		console.log(`    metallic ${m.metallicFactor.toFixed(2)}  roughness ${m.roughnessFactor.toFixed(2)}  alpha ${m.alphaMode}  doubleSided ${m.doubleSided}`);
		for (const ch of CHANNELS) {
			const info = m.channels[ch.key];
			const mime = info?.present ? `  ${info.mimeType}  ${(info.bytes / 1024).toFixed(1)} KiB` : '';
			console.log(`    ${ch.label.padEnd(18)} ${tick(info).padEnd(12)}${mime}`);
		}
		console.log(`    extensions         ${m.extensions.join(', ') || '(none)'}`);
		if (m.gaps.length) console.log(`    MISSING            ${m.gaps.join(', ')}`);
	}
}

/** The markdown lane table that ships in workers/texture/README.md. */
export function printMatrix(reports) {
	const header = ['Lane / model', ...CHANNELS.map((c) => c.label), 'Extensions'];
	const rows = reports.map((r) => {
		// One row per model, collapsing its materials: a channel counts as
		// present only when EVERY material carries it, because a model whose hair
		// has a normal map and whose skin does not still renders a flat face.
		const cells = CHANNELS.map((ch) => {
			if (r.materialCount === 0) return 'no materials';
			const infos = r.materials.map((m) => m.channels[ch.key]);
			if (infos.every((i) => i?.present)) {
				const res = [...new Set(infos.map((i) => resolutionOf(i)))];
				return res.length === 1 ? res[0] : res.join(' / ');
			}
			if (infos.some((i) => i?.present)) return 'partial';
			return 'no';
		});
		const exts = [...new Set(r.materials.flatMap((m) => m.extensions))].sort();
		return [r.label, ...cells, exts.join(', ') || '(none)'];
	});
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
	const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
	console.log('');
	console.log(line(header));
	console.log(`| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`);
	for (const row of rows) console.log(line(row));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.inputs.length === 0) {
		console.error('usage: node scripts/inspect-glb-materials.mjs [--matrix] [--json] [--label=<name>] <glb path or url>...');
		process.exit(2);
	}

	const reports = [];
	let failures = 0;
	for (const input of args.inputs) {
		try {
			reports.push(await inspectOne(input));
		} catch (err) {
			failures++;
			reports.push({ label: input.label, source: input.source, error: String(err.message || err) });
		}
	}

	const ok = reports.filter((r) => !r.error);
	if (args.json) {
		console.log(JSON.stringify({ generatedAt: new Date().toISOString(), models: reports }, null, 2));
	} else if (args.matrix) {
		printMatrix(ok);
	} else {
		for (const r of reports) {
			if (r.error) console.error(`\n${r.label}\n  ERROR ${r.error}`);
			else printReport(r);
		}
	}

	const gapped = ok.filter((r) => r.unmaterialedPrimitives > 0 || r.materials.some((m) => m.gaps.length));
	if (!args.json) {
		console.log('');
		if (gapped.length) {
			console.log(`${gapped.length} of ${ok.length} model(s) missing an implied PBR channel: ${gapped.map((r) => r.label).join(', ')}`);
		} else if (ok.length) {
			console.log(`All ${ok.length} model(s) carry a complete PBR set.`);
		}
	}
	if (failures > 0) process.exit(2);
	if (args.strict && gapped.length > 0) process.exit(1);
}

// Only run the CLI when this file is executed directly; importing it from a
// test or another script must stay side-effect free.
const invokedDirectly =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	main().catch((err) => {
		console.error(err);
		process.exit(2);
	});
}
