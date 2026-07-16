// Tests for the HuggingFace provider's durable re-host of the reconstructed GLB.
//
// The Space serves the finished mesh from an ephemeral gradio /tmp path that is
// purged within minutes, so every later consumer (forge image lane, avatar
// reconstruct poll) can 404 against it. The provider re-hosts the bytes to our
// own object storage the instant the SSE completes and returns that durable URL.
//
// Invariants under test:
//   • With object storage configured, the returned resultGlbUrl is the durable
//     R2 URL, not the raw Space URL, and the mesh was uploaded exactly once.
//   • With storage configured, a 404 on the (already-expired) Space file must NOT
//     leak the ephemeral URL downstream: the provider fails over to the next
//     Space and regenerates, and if none remain it throws a designed error
//     instead of handing back a URL guaranteed to 404 in materializeCreation.
//   • Without storage configured, re-host is skipped entirely (no fetch of the
//     mesh, no upload) and the raw Space URL is returned, unchanged behavior.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const putObject = vi.fn(async () => {});
const publicUrl = vi.fn((key) => `https://cdn.example/${key}`);
vi.mock('../../api/_lib/r2.js', () => ({ putObject, publicUrl }));

const ORIGINAL_FETCH = globalThis.fetch;
const S3_KEYS = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_PUBLIC_DOMAIN', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
const ORIGINAL = {};
for (const k of [...S3_KEYS, 'HF_TOKEN', 'HF_RECONSTRUCT_SPACES']) ORIGINAL[k] = process.env[k];

function spaceUrl(slug) {
	return `https://${slug.replace(/\//g, '-').toLowerCase()}.hf.space`;
}

function sseStream(output) {
	const text = `event: complete\ndata: ${JSON.stringify(output)}\n\n`;
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResp(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Minimal valid-looking GLB byte blob (header is irrelevant to the re-host copy).
function glbBytes() {
	return new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]);
}

function setS3() {
	process.env.S3_ENDPOINT = 'https://s3.local';
	process.env.S3_BUCKET = 'bucket';
	process.env.S3_PUBLIC_DOMAIN = 'https://cdn.example';
	process.env.S3_ACCESS_KEY_ID = 'key';
	process.env.S3_SECRET_ACCESS_KEY = 'secret';
}
function clearS3() {
	for (const k of S3_KEYS) delete process.env[k];
}

beforeEach(() => {
	process.env.HF_TOKEN = 'hf_test_token';
	process.env.HF_RECONSTRUCT_SPACES = 'foo/A';
	putObject.mockClear();
	publicUrl.mockClear();
	vi.resetModules();
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	for (const k of [...S3_KEYS, 'HF_TOKEN', 'HF_RECONSTRUCT_SPACES']) {
		if (ORIGINAL[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL[k];
	}
});

describe('huggingface provider — durable GLB re-host', () => {
	it('re-hosts the freshly-produced mesh to R2 and returns the durable URL', async () => {
		setS3();
		const fetchMock = vi.fn(async (url, opts) => {
			if (url === `${spaceUrl('foo/A')}/call/generation_all`) return jsonResp({ event_id: 'evt-A' });
			if (url === `${spaceUrl('foo/A')}/call/generation_all/evt-A`) {
				return sseStream([{ url: 'https://files.hf/tmp/gradio/abc/model.glb' }]);
			}
			if (url === 'https://files.hf/tmp/gradio/abc/model.glb') {
				// Re-host fetch must forward the HF bearer token for private Spaces.
				expect(opts?.headers?.authorization).toBe('Bearer hf_test_token');
				return new Response(glbBytes(), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
			}
			throw new Error(`unexpected url ${url}`);
		});
		globalThis.fetch = fetchMock;

		const { createRegenProvider } = await import('../../api/_providers/huggingface.js');
		const out = await createRegenProvider().submit({
			mode: 'reconstruct',
			params: { images: ['data:image/jpeg;base64,AAA'] },
		});

		const decoded = JSON.parse(Buffer.from(out.extJobId, 'base64url').toString('utf8'));
		expect(decoded.resultGlbUrl).toMatch(/^https:\/\/cdn\.example\/hf-recon\/[0-9a-f-]+\.glb$/);
		expect(decoded.resultGlbUrl).not.toContain('files.hf');
		expect(putObject).toHaveBeenCalledTimes(1);
		expect(putObject.mock.calls[0][0]).toMatchObject({ contentType: 'model/gltf-binary' });
	});

	it('regenerates on the next Space when the first Space\'s mesh already 404s, never leaking the ephemeral URL', async () => {
		setS3();
		// foo/A produces a GLB whose temp file is already gone (404 on rehost); bar/B
		// produces a live one. The doomed foo/A URL must never escape — we expect a
		// durable bar/B copy instead.
		process.env.HF_RECONSTRUCT_SPACES = 'foo/A,bar/B';
		const fetchMock = vi.fn(async (url, opts) => {
			if (url === `${spaceUrl('foo/A')}/call/generation_all`) return jsonResp({ event_id: 'evt-A' });
			if (url === `${spaceUrl('foo/A')}/call/generation_all/evt-A`) {
				return sseStream([{ url: 'https://files.hf/tmp/gradio/gone/model.glb' }]);
			}
			if (url === 'https://files.hf/tmp/gradio/gone/model.glb') return new Response('', { status: 404 });
			if (url === `${spaceUrl('bar/B')}/call/generation_all`) return jsonResp({ event_id: 'evt-B' });
			if (url === `${spaceUrl('bar/B')}/call/generation_all/evt-B`) {
				return sseStream([{ url: 'https://files.hf/tmp/gradio/live/model.glb' }]);
			}
			if (url === 'https://files.hf/tmp/gradio/live/model.glb') {
				expect(opts?.headers?.authorization).toBe('Bearer hf_test_token');
				return new Response(glbBytes(), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
			}
			throw new Error(`unexpected url ${url}`);
		});
		globalThis.fetch = fetchMock;

		const { createRegenProvider } = await import('../../api/_providers/huggingface.js');
		const out = await createRegenProvider().submit({
			mode: 'reconstruct',
			params: { images: ['data:image/jpeg;base64,AAA'] },
		});

		const decoded = JSON.parse(Buffer.from(out.extJobId, 'base64url').toString('utf8'));
		expect(decoded.resultGlbUrl).toMatch(/^https:\/\/cdn\.example\/hf-recon\/[0-9a-f-]+\.glb$/);
		expect(decoded.resultGlbUrl).not.toContain('files.hf');
		expect(decoded.space).toBe('bar/B');
		expect(decoded.fellBackFrom).toEqual(['foo/A']);
		expect(putObject).toHaveBeenCalledTimes(1);
	});

	it('throws a designed error rather than returning the ephemeral URL when every Space\'s mesh 404s', async () => {
		setS3();
		const fetchMock = vi.fn(async (url) => {
			if (url === `${spaceUrl('foo/A')}/call/generation_all`) return jsonResp({ event_id: 'evt-A' });
			if (url === `${spaceUrl('foo/A')}/call/generation_all/evt-A`) {
				return sseStream([{ url: 'https://files.hf/tmp/gradio/gone/model.glb' }]);
			}
			if (url === 'https://files.hf/tmp/gradio/gone/model.glb') return new Response('', { status: 404 });
			throw new Error(`unexpected url ${url}`);
		});
		globalThis.fetch = fetchMock;

		const { createRegenProvider } = await import('../../api/_providers/huggingface.js');
		await expect(
			createRegenProvider().submit({
				mode: 'reconstruct',
				params: { images: ['data:image/jpeg;base64,AAA'] },
			}),
		).rejects.toMatchObject({
			code: 'all_providers_failed',
			message: expect.stringMatching(/not persistable/),
		});
		// The doomed ephemeral URL was never persisted.
		expect(putObject).not.toHaveBeenCalled();
	});

	it('recovers the mesh via the canonical /file= route when the Space\'s self-reported url is a stale proxy path', async () => {
		setS3();
		// Observed live on stabilityai/TripoSR (2026-07-16): the FileData `url`
		// carries a replica-router prefix ("/ca/file=...") that 404s, while the
		// same file serves fine at `${spaceUrl}/file=${path}`. The provider must
		// build the canonical route from `path` instead of dying on the bad url.
		const base = spaceUrl('foo/A');
		const fetchMock = vi.fn(async (url) => {
			if (url === `${base}/call/generation_all`) return jsonResp({ event_id: 'evt-A' });
			if (url === `${base}/call/generation_all/evt-A`) {
				return sseStream([
					{ path: '/tmp/gradio/abc/mesh.obj', url: `${base}/ca/file=/tmp/gradio/abc/mesh.obj` },
					{ path: '/tmp/gradio/abc/mesh.glb', url: `${base}/ca/file=/tmp/gradio/abc/mesh.glb` },
				]);
			}
			if (url === `${base}/file=/tmp/gradio/abc/mesh.glb`) {
				return new Response(glbBytes(), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
			}
			// The stale proxy-prefixed url 404s, as it does live.
			if (url === `${base}/ca/file=/tmp/gradio/abc/mesh.glb`) return new Response('', { status: 404 });
			throw new Error(`unexpected url ${url}`);
		});
		globalThis.fetch = fetchMock;

		const { createRegenProvider } = await import('../../api/_providers/huggingface.js');
		const out = await createRegenProvider().submit({
			mode: 'reconstruct',
			params: { images: ['data:image/jpeg;base64,AAA'] },
		});

		const decoded = JSON.parse(Buffer.from(out.extJobId, 'base64url').toString('utf8'));
		expect(decoded.resultGlbUrl).toMatch(/^https:\/\/cdn\.example\/hf-recon\/[0-9a-f-]+\.glb$/);
		expect(putObject).toHaveBeenCalledTimes(1);
	});

	it('skips re-host entirely (no mesh fetch, no upload) when storage is unconfigured', async () => {
		clearS3();
		const fetchMock = vi.fn(async (url) => {
			if (url === `${spaceUrl('foo/A')}/call/generation_all`) return jsonResp({ event_id: 'evt-A' });
			if (url === `${spaceUrl('foo/A')}/call/generation_all/evt-A`) {
				return sseStream([{ url: 'https://files.hf/tmp/gradio/x/model.glb' }]);
			}
			throw new Error(`unexpected url ${url}`); // a mesh fetch here would fail the test
		});
		globalThis.fetch = fetchMock;

		const { createRegenProvider } = await import('../../api/_providers/huggingface.js');
		const out = await createRegenProvider().submit({
			mode: 'reconstruct',
			params: { images: ['data:image/jpeg;base64,AAA'] },
		});

		const decoded = JSON.parse(Buffer.from(out.extJobId, 'base64url').toString('utf8'));
		expect(decoded.resultGlbUrl).toBe('https://files.hf/tmp/gradio/x/model.glb');
		expect(putObject).not.toHaveBeenCalled();
		// enqueue + SSE only — the mesh URL was never fetched.
		expect(fetchMock.mock.calls.length).toBe(2);
	});
});
