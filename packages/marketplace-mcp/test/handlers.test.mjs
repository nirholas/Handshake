// Handler behavior for @three-ws/marketplace-mcp: request building, response
// shaping, and error normalization. Global fetch is stubbed for every test —
// nothing here touches the network.
//
// Env is pinned BEFORE the dynamic imports because src/config.js reads
// process.env at module load.
//
// Run: node --test packages/marketplace-mcp/test/handlers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.THREE_WS_BASE = 'https://market.test/';
delete process.env.THREE_WS_TIMEOUT_MS;

const { def: browseAgents } = await import('../src/tools/browse-agents.js');
const { def: agentDetail } = await import('../src/tools/agent-detail.js');
const { def: agentCategories } = await import('../src/tools/agent-categories.js');
const { def: browseSkills } = await import('../src/tools/browse-skills.js');
const { def: skillCategories } = await import('../src/tools/skill-categories.js');
const { apiRequest } = await import('../src/lib/api.js');
const { THREE_WS_BASE } = await import('../src/config.js');
const { buildServer } = await import('../src/index.js');

// Swap globalThis.fetch for the duration of fn, always restoring it.
async function withFetch(stub, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = stub;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function recordingFetch(body, log, status = 200) {
	return async (url, init) => {
		log.push({ url: String(url), init });
		return jsonResponse(body, status);
	};
}

test('config strips trailing slashes off THREE_WS_BASE', () => {
	assert.equal(THREE_WS_BASE, 'https://market.test');
});

// ── browse_agents ─────────────────────────────────────────────────────────

test('browse_agents queries /api/marketplace/agents with exactly the given filters', async () => {
	const log = [];
	const payload = { data: { items: [{ id: 'a1', name: 'Coder' }], next_cursor: 'c2' } };
	const out = await withFetch(recordingFetch(payload, log), () =>
		browseAgents.handler({ category: 'programming', q: 'refactor', sort: 'popular', limit: 12, cursor: 'c1' }),
	);
	const url = new URL(log[0].url);
	assert.equal(url.origin + url.pathname, 'https://market.test/api/marketplace/agents');
	assert.equal(url.searchParams.get('category'), 'programming');
	assert.equal(url.searchParams.get('q'), 'refactor');
	assert.equal(url.searchParams.get('sort'), 'popular');
	assert.equal(url.searchParams.get('limit'), '12');
	assert.equal(url.searchParams.get('cursor'), 'c1');
	assert.deepEqual(out, { ok: true, items: [{ id: 'a1', name: 'Coder' }], next_cursor: 'c2' });
});

test('browse_agents omits unset filters from the query string entirely', async () => {
	const log = [];
	await withFetch(recordingFetch({ data: { items: [] } }, log), () => browseAgents.handler({}));
	const url = new URL(log[0].url);
	assert.equal([...url.searchParams.keys()].length, 0, 'no filter → no query params');
});

test('browse_agents shapes a malformed upstream body into an empty, well-typed page', async () => {
	for (const body of [{}, { data: {} }, { data: { items: 'not-an-array' } }]) {
		const out = await withFetch(async () => jsonResponse(body), () => browseAgents.handler({}));
		assert.deepEqual(out, { ok: true, items: [], next_cursor: null });
	}
});

// ── agent_detail ──────────────────────────────────────────────────────────

test('agent_detail trims the id and URL-encodes it into the path', async () => {
	const log = [];
	const payload = { data: { agent: { id: 'abc/1', name: 'Slashy' } } };
	const out = await withFetch(recordingFetch(payload, log), () =>
		agentDetail.handler({ id: '  abc/1  ' }),
	);
	assert.equal(new URL(log[0].url).pathname, '/api/marketplace/agents/abc%2F1');
	assert.deepEqual(out, { ok: true, agent: { id: 'abc/1', name: 'Slashy' } });
});

test('agent_detail raises not_found (404) when the response carries no agent', async () => {
	await withFetch(async () => jsonResponse({ data: {} }), () =>
		assert.rejects(agentDetail.handler({ id: 'missing-id' }), (err) => {
			assert.equal(err.code, 'not_found');
			assert.equal(err.status, 404);
			assert.ok(err.message.includes('missing-id'));
			return true;
		}),
	);
});

// ── categories + skills ───────────────────────────────────────────────────

test('agent_categories returns total and categories, defaulting when absent', async () => {
	const log = [];
	const payload = { data: { total: 42, categories: [{ slug: 'programming', count: 7 }] } };
	const out = await withFetch(recordingFetch(payload, log), () => agentCategories.handler());
	assert.equal(new URL(log[0].url).pathname, '/api/marketplace/categories');
	assert.deepEqual(out, { ok: true, total: 42, categories: [{ slug: 'programming', count: 7 }] });

	const empty = await withFetch(async () => jsonResponse({}), () => agentCategories.handler());
	assert.deepEqual(empty, { ok: true, total: 0, categories: [] });
});

test('browse_skills queries /api/skills and shapes skills + next_cursor', async () => {
	const log = [];
	const payload = { skills: [{ id: 's1', slug: 'summarize' }], next_cursor: 'n1' };
	const out = await withFetch(recordingFetch(payload, log), () =>
		browseSkills.handler({ q: 'summarize', category: 'general', sort: 'new', limit: 5 }),
	);
	const url = new URL(log[0].url);
	assert.equal(url.pathname, '/api/skills');
	assert.equal(url.searchParams.get('q'), 'summarize');
	assert.equal(url.searchParams.get('category'), 'general');
	assert.equal(url.searchParams.get('sort'), 'new');
	assert.equal(url.searchParams.get('limit'), '5');
	assert.deepEqual(out, { ok: true, skills: [{ id: 's1', slug: 'summarize' }], next_cursor: 'n1' });
});

test('browse_skills and skill_categories tolerate missing arrays in the body', async () => {
	const skills = await withFetch(async () => jsonResponse({}), () => browseSkills.handler({}));
	assert.deepEqual(skills, { ok: true, skills: [], next_cursor: null });

	const cats = await withFetch(async () => jsonResponse({ categories: 'nope' }), () =>
		skillCategories.handler(),
	);
	assert.deepEqual(cats, { ok: true, categories: [] });
});

test('skill_categories hits /api/skills/categories and passes categories through', async () => {
	const log = [];
	const payload = { categories: [{ slug: 'general', label: 'General', count: 3 }] };
	const out = await withFetch(recordingFetch(payload, log), () => skillCategories.handler());
	assert.equal(new URL(log[0].url).pathname, '/api/skills/categories');
	assert.deepEqual(out.categories, payload.categories);
});

// ── apiRequest error normalization ────────────────────────────────────────

test('apiRequest sends the accept and user-agent identification headers', async () => {
	const log = [];
	await withFetch(recordingFetch({}, log), () => apiRequest('/api/skills'));
	assert.equal(log[0].init.headers.accept, 'application/json');
	assert.equal(log[0].init.headers['user-agent'], '@three-ws/marketplace-mcp');
	assert.equal(log[0].init.method, 'GET');
	assert.equal(log[0].init.body, undefined, 'GET carries no body');
});

test('apiRequest normalizes an upstream 5xx into upstream_error with status and body', async () => {
	const body = { message: 'database is down' };
	await withFetch(async () => jsonResponse(body, 503), () =>
		assert.rejects(apiRequest('/api/marketplace/agents'), (err) => {
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.status, 503);
			assert.equal(err.message, 'database is down');
			assert.deepEqual(err.body, body);
			return true;
		}),
	);
});

test('apiRequest falls back to a generic message when the error body is not JSON', async () => {
	await withFetch(async () => new Response('<html>oops</html>', { status: 500 }), () =>
		assert.rejects(apiRequest('/api/skills'), (err) => {
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.status, 500);
			assert.match(err.message, /returned HTTP 500/);
			assert.deepEqual(err.body, { raw: '<html>oops</html>' });
			return true;
		}),
	);
});

test('apiRequest maps a transport failure to network_error and an abort to timeout', async () => {
	await withFetch(
		async () => {
			throw new TypeError('fetch failed');
		},
		() =>
			assert.rejects(apiRequest('/api/skills'), (err) => {
				assert.equal(err.code, 'network_error');
				return true;
			}),
	);
	await withFetch(
		async () => {
			throw Object.assign(new Error('aborted'), { name: 'AbortError' });
		},
		() =>
			assert.rejects(apiRequest('/api/skills'), (err) => {
				assert.equal(err.code, 'timeout');
				assert.match(err.message, /timed out after/);
				return true;
			}),
	);
});

test('apiRequest skips undefined/null/empty query values but keeps zero', async () => {
	const log = [];
	await withFetch(recordingFetch({}, log), () =>
		apiRequest('/api/skills', { query: { keep: 0, gone1: undefined, gone2: null, gone3: '' } }),
	);
	const url = new URL(log[0].url);
	assert.equal(url.searchParams.get('keep'), '0');
	assert.equal([...url.searchParams.keys()].length, 1);
});

// ── registered wrapper ────────────────────────────────────────────────────

test('the registered MCP handler converts a thrown handler error into an isError payload', async () => {
	const server = buildServer();
	const entry = server._registeredTools.agent_detail;
	assert.ok(entry, 'agent_detail must be registered');
	const result = await withFetch(async () => jsonResponse({ data: {} }), () =>
		entry.handler({ id: 'ghost' }, {}),
	);
	assert.equal(result.isError, true);
	const payload = JSON.parse(result.content[0].text);
	assert.deepEqual(payload, {
		ok: false,
		error: 'not_found',
		message: 'No marketplace agent found with id "ghost".',
		status: 404,
	});
});
