#!/usr/bin/env node
// Rebuild @three-ws/tour's CDN bundle and sync it into public/tour-builder/.
// =========================================================================
// The Tour Builder page (/tour-builder) previews a REAL tour, not a mockup, by
// loading /tour-builder/tour.global.js, the same IIFE the package publishes to
// unpkg. That file used to be a hand-copied build output with nothing producing
// it, so it drifted: the copy served to visitors was built against an older
// walk-sdk than the one in this repo. This script is the missing wiring.
//
//   node scripts/sync-tour-global.mjs           # rebuild + copy
//   node scripts/sync-tour-global.mjs --check   # fail if the copy is stale
//
// The bundle's //# sourceMappingURL comment is stripped on the way in: the map
// is 3.6 MB of build output nobody ships to the edge, and leaving the comment
// makes every visitor's devtools request a 404.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkDir = resolve(root, 'tour-sdk');
const built = resolve(sdkDir, 'dist/tour.global.js');
const target = resolve(root, 'public/tour-builder/tour.global.js');
const check = process.argv.includes('--check');

execFileSync('node', ['build.mjs'], { cwd: sdkDir, stdio: 'inherit' });

if (!existsSync(built)) {
	console.error('[sync-tour-global] tour-sdk build produced no dist/tour.global.js');
	process.exit(1);
}

const next = readFileSync(built, 'utf8').replace(/\n?\/\/# sourceMappingURL=.*\n?$/, '\n');
const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
const kb = (s) => Math.round(s.length / 1024);

if (current === next) {
	console.log(`[sync-tour-global] public/tour-builder/tour.global.js up to date (${kb(next)} kB)`);
	process.exit(0);
}

if (check) {
	console.error(
		'[sync-tour-global] public/tour-builder/tour.global.js is stale, run `npm run build:tour-global`',
	);
	process.exit(1);
}

writeFileSync(target, next);
console.log(
	`[sync-tour-global] wrote public/tour-builder/tour.global.js (${kb(next)} kB, was ${current ? `${kb(current)} kB` : 'absent'})`,
);
