#!/usr/bin/env node
// Build the standalone deployer site into ../docs, which GitHub Pages serves
// from the main branch (Settings > Pages > Deploy from a branch > main /docs).
//
// The whole Solana stack is bundled so the page is a self-contained static app:
// no server, no build step for the visitor, nothing to install. `npm run
// build:site` from the package root; the committed ../docs output is what ships.

import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'docs');
const pkg = JSON.parse(await readFile(resolve(here, '..', 'package.json'), 'utf8'));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const result = await build({
	entryPoints: [resolve(here, 'src/app.js')],
	bundle: true,
	format: 'esm',
	target: ['es2022'],
	minify: true,
	sourcemap: false,
	outfile: resolve(out, 'app.js'),
	define: { 'process.env.NODE_ENV': '"production"', __SITE_VERSION__: JSON.stringify(pkg.version) },
	inject: [resolve(here, 'src/shims/node-globals.js')],
	alias: { 'node-fetch': resolve(here, 'src/shims/node-fetch.js') },
	logLevel: 'info',
	metafile: true,
});

for (const file of ['index.html', 'docs.html', 'styles.css']) {
	const html = await readFile(resolve(here, file), 'utf8');
	await writeFile(resolve(out, file), html.replace(/__SITE_VERSION__/g, pkg.version));
}
await cp(resolve(here, 'favicon.svg'), resolve(out, 'favicon.svg'));
// Jekyll would otherwise swallow paths it considers special; this is a plain
// static bundle, so tell Pages to serve the files exactly as committed.
await writeFile(resolve(out, '.nojekyll'), '');

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`site built -> docs/ (${(bytes / 1024).toFixed(0)} KB of JS)`);
