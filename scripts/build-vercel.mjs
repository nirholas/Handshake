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

function run(label, cmd, opts = {}) {
	const start = Date.now();
	return new Promise((res, rej) => {
		console.log(`\n[${label}] starting: ${cmd}`);
		const child = spawn('sh', ['-c', cmd], {
			cwd: opts.cwd || ROOT,
			stdio: 'inherit',
			env: { ...process.env, ...opts.env },
		});
		child.on('close', (code) => {
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

try {
	// Phase 1: prebuild + build:lib + independent sub-builds — all in parallel
	// prebuild generates data files the app vite build reads (pages.json, skill metadata, news)
	// build:lib is independent of prebuild — produces dist-lib/agent-3d.js
	// avatar-studio, chat, bundle-api are fully independent
	await Promise.all([
		prebuild(),
		buildLib(),
		buildAvatarStudio(),
		buildChat(),
		bundleApi(),
	]);

	// Phase 2: app vite build (needs prebuild outputs + same node_modules)
	await buildApp();

	// Phase 3: post-build steps (depend on Phase 1+2 outputs)
	await postBuild();

	const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
	console.log(`\n✓ build:vercel complete in ${totalElapsed}s`);
} catch (err) {
	console.error(`\n✗ build:vercel failed: ${err.message}`);
	process.exit(1);
}
