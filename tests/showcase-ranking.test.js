import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CATEGORIES, GRAVITY, SORTS, isCategory, mapEntry, trendingScore } from '../api/_lib/showcase-store.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);

function at(daysAgo) {
	return new Date(NOW - daysAgo * DAY).toISOString();
}

describe('spotlight trending score', () => {
	it('matches the published formula exactly', () => {
		// The doc and the STRUCTURE row both quote (votes + 1) / (age_days + 1) ^ 1.2.
		// If this drifts, one of the three is lying to a reader.
		const score = trendingScore({ voteCount: 7, createdAt: at(3), now: NOW });
		expect(score).toBeCloseTo(8 / Math.pow(4, GRAVITY), 10);
	});

	it('keeps a brand-new entry with no votes above a month-old entry with a few', () => {
		const fresh = trendingScore({ voteCount: 0, createdAt: at(0), now: NOW });
		const stale = trendingScore({ voteCount: 2, createdAt: at(30), now: NOW });
		expect(fresh).toBeGreaterThan(stale);
	});

	// This is the property the hour-scaled Hacker News curve fails at this
	// surface's volume: it decays so fast that any fresh empty entry outranks a
	// week-old entry everyone liked, which turns trending into newest.
	it('keeps a week-old entry with real support above a fresh empty one', () => {
		const fresh = trendingScore({ voteCount: 0, createdAt: at(0), now: NOW });
		const loved = trendingScore({ voteCount: 20, createdAt: at(7), now: NOW });
		expect(loved).toBeGreaterThan(fresh);
	});

	it('still lets recency beat a stale favourite eventually', () => {
		const fresh = trendingScore({ voteCount: 0, createdAt: at(0), now: NOW });
		const old = trendingScore({ voteCount: 20, createdAt: at(60), now: NOW });
		expect(fresh).toBeGreaterThan(old);
	});

	it('leaves a day-old entry within reach of a fresh one', () => {
		const fresh = trendingScore({ voteCount: 0, createdAt: at(0), now: NOW });
		const day = trendingScore({ voteCount: 0, createdAt: at(1), now: NOW });
		const ratio = day / fresh;
		expect(ratio).toBeGreaterThan(0.4);
		expect(ratio).toBeLessThan(0.5);
	});

	it('treats a future or unparseable timestamp as age zero rather than NaN', () => {
		expect(trendingScore({ voteCount: 1, createdAt: at(-5), now: NOW })).toBeCloseTo(2, 10);
		expect(Number.isFinite(trendingScore({ voteCount: 1, createdAt: 'not a date', now: NOW }))).toBe(true);
	});
});

describe('spotlight SQL and JS agree', () => {
	it('computes the same expression in the ORDER BY as trendingScore does', () => {
		const source = readFileSync(new URL('../api/_lib/showcase-store.js', import.meta.url), 'utf8');
		// The ranking exists twice by necessity (Postgres orders the page, JS
		// reports the score on each row). Pin the SQL shape so a change to one
		// without the other fails here instead of silently reordering the page.
		expect(source).toMatch(/\(coalesce\(v\.n, 0\) \+ 1\)::numeric/);
		expect(source).toMatch(/power\(extract\(epoch from \(now\(\) - s\.created_at\)\)::numeric \/ 86400\.0 \+ 1, \$\{GRAVITY\}::numeric\)/);
	});
});

describe('spotlight categories', () => {
	it('exposes a stable slug set the API validates against', () => {
		expect(CATEGORIES.length).toBeGreaterThan(0);
		for (const c of CATEGORIES) {
			expect(c.slug).toMatch(/^[a-z]+$/);
			expect(c.label.length).toBeGreaterThan(0);
			expect(isCategory(c.slug)).toBe(true);
		}
	});

	it('rejects anything not in the set, case-insensitively', () => {
		expect(isCategory('TRADING')).toBe(true);
		expect(isCategory('bogus')).toBe(false);
		expect(isCategory('')).toBe(false);
		expect(isCategory(null)).toBe(false);
	});

	it('offers exactly the three sorts the page renders', () => {
		expect([...SORTS].sort()).toEqual(['new', 'top', 'trending']);
	});
});

describe('spotlight row mapping', () => {
	const row = {
		id: 'e1',
		title: 'A title',
		tagline: 'A tagline long enough to be real',
		story: null,
		demo_url: null,
		category: 'research',
		tags: ['on-chain'],
		source: 'curated',
		featured_at: null,
		view_count: 3,
		created_at: at(2),
		agent_id: 'a1',
		agent_name: 'Nova',
		agent_description: 'does things',
		agent_skills: ['think'],
		agent_meta: {},
		erc8004_agent_id: null,
		agent_created_at: at(500),
		avatar_thumbnail_key: 'thumb/x.png',
		avatar_storage_key: 'u/x.glb',
		avatar_visibility: 'private',
		builder_display_name: 'Ada',
		builder_username: null,
		vote_count: 4,
		chat_count: 9,
		action_count: 0,
		voted_by_me: false,
		editable_by_me: false,
	};

	it('never emits a URL for a private avatar', () => {
		const entry = mapEntry(row, { now: NOW });
		expect(entry.agent.thumbnail).toBeNull();
		expect(entry.agent.glb_url).toBeNull();
	});

	it('credits a builder without a username but gives no dead profile link', () => {
		const entry = mapEntry(row, { now: NOW });
		expect(entry.builder).toEqual({ name: 'Ada', username: null, profile_url: null });
	});

	it('reports the same score the ranking uses', () => {
		const entry = mapEntry(row, { now: NOW });
		expect(entry.trending_score).toBeCloseTo(trendingScore({ voteCount: 4, createdAt: row.created_at, now: NOW }), 6);
	});

	it('marks an on-chain agent from any of the identity fields', () => {
		expect(mapEntry(row, { now: NOW }).agent.is_registered).toBe(false);
		expect(mapEntry({ ...row, erc8004_agent_id: 12n }, { now: NOW }).agent.is_registered).toBe(true);
		expect(
			mapEntry({ ...row, agent_meta: { onchain: { network: 'mainnet' } } }, { now: NOW }).agent.is_registered,
		).toBe(true);
	});
});
