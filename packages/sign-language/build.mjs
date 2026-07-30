#!/usr/bin/env node
// Build @three-ws/sign-language into a self-contained, publishable ES module.
// ===========================================================================
// The entry re-exports the ASL engine from the monorepo source; esbuild bundles
// those files into dist/index.mjs with NO externals, because the engine has no
// runtime dependencies at all (no three.js, no DOM APIs). Same publish pattern
// as @three-ws/retarget.

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
	platform: 'neutral',
	target: 'es2020',
	legalComments: 'none',
	logLevel: 'info',
});

console.log('[sign-language] built dist/index.mjs');
