#!/usr/bin/env node
// Build public/atlas-index.json, the search index behind the Atlas command
// palette (public/atlas.js) and the Atlas map page (/atlas).
// ============================================================================
// The problem this exists to solve: three.ws ships 600+ public routes across ten
// sections. Nothing on the site could take a visitor from "I want to do X" to
// the page that does X in one step; they had to already know the URL, or walk
// the sitemap. Discovery was the single largest UX tax on the product.
//
// The index has two halves:
//
//   pages   is every route in data/pages.json, flattened into compact tuples.
//             This is the destination set. Generated, never hand-edited, so a
//             page can never be in the sitemap yet missing from search.
//   intents is data/atlas-intents.json: curated "how do I ..." tasks that answer
//             with ORDERED STEPS, not a link. A palette that only navigates
//             still leaves a newcomer guessing which of four plausible pages
//             starts the flow; an intent tells them the flow.
//
// The build GATE is the point of generating this rather than fetching
// data/pages.json at runtime: every intent step target is resolved against the
// real route table here, at build time. A step pointing at a route that does not
// exist fails the build. That makes it structurally impossible to ship an
// onboarding path that dead-ends on a 404, the exact failure mode that makes
// hand-written getting-started docs rot.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = resolve(root, 'data/pages.json');
// Overridable so tests/atlas.test.js can run the REAL generator against a
// deliberately broken catalog and prove the gate below actually bites. A gate
// nobody has ever seen fail is a gate nobody knows works.
const INTENTS = process.env.ATLAS_INTENTS || resolve(root, 'data/atlas-intents.json');
const OUT = process.env.ATLAS_OUT || resolve(root, 'public/atlas-index.json');

// Descriptions in data/pages.json run to 428 chars. The palette renders one
// clamped line and scores on the leading text anyway, so carrying the full body
// would roughly double the payload for text no one reads. 160 is the meta
// description convention and keeps the sentence intact in practice.
const DESC_MAX = 160;

// Routes an intent step may target that are not pages in data/pages.json:
// external docs, API endpoints, and the palette's own pseudo-actions. Anything
// NOT in this set and not a real page path fails the build.
const NON_PAGE_TARGETS = new Set(['/docs/start-here', '/api/status', '/llms.txt']);

function clampDescription(text) {
	const s = String(text || '').trim();
	if (s.length <= DESC_MAX) return s;
	// Cut on a word boundary so the clamped line never ends mid-token.
	const cut = s.slice(0, DESC_MAX);
	const lastSpace = cut.lastIndexOf(' ');
	return `${(lastSpace > DESC_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:]$/, '')}...`;
}

function readJson(path, label) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (e) {
		console.error(`[atlas] cannot read ${label} (${path}): ${e.message}`);
		process.exit(2);
	}
}

const pagesDoc = readJson(PAGES, 'the route table');
const intentsDoc = readJson(INTENTS, 'the intent catalog');

if (!Array.isArray(pagesDoc.sections)) {
	console.error('[atlas] data/pages.json has no `sections` array');
	process.exit(2);
}

/** @type {Array<[string,string,string,string,number,number]>} */
const pages = [];
const sections = [];
const knownPaths = new Set();
const duplicates = [];

for (const section of pagesDoc.sections) {
	sections.push({ id: section.id, title: section.title, hint: section.description || '' });
	for (const page of section.pages || []) {
		if (!page.path) continue;
		if (knownPaths.has(page.path)) {
			duplicates.push(page.path);
			continue;
		}
		knownPaths.add(page.path);
		// Tuple order is a wire contract with public/atlas.js and src/atlas-page.js:
		// [path, title, description, sectionId, priority, flags].
		// flags is a bitfield: 1 = needs sign-in, 2 = not search-indexable.
		const flags = (page.auth ? 1 : 0) | (page.indexable === false ? 2 : 0);
		pages.push([
			page.path,
			page.title || page.path,
			clampDescription(page.description),
			section.id,
			typeof page.priority === 'number' ? page.priority : 0.5,
			flags,
		]);
	}
}

if (duplicates.length) {
	console.error(
		`[atlas] data/pages.json declares ${duplicates.length} duplicate path(s): ${duplicates.join(', ')}`,
	);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Intent validation. Every claim an intent makes about the product has to be
// checkable, so all three of these are hard failures rather than warnings:
// a step that goes nowhere real, an intent with no trigger phrases (it would be
// unreachable), and a duplicate id (the palette dedupes by id and would drop one).
// ---------------------------------------------------------------------------
const intents = [];
const seenIntentIds = new Set();
const problems = [];

for (const intent of intentsDoc.intents || []) {
	if (!intent.id) {
		problems.push(`an intent is missing "id" (title: ${intent.title || 'untitled'})`);
		continue;
	}
	if (seenIntentIds.has(intent.id)) {
		problems.push(`duplicate intent id "${intent.id}"`);
		continue;
	}
	seenIntentIds.add(intent.id);

	const match = Array.isArray(intent.match) ? intent.match.filter(Boolean) : [];
	if (match.length === 0) problems.push(`intent "${intent.id}" has no match phrases, so nothing can reach it`);

	const steps = Array.isArray(intent.steps) ? intent.steps : [];
	if (steps.length === 0) problems.push(`intent "${intent.id}" has no steps`);

	for (const [i, step] of steps.entries()) {
		if (!step.do) problems.push(`intent "${intent.id}" step ${i + 1} has no "do" text`);
		if (!step.to) continue; // A step may be pure instruction with no destination.
		if (/^https?:\/\//.test(step.to)) continue; // External links are the author's call.
		if (knownPaths.has(step.to) || NON_PAGE_TARGETS.has(step.to)) continue;
		problems.push(
			`intent "${intent.id}" step ${i + 1} points at "${step.to}", which is not a route in data/pages.json`,
		);
	}

	intents.push({
		id: intent.id,
		title: intent.title,
		blurb: intent.blurb || '',
		match,
		steps: steps.map((s) => ({ do: s.do, ...(s.to ? { to: s.to } : {}), ...(s.note ? { note: s.note } : {}) })),
	});
}

if (problems.length) {
	console.error('[atlas] the intent catalog does not hold up:');
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}

const out = {
	// Not a timestamp: a content fingerprint. A rebuild that changes nothing
	// leaves the file byte-identical, so the CDN keeps serving the cached copy
	// and `git status` stays clean between unrelated builds.
	version: 1,
	pageCount: pages.length,
	intentCount: intents.length,
	sections,
	pages,
	intents,
};

mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(out);
let previous = null;
try {
	previous = readFileSync(OUT, 'utf8');
} catch {
	previous = null;
}
if (previous === json) {
	console.log(`[atlas] index unchanged (${pages.length} pages, ${intents.length} intents)`);
} else {
	writeFileSync(OUT, json);
	console.log(
		`[atlas] wrote ${OUT.replace(`${root}/`, '')}: ${pages.length} pages across ` +
			`${sections.length} sections, ${intents.length} intents, ${(json.length / 1024).toFixed(1)} KB`,
	);
}
