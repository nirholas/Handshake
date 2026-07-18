#!/usr/bin/env node
/**
 * Build @three-ws/concierge.
 *
 * Three artifacts:
 *   dist/concierge.mjs        — ESM, `three` left external. For bundler / npm
 *                               consumers who already depend on three.
 *   dist/concierge.global.js  — self-contained ESM with three + addons inlined,
 *                               registers <three-concierge>, runs the
 *                               data-concierge auto-init, and exposes
 *                               window.ThreeWsConcierge. For a one-tag CDN
 *                               <script type="module"> embed.
 *   dist/concierge.css        — the injected stylesheet, materialised for the
 *                               "@three-ws/concierge/style.css" subpath.
 */

import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSS } from './src/styles.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'dist');
mkdirSync(outDir, { recursive: true });

const common = {
	bundle: true,
	sourcemap: true,
	target: ['es2020'],
	logLevel: 'info',
};

// 1) ESM, three external (peer dependency).
await build({
	...common,
	entryPoints: [resolve(here, 'src/index.js')],
	format: 'esm',
	external: ['three', 'three/addons/*'],
	outfile: resolve(outDir, 'concierge.mjs'),
});

// 2) Self-contained build for a plain CDN <script type="module"> — ESM (not
//    IIFE) because the stage lazy-imports the meshopt decoder module.
await build({
	...common,
	entryPoints: [resolve(here, 'src/global.js')],
	format: 'esm',
	minify: true,
	outfile: resolve(outDir, 'concierge.global.js'),
	banner: { js: '/* @three-ws/concierge — https://three.ws/concierge */' },
});

// 3) Stylesheet for the ./style.css subpath import.
writeFileSync(resolve(outDir, 'concierge.css'), CSS.trimStart());

console.log('[concierge] built dist/concierge.mjs, dist/concierge.global.js, dist/concierge.css');
