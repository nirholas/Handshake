// Patches pump-sdk packages after install so they can be loaded as ESM and
// resolved by esbuild during Vercel API bundling.
//
// 1. @pump-fun/pump-sdk / @pump-fun/pump-swap-sdk:
//    Both ship `dist/esm/index.js` containing ES `import` statements, but
//    neither the package root nor the `dist/esm/` directory declares
//    `"type": "module"`. Node loads those files as CommonJS and throws
//    "Cannot use import statement outside a module" on first dynamic import.
//    Fix: drop a `{"type":"module"}` package.json into each `dist/esm/` folder.
//
// 2. @nirholas/pump-sdk:
//    v1.30.0's package.json `module` and `exports.import` point at
//    `dist/esm/index.js`, but the actual file shipped is `dist/esm/index.mjs`.
//    esbuild respects `exports` strictly and fails with "Could not resolve",
//    which causes bundle-api.mjs to leave any batch containing pump-sdk
//    importers unbundled — those routes then fall through to Vercel's nft
//    tracer, which scans the full node_modules tree (~2 GB) and exceeds the
//    45 minute build timeout. Fix: rewrite `module` / `exports.import` to
//    point at the real `.mjs` file.
//
// Idempotent; runs from `postinstall` so it survives `npm ci`.

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);

const esmTypeTargets = [
	'node_modules/@pump-fun/pump-sdk/dist/esm',
	'node_modules/@pump-fun/pump-swap-sdk/dist/esm',
];

let patched = 0;
let skipped = 0;
for (const rel of esmTypeTargets) {
	const dir = join(repo, rel);
	if (!existsSync(dir)) {
		skipped++;
		continue;
	}
	const pkgPath = join(dir, 'package.json');
	const desired = { type: 'module' };
	if (existsSync(pkgPath)) {
		const current = JSON.parse(readFileSync(pkgPath, 'utf8'));
		if (current.type === 'module') {
			skipped++;
			continue;
		}
	}
	writeFileSync(pkgPath, JSON.stringify(desired, null, 2) + '\n');
	patched++;
}

// Rewrite @nirholas/pump-sdk's exports/module to point at the real .mjs file.
const nirholasPkgPath = join(repo, 'node_modules/@nirholas/pump-sdk/package.json');
let nirholasPatched = false;
if (existsSync(nirholasPkgPath)) {
	const pkg = JSON.parse(readFileSync(nirholasPkgPath, 'utf8'));
	const esmActual = './dist/esm/index.mjs';
	const esmActualAbs = join(repo, 'node_modules/@nirholas/pump-sdk', esmActual);
	if (existsSync(esmActualAbs)) {
		let changed = false;
		if (pkg.module !== esmActual) {
			pkg.module = esmActual;
			changed = true;
		}
		if (pkg.exports && pkg.exports['.'] && pkg.exports['.'].import !== esmActual) {
			pkg.exports['.'].import = esmActual;
			changed = true;
		}
		if (changed) {
			writeFileSync(nirholasPkgPath, JSON.stringify(pkg, null, 2) + '\n');
			nirholasPatched = true;
		}
	}
}

console.log(
	`[fix-pump-sdk-esm] patched ${patched}, skipped ${skipped}` +
		(nirholasPatched ? ', rewrote @nirholas/pump-sdk exports' : ''),
);
