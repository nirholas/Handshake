#!/usr/bin/env node
/**
 * Critical-path test gate for the deploy build.
 *
 * GitHub Actions is unavailable on this account, so the Vercel deploy build is
 * the only automated checkpoint (see scripts/build-vercel.mjs). The full vitest
 * suite (`npm test`) drives a real browser via Playwright and includes specs
 * that need live DB/RPC credentials — too heavy and too environment-dependent to
 * gate every deploy on. This runs a curated subset of fast, offline-safe,
 * mock-backed unit tests that cover the highest-consequence logic — money-path
 * confirmation handling, the HTTP cache/error boundary, custody spend guards,
 * payment verification — so a regression in any of them FAILS THE DEPLOY instead
 * of shipping silently.
 *
 * Keep this list tight and green-offline. When you add a unit test that protects
 * a money/auth invariant and runs without external credentials, add it here.
 * Anything needing a live DB/RPC/browser belongs in `npm test`, not the gate.
 */
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Resolve vitest's CLI entry through Node module resolution rather than relying
// on the `.bin/vitest` shim (or `npx`'s PATH lookup). Vercel restores a cached
// `node_modules` between builds but does NOT always recreate the `.bin/`
// symlinks — so the vitest *package* is present while `.bin/vitest` is missing,
// and `npx vitest` dies with "vitest: not found" in <1s, failing every deploy
// even though no test regressed. `node <pkg>/vitest.mjs` needs only the package
// directory, which survives the cache intact, so it is immune to the stripped
// bin. If the package itself is genuinely absent the install is broken and the
// deploy SHOULD fail — that case throws below with a clear message.
function resolveVitestCli() {
	const require = createRequire(import.meta.url);
	const pkgJsonPath = require.resolve('vitest/package.json');
	const bin = require(pkgJsonPath).bin;
	const rel = typeof bin === 'string' ? bin : bin?.vitest;
	if (!rel) throw new Error('vitest package.json has no `bin.vitest` entry');
	return join(dirname(pkgJsonPath), rel);
}

const GATE_TESTS = [
	'tests/solana-confirm.test.js',        // reverted-tx → throw (no false-success money path)
	'tests/http-cache-control.test.js',    // cache/no-store boundary; errors never cached
	'tests/agent-custody-guards.test.js',  // custodial ownership / spend guards
	'tests/agent-wallet-vanity.test.js',   // vanity flow guards
	'tests/api/x402.test.js',              // x402 payment manifest/verify surface
	'tests/api/three-token-leaderboard.test.js', // holder snapshot read path
	'tests/api/healthz.test.js',           // smoke
];

console.log(`[test-gate] running ${GATE_TESTS.length} critical-path test files…`);

// On Vercel the repo is cloned and then `.vercelignore` paths are STRIPPED before
// the build runs. `tests/` is ignored to keep the suite out of the deploy upload,
// so each gate file must be explicitly re-included in `.vercelignore`. If one is
// missing here, vitest would just print a cryptic "No test files found" and exit
// 1 — indistinguishable from a real regression. Detect it ourselves and fail with
// a message that names the file and points at the actual fix.
const missing = GATE_TESTS.filter((t) => !existsSync(resolve(ROOT, t)));
if (missing.length) {
	console.error(`[test-gate] ✗ ${missing.length} gate test file(s) absent from the build context:`);
	for (const m of missing) console.error(`[test-gate]     ${m}`);
	console.error('[test-gate]   These are stripped by .vercelignore (which excludes tests/). Re-include each');
	console.error('[test-gate]   gate file there with a `!` negation — keep .vercelignore in sync with GATE_TESTS.');
	process.exit(1);
}

let vitestCli;
try {
	vitestCli = resolveVitestCli();
} catch (err) {
	// The vitest package could not be resolved at all — a genuinely broken
	// install, not a code regression. Fail the deploy loudly rather than skip the
	// only automated checkpoint: a silent pass here would let a real money/auth
	// regression ship unguarded.
	console.error(`[test-gate] ✗ cannot resolve the vitest runner: ${err.message}`);
	console.error('[test-gate]   the test runner is missing from node_modules — the install is broken; blocking deploy');
	process.exit(1);
}

try {
	execFileSync(process.execPath, [vitestCli, 'run', ...GATE_TESTS], {
		cwd: ROOT,
		stdio: 'inherit',
		env: process.env,
	});
	console.log('[test-gate] ✓ all critical-path tests passed');
} catch {
	console.error('[test-gate] ✗ critical-path tests failed, blocking deploy');
	process.exit(1);
}
