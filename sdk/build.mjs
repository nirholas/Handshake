/**
 * Build script for @three-ws/sdk
 *
 * The package ships its ESM source as-is (package.json `exports` resolve the
 * `import` condition straight to src/), so the only thing that has to be built
 * is the CommonJS interop layer for consumers that `require()` the package.
 *
 * Uses esbuild (available in the root node_modules) to bundle every public
 * entry point to a `.cjs` file under dist/. The `.cjs` extension is
 * load-bearing: this package is `"type": "module"`, so a CJS bundle named
 * `.js` is parsed as ESM by Node and resolves to zero exports.
 *
 * Run: node build.mjs (from sdk/ directory)
 */

import { build } from '../node_modules/esbuild/lib/main.js';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'dist');

// Every entry point declared in package.json `exports` that has JS behind it.
// Keep this list in sync with the `require` conditions in package.json.
const ENTRIES = [
	{ src: 'src/index.js', out: 'index.cjs' },
	{ src: 'src/permissions.js', out: 'permissions.cjs' },
	{ src: 'src/permissions/advanced.js', out: 'permissions/advanced.cjs' },
	{ src: 'src/solana.js', out: 'solana.cjs' },
	{ src: 'src/solana-attestations.js', out: 'solana-attestations.cjs' },
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'permissions'), { recursive: true });

for (const entry of ENTRIES) {
	await build({
		entryPoints: [join(__dirname, entry.src)],
		outfile: join(outDir, entry.out),
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node18',
		// Peer deps stay external: consumers install them.
		external: ['ethers', '@solana/web3.js', 'viem'],
		sourcemap: false,
		logLevel: 'info',
	});
}

console.log(`Build complete: ${ENTRIES.length} CommonJS entry points in dist/`);
