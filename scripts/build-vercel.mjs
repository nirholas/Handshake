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
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isCached, writeStamp } from './build-cache.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
	await run('avatar-studio', 'npm run build --prefix character-studio');
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

async function prebuild() {
	await Promise.all([
		run('build:news', 'node scripts/build-news.mjs'),
		run('build:skill-metadata', 'node scripts/build-skill-metadata.mjs'),
		run('build:local-skill-packs', 'node scripts/build-local-skill-packs.mjs'),
		run('build:club-props', 'node scripts/build-club-props.mjs'),
		run('build:club-venue', 'node scripts/build-club-venue.mjs'),
		run('build:club-hdri', 'node scripts/build-club-hdri.mjs'),
	]);
	await run('build:page-index', 'node scripts/build-page-index.mjs && node scripts/audit-page-index.mjs');
}

async function buildLib() {
	await run('build:lib', 'TARGET=lib npx vite build');
	await run('avatar-sdk', 'node avatar-sdk/build.mjs');
}

async function buildApp() {
	await run('build:app', 'npx vite build && node scripts/strip-sw-from-embeds.mjs', {
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
	]);
}

const totalStart = Date.now();
const phase = (n, label) => console.log(`\n=== build:vercel phase ${n}: ${label} (t+${((Date.now() - totalStart) / 1000).toFixed(1)}s) ===`);

try {
	phase(1, 'prebuild + lib + avatar-studio + chat + bundle-api (parallel)');
	await Promise.all([
		prebuild(),
		buildLib(),
		buildAvatarStudio(),
		buildChat(),
		bundleApi(),
	]);

	phase(2, 'app vite build');
	await buildApp();

	phase(3, 'post-build (copy-avatar-studio + publish-lib + r2-cors)');
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
