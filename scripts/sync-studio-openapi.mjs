#!/usr/bin/env node
// Keeps the custom-GPT Actions file in step with the served 3D Studio schema.
//
// public/.well-known/3d-studio-openapi.yaml is the source of truth: it is what
// https://three.ws/.well-known/3d-studio-openapi.yaml returns and what the GPT
// builder imports by URL (see docs/chatgpt-3d-studio-gpt.md). The submission kit
// carries a byte copy at prompts/store-submissions/_generated/openai-actions.yaml
// so the package an OpenAI reviewer reads is the same document the site serves.
// Neither copy is hand-maintained: edit the served one, then run this.
//
//   node scripts/sync-studio-openapi.mjs           regenerate the copy
//   node scripts/sync-studio-openapi.mjs --check   exit 1 if the copy drifted
//
// The same invariant is asserted from the test side in
// tests/api/3d-studio-openapi.test.js, which also guards the schema's contents.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVED = resolve(ROOT, 'public/.well-known/3d-studio-openapi.yaml');
const COPY = resolve(ROOT, 'prompts/store-submissions/_generated/openai-actions.yaml');

const rel = (p) => relative(ROOT, p);
const check = process.argv.includes('--check');

let served;
try {
	served = readFileSync(SERVED, 'utf8');
} catch {
	console.error(`Missing the served 3D Studio schema at ${rel(SERVED)}.`);
	console.error('It is the source of truth for the custom-GPT Actions contract and must exist.');
	process.exit(1);
}

let copy = null;
try {
	copy = readFileSync(COPY, 'utf8');
} catch {
	copy = null;
}

if (copy === served) {
	console.log(`3D Studio OpenAPI in sync: ${rel(COPY)} matches ${rel(SERVED)}.`);
	process.exit(0);
}

if (check) {
	console.error(`3D Studio OpenAPI drift: ${rel(COPY)} does not match ${rel(SERVED)}.`);
	console.error(copy === null ? 'The submission copy is missing.' : 'The two copies differ.');
	console.error('Fix: edit the served schema, then run `npm run sync:studio-openapi`.');
	process.exit(1);
}

writeFileSync(COPY, served);
console.log(`Wrote ${rel(COPY)} from ${rel(SERVED)}.`);
