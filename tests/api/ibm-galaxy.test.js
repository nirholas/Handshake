// Unit tests for /api/ibm/galaxy, the IBM Granite Agent Galaxy.
//
// Covers both handlers with no network and no database:
//   GET  builds the constellation from Granite embeddings, caches it keyed by a
//        fingerprint of the agent set, serves that cache on a repeat call, and
//        rebuilds on ?refresh=1.
//   POST embeds a natural-language query and ranks agents by cosine similarity.
// The cache regression this locks down: the layout used to be built from a
// SECOND read of the agent set, so an agent added between the two reads was
// embedded into the payload while the cache row carried the pre-add fingerprint,
// and the stale layout was then served as fresh until the TTL expired.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const state = {
	wxConfigured: true,
	agents: [],
	cacheRow: null,
	sqlCalls: [],
	// How many CREATE TABLE calls should reject before the DDL starts succeeding,
	// standing in for a transient database blip.
	ddlFailures: 0,
};

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({ success: true })),
		watsonxEmbedGlobal: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

// A tagged-template `sql` that answers by looking at the query text: the agent
// SELECT returns the current agent set, the cache SELECT returns the stored row,
// and the cache UPSERT records it. Every call is logged so a test can assert how
// many times the agent set was read for one request.
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		const text = strings.join(' ');
		state.sqlCalls.push(text);
		if (text.includes('FROM agent_identities')) return state.agents;
		if (text.includes('CREATE TABLE IF NOT EXISTS agent_galaxy_cache')) {
			if (state.ddlFailures > 0) {
				state.ddlFailures--;
				throw new Error('connection terminated unexpectedly');
			}
			return [];
		}
		if (text.includes('SELECT payload')) return state.cacheRow ? [state.cacheRow] : [];
		if (text.includes('INSERT INTO agent_galaxy_cache')) {
			state.cacheRow = {
				data_version: values[0],
				payload: JSON.parse(values[1]),
				computed_at: new Date().toISOString(),
			};
			return [];
		}
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/r2.js', () => ({
	publicUrl: (k) => `https://cdn.test/${k}`,
	thumbnailUrl: (k) => `https://cdn.test/${k}`,
}));

vi.mock('../../api/_lib/watsonx.js', () => ({
	watsonxConfig: vi.fn(() =>
		state.wxConfigured
			? {
					configured: true,
					url: 'https://wx',
					projectId: 'proj',
					apiVersion: '2024-05-31',
					chatModel: 'ibm/granite-3-8b-instruct',
					embedModel: 'ibm/granite-embedding-278m-multilingual',
				}
			: { configured: false },
	),
	// A deterministic 4-dim "embedding" of the query: enough for cosine ranking.
	watsonxEmbed: vi.fn(async (_cfg, { inputs }) => ({
		vectors: inputs.map(() => [1, 0, 0, 0]),
		model: 'ibm/granite-embedding-278m-multilingual',
	})),
	watsonxChatComplete: vi.fn(async () => ({
		text: 'Solana Traders',
		model: 'ibm/granite-3-8b-instruct',
	})),
}));

// Agent vectors: agent N gets a unit vector leaning on axis N % 4, so clusters
// and neighbours are stable and the query vector [1,0,0,0] has an obvious best
// match (the agents leaning on axis 0).
const vectorFor = (i) => {
	const v = [0, 0, 0, 0];
	v[i % 4] = 1;
	return v;
};

vi.mock('../../api/_lib/agent-embeddings.js', () => ({
	agentEmbedText: (a) => `${a.name} ${a.description}`.trim(),
	ensureAgentEmbeddings: vi.fn(async (_cfg, agents) => ({
		vectors: agents.map((_, i) => vectorFor(i)),
		model: 'ibm/granite-embedding-278m-multilingual',
		dims: 4,
	})),
	readAgentVectors: vi.fn(async (ids) => new Map(ids.map((id, i) => [id, vectorFor(i)]))),
}));

import { limits } from '../../api/_lib/rate-limit.js';
import { sql } from '../../api/_lib/db.js';
import { watsonxEmbed } from '../../api/_lib/watsonx.js';
import { ensureAgentEmbeddings } from '../../api/_lib/agent-embeddings.js';

const handler = (await import('../../api/ibm/galaxy.js')).default;

// ── Helpers ───────────────────────────────────────────────────────────────────
function mkAgents(n) {
	return Array.from({ length: n }, (_, i) => ({
		id: `agent-${i}`,
		name: `Agent ${i}`,
		description: `A real agent that does thing number ${i} on Solana`,
		avatar_url: null,
		profile_image_url: null,
		home_url: null,
		persona_tone_tags: null,
		updated_at: `2026-0${(i % 9) + 1}-01T00:00:00.000Z`,
		created_at: '2026-01-01T00:00:00.000Z',
	}));
}

// `rawBody` sends the exact bytes instead of JSON.stringify(body), so a test can
// post literal `null` or a bare string: valid JSON that is not an object.
function makeReq({ method = 'GET', url = '/api/ibm/galaxy', body = null, rawBody = null } = {}) {
	const payload = rawBody ?? (body ? JSON.stringify(body) : null);
	const req = payload ? Readable.from([Buffer.from(payload)]) : Readable.from([]);
	req.method = method;
	req.url = url;
	req.headers = {
		host: 'localhost',
		'content-type': 'application/json',
		origin: 'http://localhost',
	};
	return req;
}
function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}
async function invoke(opts) {
	const res = makeRes();
	await handler(makeReq(opts), res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, res };
}

const agentSelects = () => state.sqlCalls.filter((t) => t.includes('FROM agent_identities')).length;

beforeEach(() => {
	vi.clearAllMocks();
	limits.publicIp.mockResolvedValue({ success: true });
	limits.watsonxEmbedGlobal.mockResolvedValue({ success: true });
	state.wxConfigured = true;
	state.agents = mkAgents(12);
	state.cacheRow = null;
	state.sqlCalls = [];
	state.ddlFailures = 0;
});

describe('GET /api/ibm/galaxy', () => {
	it('builds a constellation with real coordinates, clusters, and neighbours', async () => {
		const { status, body } = await invoke({});
		expect(status).toBe(200);
		expect(body.available).toBe(true);
		expect(body.agents).toHaveLength(12);
		expect(body.clusters.length).toBeGreaterThan(0);
		for (const a of body.agents) {
			expect(Number.isFinite(a.x)).toBe(true);
			expect(Number.isFinite(a.y)).toBe(true);
			expect(Number.isFinite(a.z)).toBe(true);
			expect(a.neighbors.length).toBeGreaterThan(0);
			expect(a.neighbors.every((n) => n.id !== a.id)).toBe(true);
		}
		expect(body.meta.cache).toBe('miss');
		expect(body.meta.model).toBe('ibm/granite-embedding-278m-multilingual');
	});

	it('names each theme with Granite', async () => {
		const { body } = await invoke({});
		expect(body.clusters.every((c) => c.label)).toBe(true);
		expect(body.clusters.some((c) => c.labelSource === 'granite')).toBe(true);
	});

	// The regression: one read of the agent set per request, so the fingerprint
	// stored in the cache always describes the payload stored beside it.
	it('reads the agent set exactly once per build', async () => {
		await invoke({});
		expect(agentSelects()).toBe(1);
		expect(ensureAgentEmbeddings).toHaveBeenCalledTimes(1);
	});

	it('serves the cached layout on a repeat request without re-embedding', async () => {
		await invoke({});
		state.sqlCalls = [];
		vi.clearAllMocks();
		const { body, res } = await invoke({});
		expect(body.meta.cache).toBe('hit');
		expect(res.headers['x-galaxy-cache']).toBe('hit');
		expect(ensureAgentEmbeddings).not.toHaveBeenCalled();
	});

	it('rebuilds when the agent set changes', async () => {
		await invoke({});
		state.agents = mkAgents(13); // a new agent joined
		const { body } = await invoke({});
		expect(body.meta.cache).toBe('miss');
		expect(body.agents).toHaveLength(13);
	});

	it('rebuilds on ?refresh=1 even when the cache is valid', async () => {
		await invoke({});
		const { body, res } = await invoke({ url: '/api/ibm/galaxy?refresh=1' });
		expect(body.meta.cache).toBe('refresh');
		expect(res.headers['x-galaxy-cache']).toBe('refresh');
		expect(ensureAgentEmbeddings).toHaveBeenCalled();
	});

	it('reports too_few_agents instead of a broken layout', async () => {
		state.agents = mkAgents(1);
		const { status, body } = await invoke({});
		expect(status).toBe(200);
		expect(body.agents).toEqual([]);
		expect(body.meta.reason).toBe('too_few_agents');
		// An empty layout must never poison the cache.
		expect(state.sqlCalls.some((t) => t.includes('INSERT INTO agent_galaxy_cache'))).toBe(
			false,
		);
	});

	it('says so when watsonx is not configured', async () => {
		state.wxConfigured = false;
		const { status, body } = await invoke({});
		expect(status).toBe(200);
		expect(body.available).toBe(false);
		expect(body.reason).toBe('watsonx_not_configured');
		expect(sql).not.toHaveBeenCalled();
	});
});

describe('POST /api/ibm/galaxy (semantic search)', () => {
	it('ranks agents by cosine similarity to the query embedding', async () => {
		const { status, body } = await invoke({
			method: 'POST',
			body: { query: 'a witty Solana trading assistant' },
		});
		expect(status).toBe(200);
		expect(body.query).toBe('a witty Solana trading assistant');
		expect(body.results.length).toBeGreaterThan(0);
		expect(body.best.score).toBe(1); // the query vector matches axis-0 agents exactly
		const scores = body.results.map((r) => r.score);
		expect([...scores].sort((a, b) => b - a)).toEqual(scores); // descending
		expect(watsonxEmbed).toHaveBeenCalledTimes(1);
	});

	it('rejects an empty query', async () => {
		const { status, body } = await invoke({ method: 'POST', body: { query: '   ' } });
		expect(status).toBe(400);
		expect(body.error).toBe('bad_request');
	});

	// `null` and `"hi"` parse as valid JSON, so readJson hands them straight back
	// on the raw-stream path. Reading .query off a non-object used to throw a
	// TypeError that wrap() sanitized into a 500 internal_error.
	it.each([
		['null', 'null'],
		['a bare string', '"hi"'],
		['a number', '42'],
	])('rejects a JSON body that is %s with 400', async (_label, rawBody) => {
		const { status, body } = await invoke({ method: 'POST', rawBody });
		expect(status).toBe(400);
		expect(body.error).toBe('bad_request');
		expect(body.error_description).toMatch(/query is required/);
	});

	it('returns 503 when watsonx is not configured', async () => {
		state.wxConfigured = false;
		const { status, body } = await invoke({ method: 'POST', body: { query: 'anything' } });
		expect(status).toBe(503);
		expect(body.error).toBe('watsonx_not_configured');
	});

	it('returns an empty result set when there are no embeddable agents', async () => {
		state.agents = [];
		const { status, body } = await invoke({ method: 'POST', body: { query: 'anything' } });
		expect(status).toBe(200);
		expect(body.results).toEqual([]);
	});
});

// The cache table is created lazily and the promise is memoized so concurrent
// callers on a warm instance share one round-trip. Memoizing a REJECTED promise
// would pin the galaxy down for the life of the instance: every later request
// re-awaits the same failure, long after the database recovered.
describe('lazy cache-table create', () => {
	it('retries the create on the next request after a transient DB failure', async () => {
		vi.resetModules();
		const fresh = (await import('../../api/ibm/galaxy.js')).default;
		const ddlCalls = () =>
			state.sqlCalls.filter((t) =>
				t.includes('CREATE TABLE IF NOT EXISTS agent_galaxy_cache'),
			).length;

		state.ddlFailures = 1;
		const failed = makeRes();
		await fresh(makeReq({}), failed);
		expect(failed.statusCode).toBe(500);
		expect(ddlCalls()).toBe(1);

		const recovered = makeRes();
		await fresh(makeReq({}), recovered);
		expect(recovered.statusCode).toBe(200);
		expect(ddlCalls()).toBe(2);
		expect(JSON.parse(recovered.body).available).toBe(true);
	});
});

describe('guards', () => {
	it('returns 429 when the rate limit is exceeded', async () => {
		limits.publicIp.mockResolvedValue({ success: false });
		const { status, body } = await invoke({});
		expect(status).toBe(429);
		expect(body.error).toBe('rate_limited');
	});

	it('returns 429 when the global watsonx ceiling is reached', async () => {
		limits.watsonxEmbedGlobal.mockResolvedValue({ success: false });
		const { status } = await invoke({});
		expect(status).toBe(429);
	});

	it('returns 405 for unsupported methods', async () => {
		const { status } = await invoke({ method: 'DELETE' });
		expect(status).toBe(405);
	});
});
