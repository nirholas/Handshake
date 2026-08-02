import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, copyFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the guard, twice over: the installer that writes .git/hooks/pre-push,
// and the hook body it writes.
//
// Why this file exists: scripts/check-rules.mjs shipped working and enforced by
// nothing, so violations reached main anyway. The hook is what makes it
// mandatory, which means the hook is now load-bearing for every push from this
// machine. Three properties have to hold or it does active harm:
//
//   1. It must not block a clean push. A pre-push hook that false-positives gets
//      deleted by the first person it blocks, and then nothing is enforced
//      again. The clean-push case below asserts it reaches the git-lfs handoff.
//   2. It must not swallow git-lfs. The stock LFS hook occupied this path first
//      and consumes the pushed refs on stdin. Ours reads that same stdin to run
//      its own per-ref check, so it has to replay the refs downstream or LFS
//      silently stops uploading objects. That is a data-loss bug, invisible
//      until a clone comes back with pointer files.
//   3. It must not clobber a hook it does not recognize. Overwriting someone's
//      custom pre-push disables whatever it guarded, silently.
//
// The zero-sha cases matter because git uses the all-zeroes sha for both "new
// remote branch" and "delete this ref". Diffing against it produces a bogus
// range, so both must be skipped rather than checked.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(repoRoot, 'scripts', 'setup-git-hooks.mjs');
const checkRules = join(repoRoot, 'scripts', 'check-rules.mjs');

const ZERO = '0'.repeat(40);
// Assembled at runtime so this file does not itself contain a literal the
// hard-rules checker bans (it scans its own repo's added lines).
const STUB_COMMENT = `// ${'TO' + 'DO'}: implement later`;

let sandbox;
let repo;
let shimDir;

/**
 * Copy the installer (and the checker the hook shells out to) into `dir` as
 * scripts/, mirroring the real layout.
 *
 * The installer deliberately resolves its target repo from its own file
 * location rather than from cwd, because postinstall runs with an
 * unpredictable cwd and must still install into the repo it ships with. So a
 * staged copy is the only way to point it at a sandbox, and testing it this way
 * exercises the real resolution path instead of a test-only override.
 */
function stageScripts(dir) {
	mkdirSync(join(dir, 'scripts'), { recursive: true });
	copyFileSync(installer, join(dir, 'scripts', 'setup-git-hooks.mjs'));
	copyFileSync(checkRules, join(dir, 'scripts', 'check-rules.mjs'));
}

/** Run the staged installer inside `dir`; returns { code, out }. */
function install(dir) {
	try {
		const out = execFileSync('node', [join(dir, 'scripts', 'setup-git-hooks.mjs')], { cwd: dir, encoding: 'utf8' });
		return { code: 0, out };
	} catch (err) {
		return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
	}
}

/**
 * Invoke the installed hook the way git does: refs on stdin, remote name and
 * URL as argv. `env` overrides are merged in.
 */
function runHook(dir, stdin, env = {}) {
	try {
		const out = execFileSync('sh', [join(dir, '.git', 'hooks', 'pre-push'), 'threews', 'https://example.invalid'], {
			cwd: dir,
			input: stdin,
			encoding: 'utf8',
			env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, ...env },
		});
		return { code: 0, out };
	} catch (err) {
		return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
	}
}

function git(dir, args) {
	return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
}

/** Commit everything and return the new sha. */
function commitAll(dir, message) {
	git(dir, ['add', '-A']);
	git(dir, ['commit', '-q', '-m', message, '--no-verify']);
	return git(dir, ['rev-parse', 'HEAD']).trim();
}

beforeAll(() => {
	sandbox = mkdtempSync(join(tmpdir(), 'hook-guard-'));

	// A git-lfs stand-in that records the stdin it was handed, so the pass-through
	// can be asserted rather than assumed.
	shimDir = join(sandbox, 'bin');
	mkdirSync(shimDir, { recursive: true });
	const lfsLog = join(sandbox, 'lfs-stdin.txt');
	writeFileSync(join(shimDir, 'git-lfs'), `#!/bin/sh\ncat > "${lfsLog}"\necho "lfs-shim ran"\nexit 0\n`);
	execFileSync('chmod', ['755', join(shimDir, 'git-lfs')]);

	repo = join(sandbox, 'repo');
	mkdirSync(repo, { recursive: true });
	git(repo, ['init', '-q']);
	// The hook shells out to `node scripts/check-rules.mjs`, resolved against the
	// pushing repo, so the checker has to exist here too.
	stageScripts(repo);
	writeFileSync(join(repo, 'clean.js'), 'export const ok = 1;\n');
	commitAll(repo, 'base');
});

afterAll(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

describe('setup-git-hooks (installer)', () => {
	it('installs an executable pre-push hook', () => {
		const { code, out } = install(repo);
		expect(code).toBe(0);
		expect(out).toContain('installed pre-push hook');
		const hookPath = join(repo, '.git', 'hooks', 'pre-push');
		expect(existsSync(hookPath)).toBe(true);
		expect(statSync(hookPath).mode & 0o111).toBeTruthy();
		expect(readFileSync(hookPath, 'utf8')).toContain('check-rules.mjs');
	});

	it('is idempotent, so every npm install does not rewrite it', () => {
		const hookPath = join(repo, '.git', 'hooks', 'pre-push');
		const before = readFileSync(hookPath, 'utf8');
		const { code, out } = install(repo);
		expect(code).toBe(0);
		expect(out).not.toContain('installed pre-push hook');
		expect(readFileSync(hookPath, 'utf8')).toBe(before);
	});

	it('upgrades the stock git-lfs hook in place', () => {
		const fresh = join(sandbox, 'lfs-repo');
		mkdirSync(fresh, { recursive: true });
		git(fresh, ['init', '-q']);
		stageScripts(fresh);
		const hookPath = join(fresh, '.git', 'hooks', 'pre-push');
		writeFileSync(hookPath, '#!/bin/sh\ngit lfs pre-push "$@"\n');
		const { code } = install(fresh);
		expect(code).toBe(0);
		const body = readFileSync(hookPath, 'utf8');
		expect(body).toContain('check-rules.mjs');
		// The LFS behavior it replaced must survive the upgrade.
		expect(body).toContain('git lfs pre-push');
	});

	it('refuses to clobber an unrecognized custom hook', () => {
		const fresh = join(sandbox, 'custom-repo');
		mkdirSync(fresh, { recursive: true });
		git(fresh, ['init', '-q']);
		stageScripts(fresh);
		const hookPath = join(fresh, '.git', 'hooks', 'pre-push');
		const custom = '#!/bin/sh\n# somebody\'s own guard\nexit 0\n';
		writeFileSync(hookPath, custom);
		const { code, out } = install(fresh);
		expect(code).toBe(1);
		expect(out).toContain('not overwriting');
		expect(readFileSync(hookPath, 'utf8')).toBe(custom);
	});

	it('exits quietly outside a git repository', () => {
		const notARepo = join(sandbox, 'plain-dir');
		mkdirSync(notARepo, { recursive: true });
		stageScripts(notARepo);
		const { code } = install(notARepo);
		expect(code).toBe(0);
		expect(existsSync(join(notARepo, '.git'))).toBe(false);
	});

	it('honors core.hooksPath instead of writing where git will not look', () => {
		// CLAUDE.md and the stock LFS message both reference core.hooksPath. If the
		// installer hardcoded .git/hooks, a repo using hooksPath would get a hook
		// git never runs: enforcement silently off, with a file on disk implying
		// it is on.
		const fresh = join(sandbox, 'hookspath-repo');
		const alt = join(fresh, 'my-hooks');
		mkdirSync(alt, { recursive: true });
		git(fresh, ['init', '-q']);
		stageScripts(fresh);
		git(fresh, ['config', 'core.hooksPath', 'my-hooks']);
		const { code } = install(fresh);
		expect(code).toBe(0);
		expect(existsSync(join(alt, 'pre-push'))).toBe(true);
		expect(existsSync(join(fresh, '.git', 'hooks', 'pre-push'))).toBe(false);
	});
});

describe('setup-git-hooks (documented remote)', () => {
	// Git remotes are local config and cannot be committed, so a fresh clone has
	// only `origin` while CLAUDE.md's instruction is `git push threews main`. That
	// command failed in this worktree on 2026-07-30. The installer re-derives the
	// documented target so the instruction is true on every machine, which also
	// keeps check:claude from red-flagging an innocent clone.
	const REMOTE_DOC = [
		'### Remotes',
		'',
		'- `threews` -> `https://github.com/nirholas/three.ws`',
		'- `threeD` -> `https://github.com/nirholas/3D-Agent`',
		'',
		'When the user asks you to push: `git push threews main`.',
		'',
	].join('\n');

	/** A repo with a CLAUDE.md remote table and only an `origin` remote, like a clone. */
	function cloneLikeRepo(name, doc = REMOTE_DOC) {
		const dir = join(sandbox, name);
		mkdirSync(dir, { recursive: true });
		git(dir, ['init', '-q']);
		stageScripts(dir);
		writeFileSync(join(dir, 'CLAUDE.md'), doc);
		git(dir, ['remote', 'add', 'origin', 'https://github.com/nirholas/three.ws']);
		return dir;
	}

	const remotesOf = (dir) => git(dir, ['remote']).split('\n').filter(Boolean);

	it('adds the push target a clone does not have', () => {
		const dir = cloneLikeRepo('clone-like');
		const { code, out } = install(dir);
		expect(code).toBe(0);
		expect(out).toContain('added the `threews` remote');
		expect(remotesOf(dir)).toContain('threews');
		expect(git(dir, ['remote', 'get-url', 'threews']).trim()).toBe('https://github.com/nirholas/three.ws');
	});

	it('never creates the retired mirror, which the doc forbids fetching from', () => {
		const dir = cloneLikeRepo('no-mirror');
		install(dir);
		// `threeD` is in the documented table but is not the push target, so it must
		// not be created. Fetching from it has corrupted this repo's history before.
		expect(remotesOf(dir)).not.toContain('threeD');
	});

	it('leaves an existing remote of that name untouched', () => {
		const dir = cloneLikeRepo('existing-remote');
		git(dir, ['remote', 'add', 'threews', 'https://github.com/someone/fork']);
		install(dir);
		// Repointing somebody's remote is how a push ends up at the wrong repo.
		// Surfacing the mismatch is check:claude's job, not this script's.
		expect(git(dir, ['remote', 'get-url', 'threews']).trim()).toBe('https://github.com/someone/fork');
	});

	it('is idempotent across installs', () => {
		const dir = cloneLikeRepo('remote-idempotent');
		install(dir);
		const { out } = install(dir);
		expect(out).not.toContain('added the');
		expect(remotesOf(dir).filter((r) => r === 'threews')).toHaveLength(1);
	});

	it('does nothing when the doc names no push target', () => {
		const dir = cloneLikeRepo('no-target', '# No remote table and no push instruction here.\n');
		const { code } = install(dir);
		expect(code).toBe(0);
		expect(remotesOf(dir)).toEqual(['origin']);
	});

	it('still installs the hook when the remote is already correct', () => {
		// The hook is the load-bearing half; remote setup must never short-circuit it.
		const dir = cloneLikeRepo('hook-still-installed');
		git(dir, ['remote', 'add', 'threews', 'https://github.com/nirholas/three.ws']);
		const { code } = install(dir);
		expect(code).toBe(0);
		expect(existsSync(join(dir, '.git', 'hooks', 'pre-push'))).toBe(true);
	});
});

describe('pre-push hook (behavior)', () => {
	let baseSha;
	let cleanSha;
	let dirtySha;

	beforeAll(() => {
		install(repo);
		baseSha = git(repo, ['rev-parse', 'HEAD']).trim();
		writeFileSync(join(repo, 'added.js'), 'export const fine = 2;\n');
		cleanSha = commitAll(repo, 'feat(test): add a module that follows every hard rule');
		writeFileSync(join(repo, 'bad.js'), `${STUB_COMMENT}\nexport const x = 1;\n`);
		dirtySha = commitAll(repo, 'feat(test): add a module whose body breaks a hard rule');
	});

	it('passes a clean push and hands the refs to git-lfs', () => {
		const { code, out } = runHook(repo, `refs/heads/main ${cleanSha} refs/heads/main ${baseSha}\n`);
		expect(code).toBe(0);
		expect(out).toContain('lfs-shim ran');
		// Property 2: the refs the hook consumed on stdin must reach LFS.
		expect(readFileSync(join(sandbox, 'lfs-stdin.txt'), 'utf8')).toContain(cleanSha);
	});

	it('blocks a push whose commits break a hard rule, naming the file', () => {
		const { code, out } = runHook(repo, `refs/heads/main ${dirtySha} refs/heads/main ${cleanSha}\n`);
		expect(code).toBe(1);
		expect(out).toContain('bad.js');
		expect(out).toContain('SKIP_PUSH_CHECKS=1');
	});

	it('blocks a push whose commit subject is a generic sweep message', () => {
		// The 22-of-60 "chore: sync working tree" era: the message lint rejects
		// the subject even when the diff itself is clean.
		writeFileSync(join(repo, 'swept.js'), 'export const swept = 4;\n');
		const sweepSha = commitAll(repo, 'chore: sync working tree');
		try {
			const { code, out } = runHook(repo, `refs/heads/main ${sweepSha} refs/heads/main ${dirtySha}\n`);
			expect(code).toBe(1);
			expect(out).toContain('meaningless subject');
			expect(out).toContain('sync working tree');
		} finally {
			git(repo, ['reset', '-q', '--hard', dirtySha]);
		}
	});

	it('blocks a subject too short to describe anything, allows a neutral revert', () => {
		writeFileSync(join(repo, 'short.js'), 'export const s = 5;\n');
		const shortSha = commitAll(repo, 'fix: tweak');
		writeFileSync(join(repo, 'short.js'), 'export const s = 6;\n');
		const revertSha = commitAll(repo, 'Revert previous change');
		try {
			const blocked = runHook(repo, `refs/heads/main ${shortSha} refs/heads/main ${dirtySha}\n`);
			expect(blocked.code).toBe(1);
			expect(blocked.out).toContain('too short');
			// The neutral revert wording CLAUDE.md mandates must pass the lint.
			const allowed = runHook(repo, `refs/heads/main ${revertSha} refs/heads/main ${shortSha}\n`);
			expect(allowed.out).not.toContain('meaningless subject');
			expect(allowed.code).toBe(0);
		} finally {
			git(repo, ['reset', '-q', '--hard', dirtySha]);
		}
	});

	it('does not run git-lfs when it blocks, so a rejected push uploads nothing', () => {
		writeFileSync(join(sandbox, 'lfs-stdin.txt'), 'untouched');
		const { code } = runHook(repo, `refs/heads/main ${dirtySha} refs/heads/main ${cleanSha}\n`);
		expect(code).toBe(1);
		expect(readFileSync(join(sandbox, 'lfs-stdin.txt'), 'utf8')).toBe('untouched');
	});

	it('SKIP_PUSH_CHECKS bypasses the check but still runs git-lfs', () => {
		const { code, out } = runHook(repo, `refs/heads/main ${dirtySha} refs/heads/main ${cleanSha}\n`, {
			SKIP_PUSH_CHECKS: '1',
		});
		expect(code).toBe(0);
		expect(out).toContain('lfs-shim ran');
		expect(out).not.toContain('hard-rule');
	});

	it('skips a ref deletion, which pushes no commits to check', () => {
		const { code } = runHook(repo, `(delete) ${ZERO} refs/heads/gone ${dirtySha}\n`);
		expect(code).toBe(0);
	});

	it('skips a brand-new remote branch, where the zero base is not a diffable range', () => {
		const { code } = runHook(repo, `refs/heads/new ${dirtySha} refs/heads/new ${ZERO}\n`);
		expect(code).toBe(0);
	});

	it('skips a remote sha absent from the local object database', () => {
		// A stale remote tip that was never fetched cannot be diffed against.
		// Erroring here would block pushes for a reason the author cannot act on.
		const unknown = 'd'.repeat(40);
		const { code } = runHook(repo, `refs/heads/main ${dirtySha} refs/heads/main ${unknown}\n`);
		expect(code).toBe(0);
	});

	it('blocks the whole push when any one of several refs is dirty', () => {
		const stdin =
			`refs/heads/main ${cleanSha} refs/heads/main ${baseSha}\n` +
			`refs/heads/other ${dirtySha} refs/heads/other ${cleanSha}\n`;
		const { code, out } = runHook(repo, stdin);
		expect(code).toBe(1);
		expect(out).toContain('bad.js');
	});

	it('judges only the pushed commits, ignoring dirty working-tree state', () => {
		// The reason the hook uses --base/--head instead of a worktree check:
		// concurrent agents share this checkout, so an unrelated in-flight file
		// must never block a push of already-committed clean work.
		const stray = join(repo, 'stray-agent-file.js');
		writeFileSync(stray, `${STUB_COMMENT}\nexport const y = 3;\n`);
		try {
			const { code } = runHook(repo, `refs/heads/main ${cleanSha} refs/heads/main ${baseSha}\n`);
			expect(code).toBe(0);
		} finally {
			rmSync(stray, { force: true });
		}
	});
});

describe('this repository', () => {
	it('has the current hook version installed', () => {
		const hookPath = join(repoRoot, '.git', 'hooks', 'pre-push');
		expect(existsSync(hookPath)).toBe(true);
		const body = readFileSync(hookPath, 'utf8');
		expect(body).toContain('three.ws pre-push hook');
		expect(body).toContain('git lfs pre-push');
	});

	it('reinstalls the hook from postinstall, so a fresh clone is covered', () => {
		const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
		expect(pkg.scripts.postinstall).toContain('setup-git-hooks.mjs');
	});
});
