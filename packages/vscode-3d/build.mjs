// Two bundles and a decoder copy step.
//
//   src/extension.js  -> dist/extension.cjs   (Node, CJS: what the extension host requires)
//   webview/main.js   -> media/viewer.js      (browser, IIFE: the three.js viewer)
//
// The webview never reaches the network for a decoder, so Draco and KTX2 assets
// are copied out of three's examples into media/vendor and loaded from the
// webview's own origin. That keeps the viewer working offline and inside the
// webview's strict CSP.
import esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// three does not export ./package.json, so the libs directory is derived from a
// file that is exported.
const threeLibs = dirname(dirname(require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js')));

// Only what the loaders fetch at runtime: the Draco encoder alone is a megabyte
// of dead weight in the .vsix.
const DECODERS = [
	['draco/gltf/draco_decoder.js', 'draco/draco_decoder.js'],
	['draco/gltf/draco_decoder.wasm', 'draco/draco_decoder.wasm'],
	['draco/gltf/draco_wasm_wrapper.js', 'draco/draco_wasm_wrapper.js'],
	['basis/basis_transcoder.js', 'basis/basis_transcoder.js'],
	['basis/basis_transcoder.wasm', 'basis/basis_transcoder.wasm'],
];

async function copyDecoders() {
	await rm('media/vendor', { recursive: true, force: true });
	for (const [from, to] of DECODERS) {
		await mkdir(dirname(join('media/vendor', to)), { recursive: true });
		await cp(join(threeLibs, from), join('media/vendor', to));
	}
}

/** @type {import('esbuild').BuildOptions} */
const host = {
	entryPoints: ['src/extension.js'],
	bundle: true,
	// .cjs (not .js) because package.json declares "type": "module" for the ESM
	// sources; the extension host still requires this bundle as CommonJS.
	outfile: 'dist/extension.cjs',
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	external: ['vscode'],
	// ndarray-pixels (a texture dependency of @gltf-transform/functions) imports
	// the native `sharp` binary on Node. Nothing here resizes textures, and a
	// native module cannot ship in a .vsix, so it is aliased to a stub.
	alias: { sharp: './src/shims/sharp.js' },
	sourcemap: !production,
	minify: production,
	logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
	entryPoints: ['webview/main.js'],
	bundle: true,
	outfile: 'media/viewer.js',
	platform: 'browser',
	format: 'iife',
	target: 'es2020',
	sourcemap: !production,
	minify: production,
	logLevel: 'info',
};

await copyDecoders();

if (watch) {
	const contexts = await Promise.all([esbuild.context(host), esbuild.context(webview)]);
	await Promise.all(contexts.map((c) => c.watch()));
	console.log('[vscode-3d] watching…');
} else {
	await Promise.all([esbuild.build(host), esbuild.build(webview)]);
}
