#!/usr/bin/env node
/**
 * GLB compression pipeline.
 *
 * Reads GLB files with @gltf-transform, applies a lossless-perceptual transform
 * chain (dedup → prune → resample → quantize → EXT_meshopt_compression) and
 * writes the result back in place — but only if the output is actually smaller.
 *
 *   node scripts/compress-glbs.mjs                       # scan public/ + rider/assets/
 *   node scripts/compress-glbs.mjs public/avatars/x.glb  # explicit file list
 *
 * The output uses EXT_meshopt_compression because the main viewer and the
 * marketplace lobby both wire the meshopt decoder (src/viewer/internal.js).
 * Three.js' GLTFLoader decodes KHR_mesh_quantization natively.
 *
 * Idempotent: reading an already-compressed GLB requires the meshopt *decoder*,
 * which is why both encoder and decoder are registered below. Re-running yields
 * files of similar or smaller size, never growth (growth is detected and the
 * write is skipped).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const DEFAULT_SCAN_DIRS = ['public', 'rider/assets'];

/** Recursively collect every `.glb` under `dir`, excluding any `dist/` segment. */
function collectGlbs(dir) {
	const out = [];
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out; // directory does not exist — skip silently
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'dist' || entry.name === 'node_modules') continue;
			out.push(...collectGlbs(full));
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith('.glb')) {
			out.push(full);
		}
	}
	return out;
}

function resolveTargets(argv) {
	if (argv.length) {
		return argv.map((p) => path.resolve(ROOT, p)).filter((p) => {
			if (!fs.existsSync(p)) {
				console.warn(`[compress] skip (not found): ${p}`);
				return false;
			}
			return true;
		});
	}
	const found = [];
	for (const rel of DEFAULT_SCAN_DIRS) found.push(...collectGlbs(path.join(ROOT, rel)));
	return found;
}

function fmtBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
	await MeshoptEncoder.ready;
	await MeshoptDecoder.ready;

	const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
		'meshopt.encoder': MeshoptEncoder,
		'meshopt.decoder': MeshoptDecoder,
	});

	const targets = resolveTargets(process.argv.slice(2));
	if (!targets.length) {
		console.log('[compress] no GLB files found.');
		return;
	}

	console.log(`[compress] processing ${targets.length} file(s)…\n`);
	const summary = [];

	for (const file of targets) {
		const rel = path.relative(ROOT, file);
		let before;
		try {
			before = fs.statSync(file).size;
		} catch (err) {
			console.warn(`[compress] skip ${rel}: ${err.message}`);
			continue;
		}

		try {
			const document = await io.read(file);
			await document.transform(
				dedup(),
				prune(),
				resample(),
				quantize(),
				meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
				// TODO: add textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 85 })
				// once sharp is wired into the asset pipeline (it needs a native binary).
			);

			const bytes = await io.writeBinary(document);
			const after = bytes.byteLength;

			if (after >= before) {
				console.warn(
					`  ⚠ ${rel}: ${fmtBytes(before)} → ${fmtBytes(after)} (would grow) — keeping original.`,
				);
				summary.push({ rel, before, after: before, pct: 0, status: 'kept (no gain)' });
				continue;
			}

			fs.writeFileSync(file, bytes);
			const pct = ((1 - after / before) * 100).toFixed(1);
			console.log(`  ✓ ${rel}: ${fmtBytes(before)} → ${fmtBytes(after)}  (−${pct}%)`);
			summary.push({ rel, before, after, pct: Number(pct), status: 'compressed' });
		} catch (err) {
			console.error(`  ✗ ${rel}: ${err.message}`);
			summary.push({ rel, before, after: before, pct: 0, status: `error: ${err.message}` });
		}
	}

	// Summary table.
	console.log('\n── Summary ─────────────────────────────────────────────');
	const nameW = Math.max(4, ...summary.map((s) => s.rel.length));
	console.log(
		`${'file'.padEnd(nameW)}  ${'before'.padStart(10)}  ${'after'.padStart(10)}  ${'saved'.padStart(7)}  status`,
	);
	let totalBefore = 0;
	let totalAfter = 0;
	for (const s of summary) {
		totalBefore += s.before;
		totalAfter += s.after;
		console.log(
			`${s.rel.padEnd(nameW)}  ${fmtBytes(s.before).padStart(10)}  ${fmtBytes(s.after).padStart(10)}  ${(s.pct ? `−${s.pct}%` : '—').padStart(7)}  ${s.status}`,
		);
	}
	const totalPct = totalBefore ? ((1 - totalAfter / totalBefore) * 100).toFixed(1) : '0';
	console.log('─'.repeat(56));
	console.log(
		`${'TOTAL'.padEnd(nameW)}  ${fmtBytes(totalBefore).padStart(10)}  ${fmtBytes(totalAfter).padStart(10)}  ${`−${totalPct}%`.padStart(7)}`,
	);
}

main().catch((err) => {
	console.error('[compress] fatal:', err);
	process.exit(1);
});
