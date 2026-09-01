#!/usr/bin/env node
// Compacts the baked animation clips in public/animations/clips/*.json.
//
// The baker serializes three.js AnimationClips with JSON.stringify, which prints
// every float32 keyframe at double precision: `0.03333333507180214` for a
// 1/30 s timestamp, 17 digits for a number that only ever carried 7. Across a
// 15 s clip that is ~2.5 MB of JSON (900 KB gzipped) for the home page's idle
// loop alone, and 138 MB across the library. Printing each number at 7
// significant digits is lossless for float32 data at the precision the mixer
// consumes (a quaternion component or a hip offset is not observable past the
// sixth digit) and roughly halves both the raw and the compressed size.
//
// Usage:
//   node scripts/compact-clips.mjs            rewrite every clip + the manifest
//   node scripts/compact-clips.mjs --check    exit 1 if any file is not compact
//
// build-animations.mjs applies compactClipJson() to every clip it writes, so a
// fresh bake is already compact; the CLI exists for the committed artifacts
// (their sources are deliberately not in the repo) and as a guard.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIGNIFICANT_DIGITS = 7;

export function compactNumber(n) {
	if (!Number.isFinite(n) || Number.isInteger(n)) return n;
	const rounded = Number(n.toPrecision(SIGNIFICANT_DIGITS));
	return Object.is(rounded, -0) ? 0 : rounded;
}

// Deep copy with every number compacted. Track arrays (times/values) are the
// bulk of a clip; the walk also reaches `duration` and any nested metadata.
export function compactClipJson(value) {
	if (typeof value === 'number') return compactNumber(value);
	if (Array.isArray(value)) return value.map(compactClipJson);
	if (value && typeof value === 'object') {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = compactClipJson(v);
		return out;
	}
	return value;
}

export function compactClipText(text) {
	return JSON.stringify(compactClipJson(JSON.parse(text)));
}

function main() {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
	const clipsDir = resolve(root, 'public/animations/clips');
	const manifest = resolve(root, 'public/animations/manifest.json');
	const check = process.argv.includes('--check');
	const files = readdirSync(clipsDir)
		.filter((f) => f.endsWith('.json') && !f.startsWith('.'))
		.map((f) => resolve(clipsDir, f));
	files.push(manifest);
	let before = 0;
	let after = 0;
	let stale = 0;
	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		const compact = file === manifest
			? JSON.stringify(compactClipJson(JSON.parse(text)), null, '\t') + '\n'
			: compactClipText(text);
		before += Buffer.byteLength(text);
		after += Buffer.byteLength(compact);
		if (compact === text) continue;
		stale++;
		if (!check) writeFileSync(file, compact);
	}
	const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
	if (check) {
		if (stale) {
			console.error(`[compact-clips] ${stale} file(s) are not compact (${mb(before)} -> ${mb(after)}); run: node scripts/compact-clips.mjs`);
			process.exit(1);
		}
		console.log(`[compact-clips] ${files.length} files compact (${mb(after)})`);
		return;
	}
	console.log(`[compact-clips] rewrote ${stale}/${files.length} files: ${mb(before)} -> ${mb(after)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
