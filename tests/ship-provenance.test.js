import { describe, it, expect } from 'vitest';
import { provenanceByEntry } from '../api/_lib/ship-provenance.js';
import { formatTelegramMessage } from '../api/_lib/changelog-push.js';

const commit = (sha, message, date) => ({
	sha: sha.padEnd(40, '0'),
	parents: [{ sha: 'parent' }],
	commit: {
		message,
		author: { name: 'nirholas', date },
		committer: { date },
	},
	author: { login: 'nirholas' },
});

const entry = {
	date: '2026-08-27',
	title: 'Text-to-3D now has five independent image sources behind it',
	summary:
		'Every text-to-3D generation starts by painting a concept image. The painter now tries five independent image providers in order, under one shared time budget.',
	tags: ['fix', 'infra'],
	link: '/forge',
};

describe('provenanceByEntry', () => {
	// Term weighting is inverse-document-frequency based, so it needs a corpus to
	// weigh against. Real ticks read 300 commits; these stand in for the rest of
	// the afternoon's unrelated work.
	const background = [
		commit('d001', 'docs(seeker): write the dApp Store release runbook', '2026-08-27T07:00:00Z'),
		commit('d002', 'fix(wallet): tell the owner a wallet is unsignable', '2026-08-27T07:30:00Z'),
		commit('d003', 'test(agent-index): cover the backlog drain', '2026-08-27T08:00:00Z'),
		commit('d004', 'style(nav): tighten the mobile breakpoint', '2026-08-27T08:30:00Z'),
	];

	it('reports the commit count and a compare range for an entry it can place', async () => {
		const commits = [
			commit('bbb2', 'fix(forge): add two more concept image provider rungs to the painter', '2026-08-27T11:00:00Z'),
			commit('aaa1', 'fix(forge): put every concept image provider on one shared time budget', '2026-08-27T09:00:00Z'),
			...background,
		];
		const map = await provenanceByEntry([entry], { commits });
		const p = map.get(`${entry.date}:${entry.title}`);
		expect(p.count).toBe(2);
		expect(p.range).toBe('aaa1000..bbb2000');
		expect(p.compareUrl).toContain('/compare/');
	});

	it('links a single commit directly rather than to an empty compare view', async () => {
		const commits = [
			commit('aaa1', 'fix(forge): put every concept image provider on one shared time budget', '2026-08-27T09:00:00Z'),
			...background,
		];
		const map = await provenanceByEntry([entry], { commits });
		const p = map.get(`${entry.date}:${entry.title}`);
		expect(p.count).toBe(1);
		expect(p.compareUrl).toContain('/commit/');
	});

	it('returns nothing for an entry no commit matches', async () => {
		const commits = [commit('cccc', 'style: reindent the footer', '2026-08-27T09:00:00Z'), ...background];
		const map = await provenanceByEntry([entry], { commits });
		expect(map.size).toBe(0);
	});

	it('returns an empty map when commits cannot be read, so a send never blocks', async () => {
		expect((await provenanceByEntry([entry], { commits: null })).size).toBe(0);
		expect((await provenanceByEntry([], { commits: [] })).size).toBe(0);
	});
});

describe('formatTelegramMessage with provenance', () => {
	const e = { date: '2026-08-27', title: 'A release', summary: 'What changed.', tags: ['fix'] };

	it('adds a shipped-in line that points at the diff', () => {
		const msg = formatTelegramMessage(e, {
			count: 7,
			compareUrl: 'https://github.com/nirholas/three.ws/compare/aaa...bbb',
		});
		expect(msg).toContain('shipped in <a href="https://github.com/nirholas/three.ws/compare/aaa...bbb">7 commits</a>');
	});

	it('says "commit" for a single commit', () => {
		const msg = formatTelegramMessage(e, { count: 1, compareUrl: 'https://example.invalid/c' });
		expect(msg).toContain('>1 commit<');
	});

	it('is byte-identical to the old message when provenance is unavailable', () => {
		const withNull = formatTelegramMessage(e, null);
		expect(withNull).toBe(formatTelegramMessage(e));
		expect(withNull).not.toContain('shipped in');
	});
});
