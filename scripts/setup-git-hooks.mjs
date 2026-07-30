#!/usr/bin/env node
// Install the repo's pre-push hook into .git/hooks.
//
// Why this exists: scripts/check-rules.mjs (the diff-scoped CLAUDE.md hard-rules
// guard) was enforced by nothing. It existed, it worked, and no mandatory path
// ran it, so violations shipped anyway. A guard that is not wired into an
// unavoidable path decays into documentation. The unavoidable path for
// commit-content rules is pre-push: it sees exactly the commits leaving the
// machine, after all local churn has settled.
//
// Design constraints, in order:
//   1. Scoped to the push. The hook runs check-rules with --base <remote sha>
//      --head <local sha> per pushed ref, so it judges only the commits being
//      pushed. Concurrent agents' in-flight worktree edits are invisible to it.
//      This is why the hook does NOT run `npm run gate` or working-tree checks:
//      on a worktree shared by several agents those block your push on someone
//      else's red, and the owner's rule is that a requested push executes
//      immediately.
//   2. Fast. One node process per pushed ref, seconds not minutes.
//   3. Escapable. SKIP_PUSH_CHECKS=1 git push bypasses it for emergencies.
//   4. Composes with git-lfs. The stock LFS hook lived here first; ours replays
//      the refs on stdin to `git lfs pre-push` after the rules pass.
//
// Runs from postinstall, so every `npm install` (re)installs it. Safe to run
// anywhere: exits quietly when there is no git repo (tarball installs, CI).
//
// Usage: node scripts/setup-git-hooks.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'three.ws pre-push hook v1';

const HOOK = `#!/bin/sh
# ${MARKER} (installed by scripts/setup-git-hooks.mjs; edits here are overwritten
# on the next npm install, change the installer instead).
#
# Enforces the CLAUDE.md hard rules on the commits being pushed, scoped to
# exactly those commits (never the shared working tree), then hands the refs to
# git-lfs. Emergency bypass: SKIP_PUSH_CHECKS=1 git push
input="$(cat)"

zero=0000000000000000000000000000000000000000

if [ -z "$SKIP_PUSH_CHECKS" ] && command -v node >/dev/null 2>&1; then
	echo "$input" | {
		status=0
		while read -r local_ref local_sha remote_ref remote_sha; do
			[ -z "$local_ref" ] && continue
			# Deleting a remote ref pushes no commits.
			[ "$local_sha" = "$zero" ] && continue
			# New remote branch or unknown remote tip: no base to diff against.
			[ "$remote_sha" = "$zero" ] && continue
			git cat-file -e "$remote_sha" 2>/dev/null || continue
			node scripts/check-rules.mjs --base "$remote_sha" --head "$local_sha" || { status=1; break; }
		done
		exit "$status"
	} || {
		echo >&2 ""
		echo >&2 "pre-push: CLAUDE.md hard-rule violations in the commits being pushed."
		echo >&2 "pre-push: fix them, or bypass once with: SKIP_PUSH_CHECKS=1 git push"
		exit 1
	}
fi

command -v git-lfs >/dev/null 2>&1 || { printf >&2 "\\n%s\\n\\n" "This repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting the 'pre-push' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks')."; exit 2; }
echo "$input" | git lfs pre-push "$@"
`;

let hooksDir;
try {
	hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
	process.exit(0); // not a git repo (tarball install, exported source); nothing to do
}
hooksDir = path.resolve(root, hooksDir);
const hookPath = path.join(hooksDir, 'pre-push');

// Ensure the remote CLAUDE.md tells agents to push to actually exists.
//
// A clone names its remote `origin`, but CLAUDE.md's push instruction is
// `git push threews main`, so on a fresh clone that command fails at exactly the
// moment the owner asked to ship (observed in this worktree on 2026-07-30). Git
// remotes are local config and cannot be committed, so the only way to make the
// documented command true everywhere is to re-derive it here on every install.
//
// Deliberately narrow: it adds ONLY the push target named in the doc, only when
// that name is absent, and only at the URL the doc records. It never edits or
// removes an existing remote, and it can never create the retired mirror, which
// CLAUDE.md forbids fetching from. Runs before the hook logic below because that
// path exits early once the hook is current.
function ensureDocumentedRemote() {
	const docPath = path.join(root, 'CLAUDE.md');
	if (!existsSync(docPath)) return;
	const doc = readFileSync(docPath, 'utf8');
	const target = doc.match(/git push ([A-Za-z0-9_-]+) main/)?.[1];
	if (!target) return;
	const url = doc.match(new RegExp(`^-\\s+\`${target}\`\\s*(?:→|->)\\s*\`(https?://[^\`]+)\``, 'm'))?.[1];
	if (!url) return;
	const existingRemotes = execFileSync('git', ['remote'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
	if (existingRemotes.includes(target)) return;
	execFileSync('git', ['remote', 'add', target, url], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
	console.log(`[setup-git-hooks] added the \`${target}\` remote (${url}) that CLAUDE.md documents as the push target`);
}

try {
	ensureDocumentedRemote();
} catch (err) {
	// Never fail an install over this; the hook is the load-bearing half.
	console.error(`[setup-git-hooks] could not verify the documented git remote: ${err.message}`);
}

const existing = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : '';
if (existing.includes(MARKER)) {
	if (existing === HOOK) process.exit(0); // current version already installed
} else if (existing && !/git lfs pre-push/.test(existing)) {
	// A hand-written hook we do not recognize. Clobbering it would silently
	// disable whatever it guards, so refuse and say so.
	console.error(`[setup-git-hooks] ${hookPath} exists and is not the stock git-lfs hook; not overwriting.`);
	console.error('[setup-git-hooks] Merge scripts/setup-git-hooks.mjs\'s template into it by hand.');
	process.exit(1);
}

writeFileSync(hookPath, HOOK);
chmodSync(hookPath, 0o755);
console.log(`[setup-git-hooks] installed pre-push hook at ${path.relative(root, hookPath)}`);
