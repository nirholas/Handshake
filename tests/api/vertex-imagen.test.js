// Unit tests for the Vertex AI image-generation client.
//
// The Imagen `:predict` family is being retired (imagen-3.0-* shut down
// 2026-06-30; imagen-4.0-* by 2026-08-17), so the client now defaults to the
// live Gemini image model `gemini-2.5-flash-image` via `:generateContent`, and
// only takes the legacy `:predict` shape for an explicit `imagen-*` override.
//
// These tests pin BOTH request/response shapes against the documented Vertex
// contract and the model-prefix router, without any live credentials: the GCP
// token mint is mocked and every HTTP call is a recorded-shape fixture (a test
// double for an external API, not product data). Live E2E is a separate, creds-
// gated step tracked in docs/gcp-credits.md.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/_lib/gcp-auth.js', () => ({
	getGcpAccessToken: vi.fn(async () => 'fake-access-token'),
}));

// The edit lane decodes caller-supplied source/mask URLs through the SSRF guard.
// Mocking it lets the tests assert that BOTH images take the guarded path (a bare
// fetch on the mask was a live SSRF hole) without reaching the network.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('../../api/_lib/ssrf-guard.js', () => ({ fetchSafePublicUrl: safeFetch }));

import { generateImage, editImage, isConfigured } from '../../api/_mcp3d/vertex-imagen.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'VERTEX_IMAGEN_MODEL', 'VERTEX_IMAGEN_EDIT_MODEL'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function stubFetch(responder) {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, opts = {}) => {
		const call = { url: String(url), body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers };
		calls.push(call);
		return responder(call);
	});
	return calls;
}

// A gemini-2.5-flash-image generateContent success: the image rides back as an
// inlineData part (base64 + mimeType), same as the live API.
function geminiImageResponse(b64 = Buffer.from('gemini-png').toString('base64'), mime = 'image/png') {
	return new Response(
		JSON.stringify({
			candidates: [{ content: { parts: [{ inlineData: { mimeType: mime, data: b64 } }] }, finishReason: 'STOP' }],
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	);
}

// A legacy Imagen :predict success: base64 under predictions[].bytesBase64Encoded.
function imagenPredictResponse(b64 = Buffer.from('imagen-png').toString('base64')) {
	return new Response(JSON.stringify({ predictions: [{ bytesBase64Encoded: b64 }] }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

beforeEach(() => {
	for (const k of ENV_KEYS) delete process.env[k];
	process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	for (const k of ENV_KEYS) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
	vi.clearAllMocks();
});

describe('vertex-imagen — default Gemini image path', () => {
	it('calls :generateContent with the documented image-modality body', async () => {
		const calls = stubFetch(() => geminiImageResponse());
		const result = await generateImage('a red teapot', { aspectRatio: '16:9' });

		expect(calls).toHaveLength(1);
		const { url, body, headers } = calls[0];
		// Endpoint: regional host + publisher model + :generateContent (NOT :predict).
		expect(url).toBe(
			'https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project' +
				'/locations/us-central1/publishers/google/models/gemini-2.5-flash-image:generateContent',
		);
		expect(headers.authorization).toBe('Bearer fake-access-token');
		// Request shape: text prompt + IMAGE modality + aspect ratio in imageConfig.
		expect(body.contents[0].parts[0].text).toBe('a red teapot');
		expect(body.generationConfig.responseModalities).toEqual(['IMAGE']);
		expect(body.generationConfig.imageConfig.aspectRatio).toBe('16:9');

		// Response parse: inlineData → data URI carrying the real mime type + model tag.
		expect(result.imageUrl).toBe(`data:image/png;base64,${Buffer.from('gemini-png').toString('base64')}`);
		expect(result.model).toBe('vertex-ai/gemini-2.5-flash-image');
	});

	it('preserves the response mime type in the data URI', async () => {
		stubFetch(() => geminiImageResponse(Buffer.from('jpg').toString('base64'), 'image/jpeg'));
		const result = await generateImage('a teapot');
		expect(result.imageUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
	});

	it('accepts the wide Gemini aspect-ratio set and falls back to 1:1 for unknown', async () => {
		let calls = stubFetch(() => geminiImageResponse());
		await generateImage('x', { aspectRatio: '21:9' });
		expect(calls[0].body.generationConfig.imageConfig.aspectRatio).toBe('21:9');

		calls = stubFetch(() => geminiImageResponse());
		await generateImage('x', { aspectRatio: '7:3' }); // not a supported ratio
		expect(calls[0].body.generationConfig.imageConfig.aspectRatio).toBe('1:1');
	});

	it('throws with the finishReason when a safety block returns no image', async () => {
		stubFetch(
			() =>
				new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'blocked' }] }, finishReason: 'SAFETY' }] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		);
		await expect(generateImage('x')).rejects.toThrow(/no image data.*SAFETY/);
	});
});

describe('vertex-imagen — legacy Imagen :predict override', () => {
	beforeEach(() => {
		process.env.VERTEX_IMAGEN_MODEL = 'imagen-4.0-generate-001';
	});

	it('routes an imagen-* model to :predict with the instances/parameters body', async () => {
		const calls = stubFetch(() => imagenPredictResponse());
		const result = await generateImage('a red teapot', { aspectRatio: '4:3' });

		const { url, body } = calls[0];
		expect(url).toContain('/models/imagen-4.0-generate-001:predict');
		expect(body.instances[0].prompt).toBe('a red teapot');
		expect(body.parameters).toMatchObject({
			sampleCount: 1,
			aspectRatio: '4:3',
			addWatermark: false,
			safetySetting: 'block_some',
			personGeneration: 'allow_adult',
		});
		expect(result.imageUrl).toBe(`data:image/png;base64,${Buffer.from('imagen-png').toString('base64')}`);
		expect(result.model).toBe('vertex-ai/imagen-4.0-generate-001');
	});
});

describe('vertex-imagen — location + error handling', () => {
	it('uses the un-prefixed host for the global location', async () => {
		process.env.GOOGLE_CLOUD_LOCATION = 'global';
		const calls = stubFetch(() => geminiImageResponse());
		await generateImage('x');
		expect(calls[0].url.startsWith('https://aiplatform.googleapis.com/v1/projects/demo-project/locations/global/')).toBe(true);
	});

	it('maps 429 to a retryable rate_limited error', async () => {
		stubFetch(() => new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 }));
		await expect(generateImage('x')).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 10 });
	});

	it('surfaces a 500 with providerStatus so the caller can fall back', async () => {
		stubFetch(() => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }));
		await expect(generateImage('x')).rejects.toMatchObject({ providerStatus: 500 });
	});

	it('maps a network failure to provider_unreachable', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('ECONNRESET');
		});
		await expect(generateImage('x')).rejects.toMatchObject({ code: 'provider_unreachable' });
	});

	it('throws unconfigured when GOOGLE_CLOUD_PROJECT is missing', async () => {
		delete process.env.GOOGLE_CLOUD_PROJECT;
		expect(isConfigured()).toBe(false);
		await expect(generateImage('x')).rejects.toMatchObject({ code: 'unconfigured' });
	});
});

describe('vertex-imagen — editImage routing', () => {
	it('sends the source image as an inlineData part on the Gemini edit path', async () => {
		const calls = stubFetch(() => geminiImageResponse());
		const src = `data:image/png;base64,${Buffer.from('source').toString('base64')}`;
		const result = await editImage(src, 'make it blue');

		const { url, body } = calls[0];
		expect(url).toContain('/models/gemini-2.5-flash-image:generateContent');
		expect(body.contents[0].parts[0].text).toBe('make it blue');
		expect(body.contents[0].parts[1].inlineData.data).toBe(Buffer.from('source').toString('base64'));
		expect(result.model).toBe('vertex-ai/gemini-2.5-flash-image');
	});

	it('declares the source image its real mime type, not a hardcoded PNG', async () => {
		const calls = stubFetch(() => geminiImageResponse());
		await editImage(`data:image/jpeg;base64,${Buffer.from('jpg-source').toString('base64')}`, 'rotate it');
		expect(calls[0].body.contents[0].parts[1].inlineData.mimeType).toBe('image/jpeg');
	});

	it('carries the fetched content-type through for an http(s) source', async () => {
		safeFetch.mockResolvedValueOnce(
			new Response(Buffer.from('webp-bytes'), { status: 200, headers: { 'content-type': 'image/webp' } }),
		);
		const calls = stubFetch(() => geminiImageResponse());
		await editImage('https://cdn.example.com/ref.webp', 'rotate it');

		expect(safeFetch).toHaveBeenCalledWith('https://cdn.example.com/ref.webp', expect.objectContaining({ signal: expect.anything() }));
		const part = calls[0].body.contents[0].parts[1].inlineData;
		expect(part.mimeType).toBe('image/webp');
		expect(part.data).toBe(Buffer.from('webp-bytes').toString('base64'));
	});

	it('rejects a non-base64 data: URI instead of forwarding garbage to Vertex', async () => {
		const calls = stubFetch(() => geminiImageResponse());
		await expect(editImage('data:image/svg+xml,%3Csvg/%3E', 'x')).rejects.toMatchObject({
			code: 'bad_source_image',
		});
		expect(calls).toHaveLength(0);
	});

	it('surfaces an unreachable source image instead of editing an error body', async () => {
		safeFetch.mockResolvedValueOnce(new Response('nope', { status: 404 }));
		const calls = stubFetch(() => geminiImageResponse());
		await expect(editImage('https://cdn.example.com/gone.png', 'x')).rejects.toThrow(/upstream 404/);
		expect(calls).toHaveLength(0);
	});

	it('refuses a source image past the inline size cap', async () => {
		safeFetch.mockResolvedValueOnce(
			new Response('x', { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(64 * 1024 * 1024) } }),
		);
		stubFetch(() => geminiImageResponse());
		await expect(editImage('https://cdn.example.com/huge.png', 'x')).rejects.toMatchObject({
			code: 'source_image_too_large',
		});
	});

	it('routes the legacy :predict mask through the SSRF guard, not a bare fetch', async () => {
		process.env.VERTEX_IMAGEN_EDIT_MODEL = 'imagen-3.0-capability-001';
		safeFetch.mockResolvedValueOnce(
			new Response(Buffer.from('mask-bytes'), { status: 200, headers: { 'content-type': 'image/png' } }),
		);
		const calls = stubFetch(() => imagenPredictResponse());
		const src = `data:image/png;base64,${Buffer.from('source').toString('base64')}`;
		await editImage(src, 'inpaint', { maskUrl: 'https://cdn.example.com/mask.png' });

		// The only guarded fetch is the mask (the source is an inline data: URI),
		// and the raw fetch stub saw the Vertex call alone.
		expect(safeFetch).toHaveBeenCalledTimes(1);
		expect(safeFetch.mock.calls[0][0]).toBe('https://cdn.example.com/mask.png');
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toContain(':predict');
		const instance = calls[0].body.instances[0];
		expect(instance.editConfig.editMode).toBe('inpainting-insert');
		expect(instance.mask.image.bytesBase64Encoded).toBe(Buffer.from('mask-bytes').toString('base64'));
	});
});
