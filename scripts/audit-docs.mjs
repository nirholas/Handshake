#!/usr/bin/env node
/**
 * Documentation-integrity guard.
 *
 * Docs rot silently: a page gets renamed, a script gets dropped, a directory
 * gets refactored, and the doc that pointed at it keeps shipping a dead link.
 * This audit catches all four classes mechanically, so a broken doc fails a
 * command instead of failing a reader.
 *
 * What it checks:
 *   1. Relative links in Markdown resolve to a real file on disk (URL-decoded,
 *      so api/users/%5Busername%5D.js correctly resolves to the bracket file).
 *   2. Site-absolute links (/create, /docs/x) resolve to a real route: declared
 *      in data/pages.json, matched by a vercel.json route, or backed by a file
 *      under pages/ or public/.
 *   3. `npm run <script>` references name a script that exists in the relevant
 *      package.json, and `node scripts/<x>` references an existing file.
 *   4. Every packages/* and workers/* directory carries a README.md.
 *   5. Every public doc under docs/*.md is registered in data/pages.json, so it
 *      reaches the sitemap, llms.txt and features.json instead of being live at
 *      200 and invisible to every crawler. Docs that are deliberately not
 *      published carry an entry in UNPUBLISHED_DOCS below with the reason.
 *
 * Usage:
 *   node scripts/audit-docs.mjs              # audit the whole repo, exit 1 on findings
 *   node scripts/audit-docs.mjs --advisory   # report findings, always exit 0
 *   node scripts/audit-docs.mjs docs/x.md    # audit specific files
 *
 * Deliberately excluded: fenced code blocks and inline code spans (both show
 * the reader templates and examples, not links that must resolve), external
 * URLs (network-dependent), generated aggregates (docs/ALL.md, EVERYTHING.md)
 * whose links are rewritten by their generator, and the internal work-order
 * packs under prompts/ and tasks/. Those packs delete work orders as they are
 * completed (an owner directive, recorded by the retirement notes in each
 * pack's index), so dangling index links there are the documented convention
 * rather than rot. Pass an explicit path to audit them anyway:
 *   node scripts/audit-docs.mjs prompts/roadmap/00-README.md
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const advisory = args.includes('--advisory');
const explicitFiles = args.filter((a) => !a.startsWith('--'));

const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'dist-lib',
	'.git',
	'test-results',
	'character-studio',
	'coverage',
	'playwright-report',
	'.deploy-wt',
]);
// Generated aggregates: their links are produced by a generator, not authored.
const SKIP_FILES = new Set(['docs/ALL.md', 'docs/EVERYTHING.md', 'EVERYTHING.md', 'CHANGELOG.md']);
// Internal work-order packs: completed orders are deleted by design (see the
// retirement notes in each pack index), so their indexes intentionally list
// files that no longer exist. Audited only when named explicitly.
const SKIP_TREES = ['prompts', 'tasks'];

const readJson = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));

// ---------------------------------------------------------------- route table
const vercel = readJson('vercel.json');
const routeMatchers = (vercel.routes || [])
	// A rule that answers with an error status is proof the path does NOT
	// resolve, so error handlers (notably the catch-all `/(?!_vercel/).*` to
	// 404.html) must never count as evidence that a link is good. Redirects
	// (3xx) do count: they land the reader somewhere real.
	.filter((r) => !(typeof r.status === 'number' && r.status >= 400))
	.map((r) => r.src)
	.filter(Boolean)
	.filter((s) => s !== '/(.*)') // the catch-all matches everything, proving nothing
	.map((s) => {
		try {
			return new RegExp(`^${s}$`);
		} catch {
			return null;
		}
	})
	.filter(Boolean);

const declaredPages = new Set();
(function collect(node) {
	if (!node || typeof node !== 'object') return;
	if (typeof node.path === 'string') declaredPages.add(node.path.split('?')[0]);
	for (const key of Object.keys(node)) collect(node[key]);
})(readJson('data/pages.json'));

const routeExists = (sitePath) => {
	const clean = sitePath.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
	if (declaredPages.has(clean) || declaredPages.has(`${clean}/`)) return true;
	if (routeMatchers.some((rx) => rx.test(clean))) return true;
	const rel = clean.replace(/^\//, '');
	return [
		`public/${rel}`,
		`public/${rel}.html`,
		`pages/${rel}.html`,
		`public/${rel}/index.html`,
		`docs/${rel}.md`,
		// Trees copied into dist/ verbatim at build time (blog/ is the main one),
		// where the filesystem phase serves the file directly. Verified live:
		// /blog/<slug> and /blog/<slug>.html both return 200.
		rel,
		`${rel}.html`,
	].some((candidate) => existsSync(resolve(root, candidate)));
};

// -------------------------------------------------------------- npm scripts
// A doc may legitimately cite a script from its own package, from the root, or
// from a sibling package it tells the reader to cd into (the character-studio
// docs do exactly that). Collecting every script name declared anywhere in the
// repo keeps this check conservative: it still catches a genuinely deleted
// script, without crying wolf over a valid cross-package instruction. A checker
// that reports false positives gets switched off, which is worse than no check.
const allScriptNames = new Set();
(function collectScripts(dir, depth = 0) {
	if (depth > 4) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name) && entry.name !== 'character-studio') continue;
			collectScripts(full, depth + 1);
		} else if (entry.name === 'package.json') {
			try {
				for (const name of Object.keys(JSON.parse(readFileSync(full, 'utf8')).scripts || {})) {
					allScriptNames.add(name);
				}
			} catch {
				// An unparseable package.json is a different problem; not this audit's.
			}
		}
	}
})(root);

// ------------------------------------------------------------ file discovery
const markdownFiles = (dir, acc = []) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.') && entry.name !== '.github') continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			markdownFiles(full, acc);
		} else if (entry.name.endsWith('.md')) {
			acc.push(full);
		}
	}
	return acc;
};

const findings = [];
const report = (file, line, kind, detail) =>
	findings.push({ file: relative(root, file), line, kind, detail });

// ------------------------------------------------------------------- the scan
const auditFile = (file) => {
	const relPath = relative(root, file);
	if (SKIP_FILES.has(relPath)) return;
	const text = readFileSync(file, 'utf8');
	const dir = dirname(file);
	let inFence = false;

	text.split('\n').forEach((line, i) => {
		const lineNo = i + 1;
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			return;
		}
		if (inFence) return;
		// Strip inline code spans: `[Title](file.md)` inside backticks is a format
		// template being shown to the reader, not a link that should resolve.
		const scannable = line.replace(/`[^`]*`/g, '');

		for (const match of scannable.matchAll(/\]\(([^)\s]+?)(#[^)\s]*)?\)/g)) {
			const target = match[1];
			if (!target || target.startsWith('#')) continue; // same-page anchor, nothing to resolve
			if (/^([a-z][a-z0-9+.-]*:)/i.test(target)) continue; // external or mailto
			if (target.startsWith('/')) {
				if (target.startsWith('/api/')) continue; // API paths are verified by audit:routes
				if (!routeExists(target)) report(file, lineNo, 'dead-route', target);
				continue;
			}
			let decoded;
			try {
				decoded = decodeURIComponent(target);
			} catch {
				continue; // malformed escape, not our business to guess
			}
			if (!existsSync(resolve(dir, decoded))) report(file, lineNo, 'dead-link', target);
		}

		for (const match of scannable.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
			if (!allScriptNames.has(match[1])) report(file, lineNo, 'dead-script', `npm run ${match[1]}`);
		}
		for (const match of scannable.matchAll(/\bnode (scripts\/[A-Za-z0-9._/-]+)/g)) {
			// Resolve against the doc's own directory first: a skill or package
			// doc means its own scripts/ folder, not the repo root's.
			const local = resolve(dir, match[1]);
			if (!existsSync(local) && !existsSync(resolve(root, match[1]))) {
				report(file, lineNo, 'dead-script', `node ${match[1]}`);
			}
		}
	});
};

const targets = explicitFiles.length
	? explicitFiles.map((f) => resolve(root, f))
	: markdownFiles(root).filter((f) => {
			const rel = relative(root, f);
			return !SKIP_TREES.some((tree) => rel === tree || rel.startsWith(`${tree}/`));
		});

for (const file of targets) {
	if (existsSync(file) && statSync(file).isFile()) auditFile(file);
}

// ------------------------------------------------- required directory READMEs
if (!explicitFiles.length) {
	for (const parent of ['packages', 'workers']) {
		const parentDir = resolve(root, parent);
		if (!existsSync(parentDir)) continue;
		for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
			if (!existsSync(join(parentDir, entry.name, 'README.md'))) {
				findings.push({
					file: `${parent}/${entry.name}`,
					line: 0,
					kind: 'missing-readme',
					detail: 'directory has no README.md',
				});
			}
		}
	}
}

// --------------------------------------------- public docs must be registered
// A doc under docs/*.md is served at /docs/<slug> by the generic route in
// vercel.json, so it answers 200 whether or not anyone declared it. Only
// data/pages.json makes it discoverable: the sitemap, llms.txt, features.json
// and the human sitemap all read from there and nothing else. An unregistered
// doc is therefore live and invisible at the same time, which is the failure
// this check exists to make loud.
//
// Each slug below is deliberately not published, with the reason. Two kinds:
//   internal    operational, strategic or single-use material written for us,
//               not for a reader arriving from search.
//   owner-gated content referencing a crypto project other than $THREE.
//               CLAUDE.md requires explicit owner approval before that lands in
//               a commit, so registering one is a decision, never a default.
const UNPUBLISHED_DOCS = new Map([
	['agora', 'internal: strategy framing, not a reader-facing product doc'],
	['announcement-coverage', 'internal: X announcement coverage matrix for marketing planning'],
	['avatar-cli', 'internal: in-flight, register when the CLI ships'],
	['avatar-fidelity-program', 'internal: program goals and competitive targets'],
	['aws-marketplace-listing-kit', 'internal: paste-ready listing copy and portal steps'],
	['bnb-babt-findings', 'owner-gated: names a crypto project other than $THREE'],
	['bnb-vault', 'owner-gated: names a crypto project other than $THREE'],
	['bnb-world', 'owner-gated: names a crypto project other than $THREE'],
	['btn-pill-migration', 'internal: one-time component migration map'],
	['build', 'internal: build and deploy integrity runbook'],
	['clip-director', 'internal: content strategy'],
	['coin-launches', 'owner-gated: names a crypto project other than $THREE'],
	['coin-pages', 'owner-gated: names a crypto project other than $THREE'],
	['coinmarketcap-article', 'internal: draft prepared for an external publisher'],
	['coinmarketcap-live-article', 'internal: draft prepared for an external publisher'],
	['coinmarketcap-article-play', 'internal: draft prepared for an external publisher'],
	['demo-routes', 'internal: dated route inventory'],
	['education-pilot-bucharest', 'internal: partnership draft (reply copy + pilot brief), not a reader-facing product doc'],
	['economy-heartbeat', 'internal: scheduled-job operations'],
	['economy-master', 'internal: funding-root wallet operations'],
	['financial-controls', 'internal: audit-grade money-flow register'],
	['free-crypto-apis', 'internal: engineering research catalog of external free APIs'],
	['google-x-accounts', 'internal: outreach directory of external X accounts'],
	['ibm-community-article', 'internal: source draft of an IBM Community post'],
	['ibm-community-live-reaction-jessica', 'internal: source draft of an IBM Community post'],
	['ibm-community-recap-jessica', 'internal: source draft of an IBM Community post'],
	['ibm-community-recap-nichxbt', 'internal: source draft of an IBM Community post'],
	['ibm-community-blog-meetup-jessica', 'internal: source draft of an IBM Community post'],
	['ibm-community-thread', 'internal: source draft of an IBM Community post'],
	['launch-usecases', 'owner-gated: names a crypto project other than $THREE'],
	['memetic-launcher', 'owner-gated: names a crypto project other than $THREE'],
	['meta-allocator', 'owner-gated: names a crypto project other than $THREE'],
	['money-map', 'internal: revenue-share and treasury routing'],
	['native-launchpad', 'owner-gated: names a crypto project other than $THREE'],
	['okx-marketplace', 'owner-gated: names a crypto project other than $THREE'],
	['pay-skills-listing', 'internal: listing metadata, not prose'],
	['play-boot-performance', 'internal: performance runbook for the /play boot path'],
	['popular-3d-github-repos', 'internal: one-off ecosystem research sweep'],
	['pump-fun-mcp-edge', 'owner-gated: names a crypto project other than $THREE'],
	['pump-launch-repos', 'owner-gated: names a crypto project other than $THREE'],
	['pump-platform-fee', 'owner-gated: names a crypto project other than $THREE'],
	['robinhood-chain-markets', 'owner-gated: names a crypto project other than $THREE'],
	['solana-pumpfun', 'owner-gated: names a crypto project other than $THREE'],
	['syndication', 'internal: distribution mechanics for the announcements feed'],
	['trading-experiment', 'owner-gated: names a crypto project other than $THREE'],
	['trading-hub', 'in-flight: landed mid-session, register with its /trading page'],
	['event-x-posts', 'internal: ready-to-paste X post drafts; posting is owner-gated'],
	['x-meetup-posts', 'internal: ready-to-paste X post drafts; posting is owner-gated'],
	['x402-solana-july-roundup-response', 'internal: ready-to-paste X reply draft; posting is owner-gated'],
]);
const GENERATED_DOCS = new Set(['ALL', 'EVERYTHING', 'README']);

if (!explicitFiles.length) {
	const docsDir = resolve(root, 'docs');
	for (const entry of readdirSync(docsDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
		const slug = entry.name.replace(/\.md$/, '');
		if (GENERATED_DOCS.has(slug) || UNPUBLISHED_DOCS.has(slug)) continue;
		if (declaredPages.has(`/docs/${slug}`)) continue;
		findings.push({
			file: `docs/${entry.name}`,
			line: 0,
			kind: 'unregistered-doc',
			detail: `served at /docs/${slug} but absent from data/pages.json, so no crawler can find it. Add an entry there, or add the slug to UNPUBLISHED_DOCS in this script with the reason it stays unpublished.`,
		});
	}
}

// ---------------------------------------------------------------- the verdict
const byKind = findings.reduce((acc, f) => {
	(acc[f.kind] = acc[f.kind] || []).push(f);
	return acc;
}, {});

const LABEL = {
	'dead-link': 'Relative links pointing at files that do not exist',
	'dead-route': 'Site links pointing at routes that do not resolve',
	'dead-script': 'Commands naming scripts that do not exist',
	'missing-readme': 'Directories required to carry a README.md',
	'unregistered-doc': 'Public docs missing from data/pages.json (live but undiscoverable)',
};

if (!findings.length) {
	console.log(`docs audit: clean (${targets.length} markdown files checked).`);
	process.exit(0);
}

for (const [kind, items] of Object.entries(byKind)) {
	console.log(`\n${LABEL[kind] || kind} (${items.length}):`);
	for (const item of items) {
		console.log(`  ${item.file}${item.line ? `:${item.line}` : ''}  ${item.detail}`);
	}
}
console.log(`\ndocs audit: ${findings.length} finding(s) across ${targets.length} files.`);
process.exit(advisory ? 0 : 1);
