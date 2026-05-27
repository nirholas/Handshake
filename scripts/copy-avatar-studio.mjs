#!/usr/bin/env node
// Post-build copy of character-studio/build → dist/avatar-studio.
// Used when build:avatar-studio runs in parallel with the main vite build, so
// the vite closeBundle hook fires before character-studio/build is ready.
// Running this after both finish ensures avatar-studio lands in dist/.
import { cpSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'character-studio/build');
const dest = resolve(root, 'dist/avatar-studio');

if (existsSync(src)) {
	cpSync(src, dest, { recursive: true });
	console.log('[copy-avatar-studio] dist/avatar-studio populated');
} else {
	console.warn('[copy-avatar-studio] character-studio/build/ missing — avatar-studio not in dist');
}
