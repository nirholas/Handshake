#!/usr/bin/env node
/**
 * Optimized Vercel build orchestrator.
 *
 * Replaces the npm script one-liner with:
 *  - Hash-based caching (skip sub-builds whose inputs haven't changed)
 *  - Maximum parallelism across independent tasks
 *  - Clear timing + error reporting
 */
import { execSync, spawn } from 'child_process';
import { createRequire } from 'module';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isCached, writeStamp } from './build-cache.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Resolve a dev tool's CLI entry through Node module resolution instead of the
// `.bin/<tool>` shim. Vercel restores a cached `node_modules` between builds
// but does NOT always recreate the `.bin/` symlinks — so the package dir is
// present while `.bin/<tool>` is missing, and `npx <tool>` dies with
// "<tool>: not found" in <1s, failing the deploy though nothing regressed.
// This exact stripped-bin hit the test gate (2026-06-21); the build's other
// tool invocations (tsc, vite) share the landmine, so route them all through
// the package's own bin file, which needs only the (intact) package directory.
// Returns a shell-quoted absolute path safe to splice into an `sh -c` command.
function binCli(pkg, binName = pkg) {
	const pkgJsonPath = require.resolve(`${pkg}/package.json`);
	const bin = require(pkgJsonPath).bin;
	const rel = typeof bin === 'string' ? bin : bin?.[binName];
	if (!rel) throw new Error(`[build:vercel] ${pkg} exposes no \`${binName}\` bin entry`);
	return JSON.stringify(resolve(dirname(pkgJsonPath), rel));
}

const running = new Set();

// Heartbeat: every 30s, print which sub-builds are still in flight. If Vercel's
// build hangs, the log makes it obvious which stage is stuck instead of leaving
// us to guess from a silent 45-minute timeout.
const heartbeat = setInterval(() => {
	if (running.size === 0) return;
	const labels = [...running].map(([l, t]) => `${l} (${((Date.now() - t) / 1000).toFixed(0)}s)`).join(', ');
	console.log(`\n[build:vercel] still running: ${labels}`);
}, 30_000);
heartbeat.unref();

function run(label, cmd, opts = {}) {
	const start = Date.now();
	const entry = [label, start];
	running.add(entry);
	return new Promise((res, rej) => {
		console.log(`\n[${label}] starting: ${cmd}`);
		const child = spawn('sh', ['-c', cmd], {
			cwd: opts.cwd || ROOT,
			stdio: 'inherit',
			env: { ...process.env, ...opts.env },
		});
		child.on('close', (code) => {
			running.delete(entry);
			const elapsed = ((Date.now() - start) / 1000).toFixed(1);
			if (code === 0) {
				console.log(`[${label}] done in ${elapsed}s`);
				res();
			} else {
				const err = new Error(`[${label}] failed (exit ${code}) after ${elapsed}s`);
				err.label = label;
				rej(err);
			}
		});
	});
}

async function buildAvatarStudio() {
	const inputs = ['character-studio/src', 'character-studio/package.json', 'character-studio/vite.config.ts'];
	if (isCached('avatar-studio', inputs) && existsSync(resolve(ROOT, 'character-studio/build'))) {
		return;
	}
	await run('avatar-studio', 'npm run build --prefix character-studio', {
		env: { NODE_OPTIONS: '--no-deprecation --max-old-space-size=4096' },
	});
	writeStamp('avatar-studio', inputs);
}

async function buildChat() {
	const inputs = ['chat/src', 'chat/package.json'];
	if (isCached('chat', inputs) && existsSync(resolve(ROOT, 'chat/build'))) {
		return;
	}
	await run('chat', 'cd chat && node scripts/ensure-deps.mjs && npm run build && cd .. && mkdir -p dist/chat && cp -rf public/chat/. dist/chat/');
	writeStamp('chat', inputs);
}

// Guard: these SDKs' dist/ dirs are gitignored. Vercel caches node_modules/
// across deploys and skips npm install (and therefore postinstall) when
// package-lock.json is unchanged. Two failure modes follow:
//   1. The dist is missing entirely → the Vite app build can't resolve the
//      package entry and fails, or — for SDKs marked external in bundle-api —
//      the deployed function FUNCTION_INVOCATION_FAILEDs at load (the bundle
//      leaves the import to be resolved against node_modules at runtime, and
//      `@three-ws/solana-agent/dist/index.js` simply isn't there).
//   2. A stale or corrupt dist survives in the cache → e.g. a malformed ESM
//      entry crashed every cron that imports the SDK at runtime with a
//      SyntaxError ("export{…} = pkg" failing ModuleJob._instantiate).
// `existsSync` alone misses case 2. Validate that every published entry parses
// as a real module; rebuild from source if any is missing or syntactically bad.
const SDKS = [
	{
		name: 'agent-payments-sdk',
		dir: 'agent-payments-sdk',
		entries: [
			'agent-payments-sdk/dist/index.js',
			'agent-payments-sdk/dist/solana/index.js',
			'agent-payments-sdk/dist/x402/index.js',
			'agent-payments-sdk/dist/evm/index.js',
		],
	},
	{
		// @three-ws/solana-agent — imported by api/agenc/[action].js and marked
		// external in scripts/bundle-api.mjs, so its dist must exist in the
		// deployed node_modules at runtime.
		name: '@three-ws/solana-agent',
		dir: 'solana-agent-sdk',
		// Unlike agent-payments-sdk this package is NOT a root workspace, so the
		// top-level `npm ci` never installs its devDeps (tsup, typescript). Its
		// own deps must be installed before the dist can be rebuilt from source.
		installDeps: true,
		// Deploy needs only the JS bundle (the package is marked external in
		// bundle-api.mjs and consumed as JS at runtime; nothing at deploy or boot
		// reads its .d.ts). Its `build` script runs `tsup --dts`, whose rollup-dts
		// declaration pass fails on a fresh checkout ("could not resolve entry
		// module src/index.ts"), which took down clean-worktree deploys. `build:dist`
		// is the same tsup invocation with `--no-dts`, so it produces the identical
		// runtime JS without the declaration step. The npm-publish path still uses
		// `build` (with types); only this deploy orchestrator skips them.
		buildScript: 'build:dist',
		entries: [
			'solana-agent-sdk/dist/index.js',
			'solana-agent-sdk/dist/wallet/index.js',
			'solana-agent-sdk/dist/x402-exact/index.js',
			'solana-agent-sdk/dist/solana-agent-kit/index.js',
		],
	},
];

function sdkDistIsValid(entries) {
	for (const rel of entries) {
		const abs = resolve(ROOT, rel);
		if (!existsSync(abs)) {
			console.log(`[sdk-dist] ${rel} missing`);
			return false;
		}
		try {
			// `node --check` parses + statically links-checks the ESM without
			// executing it. Catches the corrupt-dist case the old existsSync guard
			// let through.
			execSync(`node --check ${JSON.stringify(abs)}`, { stdio: 'pipe' });
		} catch (err) {
			const msg = (err.stderr?.toString() || err.message || '').split('\n')[0];
			console.log(`[sdk-dist] ${rel} failed parse check: ${msg}`);
			return false;
		}
	}
	return true;
}

async function ensureSDKDist() {
	for (const sdk of SDKS) {
		if (sdkDistIsValid(sdk.entries)) continue;
		console.log(`[sdk-dist] ${sdk.name} dist missing or invalid — rebuilding from source`);
		execSync('rm -rf dist', { cwd: resolve(ROOT, sdk.dir), stdio: 'inherit' });
		if (sdk.installDeps && !existsSync(resolve(ROOT, sdk.dir, 'node_modules/.bin/tsup'))) {
			console.log(`[sdk-dist] ${sdk.name} build deps missing — installing`);
			await run(`sdk-deps:${sdk.dir}`, `npm ci --prefix ${sdk.dir} --no-audit --no-fund`, {
				env: { NODE_OPTIONS: '--no-deprecation' },
			});
		}
		await run(`sdk-dist:${sdk.dir}`, `npm run ${sdk.buildScript || 'build'} --prefix ${sdk.dir}`, {
			env: { NODE_OPTIONS: '--no-deprecation' },
		});
		if (!sdkDistIsValid(sdk.entries)) {
			throw new Error(`[sdk-dist] ${sdk.name} rebuild produced an invalid dist — aborting`);
		}
	}
}

async function prebuild() {
	// Type gate first: with GitHub Actions unavailable on this account, the
	// deploy build is the only automated checkpoint, so a type error in a
	// ratcheted file (see jsconfig.json) fails the deploy instead of shipping.
	// Cheap (~5s) and has already caught a real prod bug (elevenlabs voice_id).
	await run('typecheck', `node ${binCli('typescript', 'tsc')} -p jsconfig.json`);
	await Promise.all([
		run('build:news', 'node scripts/build-news.mjs'),
		run('build:skill-metadata', 'node scripts/build-skill-metadata.mjs'),
		run('build:local-skill-packs', 'node scripts/build-local-skill-packs.mjs'),
		run('build:club-props', 'node scripts/build-club-props.mjs'),
		run('build:club-venue', 'node scripts/build-club-venue.mjs'),
		run('build:club-hdri', 'node scripts/build-club-hdri.mjs'),
	]);
	// inject-blog-seo upserts discovered posts into data/pages.json, so it must
	// run BEFORE build-page-index (which reads pages.json to emit the sitemap,
	// llms.txt and the human /sitemap page).
	await run('seo:blog', 'node scripts/inject-blog-seo.mjs --write');
	await run('build:page-index', 'node scripts/build-page-index.mjs && node scripts/audit-page-index.mjs --strict && node scripts/verify-routes.mjs --strict');
	// inject-seo-meta backfills static-page <head> tags AFTER the page index, so
	// it also stamps the freshly-generated /sitemap page. Both injectors are
	// idempotent — a no-op once a page is fully covered.
	await run('seo:pages', 'node scripts/inject-seo-meta.mjs --write');
	// Regenerate the published IBM partnership page from its editable source
	// (pages/ibm/hello.live.html) AFTER the SEO/head injectors have stamped it,
	// so the baked, self-contained pages/ibm/hello.html inherits the same <head>.
	// The Vite build then copies both verbatim into dist/ibm/.
	await run('build:ibm-shell', 'node scripts/build-ibm-shell.mjs');
}

async function buildLib() {
	await run('build:lib', `TARGET=lib node ${binCli('vite')} build`);
	await run('avatar-sdk', 'node avatar-sdk/build.mjs');
}

async function buildApp() {
	await run('build:app', `node ${binCli('vite')} build && node scripts/strip-sw-from-embeds.mjs && node scripts/inject-tour-boot.mjs`, {
		env: { NODE_OPTIONS: '--no-deprecation --max-old-space-size=6144' },
	});
}

async function bundleApi() {
	await run('bundle-api', 'node scripts/bundle-api.mjs');
}

async function postBuild() {
	await Promise.all([
		run('copy-avatar-studio', 'node scripts/copy-avatar-studio.mjs'),
		run('publish:lib', 'node scripts/publish-lib.mjs'),
		run('apply:r2-cors', "node scripts/set-r2-cors.mjs || echo '[apply:r2-cors] skipped'"),
		run('changelog:telegram', "node scripts/changelog-telegram.mjs || echo '[changelog:telegram] skipped'"),
	]);
}

const totalStart = Date.now();
const phase = (n, label) => console.log(`\n=== build:vercel phase ${n}: ${label} (t+${((Date.now() - totalStart) / 1000).toFixed(1)}s) ===`);

try {
	// Phase 1a: light tasks only — no Vite processes yet. bundle-api inlines
	// @three-ws/agent-payments (not in its EXTERNALS), so the SDK dist must
	// exist before esbuild resolves it — sdk-dist gates bundle-api; prebuild
	// stays parallel.
	phase(1, 'audit:deploy ∥ prebuild ∥ (sdk-dist → bundle-api ∥ test:gate)');
	await Promise.all([
		// Fails in seconds on committed symlinks, unsatisfied peer deps, or
		// undeclared api/ imports — the classes behind the 2026-06-11 outage —
		// instead of 18 minutes into NFT tracing or, worse, at runtime.
		run('audit:deploy', 'node scripts/audit-deploy-artifacts.mjs'),
		// Solana address parity + on-chain provenance: fails the build on a
		// hardcoded non-$THREE coin or a drifted program ID/mint across the repo,
		// and confirms the canonical accounts are the right kind on mainnet
		// (live check degrades to a warning when the RPC is unreachable).
		run('verify:solana', 'node scripts/verify-solana-parity.mjs'),
		// ERC-8004 EVM registry parity: the same registry addresses are hand-copied
		// across src/erc8004/abi.js, sdk/src/erc8004/abi.js, and
		// api/_lib/erc8004-chains.js. A drift sends registrations / reputation /
		// validation writes to the wrong (or zero) contract. Hard-fails on any
		// mismatch or the ValidationRegistry null-vs-address drift trap. The live
		// bytecode sweep defaults to Base mainnet + Base Sepolia (both deployed);
		// an unreachable RPC degrades to a warning so transport noise never blocks.
		run('verify:onchain', 'node scripts/verify-onchain-parity.mjs'),
		// MCP registry manifests: catches version drift, >100-char descriptions,
		// and mcpName mismatches at build time instead of on publish day.
		run('audit:mcp', 'node scripts/audit-mcp-manifests.mjs'),
		prebuild(),
		// sdk-dist gates BOTH consumers of @three-ws/agent-payments: bundle-api
		// inlines it (esbuild resolve), and test:gate's leaderboard test imports
		// it (vite resolve). When postinstall's build-cache skips the SDK build
		// (or a fresh install lands without dist), racing test:gate ahead of
		// sdk-dist fails the deploy on "Failed to resolve entry" — deployment
		// 516c557e7, 2026-07-03. Sequence it explicitly instead of relying on
		// postinstall having built the dist.
		ensureSDKDist().then(() =>
			Promise.all([
				bundleApi(),
				// Critical-path test gate: a curated, offline-safe subset of money/auth
				// unit tests (see scripts/test-gate.mjs). With GitHub Actions unavailable,
				// this is the only place a regression in confirmation handling, the HTTP
				// cache/error boundary, or custody spend guards fails the deploy instead
				// of shipping. ~7s; the full suite still runs via `npm test` locally.
				run('test:gate', 'node scripts/test-gate.mjs'),
			]),
		),
	]);

	// Phase 2: buildLib alone. avatar-sdk depends on dist-lib/agent-3d.js, and
	// running this Vite build in isolation keeps peak RAM well under the 8 GB
	// Vercel container ceiling before the next pair starts.
	phase(2, 'lib + avatar-sdk (sequential)');
	await buildLib();

	// Phase 3: the remaining heavy Vite builds. Cap at two concurrent Vite
	// processes — three (the previous shape) tipped the container into
	// std::bad_alloc/SIGABRT during minification.
	phase(3, 'avatar-studio + chat (parallel, capped at 2)');
	await Promise.all([
		buildAvatarStudio(),
		buildChat(),
	]);

	phase(4, 'app vite build');
	await buildApp();

	phase(5, 'post-build (copy-avatar-studio + publish-lib + r2-cors)');
	await postBuild();

	clearInterval(heartbeat);
	const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
	console.log(`\n✓ build:vercel complete in ${totalElapsed}s`);
} catch (err) {
	clearInterval(heartbeat);
	const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
	console.error(`\n✗ build:vercel failed after ${totalElapsed}s: ${err.message}`);
	if (running.size > 0) {
		const labels = [...running].map(([l, t]) => `${l} (${((Date.now() - t) / 1000).toFixed(0)}s)`).join(', ');
		console.error(`  still running when build failed: ${labels}`);
	}
	process.exit(1);
}
