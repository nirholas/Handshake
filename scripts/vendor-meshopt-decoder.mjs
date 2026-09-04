#!/usr/bin/env node
/**
 * Vendor the EXT_meshopt_compression decoder into public/vendor/.
 *
 * <model-viewer> loads its meshopt decoder by injecting a classic <script> and
 * reading the `MeshoptDecoder` global it defines. That URL used to point at
 * jsdelivr, which made every compressed model on three.ws unrenderable for
 * anyone the CDN is slow, cached-stale, or blocked for, and put a second DNS +
 * TLS handshake on the critical path of the first 3D frame on a phone. The
 * decoder is a hard dependency of the delivery format we now write by default
 * (api/_lib/glb-compress.js), so it ships from our own origin.
 *
 * The source is the `meshoptimizer` package already in package.json. Its
 * `meshopt_decoder.cjs` build is UMD with a `self.MeshoptDecoder = …` fallback,
 * which is exactly what model-viewer's classic-script loader needs.
 *
 *   node scripts/vendor-meshopt-decoder.mjs           # copy if it differs
 *   node scripts/vendor-meshopt-decoder.mjs --check    # exit 1 if it differs
 *
 * `--check` is what tests/meshopt-vendor.test.js runs, so a `meshoptimizer`
 * upgrade that leaves the vendored copy behind fails `npm test` instead of
 * silently serving an old decoder.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
export const SOURCE = path.join(ROOT, 'node_modules/meshoptimizer/meshopt_decoder.cjs');
export const TARGET = path.join(ROOT, 'public/vendor/meshopt_decoder.js');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** @returns {{ inSync: boolean, source: Buffer|null, target: Buffer|null }} */
export function compareVendoredDecoder() {
	const source = fs.existsSync(SOURCE) ? fs.readFileSync(SOURCE) : null;
	const target = fs.existsSync(TARGET) ? fs.readFileSync(TARGET) : null;
	return { inSync: Boolean(source && target && sha(source) === sha(target)), source, target };
}

function main() {
	const check = process.argv.includes('--check');
	const { inSync, source, target } = compareVendoredDecoder();
	if (!source) {
		console.error(`[vendor-meshopt] source missing: ${path.relative(ROOT, SOURCE)} (run npm install)`);
		process.exit(1);
	}
	if (inSync) {
		console.log(`[vendor-meshopt] up to date: ${path.relative(ROOT, TARGET)} (${source.length} bytes)`);
		return;
	}
	if (check) {
		console.error(
			`[vendor-meshopt] ${path.relative(ROOT, TARGET)} is ${target ? 'stale' : 'missing'}. ` +
				'Run `npm run vendor:meshopt` and commit the result.',
		);
		process.exit(1);
	}
	fs.mkdirSync(path.dirname(TARGET), { recursive: true });
	fs.writeFileSync(TARGET, source);
	console.log(`[vendor-meshopt] wrote ${path.relative(ROOT, TARGET)} (${source.length} bytes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
