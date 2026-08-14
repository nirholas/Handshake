#!/usr/bin/env node
// Build @three-ws/retarget into a self-contained, publishable ES module.
// =======================================================================
// The entry re-exports the engine from the monorepo source; esbuild bundles
// those files (and the tiny shared logger) into dist/index.mjs, leaving only
// `three` external as the peer dependency, the same publish pattern as
// @three-ws/walk.

import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'dist');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
	entryPoints: [resolve(here, 'src/index.js')],
	outfile: resolve(outDir, 'index.mjs'),
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2020',
	external: ['three', 'three/addons/*'],
	legalComments: 'none',
	logLevel: 'info',
});

console.log('[retarget] built dist/index.mjs');
