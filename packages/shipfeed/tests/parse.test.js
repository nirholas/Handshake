import { describe, it, expect } from 'vitest';
import {
	parseCommitMessage,
	parseCommit,
	parseTrailers,
	splitMessage,
	headline,
	summaryLine,
} from '../src/parse.js';

describe('splitMessage', () => {
	it('splits subject from body and normalizes CRLF', () => {
		expect(splitMessage('subject\r\n\r\nbody line\r\n')).toEqual({
			subject: 'subject',
			body: 'body line',
		});
	});

	it('handles a subject with no body', () => {
		expect(splitMessage('only a subject')).toEqual({ subject: 'only a subject', body: '' });
	});
});

describe('parseCommitMessage', () => {
	it('parses type, scope, and description', () => {
		const p = parseCommitMessage('feat(wallet): let a user withdraw');
		expect(p.type).toBe('feat');
		expect(p.scope).toBe('wallet');
		expect(p.description).toBe('let a user withdraw');
		expect(p.conventional).toBe(true);
		expect(p.breaking).toBe(false);
	});

	it('reads the bang as a breaking change', () => {
		expect(parseCommitMessage('feat(api)!: drop v1').breaking).toBe(true);
	});

	it('reads BREAKING CHANGE in the body as a breaking change', () => {
		const p = parseCommitMessage('fix: tighten a check\n\nBREAKING CHANGE: v1 callers must migrate');
		expect(p.breaking).toBe(true);
	});

	it('keeps a non-conventional subject intact', () => {
		const p = parseCommitMessage('Avatar Studio: 122 sliders');
		expect(p.conventional).toBe(false);
		expect(p.type).toBeNull();
		expect(p.subject).toBe('Avatar Studio: 122 sliders');
	});

	it('detects merges and reverts', () => {
		expect(parseCommitMessage('Merge pull request #12 from a/b').merge).toBe(true);
		const revert = parseCommitMessage('Revert "feat: a thing"');
		expect(revert.revert).toBe(true);
		expect(revert.revertedSubject).toBe('feat: a thing');
	});

	it('collects issue references once each', () => {
		const p = parseCommitMessage('fix: close #12\n\nAlso #12 and #34.');
		expect(p.issues).toEqual(['12', '34']);
	});

	it('lowercases the type but preserves scope casing', () => {
		const p = parseCommitMessage('FEAT(Avatar Studio): ship it');
		expect(p.type).toBe('feat');
		expect(p.scope).toBe('Avatar Studio');
	});
});

describe('parseTrailers', () => {
	it('reads only the final trailer block', () => {
		const { trailers, coAuthors } = parseTrailers(
			'Prose: this colon is not a trailer\n\nCo-authored-by: A <a@b.c>\nChangelog: my-entry',
		);
		expect(trailers).toEqual({ changelog: 'my-entry' });
		expect(coAuthors).toEqual(['A <a@b.c>']);
	});

	it('returns empty structures for a body with no trailers', () => {
		expect(parseTrailers('just prose')).toEqual({ trailers: {}, coAuthors: [] });
	});
});

describe('parseCommit', () => {
	const github = {
		sha: 'abcdef1234567890abcdef1234567890abcdef12',
		html_url: 'https://github.com/o/r/commit/abcdef1',
		parents: [{ sha: 'p1' }],
		commit: {
			message: 'perf(index): drain the worst backlog first',
			author: { name: 'nirholas', date: '2026-08-27T10:00:00Z' },
			committer: { date: '2026-08-27T10:05:00Z' },
		},
		author: { login: 'nirholas' },
	};

	it('normalizes a GitHub commit object', () => {
		const c = parseCommit(github);
		expect(c.shortSha).toBe('abcdef1');
		expect(c.type).toBe('perf');
		expect(c.scope).toBe('index');
		expect(c.author).toEqual({ login: 'nirholas', name: 'nirholas' });
		expect(c.committedAt).toBe('2026-08-27T10:05:00Z');
		expect(c.merge).toBe(false);
	});

	it('treats a two-parent commit as a merge', () => {
		expect(parseCommit({ ...github, parents: [{ sha: 'a' }, { sha: 'b' }] }).merge).toBe(true);
	});

	it('flattens a files array when the caller supplied one', () => {
		const c = parseCommit({ ...github, files: [{ filename: 'api/x.js' }, 'src/y.js'] });
		expect(c.files).toEqual(['api/x.js', 'src/y.js']);
	});
});

describe('headline and summaryLine', () => {
	it('reads a scoped conventional commit as label plus scope', () => {
		expect(headline(parseCommitMessage('feat(resilience): add a breaker'))).toBe(
			'Feature · resilience',
		);
	});

	it('marks breaking changes', () => {
		expect(headline(parseCommitMessage('feat(api)!: drop v1'))).toBe('Feature · api (breaking)');
	});

	it('falls back to the legacy "Scope: text" convention', () => {
		expect(headline(parseCommitMessage('Avatar Studio: 122 sliders'))).toBe('Avatar Studio');
		expect(summaryLine(parseCommitMessage('Avatar Studio: 122 sliders'))).toBe('122 sliders');
	});

	it('says "New commit" when a subject carries no convention at all', () => {
		expect(headline(parseCommitMessage('escape a raw NUL byte in the test'))).toBe('New commit');
	});

	it('accepts a raw string as well as a parsed record', () => {
		expect(headline('fix: a thing')).toBe('Fix');
		expect(summaryLine('fix: a thing')).toBe('a thing');
	});
});
