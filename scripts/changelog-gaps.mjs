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
//
// The audit alternate matches only a pure verification pass ("audit(x):
// verify ... end to end", no semicolon clause): it shipped nothing, so it can
// have no entry. An audit that also fixed something writes that fix after a
// semicolon ("audit(avatars): batch 01 verified; fix upload proxy ...") and
// deliberately stays visible to this scan. "Pending changes exported from
// your codespace" is the GitHub codespace sync sweep; the pre-push subject
// lint bans it going forward, so that alternate only matches historical ones.
const CHORE_SUBJECT =
	/^(chore|ci|test|tests|refactor|lint|style|build|bump|merge|revert|wip|typo|format)\b|^audit(\([^)]*\))?: [^;]*\bverif[^;]*$|^pending changes exported\b/i;
// The tidied-comments alternate needs the tidying verb: "strip em-dashes from
// comments" is a chore, "let holders post comments" is a feature, and a bare
// \bcomments\b would hide the second behind the first.
const CHORE_KEYWORD =
	/\b(lockfile|package-lock|pnpm-lock|node_modules|gitignore|eslint|prettier|tsconfig|rename|dead code|dead-code|comment|whitespace|no-op|noop|em-dash(?:es)?|banned dash(?:es)?|push gate|dev server)\b|\b(?:strip|correct|reword|clean|tidy)\w*\b[^.]*\bcomments\b/i;

// Paths that, if a commit touches ONLY these, make it internal regardless of
// its subject. A commit that also touches product code is kept.
//
// The generated block is every file scripts/build-page-index.mjs writes. They
// are mirrors of data/pages.json + data/changelog.json, which this audit
// already reads directly, so a commit that only regenerates them ships nothing
// new by construction. Left out, a bare `npm run build:pages` commit reads as
// unlogged user-visible work and pads the GAPS count with pure churn.
const INTERNAL_ONLY_PATH =
	/^(tests?\/|\.github\/|scripts\/|\.husky\/|\.claude\/|\.agents\/|prompts\/|data\/_generated\/|CHANGELOG\.md$|CLAUDE\.md$|ISSUES\.md$|data\/changelog\.json$|public\/changelog\.(json|xml)$|public\/features\.json$|public\/llms(-full)?\.txt$|public\/sitemap\/|public\/locales\/localized-pages\.json$|.*\.lock$|.*\.test\.[jt]s$|.*\.spec\.[jt]s$)/;

// Plumbing: real shipped work that a $THREE holder still never perceives —
// container builds, GPU-worker image pins, generated translation bundles,
// prose-only doc edits. It is NOT a chore (it changed production), so silently
// dropping it would hide work; but counting it in the headline GAPS number is
// what trained everyone to ignore this audit. A commit whose files are ALL
// plumbing gets reported under its own heading instead, outside the count.
const PLUMBING_PATH =
	/^(workers\/|services\/|crates\/|server\/|deploy\/|marketing\/|specs\/|docs\/|blog\/|public\/locales\/|locales\/|\.env\.example$|STRUCTURE\.md$|ARCHITECTURE\.md$|README\.md$|.*\/README\.md$|.*\/Dockerfile$|.*cloudbuild.*\.ya?ml$|.*\.md$)/;

// …unless the subject says the plumbing IS the product: a brand-new worker
// lane or backend is a capability holders can use, however deep it sits.
//
// Tested against the subject with its conventional-commit SCOPE removed, type
// kept: `feat(screen-worker): resolve local Chrome launch options` is a config
// change inside one worker, not a new lane, and matching "worker" out of the
// scope escaped every such commit into the GAPS count.
const PLUMBING_ESCAPE = /\b(lane|backend|worker)\b.*\b(new|add|introduc)|^(feat|feature)\b.*\b(lane|worker)\b/i;
const escapeSubject = (subject) => subject.replace(/^([a-z]+)\([^)]*\):/i, '$1:');

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
// New pages get their own changelog entry automatically from their `added`
// date (see data/pages.json's $comment) — fold those in as covered too, or
// every page-launch commit reads as a gap even though it's already logged.
const pageLaunches = JSON.parse(readFileSync(resolve(root, 'data/pages.json'), 'utf8')).sections
	.flatMap((s) => s.pages || [])
	.filter((p) => p.added)
	.map((p) => ({ date: p.added, title: p.title, summary: p.description }));
const entryTokens = [...entries, ...pageLaunches].map((e) => ({ date: e.date, tok: tokens(`${e.title} ${e.summary}`) }));

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
const plumbing = [];
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
	const row = { date: c.date, tag: tagFor(c.subject), subject: c.subject, hash: c.hash.slice(0, 9) };
	const allPlumbing =
		files.length > 0 &&
		files.every((f) => PLUMBING_PATH.test(f) || INTERNAL_ONLY_PATH.test(f)) &&
		!PLUMBING_ESCAPE.test(escapeSubject(c.subject));
	(allPlumbing ? plumbing : gaps).push(row);
}

// --- report -----------------------------------------------------------------

if (asJson) {
	console.log(
		JSON.stringify(
			{ since, scanned: commits.length, chore: choreCount, covered: coveredCount, gaps, plumbing },
			null,
			2,
		),
	);
	process.exit(0);
}

function printByDate(rows) {
	const byDate = {};
	for (const g of rows) (byDate[g.date] ||= []).push(g);
	for (const date of Object.keys(byDate).sort().reverse()) {
		console.log(`${date}`);
		for (const g of byDate[date]) {
			console.log(`  [${g.tag.padEnd(11)}] ${g.subject}  (${g.hash})`);
		}
		console.log('');
	}
}

console.log(`\nChangelog gap audit — commits since ${since}`);
console.log(
	`  scanned ${commits.length}  ·  internal/chore ${choreCount}  ·  covered ${coveredCount}  ·  GAPS ${gaps.length}  ·  plumbing ${plumbing.length}\n`,
);

printByDate(gaps);

if (gaps.length === 0) {
	console.log('No gaps — every user-visible commit in the window has a matching entry.\n');
} else {
	console.log(`${gaps.length} shipped change(s) look user-visible but have no changelog entry.`);
	console.log('Write them into data/changelog.json (holder-readable title + summary), then `npm run build:pages`.\n');
}

// Never truncate silently: plumbing is listed in full, just outside the count,
// so a judgement call ("this one IS worth an entry") stays available.
if (plumbing.length) {
	console.log(`--- plumbing (${plumbing.length}) — shipped, but nothing a holder perceives; no entry expected ---\n`);
	printByDate(plumbing);
	console.log('Promote any of these to an entry if you decide a holder would notice it.\n');
}
