#!/usr/bin/env node
/**
 * GLB optimization pipeline.
 *
 * Lossless geometry passes + WebP texture re-encode. Output GLBs use only the
 * standard glTF 2.0 feature set — no EXT_meshopt_compression, no KHR_draco — so
 * they load in every GLTFLoader site without decoder wiring.
 *
 * Run: npm run optimize:glb            (process all GLBs, in-place with .bak)
 *      npm run optimize:glb -- --dry   (report-only, no writes)
 *      npm run optimize:glb -- <path>  (single file)
 */
import { readFileSync, writeFileSync, statSync, renameSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve, relative, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, weld, textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const explicit = args.filter((a) => !a.startsWith('--'));

// Directories to scan when no explicit paths are given.
const SCAN_DIRS = ['assets', 'public', 'rider/assets'];

async function walkGlb(dir) {
	const out = [];
	const abs = resolve(ROOT, dir);
	if (!existsSync(abs)) return out;
	const stack = [abs];
	while (stack.length) {
		const cur = stack.pop();
		const entries = await readdir(cur, { withFileTypes: true });
		for (const e of entries) {
			const p = join(cur, e.name);
			if (e.isDirectory()) stack.push(p);
			else if (e.isFile() && extname(e.name).toLowerCase() === '.glb') out.push(p);
		}
	}
	return out;
}

function fmt(bytes) {
	if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
	if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
	return bytes + ' B';
}

// Most avatars here ship compressed (EXT_meshopt_compression, Draco on a few
// imports). Registering the extensions alone is not enough: gltf-transform needs the
// matching codec dependencies, or every compressed file fails to read with
// "Please install extension dependency". Build the IO once, decoders included.
async function buildIO() {
	await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
	return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
		'meshopt.decoder': MeshoptDecoder,
		'meshopt.encoder': MeshoptEncoder,
		'draco3d.decoder': await draco3d.createDecoderModule(),
		'draco3d.encoder': await draco3d.createEncoderModule(),
	});
}

const io = await buildIO();

// Output is plain glTF 2.0 by contract (see the header): drop the compression
// extensions after decoding so writeBinary does not re-encode what we just read.
const COMPRESSION_EXTENSIONS = new Set(['EXT_meshopt_compression', 'KHR_draco_mesh_compression']);

async function optimizeOne(absPath) {
	const before = statSync(absPath).size;
	const doc = await io.read(absPath);

	for (const ext of doc.getRoot().listExtensionsUsed()) {
		if (COMPRESSION_EXTENSIONS.has(ext.extensionName)) ext.dispose();
	}

	await doc.transform(
		dedup(),
		weld(),
		resample(),
		prune({ keepLeaves: false, keepAttributes: false }),
		textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 85 }),
	);

	const bytes = await io.writeBinary(doc);
	const after = bytes.byteLength;
	const rel = relative(ROOT, absPath);

	if (after >= before) {
		console.log(`  skip  ${rel}  ${fmt(before)} → ${fmt(after)} (no gain)`);
		return { before, after: before, written: false };
	}

	if (!DRY) {
		const bak = absPath + '.bak';
		if (!existsSync(bak)) renameSync(absPath, bak);
		writeFileSync(absPath, bytes);
	}
	const pct = (((before - after) / before) * 100).toFixed(1);
	console.log(`  ${DRY ? 'would' : 'wrote'}  ${rel}  ${fmt(before)} → ${fmt(after)}  (-${pct}%)`);
	return { before, after, written: !DRY };
}

async function main() {
	let targets = [];
	if (explicit.length) {
		targets = explicit.map((p) => resolve(ROOT, p));
	} else {
		for (const d of SCAN_DIRS) targets.push(...(await walkGlb(d)));
	}
	targets = [...new Set(targets)].sort();

	if (!targets.length) {
		console.error('no .glb files found');
		process.exit(1);
	}

	console.log(`${DRY ? '[dry-run] ' : ''}optimizing ${targets.length} GLB file(s)`);
	let totalBefore = 0;
	let totalAfter = 0;
	for (const t of targets) {
		try {
			const r = await optimizeOne(t);
			totalBefore += r.before;
			totalAfter += r.after;
		} catch (err) {
			console.error(`  FAIL  ${relative(ROOT, t)}  ${err.message}`);
			process.exitCode = 1;
		}
	}
	const pct = totalBefore ? (((totalBefore - totalAfter) / totalBefore) * 100).toFixed(1) : '0.0';
	console.log(`\ntotal: ${fmt(totalBefore)} → ${fmt(totalAfter)}  (-${pct}%)`);
}

main();
