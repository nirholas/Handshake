#!/usr/bin/env node
/**
 * The three-copy rule for the OKX.AI listing, enforced mechanically.
 *
 * Agent #2632's catalog exists in three places, and OKX rejects the listing if
 * they disagree:
 *   1. the module: api/_lib/okx-catalog.js, the source of truth
 *   2. the live: GET https://three.ws/api/okx/3d/catalog, what a buyer reads
 *   3. the listing: scripts/okx-listing-payload.mjs, what gets submitted to OKX
 *
 * Copies 1 and 2 diverge on every deploy that ships a catalog edit but does not
 * reach production; copies 1 and 3 diverge whenever the payload generator is
 * edited by hand. Both have happened. A reviewer who reads a price on the
 * listing and gets a different 402 amount from the endpoint fails the listing,
 * so this runs before any resubmission and after any catalog deploy.
 *
 * Usage:
 *   node scripts/okx-three-copy-check.mjs
 *   node scripts/okx-three-copy-check.mjs --base http://localhost:3000
 *   node scripts/okx-three-copy-check.mjs --json report.json
 *
 * Exit 0 = all three copies agree. Exit 1 = drift (each divergence printed).
 * Exit 2 = the live endpoint could not be read.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { OKX_CATALOG, catalogIndex, listingDescription, validateCatalog } from '../api/_lib/okx-catalog.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
	const args = { base: 'https://three.ws', json: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--base') args.base = argv[++i].replace(/\/$/, '');
		else if (argv[i] === '--json') args.json = argv[++i];
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
const drift = [];
const fail = (where, detail) => drift.push({ where, detail });

// Copy 1: the module must be internally valid before it is worth comparing.
validateCatalog();
console.log(`module    ${OKX_CATALOG.length} rows, validateCatalog PASS`);

// Copy 2: the live endpoint. catalogIndex() is the exact function the route
// serializes, so a byte-identical JSON comparison is the strongest available
// check, not an approximation of one.
let live;
try {
	const res = await fetch(`${args.base}/api/okx/3d/catalog`, { signal: AbortSignal.timeout(30_000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	live = await res.json();
} catch (err) {
	console.error(`FAIL  could not read ${args.base}/api/okx/3d/catalog: ${err.message}`);
	process.exit(2);
}

const mod = catalogIndex();
if (JSON.stringify(mod) === JSON.stringify(live)) {
	console.log(`live      ${live.services.length} rows, byte-identical to the module`);
} else {
	const liveById = new Map((live.services || []).map((s) => [s.id, s]));
	for (const m of mod.services) {
		const l = liveById.get(m.id);
		if (!l) {
			fail('live', `missing row "${m.id}" (deploy did not ship it)`);
			continue;
		}
		for (const key of new Set([...Object.keys(m), ...Object.keys(l)])) {
			if (JSON.stringify(m[key]) !== JSON.stringify(l[key])) {
				fail('live', `${m.id}.${key}\n    module: ${JSON.stringify(m[key])}\n    live  : ${JSON.stringify(l[key])}`);
			}
		}
		liveById.delete(m.id);
	}
	for (const extra of liveById.keys()) fail('live', `row "${extra}" is live but not in the module`);
	for (const key of ['provider', 'okxAgentId', 'chain', 'docs']) {
		if (JSON.stringify(mod[key]) !== JSON.stringify(live[key])) {
			fail('live', `${key}: module ${JSON.stringify(mod[key])} vs live ${JSON.stringify(live[key])}`);
		}
	}
}

// Copy 3: the submission payload. Compared by service name because that is the
// key OKX matches on when updating an existing listing.
const submission = JSON.parse(
	execFileSync('node', ['scripts/okx-listing-payload.mjs'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 24 }),
);
console.log(`listing   ${submission.length} rows from scripts/okx-listing-payload.mjs`);

const byName = new Map(submission.map((s) => [s.serviceName, s]));
for (const row of OKX_CATALOG) {
	const s = byName.get(row.name);
	if (!s) {
		fail('listing', `submission omits "${row.name}"`);
		continue;
	}
	if (s.serviceDescription !== listingDescription(row)) {
		fail('listing', `"${row.name}" description differs from listingDescription(entry)`);
	}
	if (String(s.fee) !== String(row.priceUsd)) fail('listing', `"${row.name}" fee ${s.fee} vs module ${row.priceUsd}`);
	if (s.endpoint !== row.endpoint) fail('listing', `"${row.name}" endpoint ${s.endpoint} vs module ${row.endpoint}`);
	byName.delete(row.name);
}
for (const extra of byName.keys()) fail('listing', `submission has "${extra}" which is not in the module`);

if (args.json) {
	writeFileSync(args.json, JSON.stringify({ base: args.base, rows: OKX_CATALOG.length, drift, ok: drift.length === 0 }, null, 2));
}

if (drift.length === 0) {
	console.log('\nTHREE-COPY: PASS (module == live == listing submission)');
	process.exit(0);
}
console.log('');
for (const d of drift) console.log(`DRIFT [${d.where}] ${d.detail}`);
console.log(`\nTHREE-COPY: FAIL (${drift.length} divergence${drift.length === 1 ? '' : 's'})`);
process.exit(1);
