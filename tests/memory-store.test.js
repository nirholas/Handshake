import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────
// `sql` is a tagged template — mock it as a fn returning queued FIFO results.
const sqlMock = vi.fn();
// `sqlValues` stays real: it is what builds the multi-row VALUES fragment the
// entity upsert binds, so a stub would hide exactly the shape those tests read.
// It needs no database (it only composes strings + params), and db.js reaches
// for DATABASE_URL lazily, so importing the actual module here is free.
vi.mock('../api/_lib/db.js', async () => {
	const actual = await vi.importActual('../api/_lib/db.js');
	return { sqlValues: actual.sqlValues, sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

// Control embedding configuration / vectors per test.
const embeddingsConfigured = vi.fn(() => true);
const defaultIngestEmbedderTag = vi.fn(() => 'nvidia/nv-embedqa-e5-v5@1024');
const embedPassages = vi.fn();
const scoreRowsBySpace = vi.fn();
vi.mock('../api/_lib/embeddings.js', () => ({
	embeddingsConfigured: (...a) => embeddingsConfigured(...a),
	defaultIngestEmbedderTag: (...a) => defaultIngestEmbedderTag(...a),
	embedPassages: (...a) => embedPassages(...a),
	scoreRowsBySpace: (...a) => scoreRowsBySpace(...a),
}));

const {
	searchMemories,
	computeContext,
	buildGraph,
	ensureEntities,
	estimateTokens,
	defaultTier,
	WORKING_TOKEN_BUDGET,
} = await import('../api/_lib/memory-store.js');

let sqlQueue = [];
beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset();
	sqlMock.mockImplementation(() => {
		if (!sqlQueue.length) throw new Error('unexpected sql call — no queued response');
		return Promise.resolve(sqlQueue.shift());
	});
	embeddingsConfigured.mockReturnValue(true);
	defaultIngestEmbedderTag.mockReturnValue('nvidia/nv-embedqa-e5-v5@1024');
	embedPassages.mockReset();
	scoreRowsBySpace.mockReset();
});
function queueSql(...r) { sqlQueue.push(...r); }

describe('estimateTokens / defaultTier', () => {
	it('estimates ~4 chars per token', () => {
		expect(estimateTokens('12345678')).toBe(2);
	});
	it('assigns working when pinned, archival for low-salience reference', () => {
		expect(defaultTier({ pinned: true })).toBe('working');
		expect(defaultTier({ type: 'reference', salience: 0.2 })).toBe('archival');
		expect(defaultTier({ salience: 0.6, type: 'project' })).toBe('recall');
	});
});

describe('searchMemories', () => {
	it('ranks by real cosine score and bumps access', async () => {
		// 1) ensureEmbeddings: no rows need embedding
		queueSql([]);
		// 2) candidate rows fetch
		queueSql([
			{ id: 'a', type: 'project', content: 'stop loss rule', tags: [], context: {}, salience: 0.5, tier: 'recall', embedder: 'nvidia/nv-embedqa-e5-v5@1024', embedding: [0.1, 0.2], created_at: new Date() },
			{ id: 'b', type: 'project', content: 'unrelated', tags: [], context: {}, salience: 0.5, tier: 'recall', embedder: 'nvidia/nv-embedqa-e5-v5@1024', embedding: [0.9, 0.1], created_at: new Date() },
		]);
		// 3) access bump UPDATE (fire-and-forget — still consumes a queued result)
		queueSql([]);

		scoreRowsBySpace.mockResolvedValue({
			scored: [
				{ id: 'a', type: 'project', content: 'stop loss rule', tags: [], context: {}, salience: 0.5, tier: 'recall', created_at: new Date(), score: 0.91 },
				{ id: 'b', type: 'project', content: 'unrelated', tags: [], context: {}, salience: 0.5, tier: 'recall', created_at: new Date(), score: 0.12 },
			],
			needsReembed: [],
		});

		const out = await searchMemories('agent1', 'when do I sell', { topK: 5, minScore: 0.5 });
		expect(out.provider).toBe(true);
		expect(out.results).toHaveLength(1); // only 'a' clears minScore
		expect(out.results[0].id).toBe('a');
		expect(out.results[0].match).toBe('semantic');
		expect(out.results[0].score).toBeCloseTo(0.91, 2);
	});

	it('falls back to substring + salience when no provider', async () => {
		embeddingsConfigured.mockReturnValue(false);
		// ensureEmbeddings short-circuits (no sql). Then candidate fetch:
		queueSql([
			{ id: 'a', type: 'project', content: 'remember the watchlist', tags: [], context: {}, salience: 0.8, tier: 'recall', embedder: null, embedding: null, created_at: new Date() },
			{ id: 'b', type: 'project', content: 'nothing', tags: [], context: {}, salience: 0.9, tier: 'recall', embedder: null, embedding: null, created_at: new Date() },
		]);
		// access bump
		queueSql([]);

		const out = await searchMemories('agent1', 'watchlist', { topK: 5 });
		expect(out.provider).toBe(false);
		expect(out.results).toHaveLength(1);
		expect(out.results[0].id).toBe('a');
		expect(out.results[0].match).toBe('lexical');
	});

	it('returns empty for a blank query without touching the db', async () => {
		const out = await searchMemories('agent1', '   ', {});
		expect(out.results).toEqual([]);
		expect(sqlMock).not.toHaveBeenCalled();
	});
});

describe('computeContext', () => {
	it('sums tokens of the working set and flags over-budget', async () => {
		const big = 'x'.repeat(WORKING_TOKEN_BUDGET * 4 + 40); // > budget tokens
		queueSql([
			{ id: 'w', type: 'user', content: big, tags: [], context: {}, salience: 1, tier: 'working', pinned: true, created_at: new Date() },
		]);
		queueSql([{ total: 3, working: 1, recall: 1, archival: 1, embedded: 1 }]);

		const ctx = await computeContext('agent1');
		expect(ctx.entries).toHaveLength(1);
		expect(ctx.budget).toBe(WORKING_TOKEN_BUDGET);
		expect(ctx.overBudget).toBe(true);
		expect(ctx.counts.total).toBe(3);
	});
});

describe('buildGraph', () => {
	it('derives co-occurrence edges from shared memories', async () => {
		// ensureEntities: no unprocessed rows
		queueSql([]);
		// entities
		queueSql([
			{ id: 'e1', kind: 'mint', label: 'MintA', normalized: 'minta', salience: 0.6, mention_count: 3, first_seen_at: new Date(), last_seen_at: new Date(), meta: {} },
			{ id: 'e2', kind: 'ticker', label: 'AAA', normalized: 'aaa', salience: 0.6, mention_count: 2, first_seen_at: new Date(), last_seen_at: new Date(), meta: {} },
		]);
		// links — both entities appear in memory m1 → one edge
		queueSql([
			{ entity_id: 'e1', memory_id: 'm1' },
			{ entity_id: 'e2', memory_id: 'm1' },
		]);

		const g = await buildGraph('agent1');
		expect(g.nodes).toHaveLength(2);
		expect(g.edges).toHaveLength(1);
		expect(g.edges[0]).toMatchObject({ weight: 1 });
		const pair = [g.edges[0].source, g.edges[0].target].sort();
		expect(pair).toEqual(['e1', 'e2']);
	});

	it('returns an empty graph when there are no entities', async () => {
		queueSql([]); // ensureEntities
		queueSql([]); // entities
		const g = await buildGraph('agent1');
		expect(g).toEqual({ nodes: [], edges: [], stats: { entities: 0, edges: 0 } });
	});
});

// The lazy mining pass every graph read runs first. Its writes use the
// `FROM ( VALUES … ) AS v(…)` shape, and that shape is where the whole feature
// died: a parameter inside a standalone VALUES list has no target column to
// infer a type from, so Postgres resolves it to text (see
// tests/db-sql-compose.test.js, where the driver binds every param as a string), and
// text is not assignable to a uuid column. The upsert raised
// `column "agent_id" is of type uuid but expression is of type text` on every
// call, ensureEntities caught it and returned {processed: 0}, and so no entity
// row was ever written and every agent's graph came back permanently empty
// while nothing 500'd. Verified against a real Postgres before the fix landed.
describe('ensureEntities', () => {
	/** Reassemble the SQL text of the nth `sql` call from its template strings. */
	function queryText(callIndex) {
		return sqlMock.mock.calls[callIndex][0].join(' ');
	}

	it('casts every uuid-bound column out of the untyped VALUES list', async () => {
		queueSql([
			{ id: 'm1', content: 'Never risk more than 2% per trade', tags: ['strategy'], context: {} },
		]);
		queueSql([
			{ id: 'ent-strategy', kind: 'strategy', normalized: 'never risk more than 2% per trade' },
			{ id: 'ent-topic', kind: 'topic', normalized: 'strategy' },
		]);
		queueSql([]); // link insert
		queueSql([]); // entities_extracted update

		const out = await ensureEntities('11111111-1111-4111-8111-111111111111');
		expect(out).toEqual({ processed: 1, remaining: 0 });

		const upsert = queryText(1);
		expect(upsert).toContain('INSERT INTO agent_memory_entities');
		expect(upsert).toContain('v.agent_id::uuid');

		const links = queryText(2);
		expect(links).toContain('INSERT INTO agent_memory_entity_links');
		expect(links).toContain('v.entity_id::uuid');
		expect(links).toContain('v.memory_id::uuid');
	});

	it('links a memory to every entity mined from it and marks it processed', async () => {
		queueSql([
			{ id: 'm1', content: 'Never risk more than 2% per trade', tags: ['strategy'], context: {} },
		]);
		queueSql([
			{ id: 'ent-strategy', kind: 'strategy', normalized: 'never risk more than 2% per trade' },
			{ id: 'ent-topic', kind: 'topic', normalized: 'strategy' },
		]);
		queueSql([]);
		queueSql([]);

		await ensureEntities('11111111-1111-4111-8111-111111111111');

		// The link insert binds (entity_id, memory_id) pairs, two per memory here:
		// the 'strategy' node the text mined and the 'strategy' topic from the tag.
		const linkParams = sqlMock.mock.calls[2].slice(1).flatMap((v) => v?.values ?? []);
		expect(linkParams).toEqual(['ent-topic', 'm1', 'ent-strategy', 'm1']);
	});

	it('still marks a memory processed when it mines no entities', async () => {
		queueSql([{ id: 'm1', content: 'nothing notable here', tags: [], context: {} }]);
		queueSql([]); // the entities_extracted update
		const out = await ensureEntities('11111111-1111-4111-8111-111111111111');
		expect(out).toEqual({ processed: 1, remaining: 0 });
		expect(queryText(1)).toContain('SET entities_extracted = true');
	});
});
