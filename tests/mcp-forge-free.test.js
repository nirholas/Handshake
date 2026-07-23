import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { buildForgeFreeTool } from '../mcp-server/src/tools/forge-free.js';

// `forge_free` is the ONE free MCP tool — text prompt → 3D GLB on the free
// NVIDIA NIM (TRELLIS) lane, no x402 payment and no API key. These tests guard:
//   - the descriptor advertises free-ness and is a write (mints an artifact),
//   - input is validated before any network call,
//   - the synchronous-done forge response is shaped into a free result,
//   - a queued job is polled to completion,
//   - the request never pins a paid backend — the router's own free-lane
//     default (photoreal image-intermediate pipeline first) picks the engine,
//   - upstream states (not_configured / busy / failed) become designed toolErrors
//     (ok:false → isError, which on a paid tool cancels billing; here it just
//     gives the caller a stable error contract).

// A Response stub good enough for the tool's fetch usage (status, ok, json).
function res(status, body = {}) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: async () => body,
	};
}

// Pull the tool's structured return out of the MCP CallToolResult envelope.
function structured(envelope) {
	return envelope.structuredContent;
}

describe('forge_free — descriptor', () => {
	it('is free, a write, open-world, and never quotes a USDC price', () => {
		const tool = buildForgeFreeTool();
		expect(tool.name).toBe('forge_free');
		expect(tool.title).toMatch(/free/i);
		expect(tool.description.toLowerCase()).toContain('free');
		// A free tool must NOT advertise a USDC price in its description.
		expect(tool.description).not.toMatch(/\$[0-9]/);
		// Mentions the free engine so an LLM picks it for zero-cost text→3D.
		expect(tool.description).toMatch(/TRELLIS|NVIDIA/i);

		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(tool.inputSchema.prompt).toBeTruthy();
		expect(tool.inputSchema.tier).toBeTruthy();
		expect(tool.handler).toBeTypeOf('function');
	});
});

describe('forge_free — handler', () => {
	let fetchMock;
	let tool;
	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		// Tighten the poll cadence so the queued-job test doesn't wait seconds.
		process.env.FORGE_FREE_POLL_MS = '1';
		// Disable the shared-lane rate-limit backoff loop: with retries on, a single
		// stubbed 429 is retried (against a fetch mock primed for one call) and the
		// follow-up miss reclassifies the error. With 0 retries the busy lane
		// surfaces its terminal `rate_limited` contract immediately, which is what
		// these unit tests assert. The backoff itself is covered by the live lane.
		process.env.FORGE_FREE_RATE_RETRIES = '0';
		tool = buildForgeFreeTool();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		delete process.env.FORGE_FREE_POLL_MS;
		delete process.env.FORGE_FREE_RATE_RETRIES;
	});

	it('rejects a too-short prompt without hitting the network', async () => {
		const out = structured(await tool.handler({ prompt: 'no' }, {}));
		expect(out.ok).toBe(false);
		expect(out.error).toBe('invalid_input');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('pins the free NVIDIA lane and shapes a synchronous completion', async () => {
		fetchMock.mockResolvedValueOnce(
			res(200, {
				job_id: null,
				creation_id: 'abc123',
				status: 'done',
				glb_url: 'https://three.ws/cdn/forge/nvidia/x.glb',
				backend: 'nvidia',
				durable: true,
			}),
		);

		const out = structured(await tool.handler({ prompt: 'a glossy white robot mascot' }, {}));

		// Exactly one call — the synchronous done path skips polling entirely.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toMatch(/\/api\/forge$/);
		const body = JSON.parse(opts.body);
		// No backend pin: the forge router's own free-lane default resolves to the
		// zero-cost photoreal image-intermediate pipeline (self-host TRELLIS →
		// Hunyuan3D → HuggingFace → NVIDIA NIM last resort), never the paid
		// Replicate lane, without forcing NVIDIA's native text-only preview.
		expect(body).toMatchObject({ path: 'image', prompt: 'a glossy white robot mascot' });
		expect(body.backend).toBeUndefined();
		// Tier defaults to draft (fast, free).
		expect(body.tier).toBe('draft');

		expect(out).toMatchObject({
			ok: true,
			free: true,
			cost: '$0.00',
			mode: 'text_to_3d',
			glbUrl: 'https://three.ws/cdn/forge/nvidia/x.glb',
			backend: 'nvidia',
			tier: 'draft',
			creationId: 'abc123',
			durable: true,
			jobId: null,
		});
		// The viewer link renders the model in-browser.
		expect(out.preview).toBe(
			'https://three.ws/viewer?src=' + encodeURIComponent('https://three.ws/cdn/forge/nvidia/x.glb'),
		);
		expect(typeof out.durationMs).toBe('number');
	});

	it('honors a requested tier and polls a queued job to done', async () => {
		fetchMock
			.mockResolvedValueOnce(
				res(200, { job_id: 'tok_abc', creation_id: 'c1', status: 'queued', backend: 'nvidia' }),
			)
			.mockResolvedValueOnce(res(200, { job_id: 'tok_abc', status: 'running' }))
			.mockResolvedValueOnce(
				res(200, {
					job_id: 'tok_abc',
					status: 'done',
					glb_url: 'https://three.ws/cdn/forge/nvidia/y.glb',
					backend: 'nvidia',
					creation_id: 'c1',
					durable: true,
				}),
			);

		const out = structured(await tool.handler({ prompt: 'a carved oak chair', tier: 'standard' }, {}));

		expect(JSON.parse(fetchMock.mock.calls[0][1].body).tier).toBe('standard');
		// Submit + two polls.
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[1][0]).toContain('?job=tok_abc');
		expect(out).toMatchObject({
			ok: true,
			free: true,
			tier: 'standard',
			jobId: 'tok_abc',
			glbUrl: 'https://three.ws/cdn/forge/nvidia/y.glb',
			backend: 'nvidia',
		});
	});

	it('surfaces a not-configured deployment as a designed error', async () => {
		fetchMock.mockResolvedValueOnce(res(503, { message: 'free text→3D is not configured' }));
		const envelope = await tool.handler({ prompt: 'a brass telescope' }, {});
		expect(envelope.isError).toBe(true);
		const out = structured(envelope);
		expect(out.ok).toBe(false);
		expect(out.error).toBe('not_configured');
	});

	it('surfaces a busy lane as a rate_limited error with retry hint', async () => {
		fetchMock.mockResolvedValueOnce(res(429, { message: 'busy', retry_after: 8 }));
		const out = structured(await tool.handler({ prompt: 'a ceramic teapot' }, {}));
		expect(out.ok).toBe(false);
		expect(out.error).toBe('rate_limited');
		expect(out.retryAfter).toBe(8);
	});

	it('reports a terminal generation failure from the poll loop', async () => {
		fetchMock
			.mockResolvedValueOnce(res(200, { job_id: 'tok_fail', status: 'queued', backend: 'nvidia' }))
			.mockResolvedValueOnce(res(200, { job_id: 'tok_fail', status: 'failed', error: 'NVCF dropped the job' }));
		const out = structured(await tool.handler({ prompt: 'a marble bust' }, {}));
		expect(out.ok).toBe(false);
		expect(out.error).toBe('generation_failed');
	});
});
