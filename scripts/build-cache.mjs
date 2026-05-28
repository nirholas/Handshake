#!/usr/bin/env node
/**
 * Hash-based build cache: skip a build step if its inputs haven't changed.
 *
 * Usage:
 *   import { cached } from './build-cache.mjs';
 *   const hit = await cached('avatar-studio', ['character-studio/src', 'character-studio/package.json']);
 *   if (!hit) runBuild();
 *
 * Or from CLI:
 *   node scripts/build-cache.mjs check <name> <paths...>    → exit 0 if cached, exit 1 if stale
 *   node scripts/build-cache.mjs stamp <name> <paths...>    → write stamp after successful build
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { resolve, join, relative } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const CACHE_DIR = resolve(ROOT, 'node_modules/.cache/build-stamps');

function ensureCacheDir() {
	if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function hashFile(path) {
	try {
		return createHash('sha256').update(readFileSync(path)).digest('hex');
	} catch {
		return 'missing';
	}
}

function collectFiles(dir, out = []) {
	if (!existsSync(dir)) return out;
	const st = statSync(dir);
	if (st.isFile()) {
		out.push(dir);
		return out;
	}
	if (!st.isDirectory()) return out;
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const e of entries) {
		if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'build') continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) collectFiles(full, out);
		else if (e.isFile()) out.push(full);
	}
	return out;
}

function computeHash(inputPaths) {
	const hash = createHash('sha256');
	for (const p of inputPaths) {
		const abs = resolve(ROOT, p);
		const files = collectFiles(abs).sort();
		for (const f of files) {
			hash.update(relative(ROOT, f) + '\0');
			hash.update(hashFile(f));
		}
	}
	return hash.digest('hex');
}

export function stampPath(name) {
	return join(CACHE_DIR, `${name}.stamp`);
}

export function isCached(name, inputPaths) {
	ensureCacheDir();
	const stamp = stampPath(name);
	if (!existsSync(stamp)) return false;
	const stored = readFileSync(stamp, 'utf8').trim();
	const current = computeHash(inputPaths);
	return stored === current;
}

export function writeStamp(name, inputPaths) {
	ensureCacheDir();
	writeFileSync(stampPath(name), computeHash(inputPaths));
}

export async function cached(name, inputPaths) {
	const hit = isCached(name, inputPaths);
	if (hit) console.log(`[build-cache] ${name}: cache hit, skipping`);
	else console.log(`[build-cache] ${name}: cache miss, rebuilding`);
	return hit;
}

if (process.argv[1] && process.argv[1].endsWith('build-cache.mjs')) {
	const [, , cmd, name, ...paths] = process.argv;
	if (!cmd || !name || paths.length === 0) {
		console.error('Usage: build-cache.mjs <check|stamp> <name> <paths...>');
		process.exit(2);
	}
	if (cmd === 'check') {
		process.exit(isCached(name, paths) ? 0 : 1);
	} else if (cmd === 'stamp') {
		writeStamp(name, paths);
		console.log(`[build-cache] stamped ${name}`);
	}
}
