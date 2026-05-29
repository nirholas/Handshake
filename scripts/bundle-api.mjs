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
import { readdir, stat } from 'fs/promises';
import { resolve, join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';

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
	'@aws-sdk/*',
	'@sentry/*',
	'@opentelemetry/*',
	'@asamuzakjp/*',
	'@csstools/*',
	'jsdom',
	'ethers',
];

const start = Date.now();
const routeFiles = await collectRouteFiles(API_DIR);
const BATCH_SIZE = 20;
const totalBatches = Math.ceil(routeFiles.length / BATCH_SIZE);
console.log(`[bundle-api] Bundling ${routeFiles.length} route files in ${totalBatches} batches...`);

let errors = 0;
for (let i = 0; i < routeFiles.length; i += BATCH_SIZE) {
	const batch = routeFiles.slice(i, i + BATCH_SIZE);
	const args = [
		'--bundle',
		'--platform=node',
		'--target=node20',
		'--format=esm',
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
		...batch,
	];
	try {
		execFileSync(resolve(ROOT, 'node_modules/.bin/esbuild'), args, {
			cwd: ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 60_000,
			maxBuffer: 10 * 1024 * 1024,
		});
		process.stdout.write('.');
	} catch (err) {
		process.stdout.write('!');
		errors++;
		const stderr = err.stderr?.toString().trim();
		const short = stderr
			? stderr.split('\n').filter((l) => l.includes('ERROR')).slice(0, 3).join('\n  ') || stderr.slice(0, 200)
			: err.message;
		console.error(`\n[bundle-api] Batch ${i}–${i + BATCH_SIZE} failed:\n  ${short}`);
	}
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
const sizes = await Promise.all(routeFiles.map(async (f) => (await stat(f)).size));
const totalKB = (sizes.reduce((s, n) => s + n, 0) / 1024).toFixed(0);
console.log(`\n[bundle-api] Done in ${elapsed}s — ${routeFiles.length} files, ${totalKB} KB total${errors ? ` (${errors}/${totalBatches} batch errors — unbundled files traced by NFT normally)` : ''}`);
if (errors > totalBatches / 2) process.exit(1);
