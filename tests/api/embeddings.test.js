// Tests for api/_lib/embeddings.js — the multi-provider embedding module with
// vector-space tagging. Pins the four invariants the widget RAG stack leans
// on: (1) free-first provider selection (NIM leads, OpenAI is the paid
// backstop), (2) every embed call is bound to an explicit embedder tag and the
// NIM lane carries the REQUIRED input_type + respects the 512-token cap,
// (3) untagged legacy rows resolve to OpenAI text-embedding-3-small@256,
// (4) cross-space comparison is impossible: scoreRowsBySpace refuses spaces
// no provider can serve, and cosine scores mismatched dimensions as 0.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../api/_lib/gcp-auth.js', () => ({
	getGcpAccessToken: vi.fn(async () => 'fake-access-token'),
}));

import {
	NIM_EMBED_TAG,
	VERTEX_EMBED_TAG,
	OPENAI_EMBED_TAG,
	LEGACY_EMBED_TAG,
	embeddingsConfigured,
	defaultIngestEmbedderTag,
	resolveEmbedderTag,
	embedderInfo,
	embedderConfigured,
	embedWith,
	embedPassages,
	embedQuery,
	scoreRowsBySpace,
	cosine,
} from '../../api/_lib/embeddings.js';

const NIM_URL = 'https://integrate.api.nvidia.com/v1/embeddings';
const OPENAI_URL = 'https://api.openai.com/v1/embeddings';
const VERTEX_URL =
	'https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/google/models/text-embedding-005:predict';

function okEmbeddings(vectors) {
	return {
		ok: true,
		status: 200,
		json: async () => ({ data: vectors.map((embedding, index) => ({ index, embedding })) }),
		text: async () => '',
	};
}

function okVertexEmbeddings(vectors) {
	return {
		ok: true,
		status: 200,
		json: async () => ({ predictions: vectors.map((values) => ({ embeddings: { values } })) }),
		text: async () => '',
	};
}

const fetchMock = vi.fn();

function clearKeys() {
	delete process.env.NVIDIA_API_KEY;
	delete process.env.OPENAI_API_KEY;
	delete process.env.GOOGLE_CLOUD_PROJECT;
}

beforeEach(() => {
	clearKeys();
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearKeys();
});

function lastBody() {
	return JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
}

describe('provider configuration (free-first)', () => {
	it('reports unconfigured and no default when no key is present', () => {
		expect(embeddingsConfigured()).toBe(false);
		expect(defaultIngestEmbedderTag()).toBe(null);
	});

	it('prefers the free NIM lane when its key is present', () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.OPENAI_API_KEY = 'sk-test';
		expect(embeddingsConfigured()).toBe(true);
		expect(defaultIngestEmbedderTag()).toBe(NIM_EMBED_TAG);
	});

	it('prefers Vertex over OpenAI when NIM is keyless but GCP is configured', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		process.env.OPENAI_API_KEY = 'sk-test';
		expect(defaultIngestEmbedderTag()).toBe(VERTEX_EMBED_TAG);
	});

	it('falls back to OpenAI for new ingests only when NIM and Vertex are both unavailable', () => {
		process.env.OPENAI_API_KEY = 'sk-test';
		expect(defaultIngestEmbedderTag()).toBe(OPENAI_EMBED_TAG);
	});
});

describe('embedder tag resolution (vector-space identity)', () => {
	it('treats untagged legacy rows as OpenAI text-embedding-3-small@256', () => {
		expect(LEGACY_EMBED_TAG).toBe(OPENAI_EMBED_TAG);
		expect(resolveEmbedderTag(null)).toBe(LEGACY_EMBED_TAG);
		expect(resolveEmbedderTag('')).toBe(LEGACY_EMBED_TAG);
		expect(resolveEmbedderTag(undefined)).toBe(LEGACY_EMBED_TAG);
	});

	it('refuses unknown tags — an unknown space can never be queried', () => {
		expect(resolveEmbedderTag('mystery-model@4096')).toBe(null);
		expect(embedderInfo('mystery-model@4096')).toBe(null);
		expect(embedderConfigured('mystery-model@4096')).toBe(false);
	});

	it('exposes model id + dimension for known tags', () => {
		expect(embedderInfo(NIM_EMBED_TAG)).toMatchObject({
			model: 'nvidia/nv-embedqa-e5-v5',
			dim: 1024,
			free: true,
		});
		expect(embedderInfo(VERTEX_EMBED_TAG)).toMatchObject({
			model: 'text-embedding-005',
			dim: 768,
			free: false,
		});
		expect(embedderInfo(OPENAI_EMBED_TAG)).toMatchObject({
			model: 'text-embedding-3-small',
			dim: 256,
		});
	});

	it('embedderConfigured tracks the provider key for the tag, not any key', () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		expect(embedderConfigured(NIM_EMBED_TAG)).toBe(true);
		expect(embedderConfigured(VERTEX_EMBED_TAG)).toBe(false);
		expect(embedderConfigured(OPENAI_EMBED_TAG)).toBe(false);
		expect(embedderConfigured(null)).toBe(false); // legacy = OpenAI, no key
	});

	it('embedderConfigured recognizes Vertex via GOOGLE_CLOUD_PROJECT alone', () => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
		expect(embedderConfigured(VERTEX_EMBED_TAG)).toBe(true);
		expect(embedderConfigured(NIM_EMBED_TAG)).toBe(false);
	});
});

describe('embedWith — NIM lane', () => {
	beforeEach(() => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
	});

	it('sends model, inputs, and the REQUIRED input_type for passages', async () => {
		fetchMock.mockResolvedValueOnce(okEmbeddings([[0.1, 0.2], [0.3, 0.4]]));
		const out = await embedPassages(NIM_EMBED_TAG, ['one', 'two']);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe(NIM_URL);
		expect(lastBody()).toEqual({
			model: 'nvidia/nv-embedqa-e5-v5',
			input: ['one', 'two'],
			input_type: 'passage',
		});
		expect(out).toHaveLength(2);
		expect(out[0]).toBeInstanceOf(Float64Array);
	});

	it('embeds search strings with input_type query', async () => {
		fetchMock.mockResolvedValueOnce(okEmbeddings([[0.5, 0.6]]));
		const vec = await embedQuery(NIM_EMBED_TAG, 'what is three.ws?');
		expect(lastBody().input_type).toBe('query');
		expect(Array.from(vec)).toEqual([0.5, 0.6]);
	});

	it('rejects an invalid inputType before any network call', async () => {
		await expect(embedWith(NIM_EMBED_TAG, ['x'], 'document')).rejects.toMatchObject({
			code: 'embedder_error',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('retries an over-length 400 once with inputs truncated under the 512-token cap', async () => {
		const oversized = 'x'.repeat(9000);
		fetchMock
			.mockResolvedValueOnce({
				ok: false,
				status: 400,
				text: async () => '{"error":"Input length 4032 exceeds maximum allowed token size 512"}',
			})
			.mockResolvedValueOnce(okEmbeddings([[1, 0]]));
		const out = await embedPassages(NIM_EMBED_TAG, [oversized]);
		expect(out).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const retryInput = JSON.parse(fetchMock.mock.calls[1][1].body).input[0];
		expect(retryInput.length).toBeLessThanOrEqual(512 * 3);
	});

	it('does not retry-loop: a second over-length 400 surfaces as an error', async () => {
		const reject400 = {
			ok: false,
			status: 400,
			text: async () => 'Input length 9999 exceeds maximum allowed token size 512',
		};
		fetchMock.mockResolvedValueOnce(reject400).mockResolvedValueOnce(reject400);
		await expect(embedPassages(NIM_EMBED_TAG, ['x'.repeat(9000)])).rejects.toMatchObject({
			code: 'embedder_error',
			status: 400,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('surfaces upstream failures with status for backoff routing', async () => {
		fetchMock.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'slow down' });
		await expect(embedPassages(NIM_EMBED_TAG, ['x'])).rejects.toMatchObject({
			code: 'embedder_error',
			status: 429,
		});
	});

	it('sorts response rows by index so vectors align with inputs', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				data: [
					{ index: 1, embedding: [2, 2] },
					{ index: 0, embedding: [1, 1] },
				],
			}),
		});
		const out = await embedPassages(NIM_EMBED_TAG, ['a', 'b']);
		expect(Array.from(out[0])).toEqual([1, 1]);
		expect(Array.from(out[1])).toEqual([2, 2]);
	});
});

describe('embedWith — OpenAI lane', () => {
	it('requests the Matryoshka-truncated 256 dimensions', async () => {
		process.env.OPENAI_API_KEY = 'sk-test';
		fetchMock.mockResolvedValueOnce(okEmbeddings([[0.1]]));
		await embedPassages(OPENAI_EMBED_TAG, ['hello']);
		expect(fetchMock.mock.calls[0][0]).toBe(OPENAI_URL);
		expect(lastBody()).toEqual({
			model: 'text-embedding-3-small',
			input: ['hello'],
			dimensions: 256,
		});
	});

	it('throws no_embedder when the tag is known but its key is absent', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		await expect(embedPassages(OPENAI_EMBED_TAG, ['x'])).rejects.toMatchObject({
			code: 'no_embedder',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('throws unknown_embedder for a tag this build does not know', async () => {
		await expect(embedPassages('mystery@1', ['x'])).rejects.toMatchObject({
			code: 'unknown_embedder',
		});
	});
});

describe('embedWith — Vertex lane', () => {
	beforeEach(() => {
		process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
	});

	it('sends the 768-dim output request and the REQUIRED task_type for passages', async () => {
		fetchMock.mockResolvedValueOnce(okVertexEmbeddings([[0.1, 0.2]]));
		const out = await embedPassages(VERTEX_EMBED_TAG, ['one']);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe(VERTEX_URL);
		expect(lastBody()).toEqual({
			instances: [{ content: 'one', task_type: 'RETRIEVAL_DOCUMENT' }],
			parameters: { outputDimensionality: 768 },
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toBeInstanceOf(Float64Array);
	});

	it('embeds search strings with task_type RETRIEVAL_QUERY', async () => {
		fetchMock.mockResolvedValueOnce(okVertexEmbeddings([[0.5, 0.6]]));
		const vec = await embedQuery(VERTEX_EMBED_TAG, 'what is three.ws?');
		expect(lastBody().instances[0].task_type).toBe('RETRIEVAL_QUERY');
		expect(Array.from(vec)).toEqual([0.5, 0.6]);
	});

	it('batches multiple texts into one request, aligned with the input order', async () => {
		fetchMock.mockResolvedValueOnce(okVertexEmbeddings([[1, 1], [2, 2]]));
		const out = await embedPassages(VERTEX_EMBED_TAG, ['a', 'b']);
		expect(Array.from(out[0])).toEqual([1, 1]);
		expect(Array.from(out[1])).toEqual([2, 2]);
	});

	it('throws no_embedder when GOOGLE_CLOUD_PROJECT is absent', async () => {
		delete process.env.GOOGLE_CLOUD_PROJECT;
		await expect(embedPassages(VERTEX_EMBED_TAG, ['x'])).rejects.toMatchObject({
			code: 'no_embedder',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('surfaces upstream failures with status for backoff routing', async () => {
		fetchMock.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'slow down' });
		await expect(embedPassages(VERTEX_EMBED_TAG, ['x'])).rejects.toMatchObject({
			code: 'embedder_error',
			status: 429,
		});
	});

	it('rejects a malformed response shape', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ predictions: [] }),
			text: async () => '',
		});
		await expect(embedPassages(VERTEX_EMBED_TAG, ['x'])).rejects.toMatchObject({
			code: 'embedder_error',
		});
	});
});

describe('scoreRowsBySpace — same-space routing, cross-space refusal', () => {
	it('embeds the query in each servable space and scores strictly within it', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.OPENAI_API_KEY = 'sk-test';
		// NIM query vector [1,0]; OpenAI query vector [0,1].
		fetchMock.mockImplementation(async (url, init) => {
			const body = JSON.parse(init.body);
			return okEmbeddings([body.model.startsWith('nvidia/') ? [1, 0] : [0, 1]]);
		});
		const rows = [
			{ id: 1, embedder: NIM_EMBED_TAG, embedding: [1, 0] }, // matches NIM query
			{ id: 2, embedder: null, embedding: [0, 1] }, // legacy → OpenAI space, matches
			{ id: 3, embedder: NIM_EMBED_TAG, embedding: [0, 1] }, // orthogonal in NIM space
		];
		const { scored, needsReembed } = await scoreRowsBySpace(rows, 'question?');
		expect(needsReembed).toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(2); // one query embed per space
		const byId = Object.fromEntries(scored.map((r) => [r.id, r]));
		expect(byId[1].score).toBeCloseTo(1, 6);
		expect(byId[2].score).toBeCloseTo(1, 6);
		expect(byId[2].embedder).toBe(LEGACY_EMBED_TAG); // legacy normalized, not guessed
		expect(byId[3].score).toBeCloseTo(0, 6);
	});

	it('refuses to score rows whose space no configured provider can serve', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test'; // OpenAI NOT configured
		fetchMock.mockResolvedValue(okEmbeddings([[1, 0]]));
		const rows = [
			{ id: 1, embedder: NIM_EMBED_TAG, embedding: [1, 0] },
			{ id: 2, embedder: null, embedding: [0.9, 0.1] }, // legacy OpenAI space
			{ id: 3, embedder: 'retired-model@999', embedding: [0.9, 0.1] },
		];
		const { scored, needsReembed } = await scoreRowsBySpace(rows, 'q');
		expect(scored.map((r) => r.id)).toEqual([1]);
		expect(needsReembed).toEqual(
			expect.arrayContaining([
				{ embedder: LEGACY_EMBED_TAG, chunks: 1 },
				{ embedder: 'retired-model@999', chunks: 1 },
			]),
		);
		// The legacy rows were never compared against the NIM query vector.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('cosine — dimension guard', () => {
	it('scores identical vectors as 1', () => {
		expect(cosine([0.1, 0.2, 0.3], [0.1, 0.2, 0.3])).toBeCloseTo(1, 6);
	});

	it('scores mismatched dimensions as 0 — never compares a shared prefix', () => {
		// A 1024-dim NIM vector vs a 256-dim OpenAI vector must not produce a
		// plausible-looking similarity from the overlapping prefix.
		expect(cosine([1, 1, 1], [1, 1])).toBe(0);
	});

	it('scores zero vectors as 0, not NaN', () => {
		expect(cosine([0, 0], [1, 1])).toBe(0);
	});
});
