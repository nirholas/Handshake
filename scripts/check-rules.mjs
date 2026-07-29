#!/usr/bin/env node
// Enforce the CLAUDE.md hard rules on the lines you actually changed.
//
// The hard rules (no TODOs, no stubs, no fake data, no em-dashes) were enforced
// only by agent discipline, which means they were enforced unevenly. A
// repo-wide sweep is not an option: 5,985 tracked files already contain an
// em-dash, and rewriting them all would be a catastrophic diff that buries
// every real change for a month.
//
// So this guard is DIFF-SCOPED. It reads added lines only, which stops the
// bleeding without touching history: your change is held to the rules, the
// legacy around it is left alone until someone touches it deliberately. That
// makes the rules enforceable today instead of aspirational forever.
//
// Modes:
//   node scripts/check-rules.mjs              working tree + staged, vs HEAD
//   node scripts/check-rules.mjs --staged     staged only (pre-commit)
//   node scripts/check-rules.mjs --base <ref> everything since <ref> (branch review)
//   node scripts/check-rules.mjs --paths a.js b.js   only these files
//
// --paths matters here: concurrent agents share this worktree, so a bare
// `git diff HEAD` shows everyone's in-flight work, not yours. Scope to the
// files you touched and you get a verdict on YOUR change.
//
// Exit 1 on any violation, with file:line and the rule broken.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const staged = argv.includes('--staged');
const baseIdx = argv.indexOf('--base');
const base = baseIdx === -1 ? null : argv[baseIdx + 1];
const pathsIdx = argv.indexOf('--paths');
const paths = pathsIdx === -1 ? [] : argv.slice(pathsIdx + 1).filter((a) => !a.startsWith('--'));

const git = (args) =>
	execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

// Generated, vendored, and build output. Changes here are machine-written, so
// holding them to prose rules produces noise and no signal.
const SKIP = [
	/^dist\//,
	/^dist-lib\//,
	/^node_modules\//,
	/(^|\/)node_modules\//,
	/^public\/chat\/assets\//,
	/^public\/locales\//,
	/^data\/_generated\//,
	/^docs\/ALL\.md$/,
	/^CHANGELOG\.md$/,
	/^public\/changelog\.(json|xml)$/,
	/^locales\//,
	/\.min\.(js|css)$/,
	/package-lock\.json$/,
	/\.(png|jpg|jpeg|gif|webp|glb|gltf|bin|woff2?|ttf|mp4|wasm|ico|svg)$/i,
	// The two guards themselves. Their rule tables must contain the banned
	// patterns verbatim (the dash characters, the word TODO, the
	// not-implemented string) in order to detect them, so scanning them
	// reports the detector as the offense. A linter cannot lint its own
	// pattern table.
	/^scripts\/check-rules\.mjs$/,
	/^scripts\/check-claude-md\.mjs$/,
];
const skipped = (file) => SKIP.some((re) => re.test(file));

// Each rule states the CLAUDE.md line it enforces, so a failure teaches the
// rule rather than just blocking. `test` receives the added line's content.
const RULES = [
	{
		id: 'em-dash',
		rule: 'the em-dash and en-dash are banned everywhere in this repo',
		test: (line) => /[—–]/.test(line),
		// The one legitimate mention is text that names the banned characters.
		except: (line) => /em-dash|en-dash|em dash|en dash/i.test(line),
	},
	{
		id: 'todo',
		rule: 'no TODO comments, no "implement later", no stub functions',
		test: (line) => /(^|[^A-Za-z])(TODO|FIXME|XXX|HACK)\b/.test(line) && /(\/\/|\/\*|\*|#|<!--)/.test(line),
		// A guard that forbids TODOs must be allowed to say the word "TODO".
		except: (line) => /check-rules|completionist|CLAUDE\.md|eslint|todoPattern/i.test(line),
	},
	{
		id: 'not-implemented',
		rule: 'no `throw new Error("not implemented")`, implement it',
		test: (line) => /throw new Error\(\s*['"`][^'"`]*not[ _-]?implemented/i.test(line),
	},
	{
		id: 'commented-out-code',
		rule: 'no commented-out code in committed work, delete or implement',
		// Conservative: only a commented line that ends in a statement
		// terminator and contains an assignment or call, which prose never does.
		test: (line) => /^\s*\/\/\s*(const|let|var|function|await|return|if\s*\(|for\s*\(|[\w.]+\s*\()/.test(line) && /[;{)]\s*$/.test(line),
		except: (line) => /eslint|@ts-|prettier|https?:\/\//.test(line),
	},
	{
		id: 'sample-data',
		rule: 'no fallback sample arrays shipped to production, real fetch only',
		test: (line) => /^\s*(const|let|var)\s+(sample|mock|fake|dummy|placeholder)[A-Z]\w*\s*=\s*\[/.test(line),
	},
];

let diffArgs;
if (base) diffArgs = ['diff', '--unified=0', `${base}...HEAD`];
else if (staged) diffArgs = ['diff', '--unified=0', '--staged'];
else diffArgs = ['diff', '--unified=0', 'HEAD'];
if (paths.length) diffArgs = [...diffArgs, '--', ...paths];

let diff;
try {
	diff = git(diffArgs);
} catch (err) {
	console.error(`[check-rules] could not read the diff (${diffArgs.join(' ')}): ${err.message}`);
	process.exit(1);
}

// A brand-new file is invisible to `git diff HEAD`: it has no tracked
// counterpart, so nothing shows up and a whole file of TODOs would pass. Treat
// every line of an untracked file as added, which is what it is. Skipped in
// --base mode, where the comparison is between two committed refs.
if (!base) {
	const untrackedArgs = ['ls-files', '--others', '--exclude-standard'];
	if (paths.length) untrackedArgs.push('--', ...paths);
	let untracked = [];
	try {
		untracked = git(untrackedArgs).split('\n').filter(Boolean);
	} catch {
		untracked = [];
	}
	const { readFileSync } = await import('node:fs');
	for (const f of untracked) {
		if (skipped(f)) continue;
		let body;
		try {
			body = readFileSync(path.join(root, f), 'utf8');
		} catch {
			continue; // unreadable or binary; nothing to enforce
		}
		if (body.includes('\u0000')) continue;
		diff += `\n+++ b/${f}\n@@ -0,0 +1 @@\n${body.split('\n').map((l) => `+${l}`).join('\n')}\n`;
	}
}

// Walk the unified diff, tracking the current file and new-file line number so
// every violation can be reported at a location the author can click.
const violations = [];
let file = null;
let lineNo = 0;
let filesScanned = 0;
for (const raw of diff.split('\n')) {
	if (raw.startsWith('+++ ')) {
		const p = raw.slice(4).replace(/^b\//, '');
		file = p === '/dev/null' ? null : p;
		if (file && !skipped(file)) filesScanned += 1;
		continue;
	}
	if (raw.startsWith('@@')) {
		const m = raw.match(/\+(\d+)/);
		lineNo = m ? Number(m[1]) : 0;
		continue;
	}
	if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
	const content = raw.slice(1);
	if (file && !skipped(file)) {
		for (const r of RULES) {
			if (r.test(content) && !(r.except && r.except(content))) {
				violations.push({ file, line: lineNo, id: r.id, rule: r.rule, content: content.trim().slice(0, 100) });
			}
		}
	}
	lineNo += 1;
}

if (violations.length) {
	const byRule = new Map();
	for (const v of violations) byRule.set(v.id, (byRule.get(v.id) || 0) + 1);
	console.error(`[check-rules] ${violations.length} hard-rule violation(s) in changed lines:\n`);
	for (const v of violations) {
		console.error(`[check-rules]   ${v.file}:${v.line}  [${v.id}]`);
		console.error(`[check-rules]     ${v.rule}`);
		console.error(`[check-rules]     > ${v.content}`);
	}
	console.error(
		`\n[check-rules] ${[...byRule].map(([k, n]) => `${k}:${n}`).join(' ')} across ${filesScanned} changed file(s).`,
	);
	console.error('[check-rules] These are CLAUDE.md hard rules. Fix them in this change, not later.');
	process.exit(1);
}

console.log(`[check-rules] OK: no hard-rule violations in the added lines of ${filesScanned} changed file(s)`);
