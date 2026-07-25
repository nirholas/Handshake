// A studio generation that outlives the inline wait budget must return a
// pollable pending handle, never an error.
//
// With FORGE_SELFHOST_PRIMARY set in production, the free forge lane runs on
// self-host TRELLIS at 4-6 minutes per model while the studio's inline wait is
// 3 minutes (STUDIO_FORGE_TIMEOUT_MS default 180s) — so every hosted
// forge_free call answered "Generation is taking longer than expected" while
// its model quietly completed minutes later and the caller never learned the
// job existed. The timed-out path now carries the job_id forward and the tool
// hands back { status: 'pending', jobId, pollUrl } as a SUCCESS result; the
// /api/forge?job= poll endpoint is public, so the handle is directly usable.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_mcp-studio/gpt-forge-client.js', async (importOriginal) => {
	const real = await importOriginal();
	return {
		...real,
		// Generation submits fine but outlives the wait budget: the shape
		// generate() returns after the pollJob deadline with the job_id attached.
		generate: vi.fn(async () => ({ status: 'processing', _timedOut: true, job_id: 'job-abc123' })),
		rig: vi.fn(async () => ({ status: 'processing', _timedOut: true, job_id: 'rig-xyz789' })),
		// The prompt director is irrelevant here; keep it inert.
		directPrompt: vi.fn(async () => null),
	};
});

import { dispatch } from '../api/_mcp-studio/dispatch.js';

const req = { headers: { host: 'three.ws', 'x-forwarded-proto': 'https' } };

async function call(name, args) {
	const res = await dispatch(
		{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
		{},
		req,
	);
	return res.result;
}

describe('studio pending handles', () => {
	it('forge_free returns a pollable pending result instead of an error', async () => {
		const result = await call('forge_free', { prompt: 'a red ceramic teapot with gold trim' });

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent.status).toBe('pending');
		expect(result.structuredContent.jobId).toBe('job-abc123');
		expect(result.structuredContent.pollUrl).toBe('https://three.ws/api/forge?job=job-abc123');
		expect(result.content[0].text).toContain('still rendering');
		expect(result.content[0].text).toContain(result.structuredContent.pollUrl);
	});

	it('rig_mesh returns a pollable pending result instead of an error', async () => {
		const result = await call('rig_mesh', { glb_url: 'https://three.ws/cdn/models/example.glb' });

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			status: 'pending',
			jobId: 'rig-xyz789',
			pollUrl: 'https://three.ws/api/forge?job=rig-xyz789',
		});
	});

	it('still errors when the timeout carries no job handle', async () => {
		const { generate } = await import('../api/_mcp-studio/gpt-forge-client.js');
		generate.mockResolvedValueOnce({ _timedOut: true });

		const result = await call('forge_free', { prompt: 'a small wooden rowboat' });
		expect(result.isError).toBe(true);
	});
});
