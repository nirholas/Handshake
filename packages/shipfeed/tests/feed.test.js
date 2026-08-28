import { describe, it, expect } from 'vitest';
import { buildShipFeed } from '../src/feed.js';
import { groupIntoShips } from '../src/group.js';
import { commitsFromGitLog, normalizeChangelog, GIT_LOG_FORMAT } from '../src/sources.js';

const NUL = String.fromCharCode(0);
const RS = String.fromCharCode(30);

const commit = (sha, message, date, extra = {}) => ({
	sha: sha.padEnd(40, '0'),
	html_url: `https://github.com/o/r/commit/${sha}`,
	parents: [{ sha: 'p' }],
	commit: {
		message,
		author: { name: 'nirholas', date },
		committer: { date },
	},
	author: { login: 'nirholas' },
	...extra,
});

const entries = [
	{
		date: '2026-08-27',
		title: 'Text-to-3D now has five independent image sources behind it',
		summary:
			'Every text-to-3D generation starts by painting a concept image. The painter now tries five independent image providers in order under one shared time budget.',
		tags: ['fix', 'infra'],
		link: '/forge',
	},
];

const background = [
	commit('d001', 'docs(seeker): write the dApp Store release runbook', '2026-08-27T07:00:00Z'),
	commit('d002', 'fix(wallet): tell the owner a wallet is unsignable', '2026-08-27T07:30:00Z'),
	commit('d003', 'test(agent-index): cover the backlog drain', '2026-08-27T08:00:00Z'),
];

describe('buildShipFeed', () => {
	const commits = [
		commit('aaa1', 'fix(forge): put every concept image provider on one shared time budget', '2026-08-27T09:00:00Z'),
		commit('bbb2', 'chore(deps): bump ws', '2026-08-27T09:10:00Z'),
		commit('ccc3', 'feat(companion): let the corner avatar deliver a message', '2026-08-26T18:00:00Z'),
		...background,
	];

	it('attaches commits to the release note they produced', () => {
		const feed = buildShipFeed({ commits, entries, repo: 'o/r', siteUrl: 'https://three.ws' });
		const release = feed.releases[0];
		expect(release.commits.map((c) => c.shortSha)).toContain('aaa1000');
		expect(release.stats.commits).toBeGreaterThan(0);
		expect(release.url).toBe(
			'https://three.ws/changelog/2026-08-27-text-to-3d-now-has-five-independent-image-sources-behind-it',
		);
	});

	it('carries a confidence and a reason on every linked commit', () => {
		const feed = buildShipFeed({ commits, entries, repo: 'o/r' });
		for (const c of feed.releases.flatMap((r) => r.commits)) {
			expect(c.confidence).toBeGreaterThan(0);
			expect(Array.isArray(c.why)).toBe(true);
			expect(c.why.length).toBeGreaterThan(0);
		}
	});

	it('groups everything no note claimed into ships', () => {
		const feed = buildShipFeed({ commits, entries, repo: 'o/r' });
		const shipShas = feed.ships.flatMap((s) => s.commits.map((c) => c.shortSha));
		const linkedShas = feed.releases.flatMap((r) => r.commits.map((c) => c.shortSha));
		expect(shipShas.length + linkedShas.length).toBe(commits.length);
		expect(shipShas.some((s) => linkedShas.includes(s))).toBe(false);
	});

	it('reports coverage, audience mix, and velocity', () => {
		const feed = buildShipFeed({ commits, entries, repo: 'o/r', now: Date.parse('2026-08-28T00:00:00Z') });
		expect(feed.stats.commits).toBe(commits.length);
		expect(feed.stats.coverage).toBeGreaterThan(0);
		expect(feed.stats.coverage).toBeLessThanOrEqual(1);
		expect(feed.stats.byAudience.holder + feed.stats.byAudience.developer + feed.stats.byAudience.internal).toBe(
			commits.length,
		);
		expect(feed.stats.velocity.map((v) => v.date)).toEqual(['2026-08-26', '2026-08-27']);
		expect(feed.stats.topAuthors[0]).toEqual({ name: 'nirholas', count: commits.length });
	});

	it('hides machinery at the holder floor and says how much it hid', () => {
		const feed = buildShipFeed({ commits, entries, repo: 'o/r', minAudience: 'holder' });
		const shown = [
			...feed.releases.flatMap((r) => r.commits),
			...feed.ships.flatMap((s) => s.commits),
		];
		expect(shown.some((c) => c.shortSha === 'bbb2000')).toBe(false);
		expect(feed.stats.hidden).toBeGreaterThan(0);
	});

	it('drops release notes from outside the commit window', () => {
		const old = { date: '2020-01-01', title: 'Ancient history', summary: 'Long gone.', tags: [] };
		const feed = buildShipFeed({ commits, entries: [...entries, old], repo: 'o/r' });
		expect(feed.releases.map((r) => r.title)).not.toContain('Ancient history');
		expect(feed.stats.entriesConsidered).toBe(2);
	});

	it('returns an empty but well-formed feed for an empty repository', () => {
		const feed = buildShipFeed({ commits: [], entries: [] });
		expect(feed.releases).toEqual([]);
		expect(feed.ships).toEqual([]);
		expect(feed.stats.commits).toBe(0);
		expect(feed.stats.coverage).toBe(0);
	});
});

describe('groupIntoShips', () => {
	it('splits bursts on a quiet gap and headlines each by its strongest commit', () => {
		const ships = groupIntoShips([
			commit('a1', 'chore: tidy an import', '2026-08-27T09:00:00Z'),
			commit('a2', 'feat(forge): add a provider rung to the painter', '2026-08-27T09:20:00Z'),
			commit('b1', 'fix(wallet): stop a double withdrawal prompt', '2026-08-27T16:00:00Z'),
		]);
		expect(ships).toHaveLength(2);
		expect(ships[0].commits).toHaveLength(1); // newest ship first
		expect(ships[1].title).toBe('Feature · forge');
		expect(ships[1].commits).toHaveLength(2);
	});
});

describe('commitsFromGitLog', () => {
	it('parses git log output into the same shape the API returns', () => {
		const record = [
			'f'.repeat(40),
			'2026-08-27T09:00:00Z',
			'2026-08-27T08:55:00Z',
			'nirholas',
			'nirholas',
			'parent1 parent2',
			'feat(forge): a thing\n\nbody',
		].join(NUL);
		const [parsed] = commitsFromGitLog(record + RS, { repo: 'o/r' });
		expect(parsed.sha).toBe('f'.repeat(40));
		expect(parsed.parents).toHaveLength(2);
		expect(parsed.commit.committer.date).toBe('2026-08-27T09:00:00Z');
		expect(parsed.html_url).toBe(`https://github.com/o/r/commit/${'f'.repeat(40)}`);
	});

	it('publishes the exact format string it expects', () => {
		expect(GIT_LOG_FORMAT).toContain('%x00');
		expect(GIT_LOG_FORMAT.endsWith('%x1e')).toBe(true);
	});
});

describe('normalizeChangelog', () => {
	it('accepts the three.ws feed shape and a bare array alike', () => {
		const wrapped = normalizeChangelog({ entries });
		const bare = normalizeChangelog(entries);
		expect(wrapped).toEqual(bare);
		expect(wrapped[0].tags).toEqual(['fix', 'infra']);
	});

	it('drops entries with no date or title rather than inventing one', () => {
		expect(normalizeChangelog([{ title: 'no date' }, { date: '2026-08-27' }, null])).toEqual([]);
	});
});
