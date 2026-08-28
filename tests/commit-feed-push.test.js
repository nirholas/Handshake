import { describe, it, expect } from 'vitest';
import {
	commitHeadline,
	commitSummary,
	commitPreviewUrl,
	formatTelegramMessage,
	commitDate,
	fetchCommitsSince,
	newCommitsSince,
} from '../api/_lib/commit-feed-push.js';
import commitOg from '../api/commit-og.js';

const commit = (over = {}) => ({
	sha: 'abcdef1234567890abcdef1234567890abcdef12',
	html_url: 'https://github.com/nirholas/three.ws/commit/abcdef1234567890abcdef1234567890abcdef12',
	commit: {
		message: 'feat: add a thing\n\nlonger body ignored',
		author: { name: 'nirholas', date: '2026-07-22T12:00:00Z' },
	},
	author: { login: 'nirholas' },
	...over,
});

describe('commitHeadline', () => {
	it('reads a conventional type as a friendly label', () => {
		expect(commitHeadline(commit())).toBe('Feature');
	});

	it('keeps the scope, which the raw type prefix used to swallow', () => {
		expect(
			commitHeadline(commit({ commit: { message: 'feat(resilience): add a breaker', author: {} } })),
		).toBe('Feature · resilience');
	});

	it('marks a breaking change', () => {
		expect(commitHeadline(commit({ commit: { message: 'feat(api)!: drop v1', author: {} } }))).toBe(
			'Feature · api (breaking)',
		);
	});

	it('falls back to the older "Scope: text" habit', () => {
		expect(
			commitHeadline(commit({ commit: { message: 'Avatar Studio: 122 sliders', author: {} } })),
		).toBe('Avatar Studio');
	});

	it('says "New commit" when a subject carries no convention at all', () => {
		expect(
			commitHeadline(commit({ commit: { message: 'Escape a raw NUL byte in the test', author: {} } })),
		).toBe('New commit');
	});
});

describe('commitSummary', () => {
	it('drops the type prefix and keeps the description', () => {
		expect(commitSummary(commit())).toBe('add a thing');
		expect(
			commitSummary(commit({ commit: { message: 'Avatar Studio: 122 sliders', author: {} } })),
		).toBe('122 sliders');
	});
});

describe('formatTelegramMessage', () => {
	it('uses the prettified headline as the bold title', () => {
		const msg = formatTelegramMessage(commit());
		expect(msg).toContain('<b>Feature</b>');
		expect(msg).toContain('add a thing');
		expect(msg).toContain('github.com/nirholas/three.ws/commit/abcdef1');
	});
	it('escapes HTML in the subject body', () => {
		const msg = formatTelegramMessage(commit({ commit: { message: 'fix: guard <script> & co', author: {} } }));
		expect(msg).toContain('guard &lt;script&gt; &amp; co');
		expect(msg).not.toContain('<script>');
	});
});

describe('commitPreviewUrl', () => {
	it('points at the branded commit-og landing with the sha and pretty headline', () => {
		const u = new URL(commitPreviewUrl(commit()));
		expect(u.origin + u.pathname).toBe('https://three.ws/api/commit-og');
		expect(u.searchParams.get('sha')).toBe('abcdef1234567890abcdef1234567890abcdef12');
		expect(u.searchParams.get('t')).toBe('Feature');
		expect(u.searchParams.get('d')).toBe('add a thing');
		expect(u.searchParams.get('author')).toBe('nirholas');
	});
});

// A newest-first GitHub page, one commit per minute counting backwards from
// `startMs`, matching the order /commits returns.
const NOW = Date.parse('2026-08-14T19:00:00Z');
function history(count, startMs = NOW) {
	return Array.from({ length: count }, (_, i) => ({
		sha: `sha${String(i).padStart(4, '0')}`,
		commit: {
			message: `fix: commit ${i}`,
			author: { name: 'nirholas', date: new Date(startMs - i * 60_000).toISOString() },
			committer: { date: new Date(startMs - i * 60_000).toISOString() },
		},
		author: { login: 'nirholas' },
	}));
}

describe('fetchCommitsSince', () => {
	it('pages back until lastSha is found instead of giving up after one page', async () => {
		const all = history(300);
		const pages = [];
		const getPage = async (p) => {
			pages.push(p);
			return all.slice((p - 1) * 100, p * 100);
		};
		// sha0117 is the 118th commit: page 1 cannot see it, page 2 can.
		const { commits, found } = await fetchCommitsSince('sha0117', { getPage, now: NOW });
		expect(found).toBe(true);
		expect(pages).toEqual([1, 2]);
		expect(commits.length).toBe(200);
	});

	it('stops on page one when lastSha is right there', async () => {
		const all = history(300);
		const pages = [];
		const getPage = async (p) => {
			pages.push(p);
			return all.slice((p - 1) * 100, p * 100);
		};
		const { found } = await fetchCommitsSince('sha0005', { getPage, now: NOW });
		expect(found).toBe(true);
		expect(pages).toEqual([1]);
	});

	it('stops paging once the history falls past the cutoff', async () => {
		// One commit per hour: page 1 alone reaches back past the 3-day cutoff.
		const all = history(500, NOW).map((c, i) => {
			const d = new Date(NOW - i * 3_600_000).toISOString();
			return { ...c, commit: { ...c.commit, author: { ...c.commit.author, date: d }, committer: { date: d } } };
		});
		const pages = [];
		const getPage = async (p) => {
			pages.push(p);
			return all.slice((p - 1) * 100, p * 100);
		};
		const { found } = await fetchCommitsSince('sha0499', { getPage, now: NOW });
		expect(found).toBe(false);
		expect(pages).toEqual([1]);
	});

	it('reads a single page when there is no state to resume from', async () => {
		const pages = [];
		const getPage = async (p) => {
			pages.push(p);
			return history(300).slice((p - 1) * 100, p * 100);
		};
		await fetchCommitsSince(null, { getPage, now: NOW });
		expect(pages).toEqual([1]);
	});
});

describe('newCommitsSince', () => {
	it('returns everything newer than lastSha, oldest-first', () => {
		const commits = history(10);
		const { commits: pending, reseed } = newCommitsSince(commits, { lastSha: 'sha0003' }, NOW);
		expect(reseed).toBe(false);
		expect(pending.map((c) => c.sha)).toEqual(['sha0002', 'sha0001', 'sha0000']);
	});

	it('keeps a burst backlog whole rather than dropping it', () => {
		// The bug this replaces capped at 30 fetched commits and reseeded past
		// the rest; 117 behind must now come back as 117 pending.
		const commits = history(200);
		const { commits: pending, reseed } = newCommitsSince(commits, { lastSha: 'sha0117' }, NOW);
		expect(reseed).toBe(false);
		expect(pending.length).toBe(117);
		expect(pending[0].sha).toBe('sha0116'); // oldest first
		expect(pending[pending.length - 1].sha).toBe('sha0000');
	});

	it('falls back to lastDate when lastSha is outside the window', () => {
		const commits = history(10);
		const { commits: pending, reseed, resynced } = newCommitsSince(
			commits,
			{ lastSha: 'gone-in-a-rebase', lastDate: commitDate(commits[3]) },
			NOW,
		);
		expect(reseed).toBe(false);
		expect(resynced).toBe(true);
		expect(pending.map((c) => c.sha)).toEqual(['sha0002', 'sha0001', 'sha0000']);
	});

	it('never posts commits older than the cutoff', () => {
		const commits = history(10, Date.parse('2026-08-01T00:00:00Z'));
		const { commits: pending } = newCommitsSince(commits, { lastSha: 'sha0009' }, NOW);
		expect(pending).toEqual([]);
	});

	it('reseeds when there is no anchor at all', () => {
		expect(newCommitsSince(history(5), { lastSha: null }, NOW).reseed).toBe(true);
		expect(newCommitsSince(history(5), { lastSha: 'unknown' }, NOW).reseed).toBe(true);
	});
});

// Minimal ServerResponse stub for the HTML handler.
function capture() {
	const res = {
		statusCode: 0,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(s) {
			this.body = s || '';
		},
	};
	return res;
}

describe('commit-og handler', () => {
	it('emits OG tags and a validated GitHub redirect', () => {
		const res = capture();
		commitOg(
			{ url: '/api/commit-og?sha=abcdef1234567&t=Feature&d=add%20a%20thing&date=2026-07-22&author=nirholas' },
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toContain('text/html');
		expect(res.body).toContain('<meta property="og:title" content="Feature">');
		expect(res.body).toContain('property="og:image" content="https://three.ws/api/page-og?s=commit');
		expect(res.body).toContain('github.com/nirholas/three.ws/commit/abcdef1234567');
		// redirect target is the commit, not a caller-supplied url
		expect(res.body).toContain('url=https://github.com/nirholas/three.ws/commit/abcdef1234567');
	});

	it('rejects a non-hex sha and falls back to the commits page (no open redirect)', () => {
		const res = capture();
		commitOg({ url: '/api/commit-og?sha=https://evil.example/pwn&t=x' }, res);
		expect(res.body).not.toContain('evil.example');
		expect(res.body).toContain('github.com/nirholas/three.ws/commits/main');
	});

	it('escapes HTML in OG attribute values', () => {
		const res = capture();
		commitOg({ url: '/api/commit-og?sha=abcdef1&t=' + encodeURIComponent('a" onload="x') }, res);
		expect(res.body).not.toContain('onload="x"');
		expect(res.body).toContain('&quot;');
	});
});
