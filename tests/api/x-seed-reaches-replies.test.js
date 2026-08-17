// The seeded-memory promise, pinned end to end.
//
// The X consent screen tells an owner that after they agree, the agent's next
// replies speak from the distilled facts. Three modules have to agree for that
// to be true, and nothing forced them to:
//
//   api/_lib/x-memory-seed.js   decides the tier each seeded row is written at,
//   api/_lib/memory-store.js    decides which tiers are always paged into a
//                               reply (computeContext), and
//   api/chat.js                 renders those entries into the system prompt.
//
// Each was free to move on its own: rename the tier, narrow the predicate, drop
// the prompt block, and the consent screen would keep making a promise the
// pipeline no longer keeps, silently and with every test still green. This file
// runs all three for real against one seed and asserts a fact distilled from a
// post reaches the text the model is given.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const AGENT = '11111111-2222-4333-8444-555555555555';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', async () => {
	const actual = await vi.importActual('../../api/_lib/db.js');
	return {
		sqlValues: actual.sqlValues,
		sql: sqlMock,
		isDbUnavailableError: () => false,
		isDbCapacityError: () => false,
	};
});

vi.mock('../../api/_lib/embeddings.js', () => ({
	embeddingsConfigured: () => false,
	defaultIngestEmbedderTag: () => null,
	embedPassages: vi.fn(),
	scoreRowsBySpace: vi.fn(),
}));

const { buildSeedMemories, X_SEED_LIMITS, X_SEED_TAG } = await import(
	'../../api/_lib/x-memory-seed.js'
);
const { computeContext } = await import('../../api/_lib/memory-store.js');
const { buildSystemPrompt } = await import('../../api/chat.js');

const FACTS = [
	'Builds avatar retargeting tooling and cares most about how legs land.',
	'Treats settlement latency on Solana as the core of a payments product.',
	'Prefers deleting code to adding it.',
	'Writes short, declarative posts with no hedging.',
	'Runs an open changelog and ships in public.',
	'Reads graphics papers on weekends.',
	'Keeps a strong opinion that documentation is part of a feature.',
];

// The rows the seeder actually writes, given as a real seed would build them.
const seededRows = buildSeedMemories({
	facts: FACTS,
	profile: { username: 'qauser', name: 'QA User' },
	topics: [{ topic: 'avatars', count: 4 }],
	source: 'model',
	seededAt: '2026-08-17T00:00:00.000Z',
});

// A stand-in for `agent_memories` that applies computeContext's own predicate
// rather than a restatement of it: the query text is read, so narrowing the
// predicate in memory-store.js changes what this returns.
function tableRows() {
	return seededRows.map((m, i) => ({
		id: `mem-${i + 1}`,
		agent_id: AGENT,
		type: m.type,
		content: m.content,
		tags: m.tags,
		context: m.context,
		salience: m.salience,
		tier: m.tier,
		pinned: false,
		embedder: null,
		embedding: null,
		access_count: 0,
		is_public: false,
		created_at: '2026-08-17T00:00:00.000Z',
		updated_at: '2026-08-17T00:00:00.000Z',
		last_accessed_at: null,
		expires_at: null,
	}));
}

beforeEach(() => {
	sqlMock.mockReset();
	sqlMock.mockImplementation((strings) => {
		const q = (Array.isArray(strings) ? strings.join('?') : String(strings))
			.replace(/\s+/g, ' ')
			.trim();
		const rows = tableRows();
		if (/COUNT\(\*\)::int AS total/i.test(q)) {
			return Promise.resolve([
				{
					total: rows.length,
					working: rows.filter((r) => r.tier === 'working').length,
					recall: rows.filter((r) => r.tier === 'recall').length,
					archival: 0,
					embedded: 0,
				},
			]);
		}
		// computeContext's predicate, evaluated instead of assumed.
		const pinnedOrWorking = /pinned = true OR tier = 'working'/i.test(q);
		return Promise.resolve(pinnedOrWorking ? rows.filter((r) => r.pinned || r.tier === 'working') : rows);
	});
});

describe('a seeded X memory reaches the reply the model writes', () => {
	it('lands the top facts in the always-in-context set the chat path loads', async () => {
		const ctx = await computeContext(AGENT);
		const contents = ctx.entries.map((e) => e.content);

		expect(ctx.entries).toHaveLength(X_SEED_LIMITS.workingTierFacts);
		expect(contents).toContain(FACTS[0]);
		// Ranked: the highest-salience fact leads the context the model sees.
		expect(contents[0]).toBe(FACTS[0]);
		// And they are the seeded rows, identifiable for revocation.
		for (const entry of ctx.entries) {
			expect(entry.tags).toContain(X_SEED_TAG);
			expect(entry.context.source).toBe('x_seed');
		}
	});

	it('renders those facts into the system prompt the model is given', async () => {
		const ctx = await computeContext(AGENT);
		const recalled = ctx.entries.map((m) => ({
			id: m.id,
			type: m.type,
			tier: m.tier,
			salience: m.salience,
			snippet: String(m.content).slice(0, 160),
			match: 'context',
		}));

		const prompt = buildSystemPrompt({}, 'You are QA Agent.', recalled, []);

		expect(prompt.text).toContain(FACTS[0]);
		expect(prompt.text).toContain(FACTS[1]);
		expect(prompt.text).toMatch(/What you remember/);
		// Recalled memories are the per-message half of the prompt: they must stay
		// out of the byte-identical `stable` block, or the Anthropic prompt cache
		// would serve one conversation's memories to the next.
		expect(prompt.volatile).toContain(FACTS[0]);
		expect(prompt.stable).not.toContain(FACTS[0]);
	});

	it('keeps a seed with no facts out of the prompt rather than emitting an empty block', () => {
		const prompt = buildSystemPrompt({}, 'You are QA Agent.', [], []);
		expect(prompt.text).not.toMatch(/What you remember/);
	});

	it('carries the lower-ranked facts at a tier search can still reach', () => {
		const recallTier = seededRows.slice(X_SEED_LIMITS.workingTierFacts);
		expect(recallTier.length).toBeGreaterThan(0);
		for (const row of recallTier) expect(row.tier).toBe('recall');
	});
});
