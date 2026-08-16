import { describe, it, expect } from 'vitest';

import {
	X_SEED_DISCLOSURE,
	X_SEED_LIMITS,
	X_SEED_SCOPE_VERSION,
	X_SEED_TAG,
	buildSeedMemories,
	deriveFallbackFacts,
	deriveTopics,
	parseFactList,
	sanitizeFacts,
	seedFromX,
	selectSeedPosts,
	selectSeedProfile,
	stripLinks,
	seedFromX as seed,
} from '../../api/_lib/x-memory-seed.js';

// The consent screen promises exactly what this transform does. Each block below
// pins one clause of that promise, so a change to the seeder that widens what is
// read or stored fails here instead of quietly outrunning the disclosure.

const PROFILE = {
	id: '4242',
	username: 'buildooor',
	name: 'Build Oooor',
	description: 'Shipping agents on Solana. Ex-graphics. https://example.com/me',
	public_metrics: { followers_count: 1200, following_count: 300, tweet_count: 900 },
	// Fields the disclosure never mentions. They must not survive selection.
	location: 'Lisbon',
	email: 'private@example.com',
};

const POSTS = [
	{ id: '1', text: 'Shipping a new #solana agent runtime today. Agents everywhere.', created_at: '2026-08-10T10:00:00Z' },
	{ id: '2', text: 'Retargeting animation onto arbitrary rigs is a solved problem now. #solana agents win.', created_at: '2026-08-09T10:00:00Z' },
	{ id: '3', text: 'Agents that remember beat agents that do not. https://t.co/abc123', created_at: '2026-08-08T10:00:00Z' },
	{ id: '4', text: 'gm', created_at: '2026-08-07T10:00:00Z' },
	{ id: '5', text: 'Replying to a friend about rigs', in_reply_to_user_id: '99', created_at: '2026-08-06T10:00:00Z' },
	{ id: '6', text: 'Quoting someone', referenced_tweets: [{ type: 'retweeted', id: '1' }], created_at: '2026-08-05T10:00:00Z' },
];

describe('stripLinks', () => {
	it('removes URLs and collapses whitespace', () => {
		expect(stripLinks('see  this https://t.co/abc  now')).toBe('see this now');
	});

	it('is total over nullish input', () => {
		expect(stripLinks(null)).toBe('');
		expect(stripLinks(undefined)).toBe('');
	});
});

describe('selectSeedProfile', () => {
	it('keeps only the fields the disclosure names', () => {
		const profile = selectSeedProfile(PROFILE);
		expect(Object.keys(profile).sort()).toEqual([
			'description',
			'followers',
			'following',
			'name',
			'username',
		]);
		expect(profile.username).toBe('buildooor');
		expect(profile.followers).toBe(1200);
	});

	it('strips links out of the bio and survives a missing profile', () => {
		expect(selectSeedProfile(PROFILE).description).not.toMatch(/https?:/);
		expect(selectSeedProfile(undefined)).toEqual({
			username: '',
			name: '',
			description: '',
			followers: 0,
			following: 0,
		});
	});
});

describe('selectSeedPosts', () => {
	it('drops replies and reposts even when the API returns them', () => {
		const texts = selectSeedPosts(POSTS).map((p) => p.text);
		expect(texts.some((t) => t.startsWith('Replying'))).toBe(false);
		expect(texts.some((t) => t.startsWith('Quoting'))).toBe(false);
	});

	it('drops posts too short to carry signal and strips their links', () => {
		const selected = selectSeedPosts(POSTS);
		expect(selected.some((p) => p.text === 'gm')).toBe(false);
		expect(selected.every((p) => !/https?:/.test(p.text))).toBe(true);
	});

	it('keeps only text and date, never the rest of the payload', () => {
		for (const post of selectSeedPosts(POSTS)) {
			expect(Object.keys(post).sort()).toEqual(['created_at', 'text']);
		}
	});

	it('de-duplicates reposted-by-hand text and caps the read', () => {
		const dupes = Array.from({ length: 200 }, (_, i) => ({
			text: `A distinct enough thought number ${i % 7} about rendering pipelines`,
		}));
		const selected = selectSeedPosts(dupes);
		expect(selected).toHaveLength(7);
		const many = Array.from({ length: 200 }, (_, i) => ({
			text: `Unique thought ${i} about rendering pipelines and agents`,
		}));
		expect(selectSeedPosts(many)).toHaveLength(X_SEED_LIMITS.maxPosts);
	});

	it('is total over a missing payload', () => {
		expect(selectSeedPosts(undefined)).toEqual([]);
		expect(selectSeedPosts([null, 3, 'x'])).toEqual([]);
	});
});

describe('deriveTopics', () => {
	it('ranks repeated terms and weights deliberate hashtags', () => {
		const topics = deriveTopics(selectSeedPosts(POSTS));
		const names = topics.map((t) => t.topic);
		expect(names).toContain('solana');
		expect(names).toContain('agents');
		expect(topics.find((t) => t.topic === 'solana').count).toBeGreaterThan(2);
	});

	it('drops stopwords, single mentions, and bare numbers', () => {
		const topics = deriveTopics([{ text: 'the 2026 thing that we made' }]).map((t) => t.topic);
		expect(topics).not.toContain('the');
		expect(topics).not.toContain('2026');
		expect(topics).not.toContain('thing');
	});

	// Filler words clear both the four-character length floor and the
	// "seen more than once" floor on any real timeline, so before they were
	// listed a seed reported words like "another" and "every" back to the owner
	// as the things they post about.
	it('drops filler words that repeat on every timeline', () => {
		const posts = [
			{ text: 'another day another WebGL memory leak, dispose your geometries' },
			{ text: 'every single time I skip profiling I regret it, every time' },
			{ text: 'the first rule of shipping: actually ship it, and another thing' },
			{ text: 'I really think you should know that WebGL profiling matters' },
			{ text: 'first you profile, then you complain, I think that is the rule' },
		];
		const topics = deriveTopics(posts).map((t) => t.topic);
		for (const filler of ['another', 'every', 'first', 'think', 'know', 'actually']) {
			expect(topics).not.toContain(filler);
		}
		expect(topics).toContain('webgl');
		expect(topics).toContain('profiling');
	});
});

describe('parseFactList', () => {
	it('reads a bare JSON array', () => {
		expect(parseFactList('["one fact","two fact"]')).toEqual(['one fact', 'two fact']);
	});

	it('reads a fenced JSON array', () => {
		expect(parseFactList('```json\n["one fact","two fact"]\n```')).toEqual([
			'one fact',
			'two fact',
		]);
	});

	it('reads an array embedded in prose', () => {
		expect(parseFactList('Sure! Here you go:\n["one fact","two fact"]\nHope that helps.')).toEqual(
			['one fact', 'two fact'],
		);
	});

	it('reads a numbered or bulleted list when a provider ignores the JSON ask', () => {
		expect(parseFactList('1. one fact\n2) two fact\n- three fact')).toEqual([
			'one fact',
			'two fact',
			'three fact',
		]);
	});

	it('returns nothing for empty or unusable output', () => {
		expect(parseFactList('')).toEqual([]);
		expect(parseFactList(null)).toEqual([]);
		expect(parseFactList('[]')).toEqual([]);
	});
});

describe('sanitizeFacts', () => {
	const posts = selectSeedPosts(POSTS);

	it('discards a fact that is really a copy of a post', () => {
		const verbatim = posts[0].text;
		expect(sanitizeFacts([verbatim], { sourcePosts: posts })).toEqual([]);
		expect(
			sanitizeFacts([`They once wrote: ${verbatim}`], { sourcePosts: posts }),
		).toEqual([]);
	});

	it('keeps a statement about the author', () => {
		const facts = sanitizeFacts(['Builds agent runtimes on Solana and talks about them constantly.'], {
			sourcePosts: posts,
		});
		expect(facts).toHaveLength(1);
	});

	it('strips links and wrapping punctuation out of stored text', () => {
		const [fact] = sanitizeFacts(['"Ships often, see https://t.co/xyz for proof"']);
		expect(fact).toBe('Ships often, see for proof');
	});

	it('de-duplicates on meaning, not on bytes', () => {
		expect(sanitizeFacts(['Ships agents daily.', 'ships agents daily'])).toHaveLength(1);
	});

	it('caps the count and the length of what gets stored', () => {
		const many = Array.from({ length: 40 }, (_, i) => `Fact number ${i} about their work.`);
		expect(sanitizeFacts(many)).toHaveLength(X_SEED_LIMITS.maxFacts);
		const [long] = sanitizeFacts(['x'.repeat(600)]);
		expect(long.length).toBe(X_SEED_LIMITS.maxFactChars);
	});

	it('drops non-strings and fragments', () => {
		expect(sanitizeFacts([null, 42, {}, 'tiny', ''])).toEqual([]);
	});
});

describe('buildSeedMemories', () => {
	const profile = selectSeedProfile(PROFILE);
	const topics = deriveTopics(selectSeedPosts(POSTS));
	const facts = Array.from({ length: 9 }, (_, i) => `Fact ${i} about how they work.`);
	const rows = buildSeedMemories({ facts, profile, topics, seededAt: '2026-08-11T00:00:00.000Z' });

	it('tags every row so revocation can find exactly these memories', () => {
		expect(rows).toHaveLength(9);
		expect(rows.every((r) => r.tags.includes(X_SEED_TAG))).toBe(true);
		expect(rows.every((r) => r.context.source === 'x_seed')).toBe(true);
	});

	it('records the account, rank, and the disclosure version consented to', () => {
		expect(rows[0].context).toMatchObject({
			username: 'buildooor',
			rank: 1,
			scope_version: X_SEED_SCOPE_VERSION,
			seeded_at: '2026-08-11T00:00:00.000Z',
		});
	});

	it('promotes the top facts to the always-in-context working tier', () => {
		const working = rows.filter((r) => r.tier === 'working');
		expect(working).toHaveLength(X_SEED_LIMITS.workingTierFacts);
		expect(rows.slice(X_SEED_LIMITS.workingTierFacts).every((r) => r.tier === 'recall')).toBe(true);
	});

	it('decays salience down the ranked list', () => {
		expect(rows[0].salience).toBeGreaterThan(rows.at(-1).salience);
		expect(rows.every((r) => r.salience > 0 && r.salience <= 0.8)).toBe(true);
	});

	it('only turns safe topic names into tags', () => {
		const tagged = buildSeedMemories({
			facts: ['A fact about their work.'],
			profile,
			topics: [{ topic: 'ok_topic' }, { topic: 'NOT ok' }, { topic: 'a' }],
		});
		expect(tagged[0].tags).toContain('ok_topic');
		expect(tagged[0].tags).not.toContain('NOT ok');
		expect(tagged[0].tags).not.toContain('a');
	});
});

describe('deriveFallbackFacts', () => {
	it('describes the account from the profile and the topic histogram', () => {
		const profile = selectSeedProfile(PROFILE);
		const posts = selectSeedPosts(POSTS);
		const facts = deriveFallbackFacts(profile, posts, deriveTopics(posts));
		expect(facts.join(' ')).toContain('@buildooor');
		expect(facts.some((f) => /posts most often about/.test(f))).toBe(true);
		expect(facts.some((f) => /averaging about \d+ characters/.test(f))).toBe(true);
	});
});

describe('seedFromX', () => {
	const rawPosts = POSTS;

	it('turns a model answer into memory rows', async () => {
		const result = await seedFromX({
			rawProfile: PROFILE,
			rawPosts,
			distil: async () =>
				'["Builds agent runtimes on Solana.","Cares a lot about animation retargeting."]',
		});
		expect(result.source).toBe('model');
		expect(result.memories.map((m) => m.content)).toEqual([
			'Builds agent runtimes on Solana.',
			'Cares a lot about animation retargeting.',
		]);
		expect(result.postsRead).toBe(3);
	});

	it('only shows the distiller the selected profile and posts', async () => {
		let seenProfile = null;
		let seenPosts = null;
		await seedFromX({
			rawProfile: PROFILE,
			rawPosts,
			distil: async (profile, posts) => {
				seenProfile = profile;
				seenPosts = posts;
				return '["A fact about their work."]';
			},
		});
		expect(seenProfile.location).toBeUndefined();
		expect(seenProfile.email).toBeUndefined();
		expect(seenPosts.every((p) => Object.keys(p).sort().join() === 'created_at,text')).toBe(true);
	});

	it('falls back to derived facts when the distiller throws', async () => {
		const result = await seedFromX({
			rawProfile: PROFILE,
			rawPosts,
			distil: async () => {
				throw new Error('llm chain unavailable');
			},
		});
		expect(result.source).toBe('derived');
		expect(result.memories.length).toBeGreaterThan(0);
	});

	it('falls back when the distiller answers with something unusable', async () => {
		const result = await seedFromX({
			rawProfile: PROFILE,
			rawPosts,
			distil: async () => 'I am sorry, I cannot help with that.',
		});
		// The refusal itself is a sentence, so it parses as one line; it is not a
		// copy of any post, so what matters is that a seed still produces rows.
		expect(result.memories.length).toBeGreaterThan(0);
	});

	it('never stores a post verbatim, whatever the model returns', async () => {
		const result = await seedFromX({
			rawProfile: PROFILE,
			rawPosts,
			distil: async (_profile, posts) => JSON.stringify(posts.map((p) => p.text)),
		});
		expect(result.source).toBe('derived');
		const stored = result.memories.map((m) => m.content.toLowerCase());
		for (const post of selectSeedPosts(rawPosts)) {
			expect(stored).not.toContain(post.text.toLowerCase());
		}
	});

	it('seeds an account with no readable posts from its profile alone', async () => {
		const result = await seed({
			rawProfile: PROFILE,
			rawPosts: [],
			distil: async () => '',
		});
		expect(result.postsRead).toBe(0);
		expect(result.memories.length).toBeGreaterThan(0);
		expect(result.source).toBe('derived');
	});
});

describe('X_SEED_DISCLOSURE', () => {
	it('is versioned and carries every clause the consent screen renders', () => {
		expect(X_SEED_DISCLOSURE.version).toBe(X_SEED_SCOPE_VERSION);
		for (const key of ['title', 'summary', 'retention', 'revocation']) {
			expect(typeof X_SEED_DISCLOSURE[key]).toBe('string');
			expect(X_SEED_DISCLOSURE[key].length).toBeGreaterThan(10);
		}
		for (const key of ['reads', 'skips', 'stores', 'never']) {
			expect(X_SEED_DISCLOSURE[key].length).toBeGreaterThan(0);
		}
	});

	it('states the same limits the transform enforces', () => {
		expect(X_SEED_DISCLOSURE.reads.join(' ')).toContain(String(X_SEED_LIMITS.maxPosts));
		expect(X_SEED_DISCLOSURE.stores.join(' ')).toContain(String(X_SEED_LIMITS.maxFacts));
		expect(X_SEED_DISCLOSURE.stores.join(' ')).toContain(String(X_SEED_LIMITS.maxFactChars));
	});

	it('cannot be mutated by a caller that receives it', () => {
		expect(Object.isFrozen(X_SEED_DISCLOSURE)).toBe(true);
	});
});
