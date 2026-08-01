#!/usr/bin/env node
/**
 * check-doc-media.mjs: keep the docs' figures honest.
 *
 * The media pipeline (scripts/capture-doc-media.mjs) can produce a correct
 * image and the docs can still be wrong: a tutorial can point at a file nobody
 * ever captured, a recipe can survive after the doc that used it was rewritten,
 * an image can be swapped by hand so it no longer matches the manifest it is
 * described by, and an author can ship an image with no alt text, which is a
 * defect for every reader using a screen reader.
 *
 * None of that is visible in a diff, so this is the gate that sees it.
 *
 *   node scripts/check-doc-media.mjs          report and exit non-zero on failure
 *   node scripts/check-doc-media.mjs --json   same checks, machine-readable
 *
 * Checks, in order of how badly each one breaks a reader:
 *
 *   1. Broken figure     a doc references /docs/img/x but no such file exists.
 *   2. Missing alt       a markdown image in docs/ ships with empty alt text.
 *   3. Uncaptured shot   a recipe exists but was never run, so nothing to show.
 *   4. Tampered file     bytes on disk no longer match the manifest's sha256.
 *   5. Stale usedBy      a recipe claims a doc uses it and that doc does not.
 *
 * Orphan images (present, unreferenced, not owned by a recipe) are reported as
 * notes rather than failures: images predating this pipeline are hand-placed and
 * legitimately owned by their page, not by data/doc-media.json.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_FILE = path.join(ROOT, 'data/doc-media.json');
const MANIFEST_FILE = path.join(ROOT, 'public/docs/media-manifest.json');
const IMG_DIR = path.join(ROOT, 'public/docs/img');
const DOCS_DIR = path.join(ROOT, 'docs');
const JSON_OUT = process.argv.includes('--json');

const IMAGE_RE = /!\[([^\]]*)\]\(\s*(\/docs\/img\/[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_IMG_RE = /<img\b[^>]*\bsrc=["'](\/docs\/img\/[^"']+)["'][^>]*>/gi;

function readJson(file, fallback) {
	if (!existsSync(file)) return fallback;
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch (err) {
		console.error(`check-doc-media: ${path.relative(ROOT, file)} is not valid JSON: ${err.message}`);
		process.exit(1);
	}
}

function walkMarkdown(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		const stats = statSync(full);
		if (stats.isDirectory()) walkMarkdown(full, out);
		else if (entry.endsWith('.md')) out.push(full);
	}
	return out;
}

const spec = readJson(SPEC_FILE, { shots: [] });
const manifest = readJson(MANIFEST_FILE, { shots: {} });
const shots = spec.shots || [];
const manifestShots = manifest.shots || {};

const failures = [];
const notes = [];

// ── Walk every doc once, collecting references ───────────────────────────────
const referenced = new Map(); // absolute /docs/img/… path → [doc paths]
const docFiles = existsSync(DOCS_DIR) ? walkMarkdown(DOCS_DIR) : [];

for (const file of docFiles) {
	const rel = path.relative(ROOT, file);
	const source = readFileSync(file, 'utf8');

	for (const match of source.matchAll(IMAGE_RE)) {
		const [, alt, src] = match;
		if (!alt.trim()) {
			failures.push({
				kind: 'missing-alt',
				doc: rel,
				src,
				message: `image has empty alt text: ${src}`,
			});
		}
		if (!referenced.has(src)) referenced.set(src, []);
		referenced.get(src).push(rel);
	}

	for (const match of source.matchAll(HTML_IMG_RE)) {
		const src = match[1];
		if (!/\balt=/.test(match[0])) {
			failures.push({
				kind: 'missing-alt',
				doc: rel,
				src,
				message: `<img> has no alt attribute: ${src}`,
			});
		}
		if (!referenced.has(src)) referenced.set(src, []);
		referenced.get(src).push(rel);
	}
}

// 1. Broken figures: a doc points at an image that is not on disk.
for (const [src, docs] of referenced) {
	const onDisk = path.join(ROOT, 'public', src.replace(/^\//, ''));
	if (!existsSync(onDisk)) {
		failures.push({
			kind: 'broken-figure',
			src,
			docs,
			message: `${src} is referenced by ${docs.join(', ')} but does not exist. Run: node scripts/capture-doc-media.mjs --only ${path.basename(src).replace(/\.\w+$/, '')}`,
		});
	}
}

// 3. Uncaptured shots + 4. tampered files.
for (const shot of shots) {
	const file = path.join(IMG_DIR, `${shot.id}.webp`);
	const entry = manifestShots[shot.id];
	if (!existsSync(file)) {
		failures.push({
			kind: 'uncaptured-shot',
			id: shot.id,
			message: `recipe "${shot.id}" has never been captured. Run: node scripts/capture-doc-media.mjs --only ${shot.id}`,
		});
		continue;
	}
	if (!entry) {
		failures.push({
			kind: 'uncaptured-shot',
			id: shot.id,
			message: `${shot.id}.webp exists but has no manifest entry, so the docs cannot size or attribute it. Re-run the capture.`,
		});
		continue;
	}
	const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
	if (entry.sha256 && sha !== entry.sha256) {
		failures.push({
			kind: 'tampered-file',
			id: shot.id,
			message: `${shot.id}.webp no longer matches the manifest sha256. Images in this directory are generated, not edited: re-run the capture instead of replacing the file.`,
		});
	}
}

// 5. Stale usedBy: the recipe claims a doc renders it, and that doc does not.
for (const shot of shots) {
	for (const docSlug of shot.usedBy || []) {
		const candidates = [
			path.join(DOCS_DIR, `${docSlug}.md`),
			path.join(DOCS_DIR, docSlug, 'index.md'),
		];
		const docFile = candidates.find((candidate) => existsSync(candidate));
		if (!docFile) {
			failures.push({
				kind: 'stale-usedby',
				id: shot.id,
				message: `recipe "${shot.id}" lists usedBy "${docSlug}", which is not a doc in docs/.`,
			});
			continue;
		}
		if (!readFileSync(docFile, 'utf8').includes(`/docs/img/${shot.id}.`)) {
			failures.push({
				kind: 'stale-usedby',
				id: shot.id,
				message: `recipe "${shot.id}" lists usedBy "${docSlug}", but that doc does not reference /docs/img/${shot.id}. Either embed it or drop the claim.`,
			});
		}
	}
}

// Orphans: informational. Hand-placed images that predate the pipeline are fine.
const specIds = new Set(shots.map((shot) => shot.id));
if (existsSync(IMG_DIR)) {
	for (const file of readdirSync(IMG_DIR)) {
		const src = `/docs/img/${file}`;
		const id = file.replace(/\.\w+$/, '');
		if (referenced.has(src) || specIds.has(id)) continue;
		notes.push(`${src} is not referenced by any doc and has no recipe`);
	}
}

if (JSON_OUT) {
	console.log(JSON.stringify({ ok: failures.length === 0, failures, notes }, null, '\t'));
	process.exit(failures.length ? 1 : 0);
}

const total = referenced.size;
console.log(
	`doc media: ${shots.length} recipe(s), ${Object.keys(manifestShots).length} captured, ${total} image reference(s) across ${docFiles.length} docs`,
);

for (const note of notes) console.log(`  note  ${note}`);
for (const failure of failures) console.error(`  FAIL  ${failure.message}`);

if (failures.length) {
	console.error(`\n${failures.length} problem(s).`);
	process.exit(1);
}
console.log('\nAll doc figures resolve, carry alt text, and match their manifest.');
