// Garment Forge MCP tools (api/_mcp/tools/garments.js), registered in
// api/_mcp/catalog.js. These are the agent-facing door onto the same
// garment-forge worker lane the /api/garment-forge HTTP route drives.
//
// Verifies: generate_garment queues a job against the worker with the server-side
// bearer secret and never leaks it into the tool result; garment_status reports a
// missing coverage number as "not reported" instead of announcing a measured
// 0.0% the pipeline never produced; list_garment_catalog shapes the public
// wardrobe manifest and filters by slot; an unconfigured worker, a malformed job
// id, a 404 job, an unreachable worker, and an exhausted rate limit each surface
// a clean error. The rate limiter and fetch are mocked at their boundary; the
// tool defs run real.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

process.env.GCP_GARMENT_FORGE_URL = 'https://garment-forge.test/';
process.env.GCP_RECONSTRUCTION_KEY = 'worker-secret';

let rlOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcp3dGenerate: vi.fn(async () => ({ success: rlOk, reset: Date.now() + 60_000 })),
		mcp3dStatus: vi.fn(async () => ({ success: rlOk, reset: Date.now() + 60_000 })),
	},
}));

const { toolDefs } = await import('../../api/_mcp/tools/garments.js');

const JOB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const AUTH = { userId: 'user-1', rateKey: 'garment-test', scope: '', source: 'oauth' };
const call = (name, args) => toolDefs.find((t) => t.name === name).handler(args, AUTH, {});

const realFetch = globalThis.fetch;
const fetchMock = vi.fn();
globalThis.fetch = (...a) => fetchMock(...a);
afterAll(() => {
	globalThis.fetch = realFetch;
});

const jsonResponse = (body, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	json: async () => body,
});

beforeEach(() => {
	fetchMock.mockReset();
	rlOk = true;
	process.env.GCP_GARMENT_FORGE_URL = 'https://garment-forge.test/';
	process.env.GCP_RECONSTRUCTION_KEY = 'worker-secret';
});

describe('garment MCP tools: registration', () => {
	it('registers the three tools with the wardrobe slot enum on both writers', () => {
		const byName = Object.fromEntries(toolDefs.map((t) => [t.name, t]));
		expect(Object.keys(byName)).toEqual([
			'generate_garment',
			'garment_status',
			'list_garment_catalog',
		]);
		expect(byName.generate_garment.annotations.readOnlyHint).toBe(false);
		expect(byName.generate_garment.annotations.destructiveHint).toBe(false);
		expect(byName.garment_status.annotations.readOnlyHint).toBe(true);
		expect(byName.generate_garment.inputSchema.properties.slot.enum).toContain('outerwear');
		expect(byName.list_garment_catalog.inputSchema.properties.slot.enum).toEqual(
			byName.generate_garment.inputSchema.properties.slot.enum,
		);
	});
});

describe('generate_garment', () => {
	it('queues a job on the worker with the server-side bearer and returns the job id', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ job_id: JOB_ID, status: 'queued' }));
		const r = await call('generate_garment', { prompt: 'a red varsity jacket', slot: 'outerwear' });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://garment-forge.test/generate');
		expect(init.method).toBe('POST');
		expect(init.headers.authorization).toBe('Bearer worker-secret');
		expect(JSON.parse(init.body)).toEqual({ prompt: 'a red varsity jacket', slot: 'outerwear' });

		expect(r.structuredContent).toEqual({ job_id: JOB_ID, status: 'queued', eta_seconds: 450 });
		// The worker secret is server-side only and must never reach the agent.
		expect(JSON.stringify(r)).not.toContain('worker-secret');
	});

	it('reports an unconfigured worker as a configuration fault, not a generation failure', async () => {
		delete process.env.GCP_GARMENT_FORGE_URL;
		await expect(call('generate_garment', { prompt: 'a hat', slot: 'headwear' })).rejects.toMatchObject({
			code: -32001,
			message: expect.stringContaining('not configured'),
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('surfaces a worker rejection and an unreachable worker distinctly', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: 'bad slot' }, 422));
		await expect(call('generate_garment', { prompt: 'a hat', slot: 'headwear' })).rejects.toThrow(
			'garment worker returned 422',
		);

		fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
		await expect(call('generate_garment', { prompt: 'a hat', slot: 'headwear' })).rejects.toThrow(
			'garment worker unreachable',
		);
	});

	it('rate-limits before calling the worker', async () => {
		rlOk = false;
		await expect(call('generate_garment', { prompt: 'a hat', slot: 'headwear' })).rejects.toMatchObject({
			code: -32000,
			message: 'rate_limited',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('garment_status', () => {
	it('reports the published garment with its measured bind coverage', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				job_id: JOB_ID, status: 'done', garment_id: 'red-varsity-jacket-abc123',
				glb_url: 'https://cdn.test/garment.glb', manifest_url: 'https://cdn.test/manifest.json',
				thumb_url: 'https://cdn.test/thumb.png', coverage: 0.73, occludes: ['torso', 'upperArm'],
			}),
		);
		const r = await call('garment_status', { job_id: JOB_ID });
		expect(fetchMock.mock.calls[0][0]).toBe(`https://garment-forge.test/jobs/${JOB_ID}`);
		expect(r.structuredContent.coverage).toBe(0.73);
		expect(r.content[0].text).toContain('coverage 73.0%');
		expect(r.content[0].text).toContain('occludes torso, upperArm');
	});

	it('says coverage was not reported rather than announcing a measured 0.0%', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ job_id: JOB_ID, status: 'done', garment_id: 'g1', glb_url: 'https://cdn.test/g.glb' }),
		);
		const r = await call('garment_status', { job_id: JOB_ID });
		expect(r.structuredContent.coverage).toBeNull();
		expect(r.content[0].text).toContain('coverage not reported');
		expect(r.content[0].text).not.toContain('0.0%');
		expect(r.content[0].text).toContain('occludes nothing');
	});

	it('reports a failed job with the worker error and an in-flight job with its stage', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ job_id: JOB_ID, status: 'failed', error: 'rig step diverged' }));
		const failed = await call('garment_status', { job_id: JOB_ID });
		expect(failed.content[0].text).toContain('rig step diverged');

		fetchMock.mockResolvedValue(jsonResponse({ job_id: JOB_ID, status: 'running', stage: 'compose' }));
		const running = await call('garment_status', { job_id: JOB_ID });
		expect(running.structuredContent.stage).toBe('compose');
		expect(running.content[0].text).toContain('compose');
	});

	it('rejects a malformed job id before calling the worker, and reports an unknown job', async () => {
		await expect(call('garment_status', { job_id: 'not-a-uuid' })).rejects.toThrow('malformed job id');
		expect(fetchMock).not.toHaveBeenCalled();

		fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, 404));
		await expect(call('garment_status', { job_id: JOB_ID })).rejects.toThrow('no such garment job');
	});
});

describe('list_garment_catalog', () => {
	const CATALOG = [
		{ id: 'g-top', name: 'White oxford', slot: 'top', version: 1, model: { uri: 'https://cdn.test/top.glb' }, preview: { thumbnail: 'https://cdn.test/top.png' }, occludes: ['torso'], license: 'CC0' },
		{ id: 'g-boot', name: 'Black boots', slot: 'footwear', version: 2, model: { uri: 'https://cdn.test/boot.glb' }, preview: {}, license: 'CC0' },
	];

	it('shapes every published manifest and filters by slot', async () => {
		fetchMock.mockResolvedValue(jsonResponse(CATALOG));
		const all = await call('list_garment_catalog', {});
		expect(all.structuredContent.count).toBe(2);
		expect(all.structuredContent.garments[0]).toEqual({
			id: 'g-top', name: 'White oxford', slot: 'top', version: 1,
			glb_url: 'https://cdn.test/top.glb', thumbnail: 'https://cdn.test/top.png',
			occludes: ['torso'], license: 'CC0',
		});
		// A manifest with no preview/occludes still shapes cleanly.
		expect(all.structuredContent.garments[1].thumbnail).toBeNull();
		expect(all.structuredContent.garments[1].occludes).toEqual([]);

		fetchMock.mockResolvedValue(jsonResponse(CATALOG));
		const tops = await call('list_garment_catalog', { slot: 'top' });
		expect(tops.structuredContent.garments.map((g) => g.id)).toEqual(['g-top']);
	});

	it('designs the empty state instead of returning a blank result', async () => {
		fetchMock.mockResolvedValue(jsonResponse([]));
		const r = await call('list_garment_catalog', { slot: 'glasses' });
		expect(r.structuredContent).toEqual({ garments: [], count: 0 });
		expect(r.content[0].text).toBe('The catalog is empty for that filter.');
	});

	it('errors when the public catalog is unreachable', async () => {
		fetchMock.mockRejectedValue(new Error('DNS failure'));
		await expect(call('list_garment_catalog', {})).rejects.toThrow('garment catalog unreachable');
	});
});
