// GET /api/oembed — the shared oEmbed provider for agents, on-chain agents,
// and (roadmap prompt 10) Forge 3D creations. Exercises the real handler with
// the DB and on-chain resolver mocked, so this is a real orchestration/contract
// test, not a mock of the thing under test.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';

const sqlState = { queue: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => (sqlState.queue.length ? sqlState.queue.shift() : [])),
}));

vi.mock('../../api/_lib/onchain.js', () => ({
	resolveOnChainAgent: vi.fn(async () => ({ name: 'Onchain Hero' })),
	SERVER_CHAIN_META: { 8453: { name: 'Base', short: 'BASE', testnet: false } },
}));

const { default: handler } = await import('../../api/agent-oembed.js');

function makeReq(url) {
	const stream = Readable.from([]);
	stream.method = 'GET';
	stream.url = url;
	stream.headers = { host: 'three.ws' };
	return stream;
}
function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(chunk) { if (chunk !== undefined) this.body += String(chunk); this.writableEnded = true; },
	};
}
async function get(target, extra = '') {
	const res = makeRes();
	await handler(makeReq(`/api/oembed?url=${encodeURIComponent(target)}${extra}`), res);
	let parsed = null;
	try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
	return { res, status: res.statusCode, body: parsed };
}

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const CREATION_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
	sqlState.queue = [];
});

describe('agent target', () => {
	it('resolves the canonical /agents/:id url into a rich oEmbed payload', async () => {
		sqlState.queue = [[{ id: AGENT_ID, name: 'Nova', description: 'guide', avatar_id: null }]];
		const { status, body } = await get(`https://three.ws/agents/${AGENT_ID}`);
		expect(status).toBe(200);
		expect(body.type).toBe('rich');
		expect(body.title).toBe('Nova');
		expect(body.html).toContain(`https://three.ws/agents/${AGENT_ID}/embed`);
	});

	it('still resolves the legacy /agent/:id url shape', async () => {
		sqlState.queue = [[{ id: AGENT_ID, name: 'Nova', description: 'guide', avatar_id: null }]];
		const { status, body } = await get(`https://three.ws/agent/${AGENT_ID}`);
		expect(status).toBe(200);
		expect(body.type).toBe('rich');
		expect(body.html).toContain(`https://three.ws/agents/${AGENT_ID}/embed`);
	});
});

describe('Forge creation target (roadmap prompt 10)', () => {
	it('resolves /forge/share/:id into a rich oEmbed payload pointing at /forge/embed', async () => {
		sqlState.queue = [[{ id: CREATION_ID, prompt: 'a robot', status: 'done', glb_url: 'https://cdn.test/m.glb' }]];
		const { status, body } = await get(`https://three.ws/forge/share/${CREATION_ID}`);
		expect(status).toBe(200);
		expect(body.type).toBe('rich');
		expect(body.title).toBe('a robot');
		expect(body.provider_name).toBe('three.ws');
		expect(body.html).toContain('https://three.ws/forge/embed?src=');
		expect(body.html).toContain(encodeURIComponent('https://cdn.test/m.glb'));
		expect(body.thumbnail_url).toBe(`https://three.ws/api/forge-og?id=${CREATION_ID}`);
	});

	it('returns XML when format=xml is requested', async () => {
		sqlState.queue = [[{ id: CREATION_ID, prompt: null, status: 'done', glb_url: 'https://cdn.test/m.glb' }]];
		const { status, res } = await get(`https://three.ws/forge/share/${CREATION_ID}`, '&format=xml');
		expect(status).toBe(200);
		expect(res.headers['content-type']).toContain('text/xml');
		expect(res.body).toContain('<oembed>');
		expect(res.body).toContain('Forged creation'); // fallback title when prompt is null
	});

	it('404s a creation that is still generating (never partial)', async () => {
		sqlState.queue = [[{ id: CREATION_ID, prompt: 'wip', status: 'generating', glb_url: null }]];
		const { status } = await get(`https://three.ws/forge/share/${CREATION_ID}`);
		expect(status).toBe(404);
	});

	it('404s an unknown creation id', async () => {
		sqlState.queue = [[]];
		const { status } = await get(`https://three.ws/forge/share/${CREATION_ID}`);
		expect(status).toBe(404);
	});

	it('does not treat a non-uuid path segment as a forge id', async () => {
		const { status } = await get('https://three.ws/forge/share/not-a-uuid');
		expect(status).toBe(404); // falls through to "not a recognised agent url" (no agent match either)
	});
});

describe('unrecognised target', () => {
	it('404s a URL that matches no known share route', async () => {
		const { status, body } = await get('https://three.ws/nowhere');
		expect(status).toBe(404);
		expect(body.error_description || body.error).toBeTruthy();
	});
});

describe('malformed target', () => {
	it('does not treat a non-uuid /agent/:id segment as an agent id', async () => {
		// agent_identities.id is a uuid column: the slug used to reach Postgres as
		// an uncastable literal and answer 500. The sql mock queue is empty, so a
		// regression that reintroduces the query fails here rather than 404ing.
		const { status, body } = await get('https://three.ws/agent/not-a-uuid');
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('rejects a non-GET method with 405', async () => {
		const res = makeRes();
		const req = makeReq('/api/oembed?url=https%3A%2F%2Fthree.ws%2Fnowhere');
		req.method = 'POST';
		await handler(req, res);
		expect(res.statusCode).toBe(405);
	});
});
