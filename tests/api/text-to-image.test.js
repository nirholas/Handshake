// Tests for the text→image provider chain behind text→3D.
//
// Regression cover for the production outage where a mangled
// GCP_SERVICE_ACCOUNT_JSON took down ALL text→3D generation:
//   • vertex-imagen must reject mangled service-account JSON with a designed
//     `unconfigured` error, not a raw JSON.parse SyntaxError.
//   • textToImage must fall back to Replicate flux when the preferred Vertex
//     path throws for any reason (it previously trusted isConfigured(), which
//     only checks GOOGLE_CLOUD_PROJECT, and never fell back).
//   • A Vertex data: URI result must be persisted to object storage and
//     returned as an https URL (Replicate caps inline data URIs well below an
//     Imagen PNG's size, so forwarding the data URI breaks reconstruction).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cacheDel } from '../../api/_lib/cache.js';

const vertexState = { configured: false, generate: null };
vi.mock('../../api/_mcp3d/vertex-imagen.js', () => ({
	isConfigured: () => vertexState.configured,
	generateImage: (...a) => vertexState.generate(...a),
}));

const r2State = { puts: [] };
vi.mock('../../api/_lib/r2.js', () => ({
	putObject: async (args) => {
		r2State.puts.push(args);
	},
	publicUrl: (key) => `https://cdn.example/${key}`,
}));

// The Replicate text→image submit is paced through forge-scale's rate gate. The
// gate itself fails open without Redis (its own unit tests cover that); here we
// drive it deterministically so we can assert the queue/shed behavior of the
// caller. Defaults to "slot granted, no wait" so every other test is unaffected.
const rateState = { result: { ok: true, waitMs: 0 } };
vi.mock('../../api/_lib/forge-scale.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, reserveProviderRateSlot: vi.fn(async () => rateState.result) };
});

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
	'NVIDIA_API_KEY',
	'GOOGLE_CLOUD_PROJECT',
	'GCP_SERVICE_ACCOUNT_JSON',
	'REPLICATE_API_TOKEN',
	'VERTEX_IMAGEN_ENABLED',
	'VERTEX_IMAGEN_FIRST',
	'LIVEPEER_FEDERATION_ENABLED',
	'LIVEPEER_GATEWAY_URL',
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

async function freshTextToImage() {
	const mod = await import('../../api/_mcp3d/text-to-image.js?t=' + Math.random());
	return mod.textToImage;
}

// Route a mocked fetch by host so a single test can exercise the full fallback
// chain (NIM → Vertex → Replicate) and assert which lanes were actually hit.
// Each route is [substringMatch, () => Response]; the first match wins.
function stubFetch(routes) {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, opts = {}) => {
		const u = String(url);
		calls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
		for (const [match, responder] of routes) {
			if (u.includes(match)) return responder();
		}
		throw new Error(`unexpected fetch in test: ${u}`);
	});
	return calls;
}

// NIM FLUX artifacts are JPEG (probed live, tasks/nvidia-nim/probes/flux.md),
// so the fixture carries real JPEG magic bytes (ff d8 ff) for the format sniff.
const NIM_JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('nim-jpeg-bytes')]);

function nimSuccessResponse(b64 = NIM_JPEG_BYTES.toString('base64')) {
	return new Response(JSON.stringify({ artifacts: [{ base64: b64, finishReason: 'SUCCESS' }] }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

function replicateSuccessResponse(url = 'https://replicate.delivery/out.png') {
	return new Response(JSON.stringify({ id: 'pred_flux', status: 'succeeded', output: [url] }), {
		status: 201,
		headers: { 'content-type': 'application/json' },
	});
}

function stubFluxSuccess() {
	return stubFetch([['api.replicate.com', () => replicateSuccessResponse()]]);
}

beforeEach(async () => {
	vertexState.configured = false;
	vertexState.generate = null;
	r2State.puts.length = 0;
	rateState.result = { ok: true, waitMs: 0 };
	for (const k of ENV_KEYS) delete process.env[k];
	// The NIM FLUX circuit breaker persists a short cooldown in the shared in-memory
	// cache; clear it between tests so one test's induced NIM failure doesn't make a
	// later test skip the (now healthy) NIM lane it means to exercise.
	await cacheDel('llm-cooldown:forge-nim-flux');
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	for (const k of ENV_KEYS) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
	vi.restoreAllMocks();
});

describe('textToImage: Vertex quality lane leads by default', () => {
	it('serves from Vertex before NIM when both are configured (credit-burner first)', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		vertexState.configured = true;
		const png = Buffer.from('vertex-first-png').toString('base64');
		vertexState.generate = vi.fn(async () => ({
			imageUrl: `data:image/png;base64,${png}`,
			model: 'vertex-ai/gemini-2.5-flash-image',
		}));
		const calls = stubFetch([['ai.api.nvidia.com', () => nimSuccessResponse()]]);

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		expect(result.model).toBe('vertex-ai/gemini-2.5-flash-image');
		expect(vertexState.generate).toHaveBeenCalledOnce();
		expect(calls).toHaveLength(0); // NIM never touched, Vertex led and served
	});

	it('falls from a failed Vertex lead to NIM without surfacing an error', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		vertexState.configured = true;
		vertexState.generate = vi.fn(async () => {
			throw new Error('vertex down');
		});
		const calls = stubFetch([['ai.api.nvidia.com', () => nimSuccessResponse()]]);
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		expect(result.model).toBe('black-forest-labs/flux.1-dev');
		expect(vertexState.generate).toHaveBeenCalledOnce();
		expect(calls).toHaveLength(1);
	});

	it('VERTEX_IMAGEN_FIRST=0 restores the legacy NIM-first order', async () => {
		process.env.VERTEX_IMAGEN_FIRST = '0';
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		vertexState.configured = true;
		vertexState.generate = vi.fn(async () => ({ imageUrl: 'data:image/png;base64,AAAA' }));
		const calls = stubFetch([['ai.api.nvidia.com', () => nimSuccessResponse()]]);

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		expect(result.model).toBe('black-forest-labs/flux.1-dev');
		expect(vertexState.generate).not.toHaveBeenCalled();
		expect(calls).toHaveLength(1);
	});
});

describe('textToImage: NIM FLUX free lane (legacy NIM-first order)', () => {
	beforeEach(() => {
		// These pin the legacy ladder (NIM → Vertex → Replicate), preserved
		// behind VERTEX_IMAGEN_FIRST=0.
		process.env.VERTEX_IMAGEN_FIRST = '0';
	});

	it('serves from NIM and never touches Vertex or Replicate', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		vertexState.configured = true;
		vertexState.generate = vi.fn(async () => ({ imageUrl: 'data:image/png;base64,AAAA' }));
		const calls = stubFetch([['ai.api.nvidia.com', () => nimSuccessResponse()]]);

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		expect(result.model).toBe('black-forest-labs/flux.1-dev');
		// NIM output is JPEG, persisted bytes, key extension, and Content-Type
		// must all say jpeg, not png (regression cover for the probe finding).
		expect(result.imageUrl).toMatch(/^https:\/\/cdn\.example\/forge\/refs\/.+\.jpg$/);
		// NIM artifact persisted to R2; Vertex and Replicate left untouched.
		expect(r2State.puts).toHaveLength(1);
		expect(r2State.puts[0].contentType).toBe('image/jpeg');
		expect(r2State.puts[0].key).toMatch(/\.jpg$/);
		expect(Buffer.compare(r2State.puts[0].body, NIM_JPEG_BYTES)).toBe(0);
		expect(vertexState.generate).not.toHaveBeenCalled();
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toContain('flux.1-dev');
		expect(calls[0].body.prompt).toMatch(/^a red teapot/);
		expect(calls[0].body).toMatchObject({ steps: 20, cfg_scale: 3.5 });
		// schnell is guidance-distilled: the endpoint 422s on cfg_scale > 0
		// (verified live), so the request must not send it at all.
		expect(calls[0].body).not.toHaveProperty('cfg_scale');
	});

	it('maps aspect ratio to FLUX pixel dimensions', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		const calls = stubFetch([['ai.api.nvidia.com', () => nimSuccessResponse()]]);

		const textToImage = await freshTextToImage();
		await textToImage('a wide vista', { aspectRatio: '16:9' });

		expect(calls[0].body).toMatchObject({ width: 1344, height: 768 });
	});

	it('falls through to Vertex when NIM fails', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		vertexState.configured = true;
		const png = Buffer.from('vertex-png').toString('base64');
		vertexState.generate = vi.fn(async () => ({
			imageUrl: `data:image/png;base64,${png}`,
			model: 'vertex-ai/imagen-3.0-generate-001',
		}));
		const calls = stubFetch([['ai.api.nvidia.com', () => new Response('upstream boom', { status: 500 })]]);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		expect(result.model).toBe('vertex-ai/imagen-3.0-generate-001');
		expect(vertexState.generate).toHaveBeenCalledOnce();
		expect(calls).toHaveLength(1); // NIM was attempted exactly once before handoff
		expect(Buffer.compare(r2State.puts[0].body, Buffer.from('vertex-png'))).toBe(0);
	});

	it('falls all the way through NIM → Vertex → Replicate', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		vertexState.configured = true;
		vertexState.generate = vi.fn(async () => {
			throw Object.assign(new Error('vertex down'), { code: 'unconfigured' });
		});
		// 500 is a terminal upstream fault (not a retryable gateway 502/503/504), so
		// NIM is attempted once and the chain cascades straight through.
		const calls = stubFetch([
			['ai.api.nvidia.com', () => new Response('boom', { status: 500 })],
			['api.replicate.com', () => replicateSuccessResponse()],
		]);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		expect(result.imageUrl).toBe('https://replicate.delivery/out.png');
		expect(vertexState.generate).toHaveBeenCalledOnce();
		expect(calls.filter((c) => c.url.includes('ai.api.nvidia.com'))).toHaveLength(1);
		expect(calls.some((c) => c.url.includes('api.replicate.com'))).toBe(true);
	});

	it('retries a transient NIM gateway 504 once, then succeeds inline', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		let nimHits = 0;
		const calls = stubFetch([
			[
				'ai.api.nvidia.com',
				() => {
					nimHits += 1;
					// First hit: a fast gateway 504 (cold model / routing blip).
					// Second hit: the warmed model returns the artifact.
					return nimHits === 1 ? new Response('gateway timeout', { status: 504 }) : nimSuccessResponse();
				},
			],
		]);

		vi.useFakeTimers();
		try {
			const textToImage = await freshTextToImage();
			const p = textToImage('a red teapot');
			await vi.advanceTimersByTimeAsync(2_000); // let the retry backoff elapse
			const result = await p;
			expect(result.model).toBe('black-forest-labs/flux.1-dev');
			expect(calls.filter((c) => c.url.includes('ai.api.nvidia.com'))).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does NOT retry a NIM timeout: hands off immediately to avoid a double wait', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		const calls = stubFetch([
			[
				'ai.api.nvidia.com',
				() => {
					// Emulate the AbortController firing: a timeout, not a gateway status.
					const err = new Error('aborted');
					err.name = 'TimeoutError';
					throw err;
				},
			],
			['api.replicate.com', () => replicateSuccessResponse()],
		]);
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		expect(result.imageUrl).toBe('https://replicate.delivery/out.png');
		// NIM attempted exactly once, a timeout already burned the full window.
		expect(calls.filter((c) => c.url.includes('ai.api.nvidia.com'))).toHaveLength(1);
	});

	// There is no "only configured lane" any more: keyless Pollinations always
	// sits behind the keyed rungs. NIM's failure is logged and the ladder walks
	// on; the terminal error is the LAST rung's, so a diagnosis reads the warns.
	it('walks past a NIM failure to the keyless rung, and the terminal error is the last rung\'s', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		const calls = stubFetch([
			['ai.api.nvidia.com', () => new Response('nope', { status: 401 })],
			['image.pollinations.ai', () => new Response('down', { status: 503 })],
		]);
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		const textToImage = await freshTextToImage();
		await expect(textToImage('a red teapot')).rejects.toThrow(/pollinations returned 503/);
		expect(calls.some((c) => c.url.includes('ai.api.nvidia.com'))).toBe(true);
	});

	it('skipNim bypasses the NIM lane entirely when a fallback exists', async () => {
		// A caller that just watched a sibling NVCF lane time out passes skipNim so the
		// degraded gateway never gets a second submit-timeout window this request.
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		const calls = stubFetch([['api.replicate.com', () => replicateSuccessResponse()]]);

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot', { skipNim: true });

		expect(result.imageUrl).toBe('https://replicate.delivery/out.png');
		expect(calls.some((c) => c.url.includes('ai.api.nvidia.com'))).toBe(false);
	});

	it('skipNim with no keyed fallback still lands on the keyless rung, never a dead end', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		const calls = stubFetch([
			['ai.api.nvidia.com', () => nimSuccessResponse()],
			['image.pollinations.ai', () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), { status: 200, headers: { 'content-type': 'image/jpeg' } })],
		]);

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot', { skipNim: true });

		expect(result.model).toBe('pollinations/flux');
		expect(calls.some((c) => c.url.includes('ai.api.nvidia.com'))).toBe(false);
	});

	it('a degraded NIM failure cools the lane so the next call skips it', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		const calls = stubFetch([
			['ai.api.nvidia.com', () => new Response('boom', { status: 500 })],
			['api.replicate.com', () => replicateSuccessResponse()],
		]);
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		const textToImage = await freshTextToImage();
		// First call trips the breaker (NIM 500 → cooldown), still serves via Replicate.
		await textToImage('a red teapot');
		const nimAfterFirst = calls.filter((c) => c.url.includes('ai.api.nvidia.com')).length;
		expect(nimAfterFirst).toBe(1);

		// Second call sees the cooldown and skips NIM straight to Replicate, no new NIM hit.
		await textToImage('a blue teapot');
		const nimAfterSecond = calls.filter((c) => c.url.includes('ai.api.nvidia.com')).length;
		expect(nimAfterSecond).toBe(1);
	});
});

// The Livepeer federation lane sits between the first-party free lanes and the
// paid Replicate backstop. It is a real downstream lane, so the ladder's
// "is there anything left to try" test has to count it: before this cover, a
// deployment whose ONLY downstream lane was Livepeer threw the upstream lane's
// error instead of handing off, and the configured federated lane never ran.
function livepeerSuccessResponse(url = 'https://gateway.test/images/out.png') {
	return new Response(JSON.stringify({ images: [{ url, seed: 1, nsfw: false }] }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

// A Livepeer job is TWO fetches against the same gateway host: POST
// /text-to-image returns the job JSON, then the artifact URL it names is
// downloaded and magic-byte verified before the lane is allowed to succeed.
// Route the artifact path FIRST (stubFetch is first-match-wins on a substring)
// so the download gets real PNG bytes instead of the job JSON, which the
// provider correctly rejects as "no image signature".
// A real PNG signature padded past the provider's 1 KB size floor, the same
// fixture shape tests/livepeer-federation.test.js uses.
const LIVEPEER_PNG_BYTES = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(2048, 1),
]);

function livepeerRoutes() {
	return [
		[
			'gateway.test/images/',
			() =>
				new Response(LIVEPEER_PNG_BYTES, {
					status: 200,
					headers: { 'content-type': 'image/png' },
				}),
		],
		['gateway.test', () => livepeerSuccessResponse()],
	];
}

describe('textToImage: Livepeer federation lane counts as a real fallback', () => {
	beforeEach(() => {
		process.env.LIVEPEER_FEDERATION_ENABLED = '1';
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.test';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('hands a failed NIM lane off to Livepeer when it is the only lane downstream', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		const calls = stubFetch([
			['ai.api.nvidia.com', () => new Response('boom', { status: 500 })],
			...livepeerRoutes(),
		]);

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		// The verified artifact is persisted to our own storage, so the lane
		// returns the durable CDN URL, never the gateway's ephemeral one.
		expect(result.imageUrl).toMatch(/^https:\/\/cdn\.example\/forge\/refs\/.+\.png$/);
		expect(result.lane).toBe('livepeer');
		expect(calls.some((c) => c.url.includes('gateway.test/images/'))).toBe(true);
	});

	it('hands a failed Vertex lead off to Livepeer when it is the only lane downstream', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		vertexState.configured = true;
		vertexState.generate = async () => {
			throw new Error('vertex exploded');
		};
		const calls = stubFetch(livepeerRoutes());

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		expect(result.imageUrl).toMatch(/^https:\/\/cdn\.example\/forge\/refs\/.+\.png$/);
		expect(result.lane).toBe('livepeer');
		expect(calls.some((c) => c.url.includes('gateway.test/images/'))).toBe(true);
	});

	it('with Livepeer off, the keyless rung is what stands between NIM and a dead end', async () => {
		delete process.env.LIVEPEER_FEDERATION_ENABLED;
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		const calls = stubFetch([
			['ai.api.nvidia.com', () => new Response('nope', { status: 401 })],
			['image.pollinations.ai', () => new Response('down', { status: 503 })],
		]);
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		const textToImage = await freshTextToImage();
		await expect(textToImage('a red teapot')).rejects.toThrow(/pollinations returned 503/);
		expect(calls.some((c) => c.url.includes('gateway.test'))).toBe(false);
	});
});

describe('textToImage: Vertex → Replicate fallback', () => {
	it('falls back to Replicate flux when the Vertex path throws', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		vertexState.configured = true;
		vertexState.generate = async () => {
			throw Object.assign(new Error('GCP_SERVICE_ACCOUNT_JSON is set but is not valid'), {
				code: 'unconfigured',
			});
		};
		const calls = stubFluxSuccess();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		expect(result.imageUrl).toBe('https://replicate.delivery/out.png');
		expect(calls.some((c) => c.url.includes('flux-schnell'))).toBe(true);
	});

	it('rethrows the Vertex error when no Replicate token exists to fall back to', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		vertexState.configured = true;
		vertexState.generate = async () => {
			throw Object.assign(new Error('vertex broke'), { code: 'unconfigured' });
		};

		const textToImage = await freshTextToImage();
		await expect(textToImage('a red teapot')).rejects.toThrow('vertex broke');
	});

	it('classifies a Replicate 429 as rate_limited without leaking the account credit balance', async () => {
		// The production incident: a low-credit Replicate account throttles
		// prediction creation and its `detail` names the balance. We must parse the
		// reset hint for backoff and keep the raw detail for logs (providerDetail),
		// but the surfaced message must be clean, no credit numbers, no $ amounts.
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		const RAW_DETAIL =
			'Request was throttled. Your rate limit for creating predictions is reduced to 6 requests ' +
			'per minute with a burst of 1 requests while you have less than $5.0 in credit. ' +
			'Your rate limit resets in ~10s.';
		stubFetch([
			[
				'api.replicate.com',
				() =>
					new Response(JSON.stringify({ detail: RAW_DETAIL }), {
						status: 429,
						headers: { 'content-type': 'application/json' },
					}),
			],
		]);
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		const textToImage = await freshTextToImage();
		const caught = await textToImage('a red teapot').then(
			() => null,
			(e) => e,
		);
		expect(caught).toBeTruthy();
		expect(caught.code).toBe('rate_limited');
		expect(caught.retryAfter).toBe(10); // parsed from "resets in ~10s"
		expect(caught.providerDetail).toBe(RAW_DETAIL); // retained for server logs
		expect(caught.message).toBe('Image generation is briefly busy upstream, please retry in a few seconds.');
		expect(caught.message).not.toMatch(/credit|\$5|throttl|rate limit/i);
	});

	it('queues against the Replicate rate gate and waits for the reserved slot before submitting', async () => {
		// Under the reduced-rate account state Replicate paces creation to 6/min; the
		// gate reserves the next slot and tells us to hold for it. We must wait out
		// that slot, THEN submit, never fire early into a throttle 429.
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		rateState.result = { ok: true, waitMs: 5_000 };
		const calls = stubFetch([['api.replicate.com', () => replicateSuccessResponse()]]);

		vi.useFakeTimers();
		try {
			const textToImage = await freshTextToImage();
			const p = textToImage('a red teapot');
			// Mid-wait: the reserved slot has not opened, so no prediction is created yet.
			await vi.advanceTimersByTimeAsync(4_000);
			expect(calls.some((c) => c.url.includes('api.replicate.com'))).toBe(false);
			// Slot opens, the submit fires and resolves.
			await vi.advanceTimersByTimeAsync(2_000);
			const result = await p;
			expect(result.imageUrl).toBe('https://replicate.delivery/out.png');
			expect(calls.some((c) => c.url.includes('api.replicate.com'))).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('sheds to a queued rate-limit (no submit) when the queue is deeper than the wait budget', async () => {
		// The gate reports the next slot is further out than we will block a worker for.
		// We must NOT fire the prediction (that would just earn a throttle 429); instead
		// surface a retryable, queued rate-limit carrying the time until the slot opens.
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		rateState.result = { ok: false, waitMs: 12_000 };
		const calls = stubFetch([['api.replicate.com', () => replicateSuccessResponse()]]);

		const textToImage = await freshTextToImage();
		const caught = await textToImage('a red teapot').then(
			() => null,
			(e) => e,
		);
		expect(caught).toBeTruthy();
		expect(caught.code).toBe('rate_limited');
		expect(caught.queued).toBe(true);
		expect(caught.retryAfter).toBe(12); // ceil(12000ms / 1000)
		// The Replicate prediction was never created, we shed before firing.
		expect(calls.some((c) => c.url.includes('api.replicate.com'))).toBe(false);
		// The buyer-facing message names the queue, not the account's rate state.
		expect(caught.message).not.toMatch(/credit|\$|throttl|rate limit/i);
	});

	it('masks a Replicate 402 out-of-credit failure as a buyer-safe billing error', async () => {
		// The incident the user hit: the free NIM lane fell through to the paid
		// Replicate backstop, which had zero credit. Replicate returns the hard
		// "purchase credit at replicate.com/billing" copy on a 402, that vendor
		// billing page must never reach the buyer. We keep the raw detail for logs
		// (providerDetail) but the surfaced message must be neutral.
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		const RAW_DETAIL =
			'You have insufficient credit to run this model. Go to ' +
			'https://replicate.com/account/billing#billing to purchase credit. ' +
			'Once you purchase credit, please wait a few minutes before trying again.';
		stubFetch([
			[
				'api.replicate.com',
				() =>
					new Response(JSON.stringify({ detail: RAW_DETAIL }), {
						status: 402,
						headers: { 'content-type': 'application/json' },
					}),
			],
		]);
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		const textToImage = await freshTextToImage();
		const caught = await textToImage('a red teapot').then(
			() => null,
			(e) => e,
		);
		expect(caught).toBeTruthy();
		expect(caught.code).toBe('billing');
		expect(caught.providerStatus).toBe(402);
		expect(caught.providerDetail).toBe(RAW_DETAIL); // retained for server logs
		expect(caught.message).toBe('image provider billing error');
		// The raw vendor billing page and "buy credit" call-to-action must be gone.
		expect(caught.message).not.toMatch(/credit|replicate\.com|purchase|insufficient/i);
	});

	it('masks a credit/billing message even on a non-402 status', async () => {
		// Defense in depth: if Replicate ever delivers the same billing copy under
		// a different 4xx, the content match must still keep it off the buyer.
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		stubFetch([
			[
				'api.replicate.com',
				() =>
					new Response(
						JSON.stringify({ detail: 'Payment required: please purchase credit to continue.' }),
						{ status: 400, headers: { 'content-type': 'application/json' } },
					),
			],
		]);
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		const textToImage = await freshTextToImage();
		const caught = await textToImage('a red teapot').then(
			() => null,
			(e) => e,
		);
		expect(caught.code).toBe('billing');
		expect(caught.providerStatus).toBe(402);
		expect(caught.message).not.toMatch(/credit|purchase|payment/i);
	});

	it('polls a Replicate prediction that returns non-terminal, then resolves', async () => {
		// Regression: under load / cold start Replicate returns the prediction still
		// `starting` (Prefer: wait elapsed) with no output. The free text→3D lane
		// must poll the prediction to completion, never dead-end on a transient
		// "text-to-image did not complete (status: starting)".
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		let pollHits = 0;
		stubFetch([
			[
				'/predictions/pred_poll',
				() => {
					pollHits += 1;
					const done = pollHits >= 2;
					return new Response(
						JSON.stringify({
							id: 'pred_poll',
							status: done ? 'succeeded' : 'processing',
							output: done ? ['https://replicate.delivery/polled.png'] : null,
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					);
				},
			],
			[
				'flux-schnell',
				() =>
					new Response(
						JSON.stringify({
							id: 'pred_poll',
							status: 'starting',
							output: null,
							urls: { get: 'https://api.replicate.com/v1/predictions/pred_poll' },
						}),
						{ status: 201, headers: { 'content-type': 'application/json' } },
					),
			],
		]);

		vi.useFakeTimers();
		try {
			const textToImage = await freshTextToImage();
			const p = textToImage('a red teapot');
			await vi.advanceTimersByTimeAsync(5_000); // let two poll intervals elapse
			const result = await p;
			expect(result.imageUrl).toBe('https://replicate.delivery/polled.png');
			expect(result.predictionId).toBe('pred_poll');
			expect(pollHits).toBeGreaterThanOrEqual(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('surfaces a clean error when a polled Replicate prediction fails', async () => {
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		stubFetch([
			[
				'/predictions/pred_fail',
				() =>
					new Response(
						JSON.stringify({ id: 'pred_fail', status: 'failed', error: 'NSFW content detected' }),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					),
			],
			[
				'flux-schnell',
				() =>
					new Response(
						JSON.stringify({
							id: 'pred_fail',
							status: 'starting',
							output: null,
							urls: { get: 'https://api.replicate.com/v1/predictions/pred_fail' },
						}),
						{ status: 201, headers: { 'content-type': 'application/json' } },
					),
			],
		]);

		vi.useFakeTimers();
		try {
			const textToImage = await freshTextToImage();
			const p = textToImage('a red teapot');
			const settled = p.then(
				() => null,
				(e) => e,
			);
			await vi.advanceTimersByTimeAsync(3_000);
			const caught = await settled;
			expect(caught).toBeTruthy();
			expect(caught.message).toMatch(/text-to-image failed/);
		} finally {
			vi.useRealTimers();
		}
	});

	it('persists a Vertex data: URI to object storage and returns the https URL', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		vertexState.configured = true;
		const png = Buffer.from('fake-png-bytes').toString('base64');
		vertexState.generate = async () => ({
			imageUrl: `data:image/png;base64,${png}`,
			model: 'vertex-ai/imagen-3.0-generate-001',
		});

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		expect(result.imageUrl).toMatch(/^https:\/\/cdn\.example\/forge\/refs\/.+\.png$/);
		expect(result.model).toBe('vertex-ai/imagen-3.0-generate-001');
		expect(r2State.puts).toHaveLength(1);
		expect(r2State.puts[0].contentType).toBe('image/png');
		expect(Buffer.compare(r2State.puts[0].body, Buffer.from('fake-png-bytes'))).toBe(0);
	});
});

describe('textToImage: VERTEX_IMAGEN_ENABLED gate', () => {
	it('unset ⇒ current behavior: Vertex serves when the project is set', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		vertexState.configured = true;
		vertexState.generate = vi.fn(async () => ({
			imageUrl: `data:image/png;base64,${Buffer.from('vx').toString('base64')}`,
			model: 'vertex-ai/gemini-2.5-flash-image',
		}));
		const calls = stubFetch([['api.replicate.com', () => replicateSuccessResponse()]]);

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		expect(vertexState.generate).toHaveBeenCalledOnce();
		expect(result.model).toBe('vertex-ai/gemini-2.5-flash-image');
		expect(calls).toHaveLength(0); // Replicate never reached
	});

	it('=0 forces the Vertex lane off, falling through to Replicate', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		process.env.VERTEX_IMAGEN_ENABLED = '0';
		vertexState.configured = true;
		vertexState.generate = vi.fn(async () => {
			throw new Error('vertex should never be called when gated off');
		});
		const calls = stubFluxSuccess();

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		expect(vertexState.generate).not.toHaveBeenCalled();
		expect(result.model).toBe('black-forest-labs/flux-schnell');
		expect(calls.some((c) => c.url.includes('api.replicate.com'))).toBe(true);
	});

	it('=1 keeps the Vertex lane on', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		process.env.VERTEX_IMAGEN_ENABLED = '1';
		vertexState.configured = true;
		vertexState.generate = vi.fn(async () => ({
			imageUrl: `data:image/png;base64,${Buffer.from('vx').toString('base64')}`,
			model: 'vertex-ai/gemini-2.5-flash-image',
		}));
		stubFetch([]);

		const textToImage = await freshTextToImage();
		const result = await textToImage('a red teapot');

		expect(vertexState.generate).toHaveBeenCalledOnce();
		expect(result.model).toBe('vertex-ai/gemini-2.5-flash-image');
	});
});

describe('enhanceFluxPrompt: realism + 3D-reference isolation suffixes', () => {
	const ISOLATION = ', isolated subject, bright studio lighting, plain white background';
	const REALISM =
		', photorealistic, true-to-life materials and surface detail, sharp focus, professional product photograph';

	async function enhance() {
		const mod = await import('../../api/_mcp3d/text-to-image.js?t=' + Math.random());
		return mod.enhanceFluxPrompt;
	}

	it('appends realism + isolation to a plain subject prompt (photoreal by default)', async () => {
		const enhanceFluxPrompt = await enhance();
		expect(enhanceFluxPrompt('a red teapot')).toBe('a red teapot' + REALISM + ISOLATION);
	});

	it('respects a named art style: isolation stays, realism words are withheld', async () => {
		// Regression (older): "cartoon"/"stylized" must never suppress isolation,
		// a cartoon fox still needs a plain background to reconstruct cleanly.
		// New contract: those same words DO suppress the realism cues, which would
		// otherwise fight the caller's explicit style.
		const enhanceFluxPrompt = await enhance();
		expect(enhanceFluxPrompt('a cartoon fox character standing upright')).toBe(
			'a cartoon fox character standing upright' + ISOLATION,
		);
		expect(enhanceFluxPrompt('a stylized vibrant robot')).toBe('a stylized vibrant robot' + ISOLATION);
		expect(enhanceFluxPrompt('a low-poly wolf')).toBe('a low-poly wolf' + ISOLATION);
		expect(enhanceFluxPrompt('a watercolor bird')).toBe('a watercolor bird' + ISOLATION);
	});

	it('leaves the prompt untouched when it already sets a background / composition cue', async () => {
		const enhanceFluxPrompt = await enhance();
		for (const p of [
			'a knight on a plain white background',
			'an owl figurine, studio lighting',
			'a vase isolated on white bg',
		]) {
			expect(enhanceFluxPrompt(p)).toBe(p);
		}
	});

	it('matches whole words only: substrings never trigger or suppress', async () => {
		const enhanceFluxPrompt = await enhance();
		// "light" inside "lightsaber" is not a composition cue…
		expect(enhanceFluxPrompt('a glowing lightsaber')).toBe('a glowing lightsaber' + REALISM + ISOLATION);
		// …and "cartoonish" IS a style signal via the word boundary on "cartoon"?
		// No: \b matches inside "cartoonish" only at the start, the suffix "ish"
		// keeps the word alive, so assert the boundary behaves as written.
		expect(enhanceFluxPrompt('a legolas figure')).toBe('a legolas figure' + REALISM + ISOLATION);
	});

	it('returns an empty prompt unchanged', async () => {
		const enhanceFluxPrompt = await enhance();
		expect(enhanceFluxPrompt('')).toBe('');
		expect(enhanceFluxPrompt('   ')).toBe('');
	});
});

describe('vertex-imagen: service-account JSON hardening', () => {
	it('rejects mangled GCP_SERVICE_ACCOUNT_JSON with a designed unconfigured error', async () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
		// The classic secrets-UI mangle: escaped quotes but no usable key material.
		process.env.GCP_SERVICE_ACCOUNT_JSON = '{\\"type\\":\\"service_account\\"}';
		const real = await vi.importActual('../../api/_mcp3d/vertex-imagen.js');

		await expect(real.generateImage('a red teapot')).rejects.toMatchObject({
			code: 'unconfigured',
		});
	});
});
