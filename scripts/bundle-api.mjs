#!/usr/bin/env node
/**
 * Pre-bundle all Vercel API route functions with esbuild.
 *
 * Problem: Vercel's nft (Node File Tracer) traces every api/*.js against
 * the full node_modules tree (~2 GB) to determine what to include in each
 * function package. With 450+ route files this takes 45+ minutes (exceeding
 * Vercel's build timeout).
 *
 * Solution: use esbuild to bundle each route file into a single self-contained
 * JS file BEFORE Vercel sees them. The bundled files have all deps inlined;
 * nft finds nothing external to trace — drops from ~45 min to under 3 min.
 */
import { readdir, stat, readFile } from 'fs/promises';
import { resolve, join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const API_DIR = resolve(ROOT, 'api');

// The bundler writes output to --outdir=api with --allow-overwrite, i.e. it
// overwrites every api/*.js source file in place. On Vercel that's fine — the
// checkout is ephemeral and the bundled output is what gets deployed. Locally
// it destroys your route sources, and if those get committed the repo balloons
// by millions of lines (see commits c94190b3 and dabd5884, both reverted).
// Refuse to run unless we're actually on a CI builder, or the operator opts in.
const isCiBuild =
	process.env.VERCEL === '1' ||
	process.env.NOW_BUILDER === '1' ||
	process.env.CI === 'true' ||
	process.env.CI === '1';
if (!isCiBuild && process.env.FORCE_BUNDLE_API !== '1') {
	console.log(
		'[bundle-api] Skipping — not on Vercel/CI. This script overwrites api/*.js in place; running it locally destroys route sources. Set FORCE_BUNDLE_API=1 to override (preferably in a throwaway worktree).'
	);
	process.exit(0);
}

async function collectRouteFiles(dir, out = []) {
	if (!existsSync(dir)) return out;
	const entries = await readdir(dir, { withFileTypes: true });
	for (const e of entries) {
		if (e.name.startsWith('_')) continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			await collectRouteFiles(full, out);
		} else if (e.isFile() && e.name.endsWith('.js')) {
			out.push(full);
		}
	}
	return out;
}

// Externals are NOT inlined into the bundle. esbuild leaves the import
// statement intact and Vercel's NFT resolves it from node_modules. Mark heavy
// or lazy-loaded deps as external so:
//   1. The bundle stays small (faster Vercel function packaging).
//   2. Dynamic imports stay dynamic at runtime instead of being inlined.
//      @sentry/node is the biggest offender — sentry.js uses `await import(...)`
//      to defer the ~15 MB OpenTelemetry instrumentation tree, but esbuild's
//      --bundle inlines dynamic imports unless the target is external.
const EXTERNALS = [
	'sharp', 'canvas', 'fsevents',
	'@ipshipyard/node-datachannel',
	'@three-ws/solana-agent',
	'@solana/*',
	'@solana-program/*',
	'@metaplex-foundation/*',
	'@bonfida/*',
	'@pump-fun/*',
	'@nirholas/*',
	'@coral-xyz/*',
	'@aws-sdk/*',
	'@sentry/*',
	'@opentelemetry/*',
	'@asamuzakjp/*',
	'@csstools/*',
	'@neynar/*',
	'@upstash/*',
	'@sparticuz/*',
	// @x402/extensions v2.13.0 maps both `import` and `require` conditions to
	// its CJS build (./dist/cjs/index.js). When esbuild bundles that CJS into
	// an ESM output it wraps require() calls with a __require shim, but
	// require('url') (a Node.js built-in) throws "Dynamic require of 'url' is
	// not supported" at runtime — crashing every function that imports x402-spec.js.
	// Marking @x402/* and @coinbase/* as external lets Node.js ESM loader
	// handle the CJS→ESM boundary natively (ESM can always import CJS).
	'@x402/*',
	'@coinbase/*',
	// gltf-validator ships only a CJS build (gltf_validator.dart.js) that uses
	// require('url') — same ESM-bundling incompatibility as @x402/extensions.
	// Marking it external lets Node.js load it natively as CJS.
	'gltf-validator',
	// @vercel/og reads its bundled fonts from a path relative to its own package
	// dir. Inlining it rewrites that path to the route's output location, so the
	// font read ENOENTs at load. External keeps the package (and its font assets)
	// resolvable from node_modules at runtime.
	'@vercel/og',
	'jsdom',
	'ethers',
	'@elevenlabs/elevenlabs-js',
	'playwright',
	'playwright-core',
	'puppeteer',
	'puppeteer-core',
	'puppeteer-extra',
	'puppeteer-extra-plugin-stealth',
	'puppeteer-extra-plugin-*',
];

// Hash every source file BEFORE bundling. After bundling, any file whose
// content still matches its pre-bundle hash was untouched by esbuild — Vercel's
// NFT would then trace it against the full ~2 GB node_modules tree, blowing the
// 45 min build timeout. Fail the build instead so the next deploy points at the
// real cause within minutes instead of after a 45-minute hang.
async function hashFile(path) {
	try {
		const buf = await readFile(path);
		return createHash('sha256').update(buf).digest('hex');
	} catch {
		return null;
	}
}

function esbuildArgs(files) {
	return [
		'--bundle',
		'--platform=node',
		'--target=node20',
		'--format=esm',
		// Some bundled CJS deps call `require("url")` (and other Node built-ins)
		// internally. esbuild inlines those into the ESM output behind a
		// `__require` shim that THROWS "Dynamic require of \"url\" is not
		// supported" because bare ESM has no `require` in scope. Marking the
		// offending packages external is whack-a-mole (the call sites live deep
		// in transitive CJS deps, not just @x402). Inject a real CommonJS
		// `require` via createRequire so the shim resolves built-ins natively.
		//
		// The banner must survive being inlined TWICE into one output: a route file
		// that imports a sibling route file (e.g. pump-fun-mcp.js → ./pump/[action].js)
		// pulls in the sibling's already-bundled copy, which carries this same banner.
		// A top-level `import { … as X }` binding can't be redeclared, so two copies
		// were a SyntaxError ("Identifier '__createRequireForBundle' has already been
		// declared") that crashed the function at load (FUNCTION_INVOCATION_FAILED).
		// `var require` redeclares legally and a dynamic `await import()` has no import
		// binding to collide, so duplication is harmless.
		`--banner:js=var require = (await import('node:module')).createRequire(import.meta.url);`,
		`--outdir=${API_DIR}`,
		`--outbase=${API_DIR}`,
		'--allow-overwrite',
		'--tree-shaking=true',
		'--minify=false',
		'--log-level=warning',
		'--log-override:unsupported-dynamic-import=silent',
		'--log-override:duplicate-object-key=silent',
		'--log-override:equals-negative-zero=silent',
		...EXTERNALS.map((e) => `--external:${e}`),
		...files,
	];
}

function runEsbuild(files, timeoutMs) {
	execFileSync(resolve(ROOT, 'node_modules/.bin/esbuild'), esbuildArgs(files), {
		cwd: ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: timeoutMs,
		maxBuffer: 10 * 1024 * 1024,
	});
}

const start = Date.now();
const routeFiles = await collectRouteFiles(API_DIR);
// BATCH_SIZE drives esbuild's native (Go) heap per invocation. On Vercel's
// ~8 GB build container, 20 caused std::bad_alloc/SIGABRT when bundle-api ran
// in parallel with the other Phase 1 native builds. Keep at 10.
const BATCH_SIZE = 10;
const totalBatches = Math.ceil(routeFiles.length / BATCH_SIZE);
console.log(`[bundle-api] Bundling ${routeFiles.length} route files in ${totalBatches} batches...`);

const preHashes = new Map();
await Promise.all(routeFiles.map(async (f) => preHashes.set(f, await hashFile(f))));

let batchErrors = 0;
let individualRetries = 0;
const individualFailures = [];

for (let i = 0; i < routeFiles.length; i += BATCH_SIZE) {
	const batch = routeFiles.slice(i, i + BATCH_SIZE);
	const batchIdx = Math.floor(i / BATCH_SIZE) + 1;
	try {
		runEsbuild(batch, 90_000);
		process.stdout.write('.');
	} catch (err) {
		process.stdout.write('!');
		batchErrors++;
		const stderr = err.stderr?.toString().trim() || err.message || '';
		const short = stderr.split('\n').filter((l) => l.includes('ERROR')).slice(0, 5).join('\n  ') || stderr.slice(0, 400);
		console.error(`\n[bundle-api] Batch ${batchIdx}/${totalBatches} failed — retrying individually:\n  ${short}`);
		// Retry each file in the failed batch on its own so one bad file
		// doesn't poison the other 19. Anything still failing is definitively
		// unbundled and will block the build below.
		for (const file of batch) {
			individualRetries++;
			try {
				runEsbuild([file], 30_000);
			} catch (singleErr) {
				const ss = singleErr.stderr?.toString().trim() || singleErr.message || '';
				const sshort = ss.split('\n').filter((l) => l.includes('ERROR')).slice(0, 3).join('\n    ') || ss.slice(0, 300);
				individualFailures.push({ file: relative(ROOT, file), error: sshort });
			}
		}
	}
}

const stillRaw = [];
for (const f of routeFiles) {
	const before = preHashes.get(f);
	const after = await hashFile(f);
	if (before && after && before === after) {
		stillRaw.push(relative(ROOT, f));
	}
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
const sizes = await Promise.all(routeFiles.map(async (f) => (await stat(f)).size));
const totalKB = (sizes.reduce((s, n) => s + n, 0) / 1024).toFixed(0);
console.log(
	`\n[bundle-api] Done in ${elapsed}s — ${routeFiles.length} files, ${totalKB} KB` +
		(batchErrors ? `, ${batchErrors}/${totalBatches} batch errors (${individualRetries} individual retries)` : '') +
		(individualFailures.length ? `, ${individualFailures.length} routes still failing` : '') +
		(stillRaw.length ? `, ${stillRaw.length} routes left as raw source` : '')
);

if (individualFailures.length) {
	console.error(`\n[bundle-api] FAILED — ${individualFailures.length} routes could not be bundled:`);
	for (const { file, error } of individualFailures.slice(0, 25)) {
		console.error(`  ${file}\n    ${error}`);
	}
	if (individualFailures.length > 25) console.error(`  …and ${individualFailures.length - 25} more`);
}

if (stillRaw.length) {
	console.error(`\n[bundle-api] FAILED — ${stillRaw.length} routes left as raw source (NFT would scan full node_modules):`);
	for (const f of stillRaw.slice(0, 25)) console.error(`  ${f}`);
	if (stillRaw.length > 25) console.error(`  …and ${stillRaw.length - 25} more`);
}

// Fail fast on the build container instead of letting Vercel time out at 45 min
// trying to NFT-trace raw route files against the 2 GB node_modules tree.
if (individualFailures.length > 0 || stillRaw.length > 0) {
	process.exit(1);
}
