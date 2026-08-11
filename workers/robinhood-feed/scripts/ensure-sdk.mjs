// Build the local `hoodchain` SDK if its dist/ is missing.
//
// package.json depends on the SDK through `file:../../robinhood/robinhood-chain-sdk`,
// which npm resolves by symlinking the source directory. npm does NOT run that
// directory's build for a file: dependency, and the SDK ships TypeScript whose
// dist/ is gitignored, so a fresh clone gets a symlink to a package with no
// entry point and `node index.js` dies with ERR_MODULE_NOT_FOUND. This runs as
// the worker's `prestart`/`presmoke` hook so `npm start` works from a clean
// checkout with no manual step.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = dirname(dirname(fileURLToPath(import.meta.url)));
const sdkDir = join(workerDir, '..', '..', 'robinhood', 'robinhood-chain-sdk');
const entry = join(sdkDir, 'dist', 'index.js');

if (existsSync(entry)) {
	process.exit(0);
}

if (!existsSync(join(sdkDir, 'package.json'))) {
	console.error(`[ensure-sdk] hoodchain source not found at ${sdkDir}`);
	console.error('[ensure-sdk] install the published package instead: npm install hoodchain');
	process.exit(1);
}

const run = (args) => execFileSync('npm', args, { cwd: sdkDir, stdio: 'inherit' });

console.log('[ensure-sdk] building hoodchain from source (dist/ is gitignored and absent)');
if (!existsSync(join(sdkDir, 'node_modules'))) run(['install', '--no-audit', '--no-fund']);
run(['run', 'build']);
console.log('[ensure-sdk] hoodchain dist/ ready');
