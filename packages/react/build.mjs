#!/usr/bin/env node
// Build @three-ws/react with esbuild (same toolchain as the other SDKs):
// ESM + CJS bundles from src/index.js, react left external, plus the
// hand-written type declarations copied into dist/. The bundles use the
// .mjs/.cjs extensions so Node parses each correctly without a "type"
// field or a MODULE_TYPELESS reparse warning.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'dist');
mkdirSync(outDir, { recursive: true });

const common = {
	entryPoints: [resolve(here, 'src/index.js')],
	bundle: true,
	platform: 'browser',
	target: 'es2020',
	jsx: 'automatic',
	external: ['react', 'react-dom', 'react/jsx-runtime'],
	logLevel: 'info',
};

await build({ ...common, format: 'esm', outfile: resolve(outDir, 'index.mjs') });
await build({ ...common, format: 'cjs', outfile: resolve(outDir, 'index.cjs') });
copyFileSync(resolve(here, 'src/index.d.ts'), resolve(outDir, 'index.d.ts'));
console.log('[react] built dist/index.mjs, dist/index.cjs, dist/index.d.ts');
