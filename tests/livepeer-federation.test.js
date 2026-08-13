// Livepeer federation provider (api/_providers/livepeer.js) behavior tests.
//
// The provider is the Phase 4 compute-federation adapter: one GPU job class
// (text-to-image) routed to the Livepeer network behind
// LIVEPEER_FEDERATION_ENABLED. These tests pin the contract that keeps the
// lane drop-in for the text-to-image chain:
//
//   1. Flag gating: dark by default; only an explicit truthy value lights it.
//   2. Gateway resolution: LIVEPEER_GATEWAY_URL override > keyed studio >
//      public dream gateway; bearer header present exactly when keyed.
//   3. Job envelope: the request body is the Livepeer AI gateway
//      text-to-image shape (prompt, model_id, width/height from the aspect
//      map, num_images_per_prompt, safety_check on, seed passthrough) and the
//      return is the platform's { imageUrl, model, lane } envelope.
//   4. Verification: nsfw-flagged images, missing urls, tiny payloads, and
//      non-image bytes all throw verification_failed BEFORE any persistence
//      (an error page must never enter the reference-image pipeline).
//   5. Failure coding: socket/TLS failure → provider_unreachable; 429 →
//      rate_limited; other non-2xx → upstream_error. The chain hands off on
//      any throw, so these codes are the lane-health contract.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { livepeerTextToImage, livepeerGatewayConfig, livepeerFederationEnabled, DEFAULT_T2I_MODEL } from '../api/_providers/livepeer.js';
import { persistImageBytes } from '../api/_lib/image-persist.js';

// Persistence is the one side effect the adapter owns; everything upstream of
// it is exercised for real. Mock the shared helper at the module boundary so a
// test run never writes to R2.
vi.mock('../api/_lib/image-persist.js', async (importOriginal) => {
	const mod = await importOriginal();
	return { ...mod, persistImageBytes: vi.fn(async () => 'https://cdn.example.com/forge/refs/job.png') };
});

// Tiny but real image payloads: the JPEG magic header and a minimal PNG
// signature, each padded past the 1 KB verification floor.
const JPEG_BYTES = Buffer.concat([
	Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
	Buffer.alloc(2048, 1),
]);
const PNG_BYTES = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(2048, 1),
]);

const ENV_KEYS = [
	'LIVEPEER_FEDERATION_ENABLED',
	'LIVEPEER_GATEWAY_URL',
	'LIVEPEER_API_KEY',
	'LIVEPEER_T2I_MODEL',
];

let fetchMock;
const persistMock = persistImageBytes;

beforeEach(() => {
	for (const k of ENV_KEYS) delete process.env[k];
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	vi.clearAllMocks();
	for (const k of ENV_KEYS) delete process.env[k];
});

function gatewayResponse(status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
	};
}

function imageResponse(bytes) {
	return {
		ok: true,
		status: 200,
		arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	};
}

describe('livepeerFederationEnabled', () => {
	it('is dark by default and on explicit falsy values', () => {
		expect(livepeerFederationEnabled()).toBe(false);
		for (const v of ['0', 'false', 'no', 'off', 'nope', '']) {
			process.env.LIVEPEER_FEDERATION_ENABLED = v;
			expect(livepeerFederationEnabled()).toBe(false);
		}
	});

	it('is on only for explicit truthy values', () => {
		for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
			process.env.LIVEPEER_FEDERATION_ENABLED = v;
			expect(livepeerFederationEnabled()).toBe(true);
		}
	});
});

describe('livepeerGatewayConfig', () => {
	it('uses the public dream gateway with no key by default', () => {
		expect(livepeerGatewayConfig()).toEqual({
			base: 'https://dream-gateway.livepeer.cloud',
			gateway: 'public',
			key: null,
		});
	});

	it('uses the studio gateway with bearer auth when LIVEPEER_API_KEY is set', () => {
		process.env.LIVEPEER_API_KEY = 'lp_key_123';
		expect(livepeerGatewayConfig()).toEqual({
			base: 'https://livepeer.studio/api/generate',
			gateway: 'studio',
			key: 'lp_key_123',
		});
	});

	it('LIVEPEER_GATEWAY_URL wins outright and strips a trailing slash', () => {
		process.env.LIVEPEER_API_KEY = 'lp_key_123';
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.internal:8088/';
		const cfg = livepeerGatewayConfig();
		expect(cfg.base).toBe('https://gateway.internal:8088');
		expect(cfg.gateway).toBe('override');
		expect(cfg.key).toBe('lp_key_123');
	});
});

describe('livepeerTextToImage', () => {
	it('posts the documented envelope and returns the platform envelope', async () => {
		fetchMock
			.mockResolvedValueOnce(gatewayResponse(200, { images: [{ url: '/gen/img-1.png', seed: 42, nsfw: false }] }))
			.mockResolvedValueOnce(imageResponse(PNG_BYTES));

		const out = await livepeerTextToImage('a ceramic mug on a white background', { aspectRatio: '1:1', seed: 7 });

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('https://dream-gateway.livepeer.cloud/text-to-image');
		expect(opts.method).toBe('POST');
		expect(opts.headers.authorization).toBeUndefined();
		const body = JSON.parse(opts.body);
		expect(body).toEqual({
			prompt: 'a ceramic mug on a white background',
			model_id: DEFAULT_T2I_MODEL,
			width: 1024,
			height: 1024,
			num_images_per_prompt: 1,
			safety_check: true,
			seed: 7,
		});

		// Relative artifact URL resolved against the gateway origin.
		expect(fetchMock.mock.calls[1][0]).toBe('https://dream-gateway.livepeer.cloud/gen/img-1.png');

		expect(persistMock).toHaveBeenCalledTimes(1);
		expect(Buffer.compare(persistMock.mock.calls[0][0], PNG_BYTES)).toBe(0);
		expect(out).toEqual({
			imageUrl: 'https://cdn.example.com/forge/refs/job.png',
			model: DEFAULT_T2I_MODEL,
			lane: 'livepeer',
			gateway: 'public',
			seedUsed: 42,
		});
	});

	it('maps aspect ratios to the same dimensions the NIM FLUX lane uses', async () => {
		fetchMock
			.mockResolvedValueOnce(gatewayResponse(200, { images: [{ url: 'https://cdn.livepeer.example/x.jpg', nsfw: false }] }))
			.mockResolvedValueOnce(imageResponse(JPEG_BYTES));

		await livepeerTextToImage('a wide landscape', { aspectRatio: '16:9' });
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect([body.width, body.height]).toEqual([1344, 768]);
	});

	it('sends the bearer to the studio gateway and to its artifact host', async () => {
		process.env.LIVEPEER_API_KEY = 'lp_key_123';
		fetchMock
			.mockResolvedValueOnce(gatewayResponse(200, { images: [{ url: '/gen/img-2.png', nsfw: false }] }))
			.mockResolvedValueOnce(imageResponse(PNG_BYTES));

		const out = await livepeerTextToImage('a wooden chair', {});
		expect(fetchMock.mock.calls[0][0]).toBe('https://livepeer.studio/api/generate/text-to-image');
		expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer lp_key_123');
		expect(fetchMock.mock.calls[1][1].headers.authorization).toBe('Bearer lp_key_123');
		expect(out.gateway).toBe('studio');
	});

	it('honors LIVEPEER_T2I_MODEL and LIVEPEER_GATEWAY_URL overrides', async () => {
		process.env.LIVEPEER_T2I_MODEL = 'stabilityai/sdxl-turbo';
		process.env.LIVEPEER_GATEWAY_URL = 'https://gateway.internal:8088';
		fetchMock
			.mockResolvedValueOnce(gatewayResponse(200, { images: [{ url: '/i.png', nsfw: false }] }))
			.mockResolvedValueOnce(imageResponse(PNG_BYTES));

		const out = await livepeerTextToImage('a lamp', {});
		expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.internal:8088/text-to-image');
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).model_id).toBe('stabilityai/sdxl-turbo');
		expect(out.gateway).toBe('override');
	});

	it('omits seed from the request when the caller did not supply one', async () => {
		fetchMock
			.mockResolvedValueOnce(gatewayResponse(200, { images: [{ url: '/i.png', nsfw: false }] }))
			.mockResolvedValueOnce(imageResponse(PNG_BYTES));

		await livepeerTextToImage('a lamp', {});
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('seed');
	});

	it('rejects an nsfw-flagged image before persistence', async () => {
		fetchMock.mockResolvedValueOnce(gatewayResponse(200, { images: [{ url: '/i.png', nsfw: true }] }));
		await expect(livepeerTextToImage('x', {})).rejects.toMatchObject({ code: 'verification_failed' });
		expect(persistMock).not.toHaveBeenCalled();
	});

	it('rejects a 200 with no usable image url', async () => {
		fetchMock.mockResolvedValueOnce(gatewayResponse(200, { images: [] }));
		await expect(livepeerTextToImage('x', {})).rejects.toMatchObject({ code: 'verification_failed' });
		expect(persistMock).not.toHaveBeenCalled();
	});

	it('rejects non-image bytes behind a 200 (error page) before persistence', async () => {
		fetchMock
			.mockResolvedValueOnce(gatewayResponse(200, { images: [{ url: '/i.png', nsfw: false }] }))
			.mockResolvedValueOnce(imageResponse(Buffer.from('<html><body>Gateway error</body></html>'.padEnd(2048, ' '))));
		await expect(livepeerTextToImage('x', {})).rejects.toMatchObject({ code: 'verification_failed' });
		expect(persistMock).not.toHaveBeenCalled();
	});

	it('codes a socket failure provider_unreachable', async () => {
		fetchMock.mockRejectedValueOnce(new Error('certificate mismatch'));
		await expect(livepeerTextToImage('x', {})).rejects.toMatchObject({ code: 'provider_unreachable' });
	});

	// Node's fetch reports every transport fault as the bare string "fetch
	// failed" and puts the real reason on err.cause. Losing that chain is losing
	// the diagnosis: the measured public-gateway outage is a certificate that
	// belongs to an unrelated domain, which reads identically to a DNS miss or a
	// refused connection unless the cause is carried into the message.
	it('carries the transport cause chain into the unreachable message', async () => {
		const cause = Object.assign(new Error("Hostname/IP does not match certificate's altnames"), {
			code: 'ERR_TLS_CERT_ALTNAME_INVALID',
		});
		fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause }));
		await expect(livepeerTextToImage('x', {})).rejects.toMatchObject({
			code: 'provider_unreachable',
			message: expect.stringContaining('ERR_TLS_CERT_ALTNAME_INVALID'),
		});
	});

	it('reports a transport failure that carries no cause without inventing one', async () => {
		fetchMock.mockRejectedValue(new Error('socket hang up'));
		await expect(livepeerTextToImage('x', {})).rejects.toThrow(/socket hang up/);
	});

	it('codes 429 rate_limited and other non-2xx upstream_error', async () => {
		fetchMock.mockResolvedValueOnce(gatewayResponse(429, 'slow down'));
		await expect(livepeerTextToImage('x', {})).rejects.toMatchObject({ code: 'rate_limited', providerStatus: 429 });

		fetchMock.mockResolvedValueOnce(gatewayResponse(500, 'boom'));
		await expect(livepeerTextToImage('x', {})).rejects.toMatchObject({ code: 'upstream_error', providerStatus: 500 });
	});
});
