// Publish the file-defined agent examples to public/ so the web component can
// load them from any page on the open web.
//
// examples/coach-leo/manifest.json is written for a repository reader: its body
// URI is root-relative (/avatars/cz.glb), which resolves against the HOST page
// when <agent-3d manifest="..."> runs on someone else's domain. This script
// copies the tree into public/examples/ and rewrites exactly those references to
// absolute https://three.ws URLs, so a copy-pasted snippet works off-site.
//
// Relative references (instructions.md, ../skills/wave/) are left alone: the
// runtime resolves them against the manifest URL (src/manifest.js fetchRelative),
// and the directory layout is preserved here so they keep resolving.
//
// Run via `npm run build:examples`. Output is committed, because the production
// build chain (build:gcp) does not regenerate it.

import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://three.ws';
const OUT_DIR = join(root, 'public/examples');

// Each entry is a directory copied verbatim except for the rewrites below.
const TREES = ['examples/coach-leo', 'examples/skills/wave'];

// Manifest fields that must be absolute for an off-site embed to resolve them.
const ABSOLUTE_FIELDS = [['body', 'uri'], ['image']];

// README.md is written for a repository reader and nothing at runtime fetches
// it, so it stays out of the published tree.
const SKIP = new Set(['README.md']);

function walk(dir, base = dir, out = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, base, out);
		else if (!SKIP.has(name)) out.push(relative(base, full));
	}
	return out;
}

function absolutize(value) {
	if (typeof value !== 'string' || !value.startsWith('/')) return value;
	return ORIGIN + value;
}

function rewriteManifest(text) {
	const json = JSON.parse(text);
	for (const path of ABSOLUTE_FIELDS) {
		let node = json;
		for (const key of path.slice(0, -1)) node = node?.[key];
		const leaf = path[path.length - 1];
		if (node && typeof node === 'object' && leaf in node) node[leaf] = absolutize(node[leaf]);
	}
	return JSON.stringify(json, null, '\t') + '\n';
}

rmSync(OUT_DIR, { recursive: true, force: true });

let files = 0;
for (const tree of TREES) {
	const src = join(root, tree);
	// public/examples/coach-leo, public/examples/skills/wave; the layout under
	// examples/ is preserved so ../skills/wave/ still resolves from the manifest.
	const dest = join(OUT_DIR, relative(join(root, 'examples'), src));
	for (const rel of walk(src)) {
		const from = join(src, rel);
		const to = join(dest, rel);
		mkdirSync(dirname(to), { recursive: true });
		const raw = readFileSync(from, 'utf8');
		writeFileSync(to, rel === 'manifest.json' ? rewriteManifest(raw) : raw);
		files++;
	}
}

console.log(
	`wrote ${files} file(s) to public/examples/ from ${TREES.length} example tree(s); ` +
		'body/image URIs rewritten to absolute',
);
