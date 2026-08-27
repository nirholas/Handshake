// Unit tests for POST /api/watsonx/embed, the standalone Granite embedding
// endpoint behind the watsonx Constellation.
//
// No network: the watsonx client and the platform embedding chain are both
// stubbed, so these lock down the handler's own contract:
//   - input validation returns JSON 4xx, never a stack trace
//   - the Granite lane serves the batch when watsonx is configured
//   - the process-local cache is reused on a repeat call (cachedHits)
//   - a watsonx failure falls through to the platform chain and still 200s
//   - the regression this file exists for: a provider that answers only PART
//     of the batch used to be treated as success, so the response shipped
//     `null` where a vector belonged and the fallback tier was never tried.
//     Now a short batch is a failure, the next provider covers it, and a
//     response never contains a null vector.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const state = {
	wxConfigured: true,
	// How many leading vectors the watsonx lane answers with; null means "all".
	wxCoverage: null,
	wxError: null,
	fallbackConfigured: true,
	fallbackError: null,
};

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		watsonxEmbedIp: vi.fn(async () => ({ success: true })),
		watsonxEmbedGlobal: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

// Deterministic 4-dim "embeddings": vector i leans on axis i % 4, so a test can
// tell Granite output (leading 1) from fallback output (leading 2) by value.
const graniteVec = (i) => [1, i, 0, 0];
const fallbackVec = (i) => [2, i, 0, 0];

vi.mock('../../api/_lib/watsonx.js', () => ({
	watsonxConfig: vi.fn(() =>
		state.wxConfigured
			? {
					configured: true,
					url: 'https://wx',
					projectId: 'proj',
					apiVersion: '2024-05-31',
					embedModel: 'ibm/granite-embedding-278m-multilingual',
				}
			: { configured: false },
	),
	watsonxEmbed: vi.fn(async (_cfg, { inputs, model }) => {
		if (state.wxError) throw new Error(state.wxError);
		const cover = state.wxCoverage === null ? inputs.length : state.wxCoverage;
		const vectors = inputs.map((_, i) => (i < cover ? graniteVec(i) : []));
		return { model, vectors, dimensions: 4, inputCount: inputs.length };
	}),
}));

vi.mock('../../api/_lib/embeddings.js', () => ({
	embeddingsConfigured: vi.fn(() => state.fallbackConfigured),
	defaultIngestEmbedderTag: vi.fn(() => 'nvidia/nv-embedqa-e5-v5@1024'),
	embedderInfo: vi.fn(() => ({
		tag: 'nvidia/nv-embedqa-e5-v5@1024',
		provider: 'nim',
		model: 'nvidia/nv-embedqa-e5-v5',
		dim: 4,
	})),
	embedPassages: vi.fn(async (_tag, texts) => {
		if (state.fallbackError) throw new Error(state.fallbackError);
		return texts.map((_, i) => Float64Array.from(fallbackVec(i)));
	}),
	// The handler walks the whole free-first embedder order through this rather
	// than pinning the preferred lane, so one throttled lane no longer fails the
	// endpoint while other lanes sit idle. The mock mirrors that contract: it
	// reports which lane answered alongside the vectors.
	embedPassagesAny: vi.fn(async (_preferredTag, texts) => {
		if (state.fallbackError) throw new Error(state.fallbackError);
		return {
			tag: 'nvidia/nv-embedqa-e5-v5@1024',
			info: {
				tag: 'nvidia/nv-embedqa-e5-v5@1024',
				provider: 'nim',
				model: 'nvidia/nv-embedqa-e5-v5',
				dim: 4,
			},
			vectors: texts.map((_, i) => Float64Array.from(fallbackVec(i))),
		};
	}),
}));

import { limits } from '../../api/_lib/rate-limit.js';
import { watsonxEmbed } from '../../api/_lib/watsonx.js';
import { embedPassages, embedPassagesAny } from '../../api/_lib/embeddings.js';

const handler = (await import('../../api/watsonx/embed.js')).default;

// `rawBody` sends the exact bytes instead of JSON.stringify(body), so a test can
// post literal `null`: valid JSON that is not an object.
function makeReq({ method = 'POST', body = null, rawBody = null } = {}) {
	const payload = rawBody ?? (body === null ? null : JSON.stringify(body));
	const req = payload === null ? Readable.from([]) : Readable.from([Buffer.from(payload)]);
	req.method = method;
	req.url = '/api/watsonx/embed';
	req.headers = {
		host: 'localhost',
		'content-type': 'application/json',
		origin: 'http://localhost',
	};
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function invoke(opts) {
	const res = makeRes();
	await handler(makeReq(opts), res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, res };
}

// Fresh text per test: the handler's vector cache is process-local and lives for
// the whole module, so reusing a string across tests would leak cache hits.
let seq = 0;
const uniqueTexts = (n) => {
	seq += 1;
	return Array.from({ length: n }, (_, i) => `probe ${seq} item ${i}`);
};

beforeEach(() => {
	vi.clearAllMocks();
	limits.watsonxEmbedIp.mockResolvedValue({ success: true });
	limits.watsonxEmbedGlobal.mockResolvedValue({ success: true });
	state.wxConfigured = true;
	state.wxCoverage = null;
	state.wxError = null;
	state.fallbackConfigured = true;
	state.fallbackError = null;
});

describe('POST /api/watsonx/embed validation', () => {
	it('rejects a non-POST method', async () => {
		const { status } = await invoke({ method: 'GET' });
		expect(status).toBe(405);
	});

	it('rejects a missing texts field with a JSON 400', async () => {
		const { status, body } = await invoke({ body: {} });
		expect(status).toBe(400);
		expect(body.error).toBe('bad_request');
		expect(body.error_description).toContain('texts must be an array');
	});

	it('rejects a literal null body without throwing', async () => {
		const { status, body } = await invoke({ rawBody: 'null' });
		expect(status).toBe(400);
		expect(body.error).toBe('bad_request');
	});

	it('rejects an empty batch and an oversized batch', async () => {
		const empty = await invoke({ body: { texts: [] } });
		expect(empty.status).toBe(400);
		const tooMany = await invoke({ body: { texts: uniqueTexts(97) } });
		expect(tooMany.status).toBe(400);
		expect(tooMany.body.error_description).toContain('1 to 96');
	});

	it('rejects non-string and blank entries', async () => {
		expect((await invoke({ body: { texts: ['ok', 7] } })).status).toBe(400);
		expect((await invoke({ body: { texts: ['   '] } })).status).toBe(400);
	});

	it('503s with an actionable message when no provider is configured', async () => {
		state.wxConfigured = false;
		state.fallbackConfigured = false;
		const { status, body } = await invoke({ body: { texts: uniqueTexts(1) } });
		expect(status).toBe(503);
		expect(body.error).toBe('embed_unconfigured');
		expect(body.error_description).toContain('WATSONX_API_KEY');
		expect(body.vectors).toBeUndefined();
	});
});

describe('POST /api/watsonx/embed provider chain', () => {
	it('serves the Granite lane and preserves input order', async () => {
		const texts = uniqueTexts(3);
		const { status, body } = await invoke({ body: { texts } });
		expect(status).toBe(200);
		expect(body.model).toBe('ibm/granite-embedding-278m-multilingual');
		expect(body.dimensions).toBe(4);
		expect(body.count).toBe(3);
		expect(body.cachedHits).toBe(0);
		expect(body.vectors).toEqual([graniteVec(0), graniteVec(1), graniteVec(2)]);
		expect(embedPassages).not.toHaveBeenCalled();
	});

	it('honours a caller-supplied model id', async () => {
		await invoke({ body: { texts: uniqueTexts(1), model: 'ibm/granite-embedding-107m-multilingual' } });
		expect(watsonxEmbed).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ model: 'ibm/granite-embedding-107m-multilingual' }),
		);
	});

	it('reuses the process-local cache on a repeat call', async () => {
		const texts = uniqueTexts(2);
		await invoke({ body: { texts } });
		const second = await invoke({ body: { texts } });
		expect(second.status).toBe(200);
		expect(second.body.cachedHits).toBe(2);
		expect(second.body.vectors).toEqual([graniteVec(0), graniteVec(1)]);
		// One upstream call total: the repeat was served entirely from cache.
		expect(watsonxEmbed).toHaveBeenCalledTimes(1);
	});

	it('falls through to the platform chain when watsonx fails', async () => {
		state.wxError = 'watsonx.ai error (503): service unavailable';
		const texts = uniqueTexts(2);
		const { status, body } = await invoke({ body: { texts } });
		expect(status).toBe(200);
		expect(body.model).toBe('nvidia/nv-embedqa-e5-v5');
		expect(body.vectors).toEqual([fallbackVec(0), fallbackVec(1)]);
	});

	it('skips watsonx entirely when it is not configured', async () => {
		state.wxConfigured = false;
		const { status, body } = await invoke({ body: { texts: uniqueTexts(1) } });
		expect(status).toBe(200);
		expect(watsonxEmbed).not.toHaveBeenCalled();
		expect(body.model).toBe('nvidia/nv-embedqa-e5-v5');
	});

	it('treats a partially-covered batch as a failure and lets the fallback cover it', async () => {
		// watsonx answers 1 of 3. The old code returned 200 with two nulls.
		state.wxCoverage = 1;
		const texts = uniqueTexts(3);
		const { status, body } = await invoke({ body: { texts } });
		expect(status).toBe(200);
		expect(body.model).toBe('nvidia/nv-embedqa-e5-v5');
		expect(body.count).toBe(3);
		expect(body.vectors).toHaveLength(3);
		expect(body.vectors.every((v) => Array.isArray(v) && v.length === 4)).toBe(true);
		// One call covers the whole batch, through whichever lane answers.
		expect(embedPassagesAny).toHaveBeenCalledTimes(1);
	});

	// Every tier failing at the network level is upstream weather, not a bad
	// request, so the handler answers a retryable 503 + Retry-After rather than a
	// 502 a caller reads as permanent. The cause still names the last provider.
	it('503s with the upstream cause when every provider fails', async () => {
		state.wxError = 'watsonx.ai error (401): unauthorized';
		state.fallbackError = 'nim embedder unreachable';
		const { status, body } = await invoke({ body: { texts: uniqueTexts(2) } });
		expect(status).toBe(503);
		expect(body.error).toBe('embed_unavailable');
		expect(body.error_description).toContain('nim embedder unreachable');
		expect(body.vectors).toBeUndefined();
	});

	it('never serves a null vector when both tiers answer short', async () => {
		state.wxCoverage = 0;
		state.fallbackError = 'nim embedder unreachable';
		const { status, body } = await invoke({ body: { texts: uniqueTexts(2) } });
		expect(status).toBe(503);
		expect(body.vectors).toBeUndefined();
	});
});

describe('POST /api/watsonx/embed rate limits', () => {
	it('429s on the per-IP limit before touching a provider', async () => {
		limits.watsonxEmbedIp.mockResolvedValue({ success: false, limit: 20, remaining: 0, reset: Date.now() + 1000 });
		const { status } = await invoke({ body: { texts: uniqueTexts(1) } });
		expect(status).toBe(429);
		expect(watsonxEmbed).not.toHaveBeenCalled();
	});

	it('429s on the global ceiling', async () => {
		limits.watsonxEmbedGlobal.mockResolvedValue({ success: false, limit: 500, remaining: 0, reset: Date.now() + 1000 });
		const { status } = await invoke({ body: { texts: uniqueTexts(1) } });
		expect(status).toBe(429);
		expect(watsonxEmbed).not.toHaveBeenCalled();
	});
});
