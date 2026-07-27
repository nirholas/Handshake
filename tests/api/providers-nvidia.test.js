// Tests for the free NVIDIA NIM (Microsoft TRELLIS) 3D-generation provider.
//
// Mirrors providers-replicate.test.js: global fetch is stubbed, no live calls.
// This is the backend that gives /forge a zero-vendor-cost text→3D and image→3D
// lane behind the platform NVIDIA_API_KEY, so the contract under test is the
// NVCF invoke → 202 → poll → base64-GLB shape plus the normalized error codes
// the forge layer routes around a dead/limited lane on.
//
// Coverage:
//   1. Submit request construction (text→3D and image→3D) against the schema.
//   2. The 202-then-poll loop: running → done, running → failed, poll timeout.
//   3. Asset-upload branch by image size (inline base64 vs NVCF asset handshake).
//   4. Base64-GLB decode + R2 persist (putObject mocked; asserts decoded bytes
//      in, public URL out).
//   5. Every normalized error mapping (401/403/402/429/5xx/network throw).
//   6. Forge-tiers registration + draft-tier free-first default selection.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createNvidiaProvider } from '../../api/_providers/nvidia.js';
import {
	BACKENDS,
	resolveBackendId,
	backendIsConfigured,
} from '../../api/_lib/forge-tiers.js';

const TRELLIS_INVOKE = 'https://ai.api.nvidia.com/v1/genai/microsoft/trellis';
const NVCF_STATUS = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.NVIDIA_API_KEY;

// persistGlb does a dynamic import of ../_lib/r2.js; intercept it so we can
// assert the decoded GLB bytes flow through to storage and the public URL flows
// back out, without touching real object storage.
const putObjectMock = vi.fn(async () => ({}));
const publicUrlMock = vi.fn((key) => `https://three.ws/cdn/${key}`);
vi.mock('../../api/_lib/r2.js', () => ({
	putObject: (...args) => putObjectMock(...args),
	publicUrl: (...args) => publicUrlMock(...args),
}));

function jsonResponse(body, status = 200, headers = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

beforeEach(() => {
	process.env.NVIDIA_API_KEY = 'nvapi-test-key';
	putObjectMock.mockClear();
	publicUrlMock.mockClear();
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	if (ORIGINAL_KEY === undefined) delete process.env.NVIDIA_API_KEY;
	else process.env.NVIDIA_API_KEY = ORIGINAL_KEY;
	vi.restoreAllMocks();
});

describe('nvidia provider — construction', () => {
	it('refuses to construct without NVIDIA_API_KEY', () => {
		delete process.env.NVIDIA_API_KEY;
		expect(() => createNvidiaProvider()).toThrow(/NVIDIA_API_KEY/);
		try {
			createNvidiaProvider();
		} catch (err) {
			expect(err.code).toBe('missing_key');
			expect(err.status).toBe(503);
		}
	});
});

describe('nvidia provider — text→3D submit', () => {
	function stubAccept() {
		const calls = [];
		globalThis.fetch = vi.fn(async (url, opts = {}) => {
			calls.push({ url: String(url), headers: opts.headers || {}, body: JSON.parse(opts.body) });
			return jsonResponse({}, 202, { 'nvcf-reqid': 'req-text-1' });
		});
		return calls;
	}

	it('builds the TRELLIS text body against the probed schema and returns a poll handle', async () => {
		const calls = stubAccept();
		const provider = createNvidiaProvider();
		const job = await provider.textTo3d({ prompt: 'a tiny brass teapot', tier: 'draft', seed: 7 });

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(TRELLIS_INVOKE);
		expect(calls[0].headers.authorization).toBe('Bearer nvapi-test-key');
		const body = calls[0].body;
		expect(body.mode).toBe('text');
		// buildTextBody runs enhanceTrellisPrompt, which appends a lighting cue when
		// the prompt carries none — keeps draft renders from coming out flat/unlit.
		expect(body.prompt).toBe('a tiny brass teapot, studio lighting');
		expect(body.output_format).toBe('glb');
		expect(body.ss_sampling_steps).toBe(15); // draft tier
		expect(body.slat_sampling_steps).toBe(15);
		expect(body.seed).toBe(7);

		expect(job).toEqual({ kind: 'text-to-3d', taskId: 'req-text-1' });
	});

	it('scales sampling steps by tier and clamps the prompt to 77 chars', async () => {
		const calls = stubAccept();
		const provider = createNvidiaProvider();
		const longPrompt = 'x'.repeat(200);
		await provider.textTo3d({ prompt: longPrompt, tier: { id: 'high' } });

		expect(calls[0].body.ss_sampling_steps).toBe(40); // high tier
		expect(calls[0].body.slat_sampling_steps).toBe(40);
		expect(calls[0].body.prompt).toHaveLength(77);
		// Non-integer seed is omitted, never sent as NaN/garbage.
		expect(calls[0].body).not.toHaveProperty('seed');
	});

	it('pins standard to the hosted preview\'s reliable 15-step budget (not 25)', async () => {
		// 25 steps overruns the hosted gateway's synchronous window — it neither
		// finishes inline nor returns a pollable id before our submit timeout, so the
		// free lane aborts and silently degrades to the paid fallback. Standard must
		// share draft's proven fast budget so it completes on the free lane.
		const calls = stubAccept();
		const provider = createNvidiaProvider();
		await provider.textTo3d({ prompt: 'a small red teapot', tier: 'standard' });

		expect(calls[0].body.ss_sampling_steps).toBe(15);
		expect(calls[0].body.slat_sampling_steps).toBe(15);
	});

	it('errors cleanly when NVCF accepts the job but omits the NVCF-REQID', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({}, 202)); // no nvcf-reqid header
		const provider = createNvidiaProvider();
		await expect(provider.textTo3d({ prompt: 'orb' })).rejects.toMatchObject({
			code: 'provider_error',
			status: 502,
		});
	});
});

describe('nvidia provider — transient 504 retry/backoff', () => {
	// The hosted preview's most common blip is a fast gateway 504 (it gives up on a
	// slow/cold worker). Retrying a couple of times with backoff lands most of them
	// on a warmed node — the lever that stops a transient 504 from tripping the free
	// lane's cooldown and dumping the request on the (often dry) paid lane.
	it('rides out two 504s and then succeeds on the third attempt', async () => {
		let attempts = 0;
		globalThis.fetch = vi.fn(async () => {
			attempts += 1;
			if (attempts < 3) return new Response('gateway timeout', { status: 504 });
			return jsonResponse({}, 202, { 'nvcf-reqid': 'req-after-retry' });
		});
		const provider = createNvidiaProvider();
		const job = await provider.textTo3d({ prompt: 'a brass teapot', tier: 'draft' });
		expect(attempts).toBe(3);
		expect(job).toEqual({ kind: 'text-to-3d', taskId: 'req-after-retry' });
	});

	it('recovers from a single 504 with one retry (the common cold-start case)', async () => {
		let attempts = 0;
		globalThis.fetch = vi.fn(async () => {
			attempts += 1;
			return attempts < 2 ? new Response('t', { status: 504 }) : jsonResponse({}, 202, { 'nvcf-reqid': 'r2' });
		});
		const provider = createNvidiaProvider();
		const job = await provider.textTo3d({ prompt: 'orb' });
		expect(attempts).toBe(2);
		expect(job.taskId).toBe('r2');
	});

	it('fails over fast after a bounded number of attempts when 504s persist', async () => {
		let attempts = 0;
		globalThis.fetch = vi.fn(async () => {
			attempts += 1;
			return new Response('gateway timeout', { status: 504 });
		});
		const provider = createNvidiaProvider();
		await expect(provider.textTo3d({ prompt: 'cube' })).rejects.toMatchObject({
			code: 'provider_error',
			providerStatus: 504,
		});
		// Bounded: it does not hammer a dead gateway indefinitely.
		expect(attempts).toBe(3);
	});
});

describe('nvidia provider — image input is not part of the contract', () => {
	// NVIDIA's hosted TRELLIS preview rejects every user-image input form (only
	// example_id 0–3 sample references are accepted — verified live 2026-06-11,
	// see tasks/nvidia-nim/probes/trellis.md). The provider is therefore
	// text-only by design and the forge layer routes photo submissions to the
	// standing image backend instead. Guard the contract so a future imageTo3d
	// comes back deliberately (with a live re-probe), not by accident.
	it('exposes textTo3d + status only — no imageTo3d', () => {
		globalThis.fetch = vi.fn();
		const provider = createNvidiaProvider();
		expect(typeof provider.textTo3d).toBe('function');
		expect(typeof provider.status).toBe('function');
		expect(provider.imageTo3d).toBeUndefined();
	});
});

describe('nvidia provider — synchronous 200 completion persists the GLB', () => {
	it('decodes the inline base64 GLB, persists the bytes to R2, returns the public URL', async () => {
		const glbBytes = Buffer.from('GLB\0binary-mesh-data');
		const b64 = glbBytes.toString('base64');
		globalThis.fetch = vi.fn(async () => jsonResponse({ artifacts: [{ base64: b64 }] }, 200));

		const provider = createNvidiaProvider();
		const job = await provider.textTo3d({ prompt: 'sphere' });

		// persist helper received the DECODED bytes + the GLB content type.
		expect(putObjectMock).toHaveBeenCalledTimes(1);
		const putArg = putObjectMock.mock.calls[0][0];
		expect(Buffer.isBuffer(putArg.body)).toBe(true);
		expect(putArg.body.equals(glbBytes)).toBe(true);
		expect(putArg.contentType).toBe('model/gltf-binary');
		expect(putArg.key).toMatch(/^forge\/nvidia\/.+\.glb$/);

		// Provider hands back the durable public URL, no poll handle.
		expect(job.kind).toBe('text-to-3d');
		expect(job.taskId).toBeNull();
		expect(job.resultGlbUrl).toBe(`https://three.ws/cdn/${putArg.key}`);
	});
});

describe('nvidia provider — 202-then-poll loop', () => {
	it('reports running while NVCF returns 202', async () => {
		globalThis.fetch = vi.fn(async () => new Response(null, { status: 202 }));
		const provider = createNvidiaProvider();
		const res = await provider.status({ taskId: 'req-1' });
		expect(res.status).toBe('running');
	});

	it('reports done and persists the GLB when the poll returns 200', async () => {
		const glbBytes = Buffer.from('polled-glb-bytes');
		globalThis.fetch = vi.fn(async (url) => {
			expect(String(url)).toBe(`${NVCF_STATUS}/req-1`);
			return jsonResponse({ artifacts: [{ base64: glbBytes.toString('base64') }] }, 200);
		});
		const provider = createNvidiaProvider();
		const res = await provider.status({ taskId: 'req-1' });

		expect(res.status).toBe('done');
		expect(putObjectMock).toHaveBeenCalledTimes(1);
		expect(putObjectMock.mock.calls[0][0].body.equals(glbBytes)).toBe(true);
		expect(res.resultGlbUrl).toBe(`https://three.ws/cdn/${putObjectMock.mock.calls[0][0].key}`);
	});

	it('reports failed when a finished poll carries no GLB artifact', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({ artifacts: [] }, 200));
		const provider = createNvidiaProvider();
		const res = await provider.status({ taskId: 'req-1' });
		expect(res.status).toBe('failed');
		expect(res.error).toMatch(/no GLB/i);
	});

	it('fails terminally on a 401/403 or 404, but keeps polling on 429/5xx', async () => {
		const provider = createNvidiaProvider();

		globalThis.fetch = vi.fn(async () => new Response('no', { status: 403 }));
		expect(await provider.status({ taskId: 'r' })).toMatchObject({ status: 'failed' });

		globalThis.fetch = vi.fn(async () => new Response('gone', { status: 404 }));
		expect(await provider.status({ taskId: 'r' })).toMatchObject({ status: 'failed' });

		globalThis.fetch = vi.fn(async () => new Response('slow down', { status: 429 }));
		expect(await provider.status({ taskId: 'r' })).toMatchObject({ status: 'running' });

		globalThis.fetch = vi.fn(async () => new Response('boom', { status: 503 }));
		expect(await provider.status({ taskId: 'r' })).toMatchObject({ status: 'running' });
	});

	it('keeps the job alive on a poll timeout / network throw', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
		});
		const provider = createNvidiaProvider();
		const res = await provider.status({ taskId: 'req-1' });
		expect(res.status).toBe('running');
		expect(res.error).toMatch(/poll failed/i);
	});

	it('fails fast when asked to poll with no task id', async () => {
		const provider = createNvidiaProvider();
		const res = await provider.status({});
		expect(res.status).toBe('failed');
		expect(res.error).toMatch(/missing/i);
	});

	it('reports failed when the GLB persist throws mid-poll', async () => {
		putObjectMock.mockRejectedValueOnce(new Error('R2 down'));
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ artifacts: [{ base64: Buffer.from('x').toString('base64') }] }, 200),
		);
		const provider = createNvidiaProvider();
		const res = await provider.status({ taskId: 'req-1' });
		expect(res.status).toBe('failed');
		expect(res.error).toMatch(/persist/i);
	});
});

describe('nvidia provider — normalized error mapping on submit', () => {
	const cases = [
		{ status: 401, code: 'invalid_key', mapped: 401 },
		{ status: 403, code: 'invalid_key', mapped: 401 },
		{ status: 402, code: 'insufficient_credits', mapped: 402 },
		{ status: 429, code: 'rate_limited', mapped: 429 },
		{ status: 500, code: 'provider_error', mapped: 502 },
		{ status: 503, code: 'provider_error', mapped: 502 },
	];

	for (const c of cases) {
		it(`maps HTTP ${c.status} → ${c.code}`, async () => {
			globalThis.fetch = vi.fn(async () =>
				jsonResponse({ detail: `upstream said ${c.status}` }, c.status),
			);
			const provider = createNvidiaProvider();
			await expect(provider.textTo3d({ prompt: 'cube' })).rejects.toMatchObject({
				code: c.code,
				status: c.mapped,
				providerStatus: c.status,
			});
		});
	}

	it('attaches retryAfter (seconds) from the 429 Retry-After header', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({ detail: 'slow down' }, 429, { 'retry-after': '30' }));
		const provider = createNvidiaProvider();
		await expect(provider.textTo3d({ prompt: 'cube' })).rejects.toMatchObject({
			code: 'rate_limited',
			retryAfter: 30,
		});
	});

	it('maps a network throw on submit → provider_unreachable', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new TypeError('fetch failed');
		});
		const provider = createNvidiaProvider();
		await expect(provider.textTo3d({ prompt: 'cube' })).rejects.toMatchObject({
			code: 'provider_unreachable',
			status: 502,
		});
	});

	it('surfaces a TRELLIS 422 validation array as readable detail, not [object Object]', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ detail: [{ loc: ['body', 'prompt'], msg: 'field required' }] }, 422),
		);
		const provider = createNvidiaProvider();
		await expect(provider.textTo3d({ prompt: '' })).rejects.toMatchObject({
			code: 'provider_error',
			providerStatus: 422,
		});
		await provider.textTo3d({ prompt: '' }).catch((err) => {
			expect(err.message).toContain('field required');
		});
	});
});

describe('nvidia provider — forge-tiers registration', () => {
	const prevKey = process.env.NVIDIA_API_KEY;
	afterEach(() => {
		if (prevKey === undefined) delete process.env.NVIDIA_API_KEY;
		else process.env.NVIDIA_API_KEY = prevKey;
	});

	it('registers the platform-keyed free nvidia image backend', () => {
		expect(BACKENDS.nvidia.provider).toBe('nvidia');
		expect(BACKENDS.nvidia.paths).toContain('image');
		expect(BACKENDS.nvidia.free).toBe(true);
		expect(BACKENDS.nvidia.requiresEnv).toContain('NVIDIA_API_KEY');
	});

	it('selects nvidia as the draft default only when NVIDIA_API_KEY is set', () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test-key';
		expect(backendIsConfigured('nvidia')).toBe(true);
		expect(resolveBackendId({ path: 'image', tier: 'draft' })).toBe('nvidia');

		delete process.env.NVIDIA_API_KEY;
		expect(backendIsConfigured('nvidia')).toBe(false);
		// Cleanly skipped → the standing Replicate TRELLIS default takes over.
		expect(resolveBackendId({ path: 'image', tier: 'draft' })).toBe('trellis');
	});

	it('stays explicitly selectable even when its key is absent', () => {
		delete process.env.NVIDIA_API_KEY;
		expect(resolveBackendId({ path: 'image', tier: 'standard', backend: 'nvidia' })).toBe('nvidia');
	});
});
