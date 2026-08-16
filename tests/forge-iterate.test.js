// Coverage for api/forge-iterate.js — the ownership-preserving REST twin of
// the free studio's `refine_model` MCP tool, wired into the Forge Studio
// browser UI. Verifies:
//   - input validation happens before any network call,
//   - x-forge-client is forwarded to /api/forge (the piece that makes the
//     result an owned, gallery-listed, remix-publishable creation),
//   - a synchronous-done /api/forge response is shaped into the REST contract
//     (glbUrl, viewerUrl, prompt, creationId, lineage, activeIndex),
//   - a queued job is polled to completion,
//   - lineage extension and branch (parent_index) match the pure core in
//     mcp-server/src/tools/_lineage.js,
//   - upstream failure states (503/429/timeout) surface as clean JSON errors.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { forgeIterate: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const { default: handler } = await import('../api/forge-iterate.js');
const { limits } = await import('../api/_lib/rate-limit.js');

function mockReq({ body, headers = {} } = {}) {
	return {
		method: 'POST',
		url: '/api/forge-iterate',
		headers: { host: 'three.ws', 'x-forwarded-proto': 'https', 'content-type': 'application/json', ...headers },
		body,
	};
}

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		ended: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(b) {
			this.body = b;
			this.ended = true;
		},
	};
}

function parsed(res) {
	return JSON.parse(res.body || '{}');
}

function forgeResponse(status, body) {
	return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe('api/forge-iterate — validation', () => {
	let fetchMock;
	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('rejects a missing glb_url without calling the network', async () => {
		const res = mockRes();
		await handler(mockReq({ body: { instruction: 'make it metallic' } }), res);
		expect(res.statusCode).toBe(400);
		expect(parsed(res).error).toBe('invalid_glb_url');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a missing instruction without calling the network', async () => {
		const res = mockRes();
		await handler(mockReq({ body: { glb_url: 'https://three.ws/cdn/x.glb' } }), res);
		expect(res.statusCode).toBe(400);
		expect(parsed(res).error).toBe('missing_instruction');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects an instruction over 500 characters', async () => {
		const res = mockRes();
		await handler(
			mockReq({ body: { glb_url: 'https://three.ws/cdn/x.glb', instruction: 'x'.repeat(501) } }),
			res,
		);
		expect(res.statusCode).toBe(400);
		expect(parsed(res).error).toBe('instruction_too_long');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a non-http glb_url', async () => {
		const res = mockRes();
		await handler(mockReq({ body: { glb_url: 'not-a-url', instruction: 'bigger' } }), res);
		expect(res.statusCode).toBe(400);
		expect(parsed(res).error).toBe('invalid_glb_url');
	});
});

describe('api/forge-iterate — handler', () => {
	let fetchMock;
	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('forwards x-forge-client to /api/forge and shapes a synchronous-done response', async () => {
		fetchMock.mockResolvedValueOnce(
			forgeResponse(200, {
				status: 'done',
				glb_url: 'https://three.ws/cdn/creations/def456/mesh.glb',
				creation_id: 'def456',
				durable: true,
			}),
		);
		const res = mockRes();
		await handler(
			mockReq({
				body: { glb_url: 'https://three.ws/cdn/creations/abc123/mesh.glb', instruction: 'make it metallic', parent_prompt: 'a round robot mascot' },
				headers: { 'x-forge-client': 'client-42' },
			}),
			res,
		);
		expect(res.statusCode).toBe(200);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://three.ws/api/forge');
		expect(init.headers['x-forge-client']).toBe('client-42');
		const payload = JSON.parse(init.body);
		expect(payload.prompt).toBe('a round robot mascot, metallic');

		const out = parsed(res);
		expect(out.ok).toBe(true);
		expect(out.glbUrl).toBe('https://three.ws/cdn/creations/def456/mesh.glb');
		expect(out.creationId).toBe('def456');
		expect(out.prompt).toBe('a round robot mascot, metallic');
		expect(out.durable).toBe(true);
		// Fresh lineage: origin (the parent model) + this one refinement.
		expect(out.lineage).toHaveLength(2);
		expect(out.lineage[0]).toMatchObject({ index: 0, parentIndex: null, refKind: 'origin' });
		expect(out.lineage[1]).toMatchObject({ index: 1, parentIndex: 0, instruction: 'make it metallic', refKind: 'text' });
		expect(out.activeIndex).toBe(1);
	});

	it('polls a queued job to completion', async () => {
		fetchMock
			.mockResolvedValueOnce(forgeResponse(200, { job_id: 'job-1', status: 'queued' }))
			.mockResolvedValueOnce(forgeResponse(200, { job_id: 'job-1', status: 'running' }))
			.mockResolvedValueOnce(
				forgeResponse(200, { job_id: 'job-1', status: 'done', glb_url: 'https://three.ws/cdn/x/y.glb', creation_id: 'y' }),
			);
		process.env.FORGE_ITERATE_POLL_MS = '1';
		const res = mockRes();
		await handler(mockReq({ body: { glb_url: 'https://three.ws/cdn/a/b.glb', instruction: 'add wings' } }), res);
		delete process.env.FORGE_ITERATE_POLL_MS;
		expect(res.statusCode).toBe(200);
		expect(parsed(res).glbUrl).toBe('https://three.ws/cdn/x/y.glb');
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('extends a client-supplied lineage and branches off an earlier version with parent_index', async () => {
		fetchMock.mockResolvedValueOnce(
			forgeResponse(200, { status: 'done', glb_url: 'https://three.ws/cdn/z/branch.glb', creation_id: 'z' }),
		);
		const parentLineage = [
			{ index: 0, parentIndex: null, glbUrl: 'https://three.ws/cdn/a.glb', prompt: 'a robot', refKind: 'origin' },
			{ index: 1, parentIndex: 0, glbUrl: 'https://three.ws/cdn/b.glb', prompt: 'a robot, metallic', instruction: 'make it metallic', refKind: 'text' },
		];
		const res = mockRes();
		await handler(
			mockReq({
				body: {
					glb_url: 'https://three.ws/cdn/a.glb',
					instruction: 'add wings',
					parent_prompt: 'a robot',
					parent_lineage: parentLineage,
					parent_index: 0,
				},
			}),
			res,
		);
		const out = parsed(res);
		expect(out.ok).toBe(true);
		expect(out.lineage).toHaveLength(3);
		// Branched off index 0, not the leaf (index 1).
		expect(out.lineage[2]).toMatchObject({ index: 2, parentIndex: 0, instruction: 'add wings' });
		expect(out.activeIndex).toBe(2);
	});

	it('a malformed parent_lineage falls back to a fresh lineage instead of corrupting history', async () => {
		fetchMock.mockResolvedValueOnce(forgeResponse(200, { status: 'done', glb_url: 'https://three.ws/cdn/c.glb', creation_id: 'c' }));
		const res = mockRes();
		await handler(
			mockReq({
				body: {
					glb_url: 'https://three.ws/cdn/a.glb',
					instruction: 'bigger',
					parent_lineage: [{ index: 5, parentIndex: 99, glbUrl: 'https://x/a.glb' }], // broken: dangling parent ref
				},
			}),
			res,
		);
		const out = parsed(res);
		expect(out.ok).toBe(true);
		expect(out.lineage).toHaveLength(2); // fresh seed + this refinement, not the broken array extended
		expect(out.lineage[0].parentIndex).toBeNull();
	});

	it('surfaces a 503 when /api/forge is not configured', async () => {
		fetchMock.mockResolvedValueOnce(forgeResponse(503, { message: '3D generation is not configured.' }));
		const res = mockRes();
		await handler(mockReq({ body: { glb_url: 'https://three.ws/cdn/a.glb', instruction: 'bigger' } }), res);
		expect(res.statusCode).toBe(503);
		expect(parsed(res).error).toBe('not_configured');
	});

	it('surfaces a 429 with retry_after when /api/forge is busy', async () => {
		fetchMock.mockResolvedValueOnce(forgeResponse(429, { message: 'busy', retry_after: 5 }));
		const res = mockRes();
		await handler(mockReq({ body: { glb_url: 'https://three.ws/cdn/a.glb', instruction: 'bigger' } }), res);
		expect(res.statusCode).toBe(429);
		const out = parsed(res);
		expect(out.error).toBe('busy');
		expect(out.retry_after).toBe(5);
	});

	it('reports a submit that times out as busy with a back-off, not a bare gateway timeout', async () => {
		// /api/forge holds the connection open while a saturated generator queues the
		// job (a live three.ws submit held for 157s before answering its own busy
		// 429), so the submit timeout fires on exactly the busy condition. Answering
		// 504 sent both iterate UIs down the generic "rephrase your instruction"
		// branch, blaming a wording the user had got right.
		fetchMock.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));
		const res = mockRes();
		await handler(mockReq({ body: { glb_url: 'https://three.ws/cdn/a.glb', instruction: 'bigger' } }), res);
		expect(res.statusCode).toBe(429);
		const out = parsed(res);
		expect(out.error).toBe('busy');
		expect(out.retry_after).toBeGreaterThan(0);
	});

	it('surfaces an unreachable generator as a 502 rather than a busy signal', async () => {
		fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		const res = mockRes();
		await handler(mockReq({ body: { glb_url: 'https://three.ws/cdn/a.glb', instruction: 'bigger' } }), res);
		expect(res.statusCode).toBe(502);
		expect(parsed(res).error).toBe('provider_error');
	});

	it('is rate-limited per forgeIterate', async () => {
		limits.forgeIterate.mockResolvedValueOnce({ success: false, limit: 60, remaining: 0, reset: Date.now() + 1000 });
		const res = mockRes();
		await handler(mockReq({ body: { glb_url: 'https://three.ws/cdn/a.glb', instruction: 'bigger' } }), res);
		expect(res.statusCode).toBe(429);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects non-POST methods', async () => {
		const res = mockRes();
		await handler({ ...mockReq({ body: {} }), method: 'GET' }, res);
		expect(res.statusCode).toBe(405);
	});
});
