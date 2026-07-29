import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the guard. On 2026-07-29 a `git stash pop` conflict was committed
// wholesale: `<<<<<<< Updated upstream` reached HEAD in production source
// (api/chat/config.js, src/walk.js, src/avatar-garment.js) and in
// character-studio/.gitignore. Nothing caught it, because a conflict marker is
// a SYNTAX error rather than a lint violation, and neither eslint nor vitest
// runs on commit.
//
// The subtle half is character-studio/.gitignore: that conflict had TWO nested
// opening markers, two `=======` separators, and no closing marker at all. A
// check that requires the OPEN/CLOSE pair calls that file clean — exactly
// backwards, since an unterminated conflict means the merge stopped partway.
// The "unterminated" case below is the regression test for that.

const script = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'scripts',
	'check-merge-conflicts.mjs',
);

const OPEN = '<'.repeat(7);
const MID = '='.repeat(7);
const CLOSE = '>'.repeat(7);

let repo;

/** Run the checker inside a throwaway git repo; returns { code, stdout }. */
function runIn(dir) {
	try {
		const stdout = execFileSync('node', [script], { cwd: dir, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status, stdout: `${err.stdout || ''}${err.stderr || ''}` };
	}
}

function commitAll(dir) {
	execFileSync('git', ['add', '-A'], { cwd: dir });
	execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'x', '--no-verify'], {
		cwd: dir,
	});
}

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), 'conflict-guard-'));
	execFileSync('git', ['init', '-q'], { cwd: repo });
	mkdirSync(join(repo, 'src'), { recursive: true });
	writeFileSync(join(repo, 'src', 'clean.js'), 'export const ok = 1;\n');
	commitAll(repo);
});

afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe('check-merge-conflicts', () => {
	it('passes on a tree with no markers', () => {
		const { code, stdout } = runIn(repo);
		expect(code).toBe(0);
		expect(stdout).toContain('no unresolved merge-conflict markers');
	});

	it('fails on a fully-formed conflict and names the file and line', () => {
		writeFileSync(
			join(repo, 'src', 'paired.js'),
			['const a = 1;', `${OPEN} Updated upstream`, 'const b = 2;', MID, 'const b = 3;', `${CLOSE} Stashed changes`, ''].join('\n'),
		);
		commitAll(repo);
		const { code, stdout } = runIn(repo);
		expect(code).toBe(1);
		expect(stdout).toContain('src/paired.js');
		expect(stdout).toContain('line 2');
		rmSync(join(repo, 'src', 'paired.js'));
		commitAll(repo);
	});

	it('fails on an UNTERMINATED conflict (opening marker, no closing one)', () => {
		// The character-studio/.gitignore shape: nested opens, no close.
		writeFileSync(
			join(repo, 'src', 'unterminated.js'),
			['const a = 1;', `${OPEN} HEAD`, 'const b = 2;', MID, `${OPEN} HEAD`, 'const c = 3;', MID, ''].join('\n'),
		);
		commitAll(repo);
		const { code, stdout } = runIn(repo);
		expect(code).toBe(1);
		expect(stdout).toContain('src/unterminated.js');
		expect(stdout).toContain('no closing marker');
		rmSync(join(repo, 'src', 'unterminated.js'));
		commitAll(repo);
	});

	it('ignores a bare separator line, which is ordinary markdown', () => {
		writeFileSync(join(repo, 'HEADING.md'), ['Title', MID, '', 'Body text.', ''].join('\n'));
		commitAll(repo);
		const { code } = runIn(repo);
		expect(code).toBe(0);
		rmSync(join(repo, 'HEADING.md'));
		commitAll(repo);
	});

	it('ignores untracked files, so a scratch file cannot block a build', () => {
		writeFileSync(
			join(repo, 'scratch.js'),
			[`${OPEN} HEAD`, 'x', MID, 'y', `${CLOSE} other`, ''].join('\n'),
		);
		const { code } = runIn(repo);
		expect(code).toBe(0);
		rmSync(join(repo, 'scratch.js'));
	});

	it('ignores a marker mentioned mid-line in prose, not at column 0', () => {
		// git only ever writes conflict markers at the start of a line. An
		// unanchored fixed-string search also matches any file that merely
		// *describes* one — this test file, the checker's own header comment, a
		// doc explaining how to resolve conflicts. That false positive failed a
		// production build on 2026-07-29. Anchoring is the fix; rewording every
		// mention of a marker forever is not.
		writeFileSync(
			join(repo, 'src', 'prose.js'),
			[
				'// The stash pop left `' + OPEN + ' Updated upstream` in three files.',
				`const note = "${OPEN} HEAD";`,
				'export const ok = 1;',
				'',
			].join('\n'),
		);
		commitAll(repo);
		const { code } = runIn(repo);
		expect(code).toBe(0);
		rmSync(join(repo, 'src', 'prose.js'));
		commitAll(repo);
	});

	it('still catches a real marker at column 0 in the same file as prose', () => {
		// Anchoring must not become a blind spot: a file that both discusses a
		// marker and carries a genuine one still has to fail.
		writeFileSync(
			join(repo, 'src', 'both.js'),
			[
				'// Docs mention `' + OPEN + ' HEAD` inline.',
				`${OPEN} HEAD`,
				'const b = 2;',
				MID,
				'const b = 3;',
				`${CLOSE} other`,
				'',
			].join('\n'),
		);
		commitAll(repo);
		const { code, stdout } = runIn(repo);
		expect(code).toBe(1);
		expect(stdout).toContain('src/both.js');
		expect(stdout).toContain('line 2');
		rmSync(join(repo, 'src', 'both.js'));
		commitAll(repo);
	});

	it('this repository is clean', () => {
		const { code } = runIn(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
		expect(code).toBe(0);
	});
});
