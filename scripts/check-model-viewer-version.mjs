#!/usr/bin/env node
/**
 * Guard the <model-viewer> pin.
 *
 * Google's <model-viewer> registers itself as a custom element, so the second
 * `customElements.define('model-viewer', ...)` in one document throws and the
 * later surface renders nothing. A three.ws embed pasted onto a page that also
 * carries another three.ws surface is exactly that document, which is why every
 * reference in this repo must name ONE build. What legitimately differs per
 * surface is delivery, not version: a top-level document carries an SRI hash, a
 * server-interpolated embed does not, and the Vite pages walk a CDN failover
 * chain that cannot pin one hash. api/_lib/model-viewer-cdn.js explains each rung.
 *
 * Nothing enforced that, and it drifted: eight of eighty-one references sat a
 * major version behind the rest, with two stale SRI hashes still pointing at the
 * older build. This checks three things offline:
 *
 *   1. every model-viewer URL in tracked source names the same version,
 *   2. no version is served with two different integrity hashes (the shape a
 *      half-finished bump leaves behind: URL updated, SRI forgotten),
 *   3. the vendored copy under pages/ibm/vendor/ still hashes to the build the
 *      rest of the tree points at.
 *
 *   node scripts/check-model-viewer-version.mjs
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// The offline copy of the library that pages/ibm serves itself.
const VENDORED = 'pages/ibm/vendor/model-viewer.min.js';

// Both URL shapes in use: Google's hosted path form and the npm CDN form.
const URL_RE =
	/(?:ajax\.googleapis\.com\/ajax\/libs\/model-viewer\/(\d+\.\d+\.\d+)|@google\/model-viewer@(\d+\.\d+\.\d+))/g;
// Integrity is read per <script> TAG, never from a character window around the
// URL: pages routinely load model-viewer next to another SRI-pinned CDN script
// (highlight.js on /tutorial), and a window wide enough to reach the attribute
// is also wide enough to steal the neighbour's hash.
const SCRIPT_TAG_RE = /<script\b[^>]*>/gi;
const INTEGRITY_RE = /integrity=["'](sha\d{3}-[A-Za-z0-9+/=]+)["']/i;

const SCANNED = /\.(js|mjs|cjs|jsx|ts|tsx|html|htm|md|json|svelte|vue|py|ipynb)$/;

// Point-in-time captures of past runs (audit baselines, recorded MCP responses).
// They are records of what shipped then, not references that should be bumped.
const SKIPPED = [/\/_generated\//, /\.min\.js$/, /^node_modules\//];

function trackedFiles() {
	const listed = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n');
	return [...listed(['ls-files']), ...listed(['ls-files', '-o', '--exclude-standard'])]
		.filter(Boolean)
		.filter((p) => SCANNED.test(p))
		.filter((p) => !SKIPPED.some((re) => re.test(p)))
		.sort();
}

function digest(path, algo = 'sha384') {
	return `${algo}-${createHash(algo).update(readFileSync(path)).digest('base64')}`;
}

// version -> Set(file), and version -> Map(integrity -> Set(file))
const versions = new Map();
const integrities = new Map();
let refs = 0;

for (const file of trackedFiles()) {
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		continue;
	}
	if (!text.includes('model-viewer')) continue;

	for (const match of text.matchAll(URL_RE)) {
		const version = match[1] || match[2];
		refs += 1;
		if (!versions.has(version)) versions.set(version, new Set());
		versions.get(version).add(file);
	}

	for (const tag of text.match(SCRIPT_TAG_RE) || []) {
		URL_RE.lastIndex = 0;
		const url = URL_RE.exec(tag);
		if (!url) continue;
		const version = url[1] || url[2];
		const integrity = tag.match(INTEGRITY_RE)?.[1];
		if (!integrity) continue;
		if (!integrities.has(version)) integrities.set(version, new Map());
		const byHash = integrities.get(version);
		if (!byHash.has(integrity)) byHash.set(integrity, new Set());
		byHash.get(integrity).add(file);
	}
}

const failures = [];

if (versions.size === 0) {
	failures.push('found no <model-viewer> references at all: this guard is scanning the wrong thing');
} else if (versions.size > 1) {
	const ranked = [...versions.entries()].sort((a, b) => b[1].size - a[1].size);
	const [canonical] = ranked[0];
	const lines = ranked
		.slice(1)
		.map(([v, files]) => `    ${v} in ${files.size} file(s):\n${[...files].map((f) => `      ${f}`).join('\n')}`);
	failures.push(
		`${versions.size} model-viewer versions in the tree; the majority is ${canonical}.\n` +
			`${lines.join('\n')}\n` +
			`    Two builds can collide in one document. Move every reference to one version.`,
	);
}

for (const [version, byHash] of integrities) {
	if (byHash.size < 2) continue;
	const lines = [...byHash.entries()].map(
		([hash, files]) => `    ${hash}\n${[...files].map((f) => `      ${f}`).join('\n')}`,
	);
	failures.push(
		`model-viewer ${version} is served with ${byHash.size} different integrity hashes:\n${lines.join('\n')}\n` +
			`    One of these is stale (a bumped URL with its SRI left behind). Recompute:\n` +
			`      curl -s https://ajax.googleapis.com/ajax/libs/model-viewer/${version}/model-viewer.min.js | openssl dgst -sha384 -binary | openssl base64 -A`,
	);
}

// The vendored copy must be the same build everything else points at.
const [pinned] = [...versions.keys()];
if (versions.size === 1 && integrities.has(pinned)) {
	const [expected] = [...integrities.get(pinned).keys()];
	let actual;
	try {
		actual = digest(VENDORED, expected.split('-')[0]);
	} catch {
		actual = null;
	}
	if (actual === null) {
		failures.push(`${VENDORED} is missing; the pages/ibm hosted page has no model-viewer to serve`);
	} else if (actual !== expected) {
		failures.push(
			`${VENDORED} is not the pinned ${pinned} build.\n` +
				`    expected ${expected}\n` +
				`    actual   ${actual}\n` +
				`    Restage it:\n` +
				`      curl -sSfo ${VENDORED} https://ajax.googleapis.com/ajax/libs/model-viewer/${pinned}/model-viewer.min.js`,
		);
	}
}

if (failures.length) {
	console.error('[check-model-viewer-version] the <model-viewer> pin has drifted:\n');
	for (const failure of failures) console.error(`  ${failure}\n`);
	console.error('Background: api/_lib/model-viewer-cdn.js explains why one version is load-bearing.');
	process.exit(1);
}

console.log(
	`[check-model-viewer-version] OK: ${refs} references across ${[...versions.values()][0].size} files all pin ${pinned}` +
		(integrities.has(pinned) ? `, one integrity hash, vendored copy matches` : ''),
);
