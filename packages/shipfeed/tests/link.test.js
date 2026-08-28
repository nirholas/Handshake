import { describe, it, expect } from 'vitest';
import { linkCommits, entryKey, entrySlug, tokenize, buildIdf } from '../src/link.js';

const commit = (sha, message, date) => ({
	sha: sha.padEnd(40, '0'),
	commit: { message, author: { name: 'nirholas', date }, committer: { date } },
	parents: [{ sha: 'p' }],
});

const entries = [
	{
		date: '2026-08-27',
		title: 'Text-to-3D now has five independent image sources behind it',
		summary:
			'Every text-to-3D generation starts by painting a concept image. The painter now tries five independent providers in order under one shared time budget.',
		tags: ['fix', 'infra'],
		link: '/forge',
	},
	{
		date: '2026-08-27',
		title: 'Agent history on Base and Gnosis is moving again',
		summary: 'The indexer no longer stops on an on-chain string Postgres cannot store.',
		tags: ['fix'],
	},
];

describe('tokenize', () => {
	it('drops stopwords, punctuation, and bare numbers', () => {
		expect(tokenize('The painter tries 5 providers, in order.')).toEqual([
			'painter',
			'tries',
			'providers',
			'order',
		]);
	});
});

describe('buildIdf', () => {
	it('weights a rare term above a ubiquitous one', () => {
		const idf = buildIdf([
			['agent', 'meshopt'],
			['agent', 'wallet'],
			['agent', 'forge'],
		]);
		expect(idf.get('meshopt')).toBeGreaterThan(idf.get('agent'));
	});
});

describe('entrySlug', () => {
	it('matches the three.ws changelog permalink shape', () => {
		expect(entrySlug(entries[0])).toBe(
			'2026-08-27-text-to-3d-now-has-five-independent-image-sources-behind-it',
		);
	});
});

describe('linkCommits', () => {
	it('links a commit to the entry that shares its rare terms', () => {
		const commits = [
			commit('aaa1', 'feat(forge): paint concept images across five image providers', '2026-08-27T09:00:00Z'),
			commit('bbb2', 'fix(agent-index): keep crawling past an on-chain string Postgres cannot store', '2026-08-27T09:30:00Z'),
		];
		const { byCommit } = linkCommits(entries, commits);
		expect(byCommit.get(commits[0].sha).entryKey).toBe(entryKey(entries[0]));
		expect(byCommit.get(commits[1].sha).entryKey).toBe(entryKey(entries[1]));
	});

	it('always prefers an explicit Changelog trailer', () => {
		const c = commit(
			'ccc3',
			`chore: unrelated words entirely\n\nChangelog: ${entrySlug(entries[0])}`,
			'2026-08-27T09:00:00Z',
		);
		const { byCommit } = linkCommits(entries, [c]);
		expect(byCommit.get(c.sha)).toMatchObject({ entryKey: entryKey(entries[0]), score: 1 });
		expect(byCommit.get(c.sha).reasons[0]).toContain('trailer');
	});

	it('leaves a commit outside the time window unlinked', () => {
		const c = commit('ddd4', 'feat(forge): paint concept images across five providers', '2026-01-01T09:00:00Z');
		const { byCommit, orphans } = linkCommits(entries, [c]);
		expect(byCommit.size).toBe(0);
		expect(orphans).toHaveLength(1);
	});

	it('leaves an unrelated commit unlinked even inside the window', () => {
		const c = commit('eee5', 'style: reindent the footer', '2026-08-27T09:00:00Z');
		const { byCommit } = linkCommits(entries, [c], { threshold: 0.5 });
		expect(byCommit.size).toBe(0);
	});

	it('records why it linked what it linked', () => {
		const c = commit('fff6', 'fix(forge): give every concept-image provider a shared time budget', '2026-08-27T08:00:00Z');
		const { byCommit } = linkCommits(entries, [c]);
		const link = byCommit.get(c.sha);
		expect(link.reasons.join(' ')).toMatch(/shared terms/);
		expect(link.score).toBeGreaterThan(0);
		expect(link.score).toBeLessThanOrEqual(1);
	});

	it('orders an entry bucket oldest commit first', () => {
		const commits = [
			commit('1111', 'fix(forge): second concept image provider rung', '2026-08-27T11:00:00Z'),
			commit('2222', 'fix(forge): first concept image provider rung', '2026-08-27T08:00:00Z'),
		];
		const { byEntry } = linkCommits(entries, commits);
		const bucket = byEntry.get(entryKey(entries[0]));
		expect(bucket.commits.map((c) => c.shortSha)).toEqual(['2222000', '1111000']);
	});

	it('caps how many commits one entry may claim', () => {
		const commits = Array.from({ length: 8 }, (_, i) =>
			commit(`c${i}`, `fix(forge): concept image provider rung ${i}`, '2026-08-27T08:00:00Z'),
		);
		const { byEntry, orphans } = linkCommits(entries, commits, { maxPerEntry: 3 });
		expect(byEntry.get(entryKey(entries[0])).commits).toHaveLength(3);
		expect(orphans.length).toBe(5);
	});

	it('never claims a commit for two entries', () => {
		const commits = [
			commit('9999', 'fix(forge): concept image providers and the on-chain string crawl', '2026-08-27T08:00:00Z'),
		];
		const { byEntry } = linkCommits(entries, commits);
		const claims = [...byEntry.values()].filter((b) => b.commits.length).length;
		expect(claims).toBeLessThanOrEqual(1);
	});
});
