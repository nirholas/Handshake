// Bundle the extension (and the bundled @three-ws/x402-fetch source) into a
// single CJS file VS Code can require. `vscode` is provided by the host and must
// stay external.
import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: ['src/extension.js'],
	bundle: true,
	// .cjs (not .js) because package.json declares "type": "module" for the ESM
	// sources; the extension host still requires this bundle as CommonJS.
	outfile: 'dist/extension.cjs',
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	external: ['vscode'],
	sourcemap: !production,
	minify: production,
	logLevel: 'info',
};

if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
	console.log('[vscode-x402] watching…');
} else {
	await esbuild.build(options);
}
