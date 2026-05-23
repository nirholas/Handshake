#!/usr/bin/env node
/**
 * Build script for @three-ws/agent-ui
 *
 * Bundles src/index.js into dist/index.mjs via esbuild from the root
 * node_modules. `three` is marked external so consumers' bundlers de-dupe it
 * against their own copy.
 */

import { build } from '../node_modules/esbuild/lib/main.js';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'dist');
mkdirSync(outDir, { recursive: true });

await build({
	entryPoints: [join(here, 'src/index.js')],
	bundle: true,
	format: 'esm',
	outfile: join(outDir, 'index.mjs'),
	external: ['three', 'three/addons/loaders/GLTFLoader.js'],
	target: ['es2020'],
	sourcemap: false,
	logLevel: 'info',
});

copyFileSync(join(here, 'types/index.d.ts'), join(outDir, 'index.d.ts'));

console.log('[agent-ui] built dist/index.mjs');
