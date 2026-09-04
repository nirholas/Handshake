import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
	isFreeModelId,
	rankFreeModels,
	listFreeModels,
	isLiveFreeModel,
	pickDefaultFreeModel,
	resetFreeModelCache,
} from '../../api/_lib/openrouter-free.js';

// The retirement that took /chat down on 2026-07-27: every id the app shipped
// disappeared from OpenRouter's catalog at once.
const RETIRED = [
	'openai/gpt-oss-120b:free',
	'meta-llama/llama-3.3-70b-instruct:free',
	'google/gemma-3-27b-it:free',
	'qwen/qwen3-coder:free',
	'nousresearch/hermes-3-llama-3.1-405b:free',
];

const LIVE = {
	data: [
		{ id: 'paid/model', context_length: 999999, supported_parameters: ['tools'] },
		{ id: 'zz/no-tools:free', context_length: 900000, supported_parameters: [] },
		{ id: 'google/gemma-4-31b-it:free', context_length: 262144, supported_parameters: ['tools'] },
		{ id: 'google/gemma-4-31b-it:free', context_length: 131072, supported_parameters: ['tools'] },
	],
};

function mockFetch(payload, { ok = true, status = 200 } = {}) {
	return vi.fn(async () => ({
		ok,
		status,
		json: async () => payload,
	}));
}

beforeEach(() => {
	resetFreeModelCache();
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
	resetFreeModelCache();
});

describe('isFreeModelId', () => {
	it('accepts only :free ids', () => {
		expect(isFreeModelId('google/gemma-4-31b-it:free')).toBe(true);
		expect(isFreeModelId('openai/gpt-oss-120b')).toBe(false);
		expect(isFreeModelId(null)).toBe(false);
		expect(isFreeModelId(undefined)).toBe(false);
	});
});

describe('rankFreeModels', () => {
	it('puts tool-capable models ahead of tool-less ones regardless of context size', () => {
		const ranked = rankFreeModels(LIVE.data.filter((m) => m.id.endsWith(':free')));
		expect(ranked[ranked.length - 1].id).toBe('zz/no-tools:free');
	});

	it('prefers the gpt-oss family, then gemma, among tool-capable models', () => {
		const ranked = rankFreeModels([
			{ id: 'google/gemma-4-31b-it:free', context_length: 262144, supported_parameters: ['tools'] },
			{ id: 'google/gemma-4-31b-it:free', context_length: 131072, supported_parameters: ['tools'] },
		]);
		expect(ranked.map((m) => m.id)).toEqual([
			'google/gemma-4-31b-it:free',
			'google/gemma-4-31b-it:free',
		]);
	});

	it('is deterministic for models of equal rank and context', () => {
		const models = [
			{ id: 'unknown/b:free', context_length: 100, supported_parameters: ['tools'] },
			{ id: 'unknown/a:free', context_length: 100, supported_parameters: ['tools'] },
		];
		expect(rankFreeModels(models).map((m) => m.id)).toEqual(['unknown/a:free', 'unknown/b:free']);
	});
});

describe('listFreeModels', () => {
	it('returns only :free ids and drops paid ones', async () => {
		vi.stubGlobal('fetch', mockFetch(LIVE));
		const models = await listFreeModels();
		expect(models.every((m) => m.id.endsWith(':free'))).toBe(true);
		expect(models.find((m) => m.id === 'paid/model')).toBeUndefined();
	});

	it('caches so repeated calls hit the network once', async () => {
		const f = mockFetch(LIVE);
		vi.stubGlobal('fetch', f);
		await listFreeModels();
		await listFreeModels();
		expect(f).toHaveBeenCalledTimes(1);
	});

	it('returns an empty list rather than throwing when OpenRouter is down', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
		await expect(listFreeModels()).resolves.toEqual([]);
	});

	it('serves the last good list when a later refresh fails', async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal('fetch', mockFetch(LIVE));
			const first = await listFreeModels();
			expect(first.length).toBeGreaterThan(0);

			// Past the 5-minute TTL the next call really does refetch...
			vi.advanceTimersByTime(6 * 60 * 1000);
			const failing = vi.fn(async () => { throw new Error('down'); });
			vi.stubGlobal('fetch', failing);
			const second = await listFreeModels();

			// ...and when that refetch fails, the last good list is still served.
			expect(failing).toHaveBeenCalledTimes(1);
			expect(second.map((m) => m.id)).toEqual(first.map((m) => m.id));
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('isLiveFreeModel', () => {
	it('rejects every id retired in the July 2026 outage', async () => {
		vi.stubGlobal('fetch', mockFetch(LIVE));
		for (const id of RETIRED) {
			expect(await isLiveFreeModel(id)).toBe(false);
		}
	});

	it('accepts an id OpenRouter is serving', async () => {
		vi.stubGlobal('fetch', mockFetch(LIVE));
		expect(await isLiveFreeModel('google/gemma-4-31b-it:free')).toBe(true);
	});

	it('does not declare a model dead during our own outage', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
		expect(await isLiveFreeModel('anything:free')).toBe(true);
	});

	it('rejects a non-free id outright', async () => {
		vi.stubGlobal('fetch', mockFetch(LIVE));
		expect(await isLiveFreeModel('openai/gpt-oss-120b')).toBe(false);
	});
});

describe('pickDefaultFreeModel', () => {
	it('returns the best-ranked live model', async () => {
		vi.stubGlobal('fetch', mockFetch(LIVE));
		expect(await pickDefaultFreeModel()).toBe('google/gemma-4-31b-it:free');
	});

	it('skips excluded ids so a failed model is not retried', async () => {
		vi.stubGlobal('fetch', mockFetch(LIVE));
		expect(await pickDefaultFreeModel({ exclude: ['google/gemma-4-31b-it:free'] })).toBe(
			'google/gemma-4-31b-it:free',
		);
	});

	it('returns null when nothing is live', async () => {
		vi.stubGlobal('fetch', mockFetch({ data: [] }));
		expect(await pickDefaultFreeModel()).toBeNull();
	});
});
