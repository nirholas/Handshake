// The stylize lane's poll telemetry, at the provider boundary.
//
// workers/stylize returns `face_count` on a finished task and the forge's
// stylize panel renders it next to the result ("· 14,400 faces", see
// src/forge-stylize.js). The provider's status() has to carry it across the
// hop; it used to map face_count for `remesh` only, so /api/forge-stylize
// answered face_count: null on every job and the panel silently dropped the
// label. The worker payloads below are the shapes a live stylize job returns.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRegenProvider } from '../../api/_providers/gcp.js';

const ENV = ['GCP_STYLIZE_URL', 'GCP_REMESH_URL', 'GCP_RECONSTRUCTION_KEY'];
const WORKER = 'https://stylize-service.example.run.app';
const TASK_ID = '8fd19ba8-492d-4326-bcd1-dddfa4337cba';

let saved;
let realFetch;
let calls;

function respond(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

beforeEach(() => {
	saved = {};
	for (const key of ENV) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	process.env.GCP_STYLIZE_URL = WORKER;
	process.env.GCP_REMESH_URL = 'https://remesh-service.example.run.app';
	process.env.GCP_RECONSTRUCTION_KEY = 'test-shared-worker-key';

	calls = [];
	realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		if (String(url).endsWith('/process')) return respond({ task_id: TASK_ID, status: 'queued' });
		if (String(url).includes('/tasks/')) {
			return respond({
				task_id: TASK_ID,
				status: 'done',
				result_url: `https://storage.googleapis.com/three-ws-avatar-reconstructions/stylize/${TASK_ID}.glb`,
				face_count: 14_400,
				style: 'voxel',
				resolution: 32,
				output_format: 'glb',
				bytes: 512_340,
				elapsed_ms: 1830,
			});
		}
		throw new Error(`unexpected fetch: ${url}`);
	};
});

afterEach(() => {
	globalThis.fetch = realFetch;
	for (const key of ENV) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

describe('stylize lane telemetry', () => {
	it('carries the worker face_count through submit → status', async () => {
		const provider = createRegenProvider();
		expect(provider.supportsMode('stylize')).toBe(true);

		const job = await provider.submit({
			mode: 'stylize',
			sourceUrl: 'https://three.ws/accessories/hat-cowboy.glb',
			params: { style: 'voxel', resolution: 32, output_format: 'glb' },
		});
		expect(calls[0].url).toBe(`${WORKER}/process`);
		expect(JSON.parse(calls[0].init.body)).toMatchObject({
			mesh: 'https://three.ws/accessories/hat-cowboy.glb',
			style: 'voxel',
			resolution: 32,
			output_format: 'glb',
		});

		const result = await provider.status(job.extJobId);
		expect(calls[1].url).toBe(`${WORKER}/tasks/${TASK_ID}`);
		expect(result.status).toBe('done');
		expect(result.resultGlbUrl).toContain(`/stylize/${TASK_ID}.glb`);
		// The regression: this was undefined, so the endpoint sent face_count: null.
		expect(result.faceCount).toBe(14_400);
	});

	it('leaves faceCount off when the worker omits it', async () => {
		globalThis.fetch = async (url) => {
			if (String(url).endsWith('/process')) return respond({ task_id: TASK_ID });
			return respond({
				task_id: TASK_ID,
				status: 'done',
				result_url: `https://storage.googleapis.com/bucket/stylize/${TASK_ID}.glb`,
			});
		};
		const provider = createRegenProvider();
		const job = await provider.submit({ mode: 'stylize', sourceUrl: 'https://three.ws/a.glb', params: {} });
		const result = await provider.status(job.extJobId);
		expect(result.status).toBe('done');
		expect(result.faceCount).toBeUndefined();
	});

	it('still reports remesh topology stats', async () => {
		globalThis.fetch = async (url) => {
			if (String(url).endsWith('/remesh')) return respond({ task_id: TASK_ID });
			return respond({
				task_id: TASK_ID,
				status: 'done',
				result_url: `https://storage.googleapis.com/bucket/remesh/${TASK_ID}.glb`,
				face_count: 50_000,
				quad_ratio: 0.94,
				textured: true,
			});
		};
		const provider = createRegenProvider();
		const job = await provider.submit({ mode: 'remesh', sourceUrl: 'https://three.ws/a.glb', params: {} });
		const result = await provider.status(job.extJobId);
		expect(result.faceCount).toBe(50_000);
		expect(result.quadRatio).toBe(0.94);
		expect(result.textured).toBe(true);
	});
});
