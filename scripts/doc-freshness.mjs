#!/usr/bin/env node
/**
 * Doc freshness: does this documentation still describe the code that ships?
 *
 * `npm run audit:docs` already proves a doc's LINKS resolve. Nothing proved its
 * PROSE still matches reality, and prose is what readers act on. A doc that
 * explains `scripts/deploy.mjs` is quietly wrong the moment that script is
 * rewritten, and the only signal today is a confused user.
 *
 * The idea here is that a doc already tells you what it documents. It names the
 * files, the npm scripts, and the API routes it is about, in its own text. So:
 *
 *   1. Read every doc and extract the repo paths, `npm run <script>` targets,
 *      and /api/ routes it mentions. Anything that resolves to a real file is a
 *      DEPENDENCY of that doc: source it claims to describe.
 *   2. Ask git when the doc was last edited, and whether any dependency has been
 *      committed to SINCE. Code that moved after the doc was last touched is
 *      code the doc has never been checked against.
 *   3. Rank by how much moved. That ranking is a work queue, and every entry
 *      names the exact commits a writer needs to read.
 *
 * Nothing has to be annotated: this works on all 460 existing docs today,
 * because it reads the references authors already write.
 *
 * Usage:
 *   npm run docs:freshness                 analyze, print the ranked table, write JSON
 *   npm run docs:freshness -- --top 40     show more rows
 *   npm run docs:freshness -- --doc docs/forge.md    explain one doc in full
 *   npm run check:docs-freshness           gate: fail when drift exceeds the budget
 *
 * Output: public/docs-freshness.json, read by /docs/freshness and by the
 * freshness badge on every docs page.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public/docs-freshness.json');
// The full report carries every drifted file and every commit behind it, which
// is what the dashboard needs and roughly a megabyte. A badge on a docs page
// needs four fields per doc, so it gets its own file rather than making every
// reader download the whole report to render one chip.
const SUMMARY = path.join(ROOT, 'public/docs-freshness-summary.json');
const BUDGET = path.join(ROOT, 'data/docs-freshness-budget.json');

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const opt = (n, fallback) => {
	const i = argv.indexOf('--' + n);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/** Source extensions a doc can meaningfully drift against. Prose and media cannot. */
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|html|css|sh|py|sql|toml|ya?ml)$/;

/**
 * Build outputs. These change constantly and mean nothing about a doc's accuracy:
 * the changelog gaining an entry is not evidence that a tutorial went wrong. They
 * are excluded from the dependency graph entirely rather than down-weighted,
 * because their churn is mechanical, not semantic.
 */
const GENERATED = [
	/^public\/sitemap\//,
	/^public\/llms(-full)?\.txt$/,
	/^public\/features\.json$/,
	/^public\/changelog\./,
	/^public\/examples\.json$/,
	/^public\/pages\.json$/,
	/^data\/changelog\.json$/,
	/^public\/build-info\.json$/,
	/^public\/tutorials-manifest\.js$/,
	/^public\/nav-data\.js$/,
	/^public\/docs-freshness\.json$/,
	/^public\/page-index\.json$/,
];

/** Top-level directories that hold shippable code. A path outside these is not ours. */
const CODE_DIRS = new Set([
	'api',
	'src',
	'scripts',
	'server',
	'packages',
	'workers',
	'services',
	'sdk',
	'solana-agent-sdk',
	'agent-payments-sdk',
	'pages',
	'public',
	'data',
	'specs',
	'tests',
	'chat',
	'character-studio',
	'extension',
]);

// ── Collecting the docs ──────────────────────────────────────────────────────

/** Every markdown file a reader can reach, plus the two root docs that matter. */
function collectDocs() {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
			const rel = path.posix.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
				walk(rel);
			} else if (entry.name.endsWith('.md')) {
				out.push(rel);
			}
		}
	};
	walk('docs');
	for (const rel of ['README.md', 'STRUCTURE.md', 'CLAUDE.md']) {
		if (existsSync(path.join(ROOT, rel))) out.push(rel);
	}
	return out.sort();
}

// ── Extracting what a doc claims to document ─────────────────────────────────

const npmScripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts || {};

/** Files an `npm run <name>` command actually executes. */
function scriptTargets(name) {
	const cmd = npmScripts[name];
	if (!cmd) return [];
	return [...cmd.matchAll(/[\w./-]+\.(?:mjs|js|cjs|sh)/g)]
		.map((m) => m[0])
		.filter((rel) => existsSync(path.join(ROOT, rel)) && statSync(path.join(ROOT, rel)).isFile());
}

/**
 * Resolve one candidate reference to a repo file, or null.
 *
 * Guards against three false positives that would otherwise flood the graph:
 * a path outside the code directories, a directory rather than a file, and the
 * doc's own filename echoing back at it.
 */
function resolveRef(raw, selfPath) {
	let rel = raw.replace(/^\.\//, '').replace(/^\//, '').split('#')[0].split('?')[0];
	if (!rel || rel === selfPath) return null;
	if (!CODE_EXT.test(rel)) return null;
	if (GENERATED.some((re) => re.test(rel))) return null;
	const top = rel.split('/')[0];
	if (!CODE_DIRS.has(top)) {
		// A bare root file (vite.config.js, package.json) is real code too.
		if (rel.includes('/')) return null;
	}
	const abs = path.join(ROOT, rel);
	if (!abs.startsWith(ROOT) || !existsSync(abs)) return null;
	if (!statSync(abs).isFile()) return null;
	return rel;
}

/**
 * Everything in a doc that points at code.
 *
 * Three shapes, because that is how the docs in this repo are actually written:
 * inline paths (in backticks, in links, or bare in prose), `npm run <script>`
 * commands, and /api/ routes that map onto a handler file.
 */
function extractDeps(markdown, selfPath) {
	const deps = new Set();

	// Explicit paths. The character class is deliberately narrow so a sentence
	// ending in a period does not swallow the next word into the match.
	for (const m of markdown.matchAll(/(?:^|[\s`("'[<])((?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\.\w{1,5})/g)) {
		const rel = resolveRef(m[1], selfPath);
		if (rel) deps.add(rel);
	}

	// npm scripts: a doc telling you to run something depends on what it runs.
	for (const m of markdown.matchAll(/npm run ([\w:-]+)/g)) {
		for (const rel of scriptTargets(m[1])) deps.add(rel);
	}

	// API routes documented as endpoints map to their handler. The two shapes
	// this repo uses are api/<route>.js and api/<route>/index.js.
	for (const m of markdown.matchAll(/\/api\/([\w/-]+)/g)) {
		const route = m[1].replace(/\/$/, '');
		for (const candidate of [`api/${route}.js`, `api/${route}/index.js`]) {
			if (existsSync(path.join(ROOT, candidate))) deps.add(candidate);
		}
	}

	return [...deps];
}

// ── The git index ────────────────────────────────────────────────────────────

/**
 * One pass over history: file path to the commits that touched it, newest first.
 *
 * Built once rather than shelling out per doc, which would be thousands of git
 * invocations. The record separator keeps commit subjects containing newlines
 * from corrupting the parse.
 */
function buildHistory() {
	const raw = execFileSync(
		'git',
		['log', '--format=%x1e%H|%ct|%s', '--name-only', '--no-renames'],
		{ cwd: ROOT, maxBuffer: 256 * 1024 * 1024 },
	).toString();

	const byFile = new Map();
	for (const chunk of raw.split('\x1e')) {
		if (!chunk.trim()) continue;
		const newline = chunk.indexOf('\n');
		const header = newline === -1 ? chunk : chunk.slice(0, newline);
		const [sha, ts, ...subjectParts] = header.split('|');
		if (!sha) continue;
		const commit = { sha: sha.slice(0, 9), ts: Number(ts), subject: subjectParts.join('|') };
		if (newline === -1) continue;
		for (const file of chunk.slice(newline + 1).split('\n')) {
			if (!file) continue;
			let list = byFile.get(file);
			if (!list) byFile.set(file, (list = []));
			list.push(commit);
		}
	}
	return byFile;
}

// ── Scoring ──────────────────────────────────────────────────────────────────

const DAY = 86_400;

/**
 * How much a drifted file says about THIS doc.
 *
 * `vercel.json` is referenced by sixty docs. When it changes, sixty docs light
 * up, and a ranking where everything is red is a ranking nobody reads. But
 * excluding shared files outright is wrong too: docs/demo-routes.md really is
 * about vercel.json, and that drift is real.
 *
 * So weight each dependency by how exclusively this doc claims it. A file only
 * one doc mentions is that doc's responsibility and counts fully; a file forty
 * docs mention is nobody's in particular and counts for a fortieth. This is the
 * inverse-document-frequency idea, applied to doc-to-code binding, and it makes
 * the ranking surface the doc that is uniquely wrong rather than the doc that
 * happened to name a busy file.
 */
const specificity = (share) => 1 / Math.max(1, share);

/**
 * Turn weighted drift into a status a reader and a gate can both act on.
 *
 * `unverifiable` is not a failure. Plenty of docs are conceptual and name no
 * code at all; calling those stale would be noise that trains people to ignore
 * the signal. They are counted separately so coverage stays visible.
 *
 * The thresholds read directly: 1.0 signal is "the equivalent of one file that
 * only this doc documents has changed", which is exactly when a human should
 * re-read the page. Half of that is worth watching.
 */
function classify(deps, signal) {
	if (!deps.length) return 'unverifiable';
	if (signal <= 0) return 'fresh';
	if (signal >= 1) return 'stale';
	return 'watch';
}

function analyze() {
	const history = buildHistory();
	const docs = collectDocs();
	const now = Math.floor(Date.now() / 1000);

	// Pass one: read every doc and resolve its dependencies, so the share count
	// each weight needs is known before anything is scored.
	const parsed = docs.map((docPath) => {
		const markdown = readFileSync(path.join(ROOT, docPath), 'utf8');
		return {
			path: docPath,
			markdown,
			deps: extractDeps(markdown, docPath),
			lastTouched: (history.get(docPath) || [])[0] || null,
		};
	});

	const share = new Map();
	for (const doc of parsed) {
		for (const dep of doc.deps) share.set(dep, (share.get(dep) || 0) + 1);
	}

	// Pass two: score.
	const results = [];
	for (const doc of parsed) {
		const { path: docPath, markdown, deps, lastTouched } = doc;
		const drift = [];
		let commitCount = 0;
		let signal = 0;
		if (lastTouched) {
			for (const dep of deps) {
				const since = (history.get(dep) || []).filter((c) => c.ts > lastTouched.ts);
				if (!since.length) continue;
				commitCount += since.length;
				const weight = specificity(share.get(dep) || 1);
				signal += weight;
				drift.push({
					file: dep,
					sharedWith: (share.get(dep) || 1) - 1,
					weight: Number(weight.toFixed(3)),
					commits: since.slice(0, 6).map((c) => ({
						sha: c.sha,
						date: new Date(c.ts * 1000).toISOString().slice(0, 10),
						subject: c.subject,
					})),
					total: since.length,
				});
			}
		}
		// Heaviest first: the file this doc is most uniquely responsible for is the
		// one a writer should open, regardless of which churned the most.
		drift.sort((a, b) => b.weight - a.weight || b.total - a.total);

		const title = (markdown.match(/^#\s+(.+)$/m)?.[1] || path.basename(docPath, '.md')).trim();
		results.push({
			path: docPath,
			title,
			route: docRoute(docPath),
			lastTouched: lastTouched
				? {
						sha: lastTouched.sha,
						date: new Date(lastTouched.ts * 1000).toISOString().slice(0, 10),
						ageDays: Math.floor((now - lastTouched.ts) / DAY),
					}
				: null,
			status: classify(deps, signal),
			deps: deps.length,
			depFiles: deps.slice().sort(),
			driftFiles: drift.length,
			driftCommits: commitCount,
			signal: Number(signal.toFixed(3)),
			score: Number(signal.toFixed(3)),
			drift,
		});
	}

	results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return results;
}

/** The published URL a doc reads at, so the dashboard can link straight to it. */
function docRoute(docPath) {
	if (!docPath.startsWith('docs/')) return null;
	const slug = docPath.slice('docs/'.length).replace(/\.md$/, '');
	if (/^(internal|ops|security)\//.test(slug)) return null;
	if (slug.startsWith('tutorials/')) return '/' + slug;
	return '/docs/#' + slug;
}

// ── Reporting ────────────────────────────────────────────────────────────────

const ICON = { stale: '!!', watch: ' ~', fresh: ' ok', unverifiable: '  ' };

function printTable(results, top) {
	const rows = results.filter((r) => r.status === 'stale' || r.status === 'watch').slice(0, top);
	if (!rows.length) {
		console.log('No doc is describing code that moved after it was written.');
		return;
	}
	console.log(`\n${rows.length} doc(s) describing code that changed since they were written:\n`);
	for (const r of rows) {
		const files = r.drift
			.slice(0, 3)
			.map((d) => d.file)
			.join(', ');
		console.log(
			`  ${ICON[r.status]}  ${r.path.padEnd(46)} signal ${r.signal.toFixed(2).padStart(6)}  ` +
				`${String(r.driftFiles).padStart(2)} file(s) since ${r.lastTouched?.date}`,
		);
		console.log(`      ${files}${r.driftFiles > 3 ? `, +${r.driftFiles - 3} more` : ''}`);
	}
}

function explain(results, docPath) {
	const r = results.find((x) => x.path === docPath || x.path.endsWith('/' + docPath));
	if (!r) {
		console.error(`No such doc: ${docPath}`);
		process.exit(2);
	}
	console.log(`\n${r.title}\n${r.path}\n`);
	console.log(`  status        ${r.status} (signal ${r.signal})`);
	console.log(
		`  last edited   ${r.lastTouched?.date} (${r.lastTouched?.sha}), ${r.lastTouched?.ageDays}d ago`,
	);
	console.log(`  documents     ${r.deps} file(s)`);
	if (!r.drift.length) {
		console.log(`\n  Nothing it documents has changed since. This doc is verified.\n`);
		return;
	}
	console.log(`\n  ${r.driftFiles} of them changed after this doc was last edited:\n`);
	for (const d of r.drift) {
		const shared = d.sharedWith ? `, also documented by ${d.sharedWith} other doc(s)` : '';
		console.log(`  ${d.file}  (${d.total} commit${d.total === 1 ? '' : 's'}${shared})`);
		for (const c of d.commits) console.log(`      ${c.date}  ${c.sha}  ${c.subject}`);
		console.log('');
	}
}

// ── Entry ────────────────────────────────────────────────────────────────────

const results = analyze();
const totals = {
	docs: results.length,
	stale: results.filter((r) => r.status === 'stale').length,
	watch: results.filter((r) => r.status === 'watch').length,
	fresh: results.filter((r) => r.status === 'fresh').length,
	unverifiable: results.filter((r) => r.status === 'unverifiable').length,
	trackedFiles: new Set(results.flatMap((r) => r.depFiles)).size,
};

if (has('check')) {
	const budget = JSON.parse(readFileSync(BUDGET, 'utf8'));
	const over = totals.stale - budget.maxStale;
	console.log(
		`docs freshness: ${totals.stale} stale / ${totals.watch} watch / ${totals.fresh} fresh ` +
			`/ ${totals.unverifiable} unverifiable (budget ${budget.maxStale} stale)`,
	);
	if (over > 0) {
		printTable(results, 15);
		console.error(
			`\nOver budget by ${over}. Either refresh a doc above (run ` +
				`\`npm run docs:freshness -- --doc <path>\` for the exact commits to read), ` +
				`or raise maxStale in data/docs-freshness-budget.json with a reason.`,
		);
		process.exit(1);
	}
	// The budget only ever ratchets down. Reporting the slack is what makes that
	// happen: a number nobody sees is a number nobody lowers.
	if (over < 0) console.log(`${-over} under budget. Lower maxStale to lock the gain in.`);
	process.exit(0);
}

if (opt('doc', null)) {
	explain(results, opt('doc', null));
	process.exit(0);
}

const payload = {
	$generated: 'npm run docs:freshness (scripts/doc-freshness.mjs)',
	$doc: '/docs/freshness',
	generatedAt: new Date().toISOString(),
	commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(),
	totals,
	docs: results,
};
// Commit subjects from years of history flow into these files verbatim, and
// the repo bans em/en dashes in committed bytes, so scrub them at the boundary.
const scrubDashes = (s) => s.replace(/ [\u2013\u2014] /g, ': ').replace(/[\u2013\u2014]/g, '-');
writeFileSync(OUT, scrubDashes(JSON.stringify(payload, null, '\t')) + '\n');

writeFileSync(
	SUMMARY,
	scrubDashes(JSON.stringify(
		{
			$generated: 'npm run docs:freshness (scripts/doc-freshness.mjs)',
			$doc: '/docs/freshness',
			generatedAt: payload.generatedAt,
			commit: payload.commit,
			totals,
			// Short keys: this file is fetched by every docs page that renders a
			// badge, so its bytes are on the reader's critical path.
			// s status, g signal, d date last edited, f files drifted, n deps known
			docs: Object.fromEntries(
				results.map((r) => [
					r.path,
					{ s: r.status, g: r.signal, d: r.lastTouched?.date || null, f: r.driftFiles, n: r.deps },
				]),
			),
		},
		null,
		'\t',
	)) + '\n',
);

console.log(
	`Analyzed ${totals.docs} docs against ${totals.trackedFiles} source files.\n` +
		`  fresh ${totals.fresh}   watch ${totals.watch}   stale ${totals.stale}   ` +
		`unverifiable ${totals.unverifiable}`,
);
printTable(results, Number(opt('top', 20)));
console.log(`\nWrote ${path.relative(ROOT, OUT)} (read by /docs/freshness).`);
