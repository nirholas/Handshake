#!/usr/bin/env node
// Keep the tutorial library, its markdown, and the page index in agreement.
//
// Three files have to say the same thing for a tutorial to be reachable and
// indexable, and nothing was checking that they did:
//
//   public/tutorials-manifest.js   the library index and the viewer read this
//   docs/tutorials/<slug>.md       the viewer fetches this at runtime
//   data/pages.json (learn)        the sitemap, llms.txt, and features.json read this
//
// A tutorial missing from the manifest is unreachable from /tutorials. A manifest
// entry with no markdown renders an empty page. A tutorial missing from
// pages.json is invisible to search engines and to every downstream index.
//
// Usage:
//   node scripts/sync-tutorial-pages.mjs           report drift, exit 1 if any (the gate)
//   node scripts/sync-tutorial-pages.mjs --write    add missing pages.json entries

import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'public/tutorials-manifest.js');
const TUTORIAL_DIR = path.join(ROOT, 'docs/tutorials');
const PAGES_JSON = path.join(ROOT, 'data/pages.json');

const WRITE = process.argv.includes('--write');

/** Read the manifest as data. It is a browser script, so parse the entries out of the source. */
async function readManifest() {
	const src = await readFile(MANIFEST, 'utf8');
	const entries = [];
	const blocks = src.split(/\n\t\t\{\n/).slice(1);
	for (const block of blocks) {
		const field = (name) => {
			const match = block.match(new RegExp(`${name}: (['"\`])((?:\\\\.|(?!\\1).)*)\\1`));
			return match ? match[2].replace(/\\'/g, "'").replace(/\\"/g, '"') : null;
		};
		const slug = field('slug');
		if (!slug) continue;
		entries.push({ slug, tier: field('tier'), title: field('title'), blurb: field('blurb') });
	}
	return entries;
}

function readTutorialSlugs() {
	return readdirSync(TUTORIAL_DIR)
		.filter((f) => f.endsWith('.md'))
		.map((f) => f.replace(/\.md$/, ''))
		.sort();
}

/** First commit date of the markdown file, so `added` reflects when it shipped. */
function firstSeen(slug) {
	try {
		const out = execFileSync(
			'git',
			['log', '--diff-filter=A', '--follow', '--format=%ad', '--date=short', '--', `docs/tutorials/${slug}.md`],
			{ cwd: ROOT, encoding: 'utf8' },
		).trim();
		const dates = out.split('\n').filter(Boolean);
		return dates[dates.length - 1] || new Date().toISOString().slice(0, 10);
	} catch {
		return new Date().toISOString().slice(0, 10);
	}
}

/** pages.json wants a sentence, and the manifest blurb is already written for humans. */
function describe(entry) {
	const blurb = (entry.blurb || '').trim();
	if (!blurb) return `Step-by-step tutorial: ${entry.title}.`;
	return blurb.length > 300 ? `${blurb.slice(0, 297)}...` : blurb;
}

function titleFor(entry) {
	return entry.title.startsWith('Tutorial') ? entry.title : `Tutorial · ${entry.title}`;
}

async function main() {
	const manifest = await readManifest();
	const manifestSlugs = manifest.map((e) => e.slug);
	const markdown = readTutorialSlugs();

	const duplicates = manifestSlugs.filter((s, i) => manifestSlugs.indexOf(s) !== i);
	const missingMarkdown = manifestSlugs.filter((s) => !markdown.includes(s));
	const unlisted = markdown.filter((s) => !manifestSlugs.includes(s));

	const data = JSON.parse(await readFile(PAGES_JSON, 'utf8'));
	const learn = (data.sections || []).find((s) => s.id === 'learn');
	if (!learn) throw new Error('data/pages.json has no "learn" section');
	const registered = new Set(learn.pages.map((p) => p.path));

	const added = [];
	for (const entry of manifest) {
		const pagePath = `/tutorials/${entry.slug}`;
		if (registered.has(pagePath)) continue;
		if (!markdown.includes(entry.slug)) continue; // a page with no content is not worth indexing
		added.push({
			path: pagePath,
			title: titleFor(entry),
			description: describe(entry),
			priority: 0.8,
			changefreq: 'monthly',
			added: firstSeen(entry.slug),
		});
	}

	if (added.length && WRITE) {
		learn.pages.push(...added);
		await writeFile(PAGES_JSON, `${JSON.stringify(data, null, '\t')}\n`);
	}

	const report = [];
	report.push(`manifest entries: ${manifest.length}  markdown files: ${markdown.length}`);
	if (duplicates.length) report.push(`DUPLICATE manifest slugs: ${duplicates.join(', ')}`);
	if (missingMarkdown.length) report.push(`manifest entry with no markdown: ${missingMarkdown.join(', ')}`);
	if (unlisted.length) report.push(`markdown with no manifest entry (unreachable): ${unlisted.join(', ')}`);
	report.push(
		added.length
			? `pages.json: ${WRITE ? 'added' : 'missing'} ${added.length} tutorial entr${added.length === 1 ? 'y' : 'ies'}`
			: 'pages.json: every tutorial is registered',
	);
	console.log(report.join('\n'));

	const drift = duplicates.length || missingMarkdown.length || unlisted.length || (!WRITE && added.length);
	if (drift && !WRITE) {
		console.error('\nTutorial drift found. Fix the manifest, or run: node scripts/sync-tutorial-pages.mjs --write');
		process.exitCode = 1;
	}
	if (duplicates.length || missingMarkdown.length) process.exitCode = 1;
}

main().catch((err) => {
	console.error(`sync-tutorial-pages: ${err.message}`);
	process.exit(1);
});
