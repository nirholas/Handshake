#!/usr/bin/env node
/**
 * Build @three-ws/assistant.
 *
 * Two artifacts:
 *   dist/assistant.mjs:        ESM entry for npm / bundler consumers.
 *                               `import ThreeAssistant from '@three-ws/assistant'`.
 *   dist/assistant.global.js:  self-contained IIFE for a one-tag CDN
 *                               `<script src=".../assistant/v1.js" async>`.
 *                               Binds to its own origin, sets window.ThreeAssistant,
 *                               and auto-mounts from the tag's data-* attributes.
 *
 * The loader has zero runtime dependencies (the 3D avatar, chat, and TTS all
 * run in the hosted iframe), so nothing is left external.
 */

import { build } from 'esbuild';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'dist');
mkdirSync(outDir, { recursive: true });

const common = {
	bundle: true,
	sourcemap: true,
	target: ['es2020'],
	logLevel: 'info',
};

// 1) ESM entry for npm / bundlers.
await build({
	...common,
	entryPoints: [resolve(here, 'src/index.js')],
	format: 'esm',
	outfile: resolve(outDir, 'assistant.mjs'),
});

// 2) Self-contained IIFE for a classic one-tag <script> embed.
await build({
	...common,
	entryPoints: [resolve(here, 'src/global.js')],
	format: 'iife',
	minify: true,
	outfile: resolve(outDir, 'assistant.global.js'),
	banner: { js: '/* @three-ws/assistant, https://three.ws/assistant */' },
});

// 3) Mirror the one-tag build into the app web root so three.ws serves it
//    first-party at https://three.ws/assistant/v1.js (the URL the docs and the
//    /assistant builder hand out). This copy is committed and shipped, so
//    mirror ONLY the minified JS with its sourcemap reference stripped; the map
//    stays in dist/ for npm consumers. Skipped gracefully in a standalone
//    checkout (no ../public).
const webRoot = resolve(here, '../public');
if (existsSync(webRoot)) {
	const cdnDir = resolve(webRoot, 'assistant');
	mkdirSync(cdnDir, { recursive: true });
	const bundle = readFileSync(resolve(outDir, 'assistant.global.js'), 'utf8').replace(
		/\n?\/\/# sourceMappingURL=.*$/m,
		'\n',
	);
	writeFileSync(resolve(cdnDir, 'v1.js'), bundle);
	console.log('[assistant] mirrored one-tag build -> public/assistant/v1.js');
}

console.log('[assistant] built dist/assistant.mjs, dist/assistant.global.js');
