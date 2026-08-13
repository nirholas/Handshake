// NVIDIA Cosmos provider (api/_providers/nvidia-cosmos.js) — the free
// text→world VIDEO lane behind the platform NVIDIA_API_KEY.
//
// Same NVCF async gateway as the TRELLIS provider (202 + NVCF-REQID → poll
// pexec/status), so the contract under test is: the KServe `command` invoke
// body, the 202-then-poll loop, the several result shapes the hosted preview
// ships the MP4 in, the R2 persist, and the normalized error codes callers
// route a dead lane around on.
//
// global fetch is stubbed and R2 is intercepted — no network, no live NVCF
// spend, and no mocked product data.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createNvidiaCosmosProvider,
	nvidiaCosmosConfigured,
} from '../../api/_providers/nvidia-cosmos.js';

const DEFAULT_INVOKE = 'https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos-predict1-7b';
const NVCF_STATUS = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status';

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['NVIDIA_API_KEY', 'NVIDIA_COSMOS_INVOKE_URL'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// persistVideo dynamically imports ../_lib/r2.js; intercept it so the decoded
// MP4 bytes and the returned public URL are assertable without object storage.
const putObjectMock = vi.fn(async () => ({}));
const publicUrlMock = vi.fn((key) => `https://three.ws/cdn/${key}`);
vi.mock('../../api/_lib/r2.js', () => ({
	putObject: (...args) => putObjectMock(...args),
	publicUrl: (...args) => publicUrlMock(...args),
}));

// A base64 blob only counts as inline video above the module's 64-char floor.
const MP4_BYTES = Buffer.from('x'.repeat(256), 'utf8');
const MP4_B64 = MP4_BYTES.toString('base64');

function jsonResponse(body, status = 200, headers = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

beforeEach(() => {
	process.env.NVIDIA_API_KEY = 'nvapi-test-key';
	delete process.env.NVIDIA_COSMOS_INVOKE_URL;
	putObjectMock.mockClear();
	publicUrlMock.mockClear();
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	for (const k of ENV_KEYS) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
	vi.restoreAllMocks();
});

describe('nvidia-cosmos provider — configuration', () => {
	it('reports configured only while NVIDIA_API_KEY is present', () => {
		expect(nvidiaCosmosConfigured()).toBe(true);
		delete process.env.NVIDIA_API_KEY;
		expect(nvidiaCosmosConfigured()).toBe(false);
	});

	it('refuses to construct without NVIDIA_API_KEY', () => {
		delete process.env.NVIDIA_API_KEY;
		expect(() => createNvidiaCosmosProvider()).toThrow(/NVIDIA_API_KEY/);
		try {
			createNvidiaCosmosProvider();
		} catch (err) {
			expect(err.code).toBe('missing_key');
			expect(err.status).toBe(503);
		}
	});
});

describe('nvidia-cosmos provider — text→world submit', () => {
	function stubAccept() {
		const calls = [];
		globalThis.fetch = vi.fn(async (url, opts = {}) => {
			calls.push({ url: String(url), headers: opts.headers || {}, body: JSON.parse(opts.body) });
			return jsonResponse({}, 202, { 'nvcf-reqid': 'req-world-1' });
		});
		return calls;
	}

	it('builds the KServe text2world command body and returns the poll handle', async () => {
		const calls = stubAccept();
		const provider = createNvidiaCosmosProvider();
		const job = await provider.textToWorld({ prompt: 'a rainy tokyo alley', seed: 11 });

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(DEFAULT_INVOKE);
		expect(calls[0].headers.authorization).toBe('Bearer nvapi-test-key');
		// The gateway must cap its synchronous hold, or a slow render burns our
		// socket and the pollable request id is lost with it.
		expect(calls[0].headers['nvcf-poll-seconds']).toBe('30');

		const input = calls[0].body.inputs[0];
		expect(input.name).toBe('command');
		expect(input.datatype).toBe('BYTES');
		const command = input.data[0];
		expect(command.startsWith('text2world ')).toBe(true);
		expect(command).toContain('a rainy tokyo alley');
		// A styleless prompt gets the cinematic suffix so the backdrop is not muted.
		expect(command).toContain('cinematic lighting');
		expect(command).toContain('--seed=11');

		expect(job).toEqual({ taskId: 'req-world-1' });
	});

	it('leaves a prompt that already carries style cues alone and omits an absent seed', async () => {
		const calls = stubAccept();
		const provider = createNvidiaCosmosProvider();
		await provider.textToWorld({ prompt: 'neon skyline at golden hour' });

		const command = calls[0].body.inputs[0].data[0];
		expect(command).toContain('neon skyline at golden hour');
		expect(command).not.toContain('cinematic lighting');
		expect(command).not.toContain('--seed');
	});

	it('escapes double quotes so the command line stays parseable', async () => {
		const calls = stubAccept();
		const provider = createNvidiaCosmosProvider();
		await provider.textToWorld({ prompt: 'a sign reading "OPEN"' });

		const command = calls[0].body.inputs[0].data[0];
		expect(command).toContain("a sign reading 'OPEN'");
		expect(command.match(/"/g)).toHaveLength(2); // only the --prompt="…" wrapper
	});

	it('persists the MP4 and returns a durable URL when NVCF completes synchronously', async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } }),
		);

		const provider = createNvidiaCosmosProvider();
		const job = await provider.textToWorld({ prompt: 'a desert storm' });

		expect(job.taskId).toBeNull();
		expect(job.resultVideoUrl).toMatch(/^https:\/\/three\.ws\/cdn\/forge\/cosmos\/.*\.mp4$/);
		const stored = putObjectMock.mock.calls[0][0];
		expect(stored.contentType).toBe('video/mp4');
		expect(Buffer.from(stored.body).equals(MP4_BYTES)).toBe(true);
	});

	it('falls through to the poll path when a 200 carries a request id but no video', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({ outputs: [] }, 200, { 'nvcf-reqid': 'req-late' }));
		const provider = createNvidiaCosmosProvider();
		const job = await provider.textToWorld({ prompt: 'a quiet harbour' });
		expect(job).toEqual({ taskId: 'req-late' });
		expect(putObjectMock).not.toHaveBeenCalled();
	});

	it('errors cleanly when NVCF accepts the job but omits the NVCF-REQID', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse({}, 202));
		const provider = createNvidiaCosmosProvider();
		await expect(provider.textToWorld({ prompt: 'x' })).rejects.toMatchObject({
			code: 'provider_error',
			status: 502,
		});
	});

	it('honors NVIDIA_COSMOS_INVOKE_URL so the gateway path moves without a redeploy', async () => {
		process.env.NVIDIA_COSMOS_INVOKE_URL = 'https://nim.internal.test/v1/cosmos';
		const calls = stubAccept();
		const provider = createNvidiaCosmosProvider();
		await provider.textToWorld({ prompt: 'x' });
		expect(calls[0].url).toBe('https://nim.internal.test/v1/cosmos');
	});
});

describe('nvidia-cosmos provider — normalized submit errors', () => {
	const CASES = [
		{ status: 401, code: 'invalid_key', mapped: 401 },
		{ status: 403, code: 'invalid_key', mapped: 401 },
		{ status: 402, code: 'insufficient_credits', mapped: 402 },
		{ status: 429, code: 'rate_limited', mapped: 429 },
		{ status: 400, code: 'provider_error', mapped: 502 },
	];

	for (const c of CASES) {
		it(`maps HTTP ${c.status} → ${c.code}`, async () => {
			globalThis.fetch = vi.fn(async () => jsonResponse({ detail: 'upstream said no' }, c.status));
			const provider = createNvidiaCosmosProvider();
			await expect(provider.textToWorld({ prompt: 'x' })).rejects.toMatchObject({
				code: c.code,
				status: c.mapped,
				providerStatus: c.status,
			});
		});
	}

	it('attaches retryAfter (seconds) from a 429 Retry-After header', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ detail: 'slow down' }, 429, { 'retry-after': '9' }),
		);
		const provider = createNvidiaCosmosProvider();
		await expect(provider.textToWorld({ prompt: 'x' })).rejects.toMatchObject({
			code: 'rate_limited',
			retryAfter: 9,
		});
	});

	it('treats a submit timeout as terminal instead of stacking another full window', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw Object.assign(new Error('The operation was aborted due to timeout'), {
				name: 'TimeoutError',
			});
		});
		const provider = createNvidiaCosmosProvider();
		await expect(provider.textToWorld({ prompt: 'x' })).rejects.toMatchObject({
			code: 'provider_unreachable',
			status: 502,
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('retries once through a transient gateway 503 and then succeeds', async () => {
		let attempt = 0;
		globalThis.fetch = vi.fn(async () => {
			attempt += 1;
			if (attempt === 1) return new Response('cold start', { status: 503 });
			return jsonResponse({}, 202, { 'nvcf-reqid': 'req-warm' });
		});
		const provider = createNvidiaCosmosProvider();
		const job = await provider.textToWorld({ prompt: 'x' });
		expect(attempt).toBe(2);
		expect(job).toEqual({ taskId: 'req-warm' });
	});
});

describe('nvidia-cosmos provider — 202-then-poll loop', () => {
	it('reports running while NVCF returns 202', async () => {
		globalThis.fetch = vi.fn(async (url) => {
			expect(String(url)).toBe(`${NVCF_STATUS}/req-world-1`);
			return new Response(null, { status: 202 });
		});
		const provider = createNvidiaCosmosProvider();
		expect(await provider.status({ taskId: 'req-world-1' })).toEqual({ status: 'running' });
	});

	it('decodes the KServe base64 output, persists it, and reports done', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ outputs: [{ name: 'video', datatype: 'BYTES', data: [MP4_B64] }] }),
		);
		const provider = createNvidiaCosmosProvider();
		const res = await provider.status({ taskId: 'req-world-1' });

		expect(res.status).toBe('done');
		expect(res.resultVideoUrl).toMatch(/^https:\/\/three\.ws\/cdn\/forge\/cosmos\/.*\.mp4$/);
		expect(Buffer.from(putObjectMock.mock.calls[0][0].body).equals(MP4_BYTES)).toBe(true);
	});

	it('fetches an artifact URL result and persists those bytes instead', async () => {
		const cdn = 'https://assets.nvidia.test/cosmos/world.mp4';
		globalThis.fetch = vi.fn(async (url) => {
			if (String(url) === cdn) {
				return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } });
			}
			return jsonResponse({ artifacts: [{ url: cdn }] });
		});
		const provider = createNvidiaCosmosProvider();
		const res = await provider.status({ taskId: 'req-world-1' });

		expect(res.status).toBe('done');
		expect(Buffer.from(putObjectMock.mock.calls[0][0].body).equals(MP4_BYTES)).toBe(true);
	});

	it('reports failed when a finished poll carries no recognizable video', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		globalThis.fetch = vi.fn(async () => jsonResponse({ status: 'complete' }));
		const provider = createNvidiaCosmosProvider();
		const res = await provider.status({ taskId: 'req-world-1' });
		expect(res.status).toBe('failed');
		expect(res.error).toMatch(/no video/i);
		expect(putObjectMock).not.toHaveBeenCalled();
	});

	it('reports failed when the persist throws mid-poll', async () => {
		putObjectMock.mockRejectedValueOnce(new Error('bucket unreachable'));
		globalThis.fetch = vi.fn(async () => jsonResponse({ b64_video: MP4_B64 }));
		const provider = createNvidiaCosmosProvider();
		const res = await provider.status({ taskId: 'req-world-1' });
		expect(res.status).toBe('failed');
		expect(res.error).toMatch(/failed to persist video: bucket unreachable/);
	});

	it('fails terminally on 401/404 but keeps polling on 429 and 5xx', async () => {
		const provider = createNvidiaCosmosProvider();

		for (const status of [401, 403, 404]) {
			globalThis.fetch = vi.fn(async () => new Response(null, { status }));
			expect((await provider.status({ taskId: 't' })).status, `status ${status}`).toBe('failed');
		}
		for (const status of [429, 500, 503]) {
			globalThis.fetch = vi.fn(async () => new Response(null, { status }));
			expect((await provider.status({ taskId: 't' })).status, `status ${status}`).toBe('running');
		}
	});

	it('keeps the job alive on a poll network throw', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('socket hang up');
		});
		const provider = createNvidiaCosmosProvider();
		const res = await provider.status({ taskId: 't' });
		expect(res.status).toBe('running');
		expect(res.error).toMatch(/poll failed: socket hang up/);
	});

	it('fails fast when asked to poll with no request id', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('should not be called');
		});
		const provider = createNvidiaCosmosProvider();
		expect(await provider.status({})).toEqual({
			status: 'failed',
			error: 'missing NVCF request id',
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
