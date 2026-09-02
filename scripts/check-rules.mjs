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
//   node scripts/check-rules.mjs --base <ref> --head <ref>   a pushed ref that is not HEAD (pre-push hook)
//   node scripts/check-rules.mjs --paths a.js b.js   only these files
//
// --paths matters here: concurrent agents share this worktree, so a bare
// `git diff HEAD` shows everyone's in-flight work, not yours. Scope to the
// files you touched and you get a verdict on YOUR change.
//
// In --base mode (the pre-push hook) it ALSO lints the subject line of every
// commit in base..head. History filled up with "chore: sync working tree"
// sweeps that say nothing about the diff they carry, which makes the log
// useless for archaeology. A subject must describe the change: banned generic
// subjects and sub-15-character subjects fail the push. Merge commits and the
// deliberately-neutral revert messages CLAUDE.md mandates are exempt.
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
const headIdx = argv.indexOf('--head');
const head = headIdx === -1 ? 'HEAD' : argv[headIdx + 1];
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
	// Machine-written mirrors of tool text that lives in source: the catalog is
	// written by scripts/build-mcp-catalog.mjs, the fixture by
	// scripts/audit-mcp-golden.mjs --update. Prose rules belong on the tool
	// descriptions themselves, not on the generated copies of them.
	/^public\/mcp-catalog\.json$/,
	/^tests\/fixtures\/mcp-golden-tools\.json$/,
	/^locales\//,
	// The standalone deployer site's build output. site/build.mjs esbuilds
	// site/src into packages/metaplex-agent-mcp/docs/ and copies the HTML and
	// CSS beside it, because GitHub Pages serves that directory from main. The
	// bundle carries upstream library strings (including a vendored
	// not-implemented throw) that no edit of ours can reach. The sources in
	// site/ are still scanned.
	/^packages\/metaplex-agent-mcp\/docs\//,
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
	// The guard registry, for the same reason. Every guard there carries a
	// PROOF: the exact violation it must reject, stored verbatim so
	// scripts/prove-guards.mjs can write it into a sandbox and watch the guard
	// fire. Proving this script works therefore requires storing a line that
	// this script forbids. Scanning the fixtures reports the evidence as the
	// offense. The prose fields (title, protects, why, proof summaries) are
	// still held to the typography rule, by scripts/audit-guards.mjs.
	/^data\/guards\.json$/,
	/^public\/guards\.json$/,
	// Captured third-party text, stored verbatim as evidence. The X account
	// archive is what was actually published, character for character, so
	// rewriting its typography to satisfy a house rule would falsify the
	// record the archive exists to preserve. The rule applies to prose we
	// write, not to prose we transcribe.
	/^data\/x-archive\//,
	// The store-submission evidence captures, for the same reason. Each of these
	// is a verbatim JSON-RPC wire payload pulled from the LIVE production server
	// and kept so an OpenAI or MCP-directory reviewer can diff what we claim
	// against what the endpoint actually answers. Normalizing their typography to
	// satisfy a house rule falsifies the capture (it was done once, and the
	// committed evidence silently stopped matching production). Prose rules
	// belong on the tool descriptions in api/, which is where the wording that
	// ends up in these files is authored.
	/^prompts\/store-submissions\/_generated\/[a-z-]*tools-list\.json$/,
	// Captured live API responses, stored verbatim as the evidence a gauntlet run
	// produced. Same reasoning as the archive above: the third party's own
	// wording is the record, and retyping its punctuation to satisfy a house
	// rule would make the evidence a paraphrase of what the endpoint said.
	/^prompts\/okx-ai\/e2e-evidence\//,
	// The baked animation library. Every clip, the manifest, and the signature
	// index are written by scripts/build-animations.mjs and
	// scripts/compact-clips.mjs from FBX sources deliberately kept out of the
	// repo, so nothing in them is prose anyone wrote. Skipping them also keeps a
	// re-bake (117 files, hundreds of MB of diff) out of the diff this guard has
	// to read.
	/^public\/animations\/clips\//,
	/^public\/animations\/(manifest|signatures)\.json$/,
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

// Commit-subject lint, --base mode only: the pre-push hook hands us exactly
// the commits leaving the machine, so this is the one place a message rule can
// be enforced without judging other agents' in-flight work. A commit message
// is the only documentation a diff carries into history; "chore: sync working
// tree" documents nothing.
const BANNED_SUBJECTS = new Set([
	'sync working tree',
	'sync',
	'wip',
	'update',
	'updates',
	'change',
	'changes',
	'misc',
	'stuff',
	'cleanup',
	'clean up',
	'minor changes',
	'various fixes',
	'more work',
	'progress',
	'checkpoint',
	'save work',
	'commit',
	'work',
]);
if (base) {
	let commits = [];
	try {
		commits = git(['log', '--format=%H%x00%s', `${base}..${head}`]).split('\n').filter(Boolean);
	} catch (err) {
		console.error(`[check-rules] could not read the commit list (${base}..${head}): ${err.message}`);
		process.exit(1);
	}
	const bad = [];
	for (const row of commits) {
		const [sha, subject = ''] = row.split('\0');
		const s = subject.trim();
		// Merge commits are machine-written; neutral revert messages are
		// mandated by CLAUDE.md (never echo the reverted content).
		if (/^merge /i.test(s)) continue;
		if (/^(revert previous change|roll back the prior commit)$/i.test(s)) continue;
		// Strip a conventional-commit prefix so `chore: sync` and `sync` are
		// judged by the same words.
		const meat = s.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '').trim();
		if (BANNED_SUBJECTS.has(meat.toLowerCase())) {
			bad.push({ sha, subject: s, why: 'generic sweep subject, says nothing about the diff' });
		} else if (meat.length < 15) {
			bad.push({ sha, subject: s, why: 'subject too short to describe the change (min 15 chars after the type prefix)' });
		}
	}
	if (bad.length) {
		console.error(`[check-rules] ${bad.length} commit(s) being pushed have a meaningless subject:\n`);
		for (const b of bad) {
			console.error(`[check-rules]   ${b.sha.slice(0, 9)}  "${b.subject}"`);
			console.error(`[check-rules]     ${b.why}`);
		}
		console.error('\n[check-rules] CLAUDE.md rule: every commit message describes the actual diff,');
		console.error('[check-rules] `type(scope): what changed and why a reader would care`.');
		console.error('[check-rules] Reword with `git commit --amend` (last commit) or a rebase, then push again.');
		process.exit(1);
	}
}

// Which revisions to compare. The file list and the diff itself are read
// against this same selector.
let range;
if (base) range = [`${base}...${head}`];
else if (staged) range = ['--staged'];
else range = ['HEAD'];

// Read the changed file names first, then diff them in batches, rather than
// asking git for one blob. Two reasons, both load-bearing at push time: the
// SKIP list drops generated output BEFORE git prints it, and no single spawn
// has to hold the whole diff. A push that re-baked the animation library
// produced a 215 MB diff, which overflowed execFileSync's buffer and failed the
// push with `spawnSync git ENOBUFS` (2026-09-01). That reads like a rule
// violation and is not one, and the only way past it was to bypass the guard.
const FILES_PER_DIFF = 100;

const listArgs = ['diff', '--name-only', '-z', ...range];
if (paths.length) listArgs.push('--', ...paths);
let changedFiles;
try {
	changedFiles = git(listArgs).split('\0').filter(Boolean);
} catch (err) {
	console.error(`[check-rules] could not list the changed files (${listArgs.join(' ')}): ${err.message}`);
	process.exit(1);
}
const scannable = changedFiles.filter((f) => !skipped(f));

// Where a file MOVED, batch its old path alongside its new one. Git pairs the
// two into a rename and diffs only the lines that actually changed, but that
// pairing needs both paths inside the same pathspec: limit the diff to the new
// path alone (which is all `--name-only` prints) and git falls back to calling
// it a brand-new file, so every legacy line in a file someone merely moved
// reads as an added line. That turned the 2026-09-02 move of 228 work orders
// into `prompts/finish/` into 293 phantom em-dash violations in prose nobody
// wrote that day, which is the exact "rewrite the world to move a file"
// outcome this guard's diff scoping exists to prevent.
const renamedFrom = new Map();
try {
	const statusArgs = ['diff', '--name-status', '--find-renames', '-z', ...range];
	if (paths.length) statusArgs.push('--', ...paths);
	const fields = git(statusArgs).split('\0').filter(Boolean);
	for (let i = 0; i < fields.length; i += 1) {
		if (!/^R\d*$/.test(fields[i])) continue;
		renamedFrom.set(fields[i + 2], fields[i + 1]);
		i += 2;
	}
} catch {
	// Rename detection is an optimization; without it the diff is merely noisier.
}

let diff = '';
for (let i = 0; i < scannable.length; i += FILES_PER_DIFF) {
	const batch = scannable.slice(i, i + FILES_PER_DIFF);
	const sources = batch.map((f) => renamedFrom.get(f)).filter(Boolean);
	const diffArgs = ['diff', '--unified=0', '--find-renames', ...range, '--', ...batch, ...sources];
	try {
		diff += git(diffArgs);
	} catch (err) {
		console.error(`[check-rules] could not read the diff for ${batch.length} file(s) starting at ${batch[0]}: ${err.message}`);
		process.exit(1);
	}
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
