import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Env (lazy env.* access in shared helpers) ───────────────────────────────
process.env.PUBLIC_APP_ORIGIN ||= 'https://app.test';

// ── Replicate provider (the real GPU backend) ───────────────────────────────
const providerState = {
	submit: vi.fn(async () => ({ extJobId: 'pred_123', eta: 45 })),
	status: vi.fn(async () => ({ status: 'running' })),
};
vi.mock('../../api/_providers/replicate.js', () => ({
	createRegenProvider: vi.fn(() => providerState),
}));

// ── text → image step ───────────────────────────────────────────────────────
const t2iState = { fn: vi.fn(async () => ({ imageUrl: 'https://img.test/a.png', model: 'flux' })) };
vi.mock('../../api/_mcp3d/text-to-image.js', () => ({
	textToImage: (...a) => t2iState.fn(...a),
}));

// ── Rate limits ──────────────────────────────────────────────────────────────
const rlState = {
	gen: { success: true, reset: Date.now() + 3600000 },
	status: { success: true, reset: Date.now() + 60000 },
};
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcp3dGenerate: vi.fn(async () => rlState.gen),
		mcp3dStatus: vi.fn(async () => rlState.status),
		mcpInspect: vi.fn(async () => ({ success: true })),
		mcpOptimize: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '203.0.113.9'),
}));

// ── Usage (no DB in unit tests) ──────────────────────────────────────────────
vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const { dispatch } = await import('../../api/_mcp3d/dispatch.js');

const AUTH = { userId: null, rateKey: 'test', scope: '', source: 'x402' };
const call = (name, args) =>
	dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, AUTH);

beforeEach(() => {
	providerState.submit.mockClear();
	providerState.status.mockClear();
	t2iState.fn.mockClear();
	rlState.gen = { success: true, reset: Date.now() + 3600000 };
	rlState.status = { success: true, reset: Date.now() + 60000 };
	providerState.status.mockResolvedValue({ status: 'running' });
});

describe('3D Studio MCP', () => {
	it('lists the studio toolset', async () => {
		const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, AUTH);
		const names = r.result.tools.map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining([
				'text_to_3d',
				'image_to_3d',
				'generation_status',
				'preview_3d',
				'inspect_model',
				'optimize_model',
			]),
		);
	});

	it('initialize advertises the studio server', async () => {
		const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, AUTH);
		expect(r.result.serverInfo.name).toBe('three-ws-3d-studio');
		expect(r.result.protocolVersion).toBe('2025-06-18');
	});

	it('text_to_3d runs text→image then submits a reconstruction job', async () => {
		const r = await call('text_to_3d', { prompt: 'a low-poly red fox' });
		expect(t2iState.fn).toHaveBeenCalledWith('a low-poly red fox', { aspectRatio: '1:1' });
		expect(providerState.submit).toHaveBeenCalledWith({
			mode: 'reconstruct',
			params: { image: 'https://img.test/a.png', prompt: 'a low-poly red fox' },
		});
		expect(r.result.structuredContent).toMatchObject({
			job_id: 'pred_123',
			status: 'queued',
			preview_image_url: 'https://img.test/a.png',
		});
	});

	it('rejects a too-short prompt with invalid params', async () => {
		const r = await call('text_to_3d', { prompt: 'a' });
		expect(r.error.code).toBe(-32602);
	});

	it('image_to_3d requires a public https url', async () => {
		const bad = await call('image_to_3d', { image_url: 'http://localhost/x.png' });
		expect(bad.result.isError).toBe(true);
		expect(providerState.submit).not.toHaveBeenCalled();

		const ok = await call('image_to_3d', { image_url: 'https://img.test/in.png' });
		expect(ok.result.structuredContent.job_id).toBe('pred_123');
		expect(providerState.submit).toHaveBeenCalledWith({
			mode: 'reconstruct',
			params: { image: 'https://img.test/in.png', prompt: undefined },
		});
	});

	it('generation_status returns a GLB + model-viewer artifact when done', async () => {
		providerState.status.mockResolvedValue({ status: 'done', resultGlbUrl: 'https://cdn.test/m.glb' });
		const r = await call('generation_status', { job_id: 'pred_123' });
		expect(r.result.structuredContent).toEqual({
			job_id: 'pred_123',
			status: 'done',
			glb_url: 'https://cdn.test/m.glb',
		});
		const resource = r.result.content.find((c) => c.type === 'resource');
		expect(resource.resource.mimeType).toBe('text/html');
		expect(resource.resource.text).toContain('model-viewer');
		expect(resource.resource.text).toContain('https://cdn.test/m.glb');
	});

	it('generation_status surfaces failures as tool errors', async () => {
		providerState.status.mockResolvedValue({ status: 'failed', error: 'oom' });
		const r = await call('generation_status', { job_id: 'pred_123' });
		expect(r.result.isError).toBe(true);
		expect(r.result.structuredContent).toEqual({ job_id: 'pred_123', status: 'failed', error: 'oom' });
	});

	it('generation_status reports in-progress jobs', async () => {
		const r = await call('generation_status', { job_id: 'pred_123' });
		expect(r.result.structuredContent).toEqual({ job_id: 'pred_123', status: 'running' });
		expect(r.result.isError).toBeUndefined();
	});

	it('enforces the hourly generation rate limit', async () => {
		rlState.gen = { success: false, reset: Date.now() + 1800000 };
		const r = await call('text_to_3d', { prompt: 'a teapot' });
		expect(r.error.code).toBe(-32000);
		expect(r.error.message).toBe('rate_limited');
		expect(providerState.submit).not.toHaveBeenCalled();
	});

	it('preview_3d renders any public GLB as an artifact', async () => {
		const r = await call('preview_3d', { glb_url: 'https://cdn.test/x.glb' });
		const resource = r.result.content.find((c) => c.type === 'resource');
		expect(resource.resource.text).toContain('https://cdn.test/x.glb');
	});
});
