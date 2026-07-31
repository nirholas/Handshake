#!/usr/bin/env node
// Measure every baked clip and write public/animations/signatures.json.
//
// The index is a static artifact on purpose. Analysing 112 clips takes a couple
// of seconds and the answer only changes when a clip is rebaked, so paying that
// cost per page view (or per API call) would be waste. Everything downstream
// reads the JSON: the /gestures page, the /animations gallery, and the tests
// that hold the walk-layer table to what the motion actually does.
//
// Usage:
//   node scripts/build-motion-signatures.mjs          write the index
//   node scripts/build-motion-signatures.mjs --check   fail if it is stale
//
// Wired into `npm run build:animations`, so rebaking a clip regenerates it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeClip, SIGNATURE_VERSION } from '../src/runtime/motion-signature.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIPS_DIR = path.join(ROOT, 'public/animations/clips');
const MANIFEST = path.join(ROOT, 'public/animations/manifest.json');
const OUT = path.join(ROOT, 'public/animations/signatures.json');

/**
 * Analyse every clip on disk, keyed by clip name.
 * @returns {{version:number, count:number, clips:Object}}
 */
export function buildIndex() {
	const files = fs
		.readdirSync(CLIPS_DIR)
		.filter((f) => f.endsWith('.json') && !f.startsWith('.'))
		.sort();

	const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
	const declaredLoop = new Map(manifest.map((entry) => [entry.name, !!entry.loop]));

	const clips = {};
	for (const file of files) {
		const clip = JSON.parse(fs.readFileSync(path.join(CLIPS_DIR, file), 'utf8'));
		const sig = analyzeClip(clip);
		if (!sig.clip) sig.clip = path.basename(file, '.json');
		// The manifest's loop flag is the authoring intent; `loopClean` is what
		// the keyframes support. Carrying both is what lets a report say "this
		// one is declared as a loop but does not close".
		sig.declaredLoop = declaredLoop.get(sig.clip) ?? false;
		clips[sig.clip] = sig;
	}

	return { version: SIGNATURE_VERSION, count: Object.keys(clips).length, clips };
}

/** Stable serialisation, so an unchanged library produces an unchanged file. */
function serialize(index) {
	return `${JSON.stringify(index, null, '\t')}\n`;
}

function main() {
	const check = process.argv.includes('--check');
	const index = buildIndex();
	const next = serialize(index);

	if (check) {
		const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
		if (current !== next) {
			console.error('signatures.json is stale. Run: npm run build:motion-signatures');
			process.exit(1);
		}
		console.log(`signatures.json is current (${index.count} clips).`);
		return;
	}

	fs.writeFileSync(OUT, next);

	const all = Object.values(index.clips);
	const still = all.filter((s) => s.static);
	const brokenLoops = all.filter((s) => s.declaredLoop && !s.loopClean);
	const overlays = all.filter((s) => s.overlay);

	console.log(`Wrote ${path.relative(ROOT, OUT)} (${index.count} clips, v${index.version}).`);
	console.log(`  overlay-safe: ${overlays.length}`);
	console.log(`  held poses:   ${still.length}${still.length ? ` (${still.map((s) => s.clip).join(', ')})` : ''}`);
	console.log(`  loops with a visible seam: ${brokenLoops.length}${brokenLoops.length ? ` (${brokenLoops.map((s) => s.clip).join(', ')})` : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
