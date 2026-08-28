import { describe, it, expect } from 'vitest';
import {
	renderCommitTelegram,
	renderReleaseTelegram,
	renderMarkdown,
	renderRss,
	renderTerminal,
} from '../src/render.js';

const commit = {
	sha: 'a'.repeat(40),
	shortSha: 'aaaaaaa',
	url: 'https://github.com/o/r/commit/aaaaaaa',
	date: '2026-08-27T09:00:00Z',
	author: 'nirholas',
	type: 'feat',
	scope: 'forge',
	breaking: false,
	headline: 'Feature · forge',
	summary: 'paint concept images across five providers',
	audience: 'holder',
	signal: 0.8,
	issues: [],
	confidence: 0.42,
	why: ['shared terms: forge, concept'],
};

const release = {
	key: '2026-08-27:A release',
	slug: '2026-08-27-a-release',
	date: '2026-08-27',
	title: 'A release <with> markup & risk',
	summary: 'What changed, in a sentence.',
	tags: ['fix', 'infra'],
	link: '/forge',
	url: 'https://three.ws/changelog/2026-08-27-a-release',
	commits: [commit],
	stats: { commits: 1, authors: 1, range: 'aaaaaaa..aaaaaaa' },
};

const feed = {
	version: 1,
	generatedAt: '2026-08-28T00:00:00Z',
	repo: 'o/r',
	siteUrl: 'https://three.ws',
	releases: [release],
	ships: [
		{
			id: 'bbbbbbb..bbbbbbb',
			start: '2026-08-26T09:00:00Z',
			end: '2026-08-26T09:30:00Z',
			title: 'Fix · wallet',
			summary: 'stop a double withdrawal prompt',
			authors: ['nirholas'],
			signal: 0.6,
			commits: [{ ...commit, shortSha: 'bbbbbbb', headline: 'Fix · wallet' }],
		},
	],
	stats: {
		commits: 2,
		hidden: 0,
		releases: 1,
		linked: 1,
		orphans: 1,
		coverage: 0.5,
		byType: { feat: 1, fix: 1 },
		byAudience: { holder: 2, developer: 0, internal: 0 },
		topAuthors: [{ name: 'nirholas', count: 2 }],
		velocity: [{ date: '2026-08-27', count: 2 }],
	},
};

describe('renderCommitTelegram', () => {
	it('puts the headline in bold above the description and the source line', () => {
		const msg = renderCommitTelegram(commit, { repo: 'o/r' });
		expect(msg).toContain('<b>Feature · forge</b>');
		expect(msg).toContain('paint concept images across five providers');
		expect(msg).toContain('github.com/o/r/commit/aaaaaaa');
		expect(msg).toContain('2026-08-27');
	});

	it('escapes markup in a commit subject', () => {
		const msg = renderCommitTelegram({ ...commit, summary: 'guard <script> & co' });
		expect(msg).toContain('guard &lt;script&gt; &amp; co');
		expect(msg).not.toContain('<script>');
	});
});

describe('renderReleaseTelegram', () => {
	it('adds the provenance footer the raw commit feed cannot carry', () => {
		const msg = renderReleaseTelegram(release, { repo: 'o/r' });
		expect(msg).toContain('shipped in <a href="https://github.com/o/r/compare/aaaaaaa...aaaaaaa">1 commit</a>');
		expect(msg).toContain('#fix #infra');
	});

	it('omits the footer when nothing was linked', () => {
		const msg = renderReleaseTelegram(
			{ ...release, commits: [], stats: { commits: 0, authors: 0, range: null } },
			{ repo: 'o/r' },
		);
		expect(msg).not.toContain('shipped in');
	});

	it('escapes markup in a release title', () => {
		expect(renderReleaseTelegram(release, { repo: 'o/r' })).toContain('&lt;with&gt; markup &amp; risk');
	});
});

describe('renderMarkdown', () => {
	it('writes releases with their commits, then the unannounced work', () => {
		const md = renderMarkdown(feed);
		expect(md).toContain('# Ship log');
		expect(md).toContain('## 2026-08-27 · A release');
		expect(md).toContain('`aaaaaaa`');
		expect(md).toContain('## Unannounced work');
	});

	it('can leave the unannounced section out', () => {
		expect(renderMarkdown(feed, { includeShips: false })).not.toContain('Unannounced work');
	});
});

describe('renderRss', () => {
	it('emits a valid-looking channel with one item per release', () => {
		const rss = renderRss(feed, { title: 'o/r ship log', siteUrl: 'https://three.ws/ship' });
		expect(rss.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(rss).toContain('<title>o/r ship log</title>');
		expect(rss).toContain('<guid isPermaLink="false">2026-08-27:A release</guid>');
		expect(rss).toContain('27 Aug 2026 12:00:00 GMT');
	});

	it('escapes markup so a title can never break the document', () => {
		expect(renderRss(feed)).toContain('A release &lt;with&gt; markup &amp; risk');
	});
});

describe('renderTerminal', () => {
	it('writes a plain report with no escape codes when color is off', () => {
		const out = renderTerminal(feed, { color: false });
		expect(out).toContain('ship log · o/r');
		expect(out).toContain('50% coverage');
		expect(out).toContain('unannounced');
		expect(out).not.toContain(String.fromCharCode(27));
	});

	it('colors the report when asked', () => {
		expect(renderTerminal(feed, { color: true })).toContain(String.fromCharCode(27));
	});

	it('truncates a long commit list instead of flooding the terminal', () => {
		const many = { ...release, commits: Array.from({ length: 9 }, () => commit) };
		const out = renderTerminal({ ...feed, releases: [many] }, { color: false, maxCommits: 2 });
		expect(out).toContain('+7 more');
	});
});
