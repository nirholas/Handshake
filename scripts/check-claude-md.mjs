#!/usr/bin/env node
// Assert CLAUDE.md tells the truth about this repository.
//
// CLAUDE.md is the operating brain for every agent in this workspace: it names
// npm scripts, file paths, and runbook steps that agents execute verbatim. When
// the repo moves and CLAUDE.md doesn't, agents follow instructions into dead
// ends (a renamed script, a moved runbook, a deleted directory) and burn a
// session discovering the drift. This check makes that drift a red build
// instead of a wasted session.
//
// Assertions:
//   1. Every `npm run <script>` and backticked script-name (build:gcp,
//      check:dist, ...) referenced in CLAUDE.md exists in package.json.
//   2. Every concrete repo path referenced in CLAUDE.md exists on disk.
//      Placeholders (<name>), globs (*), brace sets ({a,b}), URLs, and build
//      artifacts are skipped; the check only fails on paths an agent would
//      try to open and not find.
//   3. CLAUDE.md honors its own typography rule: no em/en-dashes outside the
//      Tone paragraph that names the banned characters.
//   4. The load-bearing factual claims still hold. These are the ones that
//      have actually drifted before and cost a session each: the cron count,
//      the build:gcp chain order, the db:migrate safety semantics, the
//      README-coverage standard, the documented git remotes (the push target
//      must actually resolve), and the retired X changelog lane. Each is
//      re-derived from the source of truth on every run, so the doc cannot
//      quietly go stale again.
//
// Run: node scripts/check-claude-md.mjs   (wired as `npm run check:claude`)

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};

const failures = [];

// 1. npm scripts: `npm run x` prose plus bare backticked script names.
const referenced = new Set();
for (const m of md.matchAll(/npm run ([a-z0-9:._-]+)/g)) referenced.add(m[1]);
for (const m of md.matchAll(/`([a-z][a-z0-9-]*(?::[a-z0-9-]+)+)`/g)) referenced.add(m[1]);
for (const name of [...referenced].sort()) {
	if (!scripts[name]) failures.push(`npm script \`${name}\` is referenced but missing from package.json`);
}

// 2. Repo paths: backticked tokens and markdown link targets that contain a
// slash. Anything an agent could not literally open is skipped, not guessed.
const artifactPaths = new Set([
	'dist/',
	'node_modules',
	'chat/node_modules',
	'character-studio/build',
	'.github/workflows/', // named only to be forbidden; must not be required to exist
	// Build outputs of the build:gcp chain. CLAUDE.md names them to explain why
	// that chain's order is load-bearing, so requiring them on disk makes this
	// gate pass only on a machine that already built, and report four phantom
	// drift errors on a fresh clone or in the detached deploy worktree the
	// runbook itself tells agents to build in.
	'dist-lib/agent-3d.js',
	'avatar-sdk/dist',
	'avatar-sdk/dist/index.mjs',
	// Git plumbing, not a repo path: in a linked worktree `.git` is a FILE
	// pointing at the main checkout, so this never resolves there.
	'.git/hooks',
]);
const candidates = new Set();
for (const m of md.matchAll(/`([^`\n]+)`/g)) candidates.add(m[1]);
for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) candidates.add(m[1]);
for (const raw of [...candidates].sort()) {
	if (!raw.includes('/')) continue;
	if (!/^[A-Za-z0-9_./-]+$/.test(raw)) continue; // placeholders, globs, braces, spaces, @scopes
	if (raw.startsWith('/') || raw.startsWith('-') || raw.includes('://')) continue; // routes, flags, URLs
	if (raw.startsWith('three.ws/') || raw.startsWith('pump.fun/')) continue; // domains in prose
	if (artifactPaths.has(raw)) continue;
	if (!existsSync(path.join(root, raw))) failures.push(`path \`${raw}\` is referenced but does not exist`);
}

// 3. Typography: the ban applies to the file that declares it. Only the lines
// that name the banned characters may contain them.
md.split('\n').forEach((line, i) => {
	if (/[—–]/.test(line) && !/em-dash|en-dash/.test(line)) {
		failures.push(`line ${i + 1} contains an em/en-dash, which CLAUDE.md itself bans`);
	}
});

// 4. Load-bearing factual claims, each re-derived from its source of truth.

// 4a. Cron count. CLAUDE.md quotes a number with an "as of" date; the array in
// vercel.json is authoritative and grew from 89 to 100 unnoticed.
const cronClaim = md.match(/the crons \((\d+) as of ([\d-]+)/);
if (!cronClaim) {
	failures.push('the cron-count sentence ("the crons (N as of DATE, see vercel.json)") is gone from CLAUDE.md');
} else {
	const actual = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')).crons.length;
	if (Number(cronClaim[1]) !== actual) {
		failures.push(
			`CLAUDE.md says ${cronClaim[1]} crons (as of ${cronClaim[2]}) but vercel.json declares ${actual}. ` +
				`Update the number and the date.`,
		);
	}
}

// 4b. build:gcp chain. The deploy runbook prints the chain step by step; an
// agent reordering it produces a dist/ missing either the pages or the lib.
const chain = (scripts['build:gcp'] || '').match(/npm run ([a-z0-9:._-]+)/g)?.map((s) => s.replace('npm run ', '')) ?? [];
if (chain.length === 0) {
	failures.push('build:gcp no longer looks like an `npm run` chain; the deploy runbook in CLAUDE.md cannot be verified');
} else {
	const runbookOrder = chain.filter((step) => md.includes(`\`${step}\``));
	const positions = runbookOrder.map((step) => md.indexOf(`\`${step}\``));
	const documentedInOrder = positions.every((p, i) => i === 0 || p > positions[i - 1]);
	if (!documentedInOrder) {
		failures.push(
			`the deploy runbook lists build:gcp steps out of order. Real chain: ${chain.join(' -> ')}`,
		);
	}
	const undocumented = chain.filter((step) => !md.includes(`\`${step}\``));
	if (undocumented.length) {
		failures.push(
			`build:gcp runs ${undocumented.join(', ')} but the CLAUDE.md deploy runbook never mentions ${undocumented.length > 1 ? 'them' : 'it'}. ` +
				`Real chain: ${chain.join(' -> ')}`,
		);
	}
}

// 4c. db:migrate safety. The npm wrapper hardcodes --apply, so the bare
// command writes to production Neon. CLAUDE.md once called it a dry run.
const migrateApplies = /--apply/.test(scripts['db:migrate'] || '');
const docSaysApplies = /`npm run db:migrate` APPLIES immediately/.test(md);
if (migrateApplies !== docSaysApplies) {
	failures.push(
		migrateApplies
			? 'db:migrate hardcodes --apply but CLAUDE.md no longer warns that it APPLIES immediately'
			: 'db:migrate no longer passes --apply, so the CLAUDE.md warning that it APPLIES immediately is now wrong',
	);
}

// 4d. README coverage. CLAUDE.md holds packages/workers/services at 100%.
const { readdirSync } = await import('node:fs');
const coverageGaps = [];
for (const base of ['packages', 'workers', 'services']) {
	const dir = path.join(root, base);
	if (!existsSync(dir)) continue;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!existsSync(path.join(dir, entry.name, 'README.md'))) coverageGaps.push(`${base}/${entry.name}`);
	}
}
if (coverageGaps.length && /Coverage under `packages\/`, `workers\/`, and `services\/` is currently 100%/.test(md)) {
	failures.push(
		`CLAUDE.md claims 100% README coverage but ${coverageGaps.length} dir(s) have none: ${coverageGaps.join(', ')}. ` +
			`Write the README (preferred) or correct the claim.`,
	);
}

// 4f. Git remotes. CLAUDE.md names the push target in an imperative the agent
// runs verbatim, and on 2026-07-30 this worktree had only `origin`, so that exact
// command failed. A push instruction that does not resolve is worse than a
// missing one: it fails at the moment the owner asked to ship. The remote table
// is also a safety boundary (the retired mirror must never be the target), so a
// documented URL that no longer matches the configured one has to surface.
try {
	const { execFileSync } = await import('node:child_process');
	const configured = new Map();
	for (const line of execFileSync('git', ['remote', '-v'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
		.split('\n')
		.filter(Boolean)) {
		const [name, url] = line.split(/\s+/);
		if (name && url && !configured.has(name)) configured.set(name, url);
	}
	// Only trust this check when git actually reported a remote set; a bare clone
	// with none configured is a legitimate state, not doc drift.
	if (configured.size) {
		const norm = (u) => u.replace(/\.git$/, '').replace(/\/$/, '');
		// The remote table: lines like  - `name` -> `https://...`
		const documented = new Map();
		for (const m of md.matchAll(/^-\s+`([A-Za-z0-9_-]+)`\s*(?:→|->)\s*`(https?:\/\/[^`]+)`/gm)) {
			documented.set(m[1], m[2]);
		}
		const pushTarget = md.match(/git push ([A-Za-z0-9_-]+) main/)?.[1];
		if (pushTarget && !configured.has(pushTarget)) {
			failures.push(
				`CLAUDE.md tells agents to run \`git push ${pushTarget} main\` but no remote named \`${pushTarget}\` is configured ` +
					`(configured: ${[...configured.keys()].join(', ')}). Add it, or correct the instruction.`,
			);
		}
		for (const [name, url] of documented) {
			const actual = configured.get(name);
			if (actual && norm(actual) !== norm(url)) {
				failures.push(`remote \`${name}\` points at ${actual} but CLAUDE.md documents ${url}`);
			}
		}
	}
} catch {
	// No git, or not a repository. Nothing to verify; never fail on that.
}

// 4g. Cloud Build service-account pins. CLAUDE.md states that EVERY cloudbuild
// config must pin one, because the project's default compute SA was deleted: an
// unpinned config is not a slow build, it is a submission Cloud Build refuses
// outright, discovered at the moment the owner asked to ship. Cloud Build also
// rejects a pinned build that has nowhere to put its logs, so the sink that
// makes the pin usable is part of the same claim. Pinning a dedicated per-worker
// SA (not just three-ws-build@) is legitimate; relying on the deleted default is
// the only failure.
if (/EVERY cloudbuild config must pin/.test(md)) {
	const { execFileSync: listFiles } = await import('node:child_process');
	let configs = [];
	try {
		configs = listFiles('git', ['ls-files', '-z', '*cloudbuild*.yaml', '*cloudbuild*.yml'], {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		})
			.split('\0')
			.filter(Boolean);
	} catch {
		// Not a git repository. Nothing to enumerate; never fail on that.
	}
	for (const rel of configs) {
		const body = readFileSync(path.join(root, rel), 'utf8');
		if (!/^serviceAccount:/m.test(body)) {
			failures.push(
				`${rel} has no top-level \`serviceAccount:\` pin, so \`gcloud builds submit\` on it is refused ` +
					`(the default compute SA was deleted). Pin three-ws-build@ as the sibling configs do.`,
			);
			continue;
		}
		const hasSink = /^\s+logging:\s*CLOUD_LOGGING_ONLY\b/m.test(body) || /^logsBucket:/m.test(body);
		if (!hasSink) {
			failures.push(
				`${rel} pins a serviceAccount but declares neither \`logging: CLOUD_LOGGING_ONLY\` nor a \`logsBucket\`. ` +
					`Cloud Build rejects that combination at submission.`,
			);
		}
	}
}

// 4e. The retired X changelog lane. If the cron ever calls it again, the
// "retired" wording in CLAUDE.md becomes a lie in the other direction.
const cronHandler = path.join(root, 'api/cron/changelog-push.js');
if (existsSync(cronHandler)) {
	const handler = readFileSync(cronHandler, 'utf8');
	const callsX = /\bpushXLane\s*\(/.test(handler);
	const docSaysRetired = /X\.com delivery is retired/.test(md);
	if (callsX && docSaysRetired) {
		failures.push('changelog-push now calls pushXLane again, but CLAUDE.md still says X.com delivery is retired');
	}
	if (!callsX && !docSaysRetired) {
		failures.push('changelog-push does not call pushXLane, but CLAUDE.md no longer records that X.com delivery is retired');
	}
}

// 5. The subagent definitions in .claude/agents/ are operating rules too: an
// agent executes them verbatim the same way it executes this file. Hold them
// to the same two mechanical standards (real scripts, banned typography).
const agentsDir = path.join(root, '.claude/agents');
if (existsSync(agentsDir)) {
	const { readdirSync: readAgents } = await import('node:fs');
	for (const file of readAgents(agentsDir).filter((f) => f.endsWith('.md'))) {
		const body = readFileSync(path.join(agentsDir, file), 'utf8');
		if (/[—–]/.test(body)) {
			failures.push(`.claude/agents/${file} contains an em/en-dash, which this repo bans everywhere`);
		}
		for (const m of body.matchAll(/npm run ([a-z0-9:._-]+)/g)) {
			if (!scripts[m[1]]) failures.push(`.claude/agents/${file} tells the agent to run \`npm run ${m[1]}\`, which does not exist`);
		}
	}
}

if (failures.length) {
	console.error(`[check-claude] ${failures.length} drift issue(s) between CLAUDE.md and the repo:`);
	for (const f of failures) console.error(`[check-claude]   ${f}`);
	console.error('[check-claude] Fix CLAUDE.md (or the repo) so agents are never handed a dead instruction.');
	process.exit(1);
}
console.log('[check-claude] OK: every script, path, and typography rule in CLAUDE.md matches the repo');
