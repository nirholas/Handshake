#!/usr/bin/env node
// Refresh public/claude-artifact-csp.txt from simonw's scraper.
//
// Run periodically (or via a cron). The contract test reads the vendored
// copy so it doesn't depend on network at run time; this script keeps it
// honest. If the upstream CSP changes shape, the test will start failing
// until /api/artifact is updated to match.
//
// The copy lives under public/ so it is also served at
// https://three.ws/claude-artifact-csp.txt: the artifact builder page reads
// the same bytes the contract test pins, from our own origin, instead of
// reaching GitHub at page load.

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SOURCE =
	'https://raw.githubusercontent.com/simonw/scrape-claude-artifacts/main/content-security-policy.txt';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(__dirname, '../public/claude-artifact-csp.txt');

const res = await fetch(SOURCE);
if (!res.ok) {
	console.error(`fetch failed: ${res.status}`);
	process.exit(1);
}
const fresh = (await res.text()).trim() + '\n';

let prev = '';
try {
	prev = readFileSync(TARGET, 'utf8');
} catch {}

if (prev.trim() === fresh.trim()) {
	console.log('CSP unchanged');
	process.exit(0);
}

writeFileSync(TARGET, fresh);
console.log(`updated ${TARGET}`);
console.log('--- diff snippet ---');
console.log('was:', prev.slice(0, 300).replace(/\n/g, ' '));
console.log('now:', fresh.slice(0, 300).replace(/\n/g, ' '));
