// Tests for the HuggingFace provider failover chain.
//
// Critical invariants:
//   • Try each Space in order; return first success.
//   • Surface per-Space failures in the final error message so debugging
//     "Avatar engine not available" tells you WHICH Spaces failed and HOW.
//   • Env-driven chain config wins over the curated default.
//   • Submit fails closed when chain is empty.
//
// We stub global fetch to model Space responses (queue enqueue, SSE stream).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_HF_TOKEN = process.env.HF_TOKEN;
const ORIGINAL_SPACES = process.env.HF_RECONSTRUCT_SPACES;
const ORIGINAL_SPACE = process.env.HF_RECONSTRUCT_SPACE;

function spaceUrl(slug) {
	return `https://${slug.replace(/\//g, '-').toLowerCase()}.hf.space`;
}

// Compose an SSE response stream emitting [event: complete, data: <output>] then close.
function sseStream(output) {
	const text =
		`event: generating\ndata: {}\n\n` +
		`event: complete\ndata: ${JSON.stringify(output)}\n\n`;
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	});
}

function jsonResp(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

beforeEach(() => {
	process.env.HF_TOKEN = 'hf_test_token';
	delete process.env.HF_RECONSTRUCT_SPACES;
	delete process.env.HF_RECONSTRUCT_SPACE;
	vi.resetModules();
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	if (ORIGINAL_HF_TOKEN === undefined) delete process.env.HF_TOKEN;
	else process.env.HF_TOKEN = ORIGINAL_HF_TOKEN;
	if (ORIGINAL_SPACES === undefined) delete process.env.HF_RECONSTRUCT_SPACES;
	else process.env.HF_RECONSTRUCT_SPACES = ORIGINAL_SPACES;
	if (ORIGINAL_SPACE === undefined) delete process.env.HF_RECONSTRUCT_SPACE;
	else process.env.HF_RECONSTRUCT_SPACE = ORIGINAL_SPACE;
});

describe('huggingface provider — failover chain', () => {
	it('first Space succeeds: returns its GLB url without trying others', async () => {
		process.env.HF_RECONSTRUCT_SPACES = 'foo/A,bar/B';
		const fetchMock = vi.fn(async (url) => {
			if (url === `${spaceUrl('foo/A')}/call/generation_all`) {
				return jsonResp({ event_id: 'evt-A' });
			}
			if (url === `${spaceUrl('foo/A')}/call/generation_all/evt-A`) {
				return sseStream([{ url: 'https://files/foo.glb' }]);
			}
			throw new Error(`unexpected url ${url}`);
		});
		globalThis.fetch = fetchMock;

		const { createRegenProvider } = await import('../../api/_providers/huggingface.js');
		const provider = createRegenProvider();
		const out = await provider.submit({
			mode: 'reconstruct',
			params: { images: ['data:image/jpeg;base64,AAA'] },
		});
		expect(out.rawStatus).toBe('completed');

		// extJobId is base64url-encoded JSON pack — decode and check the result.
		const decoded = JSON.parse(Buffer.from(out.extJobId, 'base64url').toString('utf8'));
		expect(decoded.resultGlbUrl).toBe('https://files/foo.glb');
		expect(decoded.space).toBe('foo/A');
		expect(decoded.fellBackFrom).toEqual([]);
		expect(out.providerNote).toBeUndefined();

		// We only hit foo/A — 2 calls (enqueue + SSE).
		expect(fetchMock.mock.calls.length).toBe(2);
	});

	it('first Space 502s: falls over to second and surfaces the failure note', async () => {
		process.env.HF_RECONSTRUCT_SPACES = 'down/X,up/Y';
		const fetchMock = vi.fn(async (url) => {
			if (url.startsWith(spaceUrl('down/X'))) {
				return jsonResp({ detail: 'no GPU' }, 502);
			}
			if (url === `${spaceUrl('up/Y')}/call/generation_all`) {
				return jsonResp({ event_id: 'evt-Y' });
			}
			if (url === `${spaceUrl('up/Y')}/call/generation_all/evt-Y`) {
				return sseStream(['https://x/healed.glb']);
			}
			throw new Error(`unexpected url ${url}`);
		});
		globalThis.fetch = fetchMock;

		const { createRegenProvider } = await import('../../api/_providers/huggingface.js');
		const provider = createRegenProvider();
		const out = await provider.submit({
			mode: 'reconstruct',
			params: { images: ['data:image/jpeg;base64,AAA'] },
		});

		const decoded = JSON.parse(Buffer.from(out.extJobId, 'base64url').toString('utf8'));
		expect(decoded.resultGlbUrl).toBe('https://x/healed.glb');
		expect(decoded.space).toBe('up/Y');
		expect(decoded.fellBackFrom).toEqual(['down/X']);
		expect(out.providerNote).toMatch(/succeeded on up\/Y after 1 failover/);
	});

	it('all Spaces fail: throws with per-Space breakdown', async () => {
		process.env.HF_RECONSTRUCT_SPACES = 'a/1,b/2,c/3';
		const fetchMock = vi.fn(async () => jsonResp({ detail: 'No GPU function detected' }, 502));
		globalThis.fetch = fetchMock;

		const { createRegenProvider } = await import('../../api/_providers/huggingface.js');
		const provider = createRegenProvider();
		await expect(
			provider.submit({ mode: 'reconstruct', params: { images: ['data:image/jpeg;base64,AAA'] } }),
		).rejects.toMatchObject({
			code: 'all_providers_failed',
			status: 502,
			message: expect.stringMatching(/all 3 huggingface Space\(s\) failed.*a\/1.*b\/2.*c\/3/s),
			failures: expect.arrayContaining([
				expect.objectContaining({ space: 'a/1' }),
				expect.objectContaining({ space: 'b/2' }),
				expect.objectContaining({ space: 'c/3' }),
			]),
		});
		expect(fetchMock.mock.calls.length).toBe(3); // one enqueue per Space
	});

	it('legacy HF_RECONSTRUCT_SPACE env still works as a single-Space chain', async () => {
		process.env.HF_RECONSTRUCT_SPACE = 'legacy/only';
		const fetchMock = vi.fn(async (url) => {
			if (url === `${spaceUrl('legacy/only')}/call/generation_all`) {
				return jsonResp({ event_id: 'evt-L' });
			}
			if (url.endsWith('/evt-L')) {
				return sseStream(['https://x/legacy.glb']);
			}
			throw new Error(`unexpected ${url}`);
		});
		globalThis.fetch = fetchMock;

		const { createRegenProvider } = await import('../../api/_providers/huggingface.js');
		const provider = createRegenProvider();
		const out = await provider.submit({
			mode: 'reconstruct',
			params: { images: ['data:image/jpeg;base64,AAA'] },
		});
		const decoded = JSON.parse(Buffer.from(out.extJobId, 'base64url').toString('utf8'));
		expect(decoded.space).toBe('legacy/only');
	});

	it('rejects non-reconstruct mode immediately (no fetch)', async () => {
		const fetchMock = vi.fn();
		globalThis.fetch = fetchMock;

		const { createRegenProvider } = await import('../../api/_providers/huggingface.js');
		const provider = createRegenProvider();
		await expect(provider.submit({ mode: 'restyle', params: {} })).rejects.toMatchObject({
			code: 'mode_unconfigured',
			status: 501,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects when no images are provided', async () => {
		const { createRegenProvider } = await import('../../api/_providers/huggingface.js');
		const provider = createRegenProvider();
		await expect(provider.submit({ mode: 'reconstruct', params: {} })).rejects.toMatchObject({
			code: 'invalid_input',
			status: 400,
		});
	});

	it('factory throws when HF_TOKEN is missing', async () => {
		delete process.env.HF_TOKEN;
		const { createRegenProvider } = await import('../../api/_providers/huggingface.js');
		expect(() => createRegenProvider()).toThrow(/HF_TOKEN/);
	});
});
