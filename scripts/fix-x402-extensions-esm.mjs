// Patches @x402/extensions after install.
//
// The 2.12.0 package ships with `dist/esm/` empty — only `dist/cjs/` got built.
// Its `exports` map still advertises `import` conditions pointing at the missing
// `.mjs` files, so Vite/Vitest/Node ESM fail with "Failed to resolve entry for
// package".
//
// Rewrite each subpath's `import` condition to point at the working CJS bundle.
// Vite's ESM-CJS interop handles the named-export pattern tsup produces.
// Idempotent; survives `npm ci` via postinstall.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);
const pkgPath = join(repo, 'node_modules/@x402/extensions/package.json');

if (!existsSync(pkgPath)) {
	console.log('[fix-x402-extensions-esm] package not installed, skipping');
	process.exit(0);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const exportsMap = pkg.exports || {};
let mutated = 0;

for (const conditions of Object.values(exportsMap)) {
	if (!conditions || typeof conditions !== 'object') continue;
	const require = conditions.require;
	if (!require?.default) continue;
	const desiredImport = {
		types: require.types,
		default: require.default,
	};
	const currentImport = conditions.import;
	if (
		currentImport?.types === desiredImport.types &&
		currentImport?.default === desiredImport.default
	) {
		continue;
	}
	conditions.import = desiredImport;
	mutated++;
}

if (mutated > 0) {
	writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
	console.log(`[fix-x402-extensions-esm] redirected import→cjs for ${mutated} subpath(s)`);
} else {
	console.log('[fix-x402-extensions-esm] already patched');
}
