#!/usr/bin/env node
// Publish data/guards.json to public/guards.json, which the /guards page fetches.
//
// data/ is source and is never served, so a page cannot read the registry
// directly. Every other registry here follows the same shape (pages.json feeds
// features.json, the changelog feeds changelog.json), and the generated copy is
// committed so the page works from a clean checkout without a build step.
//
// Staleness is the obvious failure: someone edits the registry, never rebuilds,
// and /guards shows last week's answer while docs/guards.md shows this week's.
// scripts/audit-guards.mjs fails the gate when the two disagree, so this is a
// closed loop rather than a convention.
//
// Run: node scripts/build-guards.mjs   (wired as `npm run build:guards`)

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The exact bytes public/guards.json must contain for a given registry. */
export function renderPublicGuards(registry) {
	return `${JSON.stringify(registry, null, '\t')}\n`;
}

const src = path.join(root, 'data/guards.json');
const out = path.join(root, 'public/guards.json');
const registry = JSON.parse(readFileSync(src, 'utf8'));
const body = renderPublicGuards(registry);

let previous = null;
try {
	previous = readFileSync(out, 'utf8');
} catch {
	previous = null;
}

if (previous === body) {
	console.log(`[build-guards] public/guards.json already current (${registry.guards.length} guards)`);
} else {
	writeFileSync(out, body);
	console.log(`[build-guards] wrote public/guards.json (${registry.guards.length} guards, ${registry.stages.length} stages)`);
}
