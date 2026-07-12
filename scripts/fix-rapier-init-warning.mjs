// Silences a false-positive console.warn from @dimforge/rapier3d-compat's own
// generated wasm-bindgen bootstrap.
//
// The package inlines its WASM binary as base64 and, on every init(), decodes
// it to a Uint8Array and passes those bytes straight into the internal
// __wbg_init(module_or_path) — positionally, not wrapped in
// `{ module_or_path }`. __wbg_init's deprecation check only special-cases
// plain objects (`Object.getPrototypeOf(x) === Object.prototype`); a
// Uint8Array fails that check, so the package's own supported, zero-argument
// `init()` entry point logs "using deprecated parameters for the
// initialization function; pass a single object instead" on every load —
// even though nothing about the call is actually deprecated or broken. This
// is a bug in rapier3d-compat's own generated bundle (still present as of
// 0.19.3, the latest release), not in how initRapier() calls it.
//
// We neutralize the console.warn call site directly rather than touch the
// call convention, since rewriting the minified call site would be brittle
// across rebuilds and the warning is the only wrong part — behavior is
// unaffected either way.
//
// Idempotent; runs from `postinstall` so it survives `npm ci`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);

const TARGETS = [
	'node_modules/@dimforge/rapier3d-compat/rapier.mjs',
	'node_modules/@dimforge/rapier3d-compat/rapier.cjs',
	'node_modules/@dimforge/rapier3d-compat/rapier_wasm3d.js',
];

// Matches both the minified bundles (double quotes) and the readable
// wasm-bindgen source shipped alongside them (single quotes).
const WARN_RE =
	/console\.warn\((['"])using deprecated parameters for the initialization function; pass a single object instead\1\)/;
const MARKER = 'void 0/*rapier-init-warning-silenced*/';

let patched = 0;
let skipped = 0;

for (const rel of TARGETS) {
	const file = join(repo, rel);
	if (!existsSync(file)) continue;

	let src = readFileSync(file, 'utf8');
	if (src.includes(MARKER)) {
		skipped++;
		continue;
	}
	if (!WARN_RE.test(src)) {
		console.warn(`[fix-rapier-init-warning] no match in ${rel} — rapier3d-compat internals may have changed`);
		continue;
	}

	src = src.replace(WARN_RE, MARKER);
	writeFileSync(file, src);
	patched++;
}

if (patched > 0) {
	console.log(`[fix-rapier-init-warning] silenced false-positive init warning in ${patched} file(s)`);
} else if (skipped > 0) {
	console.log('[fix-rapier-init-warning] already patched');
} else {
	console.log('[fix-rapier-init-warning] @dimforge/rapier3d-compat not installed, skipping');
}
