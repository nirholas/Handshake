// changelog-gaps.mjs — find shipped work that never reached the changelog.
//
// The changelog is filled by hand (data/changelog.json); only new *pages*
// auto-generate an entry. So a feature shipped inside an existing surface is
// invisible unless someone remembers to write it up — and on a busy day
// commits outrun entries ~2:1, which is where features slip.
//
// This turns "did we log everything?" from memory into a checklist. It reads
// git history since a cutoff, drops internal-only chores that legitimately get
// no entry, and cross-references the rest against data/changelog.json by date
// window + keyword overlap. Anything user- or developer-visible with no
// matching entry is reported as a GAP, tagged with the tag its conventional-
// commit type maps to, so the write-up is a fill-in-the-blank.
//
// Usage:
//   node scripts/changelog-gaps.mjs                 # last 14 days
//   node scripts/changelog-gaps.mjs --since 2026-07-10
//   node scripts/changelog-gaps.mjs --days 7
//   node scripts/changelog-gaps.mjs --json          # machine-readable
//
// It never writes anything — it only reports. Wired as `npm run changelog:gaps`.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --- args -------------------------------------------------------------------

const argv = process.argv.slice(2);
const getArg = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : null;
};
const asJson = argv.includes('--json');
const days = Number(getArg('--days') || 14);
const since = getArg('--since') || new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

// --- conventional-commit type → changelog tag -------------------------------

// A commit's type (or a scope/keyword) decides the tag its suggested entry
// carries. Order matters: the first match wins.
const TYPE_TAG = [
	[/^(feat|feature)\b/i, 'feature'],
	[/^fix\b/i, 'fix'],
	[/^perf\b/i, 'improvement'],
	[/^(docs?)\b/i, 'docs'],
	[/^(sec|security|harden)\b/i, 'security'],
	[/^(sdk)\b/i, 'sdk'],
	[/^(infra|ops|deploy|release)\b/i, 'infra'],
];

// Subjects that are internal-only by nature: they change how we build or test,
// not what a user or integrator sees. These never warrant a changelog entry,
// so flagging them as gaps would be noise.
const CHORE_SUBJECT = /^(chore|ci|test|tests|refactor|lint|style|build|bump|merge|revert|wip|typo|format)\b/i;
const CHORE_KEYWORD = /\b(lockfile|package-lock|pnpm-lock|node_modules|gitignore|eslint|prettier|tsconfig|rename|dead code|dead-code|comment|whitespace|no-op|noop)\b/i;

// Paths that, if a commit touches ONLY these, make it internal regardless of
// its subject. A commit that also touches product code is kept.
const INTERNAL_ONLY_PATH = /^(tests?\/|\.github\/|scripts\/|\.husky\/|.*\.lock$|.*\.test\.[jt]s$|.*\.spec\.[jt]s$)/;

// --- keyword extraction -----------------------------------------------------

const STOP = new Set([
	'the', 'and', 'for', 'with', 'into', 'from', 'that', 'this', 'when', 'while',
	'your', 'you', 'not', 'now', 'add', 'adds', 'added', 'wire', 'wired', 'make',
	'makes', 'made', 'use', 'uses', 'used', 'via', 'per', 'new', 'let', 'lets',
	'get', 'gets', 'set', 'sets', 'fix', 'fixes', 'fixed', 'feat', 'update',
	'updates', 'updated', 'refine', 'refinement', 'support', 'supports', 'across',
	'straight', 'instead', 'every', 'each', 'onto', 'over', 'more', 'less', 'than',
]);

function tokens(str) {
	return new Set(
		String(str)
			.toLowerCase()
			.replace(/^[a-z]+(\([^)]*\))?:/i, '') // strip "feat(scope):"
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length >= 4 && !STOP.has(w)),
	);
}

function overlap(a, b) {
	let n = 0;
	for (const t of a) if (b.has(t)) n++;
	return n;
}

// --- load data --------------------------------------------------------------

const entries = JSON.parse(readFileSync(resolve(root, 'data/changelog.json'), 'utf8')).entries;
const entryTokens = entries.map((e) => ({ date: e.date, tok: tokens(`${e.title} ${e.summary}`) }));

function daysApart(a, b) {
	return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

// A commit is "covered" if some entry within a ±3-day window shares at least
// two distinctive tokens with it. Loose on purpose: the goal is to surface
// clear misses, not to demand exact wording.
function isCovered(commitTok, commitDate) {
	for (const e of entryTokens) {
		if (daysApart(e.date, commitDate) > 3) continue;
		if (overlap(commitTok, e.tok) >= 2) return true;
	}
	return false;
}

function tagFor(subject) {
	for (const [re, tag] of TYPE_TAG) if (re.test(subject)) return tag;
	return 'improvement'; // a user-visible commit with no conventional type
}

// --- scan git ---------------------------------------------------------------

const raw = execSync(
	`git log --since=${since} --no-merges --pretty=format:%H%x1f%ad%x1f%s --date=short`,
	{ cwd: root, encoding: 'utf8' },
).trim();

const commits = raw ? raw.split('\n').map((l) => {
	const [hash, date, subject] = l.split('\x1f');
	return { hash, date, subject };
}) : [];

const gaps = [];
let choreCount = 0;
let coveredCount = 0;

for (const c of commits) {
	if (CHORE_SUBJECT.test(c.subject) || CHORE_KEYWORD.test(c.subject)) {
		choreCount++;
		continue;
	}
	// A commit touching only internal paths is internal even without a chore tag.
	const files = execSync(`git show --name-only --pretty=format: ${c.hash}`, { cwd: root, encoding: 'utf8' })
		.trim()
		.split('\n')
		.filter(Boolean);
	if (files.length > 0 && files.every((f) => INTERNAL_ONLY_PATH.test(f))) {
		choreCount++;
		continue;
	}
	const tok = tokens(c.subject);
	if (isCovered(tok, c.date)) {
		coveredCount++;
		continue;
	}
	gaps.push({ date: c.date, tag: tagFor(c.subject), subject: c.subject, hash: c.hash.slice(0, 9) });
}

// --- report -----------------------------------------------------------------

if (asJson) {
	console.log(JSON.stringify({ since, scanned: commits.length, chore: choreCount, covered: coveredCount, gaps }, null, 2));
	process.exit(0);
}

const byDate = {};
for (const g of gaps) (byDate[g.date] ||= []).push(g);

console.log(`\nChangelog gap audit — commits since ${since}`);
console.log(`  scanned ${commits.length}  ·  internal/chore ${choreCount}  ·  covered ${coveredCount}  ·  GAPS ${gaps.length}\n`);

for (const date of Object.keys(byDate).sort().reverse()) {
	console.log(`${date}`);
	for (const g of byDate[date]) {
		console.log(`  [${g.tag.padEnd(11)}] ${g.subject}  (${g.hash})`);
	}
	console.log('');
}

if (gaps.length === 0) {
	console.log('No gaps — every user-visible commit in the window has a matching entry.\n');
} else {
	console.log(`${gaps.length} shipped change(s) look user-visible but have no changelog entry.`);
	console.log('Write them into data/changelog.json (holder-readable title + summary), then `npm run build:pages`.\n');
}
