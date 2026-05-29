// Patches pump-sdk packages after install so they can be loaded as ESM and
// resolved by esbuild during Vercel API bundling.
//
// 1. @pump-fun/pump-sdk / @pump-fun/pump-swap-sdk:
//    Both ship ES `import` statements in their dist files, but neither package
//    declares `"type": "module"`. Node loads those files as CommonJS and throws
//    "Cannot use import statement outside a module" on first dynamic import.
//    For packages with `dist/esm/`: drop `{"type":"module"}` into that folder.
//    For packages where `dist/index.js` IS the ESM build (no dist/esm/ subdir):
//    patch `"type": "module"` into the root package.json directly.
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

// @pump-fun/pump-swap-sdk's layout flipped across versions and needs the inverse
// fix depending on which it ships:
//
//   • Old (≤1.0.x): dist/index.js is ESM and root has no "type", so Node loads it
//     as CommonJS and the `import`/`export` syntax throws. Fix: add type:module.
//
//   • New (1.17.0): root declares "type":"module" AND exports the CJS bundle via
//     the `require` condition (exports["."].require → ./dist/index.js, which is
//     `"use strict"; …require(…)`). Because the root is type:module, a
//     `require('@pump-fun/pump-swap-sdk')` (api/_lib/pump.js uses createRequire)
//     parses that CJS file as ESM and dies with "require is not defined in ES
//     module scope". The ESM entry lives at dist/esm/index.js and already carries
//     its own dist/esm/package.json {"type":"module"} marker (written above), so
//     dropping the root "type":"module" lets BOTH conditions resolve correctly:
//     require→dist/index.js as CJS, import→dist/esm/index.js as ESM.
const pumpSwapPkgPath = join(repo, 'node_modules/@pump-fun/pump-swap-sdk/package.json');
let pumpSwapPatched = false;
if (existsSync(pumpSwapPkgPath)) {
	const pkg = JSON.parse(readFileSync(pumpSwapPkgPath, 'utf8'));
	const exp = pkg.exports?.['.'] || {};
	const requireTargetRel = exp.require || pkg.main || 'dist/index.js';
	const requireTarget = join(repo, 'node_modules/@pump-fun/pump-swap-sdk', requireTargetRel);
	const importTargetRel = exp.import || pkg.module;
	const head = existsSync(requireTarget) ? readFileSync(requireTarget, 'utf8').slice(0, 512) : '';
	const requireTargetIsCjs = /^\s*["']use strict["']/.test(head) || (head.includes('require(') && !/(^|\n)\s*(export|import)\s/.test(head));
	const importTargetAbs = importTargetRel ? join(repo, 'node_modules/@pump-fun/pump-swap-sdk', importTargetRel) : null;
	const importTargetHasMarker =
		importTargetAbs && existsSync(join(dirname(importTargetAbs), 'package.json')) &&
		JSON.parse(readFileSync(join(dirname(importTargetAbs), 'package.json'), 'utf8')).type === 'module';

	if (pkg.type === 'module' && requireTargetIsCjs && importTargetHasMarker) {
		// New layout: root type:module collides with the CJS require target.
		delete pkg.type;
		writeFileSync(pumpSwapPkgPath, JSON.stringify(pkg, null, 2) + '\n');
		pumpSwapPatched = true;
		patched++;
	} else if (pkg.type !== 'module' && (head.includes('export ') || head.includes('import '))) {
		// Old layout: ESM main entry needs the module flag.
		pkg.type = 'module';
		writeFileSync(pumpSwapPkgPath, JSON.stringify(pkg, null, 2) + '\n');
		pumpSwapPatched = true;
		patched++;
	} else {
		skipped++;
	}
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
