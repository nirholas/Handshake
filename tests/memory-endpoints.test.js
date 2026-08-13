import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
const extractBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (...a) => extractBearerMock(...a),
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../api/_lib/env.js', () => ({ env: { APP_ORIGIN: 'http://localhost:3000', ISSUER: 'http://t', MCP_RESOURCE: 'http://t' } }));

const searchMemories = vi.fn();
const computeContext = vi.fn();
const buildGraph = vi.fn();
const memoriesForEntity = vi.fn();
// Mirrors the real api/_lib/memory-store.js export surface. MEMORY_TYPES in
// particular has to be here: search.js validates `type` against it, so leaving
// it out turns a 400 path into a TypeError that only fires under test.
vi.mock('../api/_lib/memory-store.js', () => ({
	searchMemories: (...a) => searchMemories(...a),
	computeContext: (...a) => computeContext(...a),
	buildGraph: (...a) => buildGraph(...a),
	memoriesForEntity: (...a) => memoriesForEntity(...a),
	decorateMemory: (row) => ({ id: row.id, tier: row.tier, pinned: row.pinned }),
	MEMORY_TIERS: ['working', 'recall', 'archival'],
	MEMORY_TYPES: ['user', 'feedback', 'project', 'reference'],
	WORKING_TOKEN_BUDGET: 2000,
}));

const { default: searchHandler } = await import('../api/memory/search.js');
const { default: curateHandler } = await import('../api/memory/curate.js');
const { default: graphHandler } = await import('../api/memory/graph.js');
const { default: contextHandler } = await import('../api/memory/context.js');

// agent_identities.id, agent_memories.id and the entity ids are all uuid
// columns, and every handler rejects anything else up front. Use real uuids so
// these tests exercise the same path production does.
const AGENT = '11111111-1111-4111-8111-111111111111';
const MEM = '22222222-2222-4222-8222-222222222222';
const MEM_2 = '33333333-3333-4333-8333-333333333333';
const ENTITY = '44444444-4444-4444-8444-444444444444';

function mkReq({ method = 'GET', url = '/api/memory/search', headers = {}, body = null } = {}) {
	return {
		method, url, headers: { ...headers },
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => { cb(buf); this._endCb?.(); });
			} else if (event === 'end') this._endCb = cb;
		},
		destroy() {},
	};
}
function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);
const post = (body) => mkReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body });

let sqlQueue = [];
beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset().mockImplementation(() => Promise.resolve(sqlQueue.length ? sqlQueue.shift() : []));
	getSessionUserMock.mockReset().mockResolvedValue(null);
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
	searchMemories.mockReset().mockResolvedValue({ results: [], provider: true, scored: 0 });
	computeContext.mockReset().mockResolvedValue({ entries: [], tokens: 0, budget: 2000, overBudget: false, counts: {} });
	buildGraph.mockReset().mockResolvedValue({ nodes: [], edges: [], stats: { entities: 0, edges: 0 } });
	memoriesForEntity.mockReset().mockResolvedValue([]);
});

describe('GET /api/memory/search', () => {
	it('anonymous → empty results, never searches', async () => {
		const res = mkRes();
		await searchHandler(mkReq({ url: `/api/memory/search?agentId=${AGENT}&q=hi` }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ results: [] });
		expect(searchMemories).not.toHaveBeenCalled();
	});

	it('400 without agentId', async () => {
		const res = mkRes();
		await searchHandler(mkReq({ url: '/api/memory/search?q=hi' }), res);
		expect(res.statusCode).toBe(400);
	});

	// A non-uuid agentId used to reach Postgres and come back as a 22P02 500.
	it('400 on a non-uuid agentId, before any query runs', async () => {
		const res = mkRes();
		await searchHandler(mkReq({ url: '/api/memory/search?agentId=a1&q=hi' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toMatch(/uuid/);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('400 on an unknown tier rather than silently searching nothing', async () => {
		const res = mkRes();
		await searchHandler(mkReq({ url: `/api/memory/search?agentId=${AGENT}&tier=working,bogus` }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toContain('bogus');
	});

	it('400 on an unknown type', async () => {
		const res = mkRes();
		await searchHandler(mkReq({ url: `/api/memory/search?agentId=${AGENT}&type=nope` }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toContain('nope');
	});

	it('owner GET searches and returns results', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlQueue.push([{ user_id: 'u1' }]); // ownership
		searchMemories.mockResolvedValue({ results: [{ id: MEM, match: 'semantic' }], provider: true, scored: 1 });
		const res = mkRes();
		await searchHandler(mkReq({ url: `/api/memory/search?agentId=${AGENT}&q=sell` }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).results).toHaveLength(1);
		expect(searchMemories).toHaveBeenCalledWith(AGENT, 'sell', expect.any(Object));
	});

	it('clamps topK and minScore into range', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlQueue.push([{ user_id: 'u1' }]);
		const res = mkRes();
		await searchHandler(mkReq({ url: `/api/memory/search?agentId=${AGENT}&q=x&topK=9999&minScore=-3` }), res);
		expect(searchMemories).toHaveBeenCalledWith(AGENT, 'x', expect.objectContaining({ topK: 50, minScore: 0 }));
	});

	it('non-owner GET → empty', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlQueue.push([{ user_id: 'someone-else' }]);
		const res = mkRes();
		await searchHandler(mkReq({ url: `/api/memory/search?agentId=${AGENT}&q=x` }), res);
		expect(parse(res)).toEqual({ results: [] });
	});
});

describe('POST /api/memory/search', () => {
	it('401 without auth', async () => {
		const res = mkRes();
		await searchHandler(post({ agentId: AGENT, query: 'x' }), res);
		expect(res.statusCode).toBe(401);
	});

	it('403 when not the owner', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlQueue.push([{ user_id: 'other' }]);
		const res = mkRes();
		await searchHandler(post({ agentId: AGENT, query: 'x' }), res);
		expect(res.statusCode).toBe(403);
	});

	it('owner POST searches with an array of tiers', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlQueue.push([{ user_id: 'u1' }]);
		const res = mkRes();
		await searchHandler(post({ agentId: AGENT, query: 'sell', tiers: ['working', 'recall'] }), res);
		expect(res.statusCode).toBe(200);
		expect(searchMemories).toHaveBeenCalledWith(AGENT, 'sell', expect.objectContaining({ tiers: ['working', 'recall'] }));
	});
});

describe('POST /api/memory/curate', () => {
	beforeEach(() => getSessionUserMock.mockResolvedValue({ id: 'u1' }));

	it('401 without auth', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'pin', memoryId: MEM }), res);
		expect(res.statusCode).toBe(401);
	});

	it('403 when not owner', async () => {
		sqlQueue.push([{ user_id: 'other' }]);
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'pin', memoryId: MEM }), res);
		expect(res.statusCode).toBe(403);
	});

	it('404 when the agent does not exist', async () => {
		sqlQueue.push([]);
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'pin', memoryId: MEM }), res);
		expect(res.statusCode).toBe(404);
	});

	it('400 on a non-uuid memoryId, before any write runs', async () => {
		sqlQueue.push([{ user_id: 'u1' }]);
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'pin', memoryId: 'not-a-uuid' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toMatch(/uuid/);
		expect(sqlMock).toHaveBeenCalledTimes(1); // the ownership lookup only
	});

	it('400 on an unknown op', async () => {
		sqlQueue.push([{ user_id: 'u1' }]);
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'obliterate', memoryId: MEM }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toContain('obliterate');
	});

	it('pin updates the memory and returns the entry', async () => {
		sqlQueue.push([{ user_id: 'u1' }]); // ownership
		sqlQueue.push([{ id: MEM, tier: 'working', pinned: true }]); // update
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'pin', memoryId: MEM }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).entry).toMatchObject({ id: MEM, pinned: true });
	});

	it('404 when the memory belongs to another agent', async () => {
		sqlQueue.push([{ user_id: 'u1' }]); // ownership
		sqlQueue.push([]);                   // agent-scoped UPDATE matched nothing
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'pin', memoryId: MEM }), res);
		expect(res.statusCode).toBe(404);
	});

	it('rejects an invalid tier', async () => {
		sqlQueue.push([{ user_id: 'u1' }]);
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'tier', memoryId: MEM, tier: 'bogus' }), res);
		expect(res.statusCode).toBe(400);
	});

	it('rejects an out-of-range salience', async () => {
		sqlQueue.push([{ user_id: 'u1' }]);
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'salience', memoryId: MEM, salience: 4 }), res);
		expect(res.statusCode).toBe(400);
	});

	it('edit requires content or tags', async () => {
		sqlQueue.push([{ user_id: 'u1' }]);
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'edit', memoryId: MEM }), res);
		expect(res.statusCode).toBe(400);
	});

	it('merge needs at least two ids', async () => {
		sqlQueue.push([{ user_id: 'u1' }]);
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'merge', memoryIds: [MEM] }), res);
		expect(res.statusCode).toBe(400);
	});

	// "merge a into a" dedupes to one id, so it must not delete the row it just wrote.
	it('merge rejects a repeated id rather than deleting the target', async () => {
		sqlQueue.push([{ user_id: 'u1' }]);
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'merge', memoryIds: [MEM, MEM] }), res);
		expect(res.statusCode).toBe(400);
	});

	it('merge folds the dupes into the target and reports the count', async () => {
		sqlQueue.push([{ user_id: 'u1' }]);                                    // ownership
		sqlQueue.push([                                                        // SELECT the ids
			{ id: MEM, content: 'keeps the ticker', tags: ['a'], salience: 0.4, type: 'reference' },
			{ id: MEM_2, content: 'a duplicate note', tags: ['b'], salience: 0.9, type: 'reference' },
		]);
		sqlQueue.push([{ id: MEM, tier: 'recall', pinned: false }]);           // UPDATE target
		sqlQueue.push([]);                                                     // DELETE dupes
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'merge', memoryIds: [MEM, MEM_2] }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ merged: 1, entry: { id: MEM } });
	});

	it('forget deletes the memory', async () => {
		sqlQueue.push([{ user_id: 'u1' }]);   // ownership
		sqlQueue.push([{ id: MEM }]);          // delete returning
		const res = mkRes();
		await curateHandler(post({ agentId: AGENT, op: 'forget', memoryId: MEM }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ ok: true, forgot: MEM });
	});
});

describe('GET /api/memory/graph', () => {
	it('owner gets the graph', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlQueue.push([{ user_id: 'u1' }]);
		buildGraph.mockResolvedValue({ nodes: [{ id: ENTITY }], edges: [], stats: { entities: 1, edges: 0 } });
		const res = mkRes();
		await graphHandler(mkReq({ url: `/api/memory/graph?agentId=${AGENT}` }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).nodes).toHaveLength(1);
	});

	it('entity drilldown returns memories', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlQueue.push([{ user_id: 'u1' }]);
		memoriesForEntity.mockResolvedValue([{ id: MEM }]);
		const res = mkRes();
		await graphHandler(mkReq({ url: `/api/memory/graph?agentId=${AGENT}&entityId=${ENTITY}` }), res);
		expect(parse(res).memories).toHaveLength(1);
		expect(memoriesForEntity).toHaveBeenCalledWith(AGENT, ENTITY);
	});

	it('anonymous → empty graph, never mines', async () => {
		const res = mkRes();
		await graphHandler(mkReq({ url: `/api/memory/graph?agentId=${AGENT}` }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ nodes: [], edges: [], stats: { entities: 0, edges: 0 } });
		expect(buildGraph).not.toHaveBeenCalled();
	});

	it('400 on a non-uuid entityId, before any query runs', async () => {
		const res = mkRes();
		await graphHandler(mkReq({ url: `/api/memory/graph?agentId=${AGENT}&entityId=nope` }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toMatch(/uuid/);
		expect(sqlMock).not.toHaveBeenCalled();
	});
});

describe('GET /api/memory/context', () => {
	it('owner gets the working context and its token budget', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlQueue.push([{ user_id: 'u1' }]);
		computeContext.mockResolvedValue({
			entries: [{ id: MEM, tier: 'working' }],
			tokens: 2400,
			budget: 2000,
			overBudget: true,
			counts: { total: 3, working: 1, recall: 2, archival: 0, embedded: 1 },
		});
		const res = mkRes();
		await contextHandler(mkReq({ url: `/api/memory/context?agentId=${AGENT}` }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ overBudget: true, tokens: 2400, budget: 2000 });
		expect(computeContext).toHaveBeenCalledWith(AGENT);
	});

	it('anonymous → zeroed context, never assembles', async () => {
		const res = mkRes();
		await contextHandler(mkReq({ url: `/api/memory/context?agentId=${AGENT}` }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ entries: [], tokens: 0, budget: 2000, overBudget: false });
		expect(computeContext).not.toHaveBeenCalled();
	});

	it('non-owner → zeroed context', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlQueue.push([{ user_id: 'other' }]);
		const res = mkRes();
		await contextHandler(mkReq({ url: `/api/memory/context?agentId=${AGENT}` }), res);
		expect(parse(res).entries).toEqual([]);
		expect(computeContext).not.toHaveBeenCalled();
	});

	it('400 without agentId', async () => {
		const res = mkRes();
		await contextHandler(mkReq({ url: '/api/memory/context' }), res);
		expect(res.statusCode).toBe(400);
	});

	it('400 on a non-uuid agentId, before any query runs', async () => {
		const res = mkRes();
		await contextHandler(mkReq({ url: '/api/memory/context?agentId=a1' }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toMatch(/uuid/);
		expect(sqlMock).not.toHaveBeenCalled();
	});
});
