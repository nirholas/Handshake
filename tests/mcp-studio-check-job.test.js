// check_job: the collector for a generation that outlived a tool call's inline
// wait. One status probe; each server status maps to a designed envelope:
// done → the full ok() result (widget renders the model), running → a fresh
// pending envelope carrying the live timing, failed → the clean failure copy.
// Also the regression net for the refine_model pending path, which used to
// throw a ReferenceError (undeclared `prompt`) on exactly the timed-out case
// the pending-handle work was built for.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_mcp-studio/gpt-forge-client.js', async (importOriginal) => {
	const real = await importOriginal();
	return {
		...real,
		pollOnce: vi.fn(),
		generate: vi.fn(),
		rig: vi.fn(),
		directPrompt: vi.fn(async () => null),
	};
});

import { pollOnce, generate } from '../api/_mcp-studio/gpt-forge-client.js';
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

describe('check_job', () => {
	it('renders the finished model when the job is done', async () => {
		pollOnce.mockResolvedValueOnce({
			status: 'done',
			glb_url: 'https://cdn.example.com/models/teapot.glb',
			prompt: 'a red ceramic teapot',
			preview_image_url: 'https://cdn.example.com/refs/teapot.png',
		});
		const result = await call('check_job', { job_id: 'job-abc123' });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent.glbUrl).toBe('https://cdn.example.com/models/teapot.glb');
		expect(result.structuredContent.viewerUrl).toContain('/viewer?src=');
		expect(result.structuredContent.prompt).toBe('a red ceramic teapot');
	});

	it('returns a fresh pending envelope with live timing while still rendering', async () => {
		pollOnce.mockResolvedValueOnce({
			status: 'running',
			prompt: 'a red ceramic teapot',
			eta_remaining_seconds: 42,
		});
		const result = await call('check_job', { job_id: 'job-abc123' });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			status: 'pending',
			jobId: 'job-abc123',
			pollUrl: 'https://three.ws/api/gpt-forge?job=job-abc123',
			etaRemainingSeconds: 42,
		});
		expect(result.content[0].text).toContain('42s');
	});

	it('surfaces a failed job as a clean error', async () => {
		pollOnce.mockResolvedValueOnce({ status: 'failed', error: 'generation hit a snag' });
		const result = await call('check_job', { job_id: 'job-abc123' });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('generation hit a snag');
	});

	it('rejects a missing job_id at the schema boundary', async () => {
		const res = await dispatch(
			{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_job', arguments: {} } },
			{},
			req,
		);
		expect(res.error).toBeTruthy();
	});
});

describe('refine_model pending handle', () => {
	it('returns a pollable pending result when the refinement outlives the wait', async () => {
		generate.mockResolvedValueOnce({ status: 'processing', _timedOut: true, job_id: 'ref-42', eta_remaining_seconds: 90 });
		const result = await call('refine_model', {
			glb_url: 'https://three.ws/cdn/models/teapot.glb',
			instruction: 'make it metallic',
			parent_prompt: 'a red ceramic teapot',
		});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			status: 'pending',
			jobId: 'ref-42',
			pollUrl: 'https://three.ws/api/gpt-forge?job=ref-42',
			etaRemainingSeconds: 90,
		});
		// The COMPOSED refinement prompt rides along (parent prompt + change),
		// so the collector can label the eventual model correctly.
		expect(result.structuredContent.prompt).toContain('a red ceramic teapot');
	});
});
