// inspect_model + optimize_model MCP tools (api/_mcp/tools/models.js),
// registered in both api/_mcp/catalog.js and api/_mcp3d/catalog.js.
// (validate_model's dispatch path is covered end-to-end in tests/api/mcp.test.js.)
//
// Verifies: both tools parse a REAL GLB shipped in this repo and report its
// actual structure and optimization advice, so a regression in the inspection
// pipeline fails here rather than in production; the human-readable text and
// the structuredContent agree; the caller's URL is fetched through the
// SSRF-hardened fetchModel (never a bare fetch); a blocked or unfetchable URL
// surfaces the fetch reason; and each tool rate-limits on its own bucket before
// spending any bytes. Only the fetch layer and the rate limiter are mocked; the
// glTF parsing runs for real against public/avatars/mannequin.glb.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODEL_PATH = join(process.cwd(), 'public', 'avatars', 'mannequin.glb');
const MODEL_BYTES = new Uint8Array(readFileSync(MODEL_PATH));
const MODEL_URL = 'https://three.ws/avatars/mannequin.glb';

class MockFetchModelError extends Error {
	constructor(message, code) {
		super(message);
		this.code = code;
	}
}

const fetchState = { error: null, calls: [] };
vi.mock('../../api/_lib/fetch-model.js', () => ({
	FetchModelError: MockFetchModelError,
	fetchModel: vi.fn(async (url) => {
		fetchState.calls.push(url);
		if (fetchState.error) throw fetchState.error;
		return { bytes: MODEL_BYTES, url, filename: 'mannequin.glb' };
	}),
}));

const rlState = { mcpInspect: true, mcpOptimize: true, mcpValidate: true };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcpInspect: vi.fn(async () => ({ success: rlState.mcpInspect, reset: Date.now() + 60_000 })),
		mcpOptimize: vi.fn(async () => ({ success: rlState.mcpOptimize, reset: Date.now() + 60_000 })),
		mcpValidate: vi.fn(async () => ({ success: rlState.mcpValidate, reset: Date.now() + 60_000 })),
	},
}));

const { toolDefs } = await import('../../api/_mcp/tools/models.js');

const AUTH = { userId: null, rateKey: 'model-test', scope: '', source: 'x402' };
const call = (name, args) => toolDefs.find((t) => t.name === name).handler(args, AUTH, {});

beforeEach(() => {
	fetchState.error = null;
	fetchState.calls = [];
	rlState.mcpInspect = true;
	rlState.mcpOptimize = true;
	rlState.mcpValidate = true;
});

describe('model MCP tools: registration', () => {
	it('registers four deterministic, public inspection tools', () => {
		expect(toolDefs.map((t) => t.name)).toEqual([
			'validate_model',
			'inspect_model',
			'optimize_model',
			'diff_models',
		]);
		for (const t of toolDefs) {
			expect(t.scope).toBeUndefined();
			expect(t.annotations).toEqual({
				readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
			});
		}
		// The three single-model tools take one url; diff_models is the only one
		// that reads two, so it names them rather than reusing `url`.
		for (const t of toolDefs.filter((x) => x.name !== 'diff_models')) {
			expect(t.inputSchema.required).toEqual(['url']);
		}
		expect(toolDefs.find((t) => t.name === 'diff_models').inputSchema.required).toEqual([
			'before',
			'after',
		]);
	});
});

describe('inspect_model', () => {
	it('reports the real structure of a GLB shipped in this repo', async () => {
		const r = await call('inspect_model', { url: MODEL_URL });
		expect(fetchState.calls).toEqual([MODEL_URL]);

		const s = r.structuredContent;
		expect(s.url).toBe(MODEL_URL);
		expect(s.filename).toBe('mannequin.glb');
		expect(s.container).toBe('glb');
		expect(s.version).toBe('2.0');
		expect(s.fileSize).toBe(MODEL_BYTES.byteLength);
		expect(s.counts.meshes).toBeGreaterThan(0);
		expect(s.counts.totalTriangles).toBeGreaterThan(0);
		expect(Array.isArray(s.extensionsUsed)).toBe(true);

		// The text summary is a rendering of the same numbers, never a second source.
		const text = r.content[0].text;
		expect(text).toContain('Model: mannequin.glb');
		expect(text).toContain(`Meshes: ${s.counts.meshes}`);
		expect(text).toContain(`Vertices: ${s.counts.totalVertices.toLocaleString()}`);
	});

	it('surfaces the fetch reason when the URL is blocked', async () => {
		fetchState.error = new MockFetchModelError('host resolves to private address', 'private_address');
		await expect(call('inspect_model', { url: 'http://169.254.169.254/model.glb' })).rejects.toThrow(
			'fetch failed: host resolves to private address (private_address)',
		);
	});

	it('rate-limits on its own bucket before fetching', async () => {
		rlState.mcpInspect = false;
		await expect(call('inspect_model', { url: MODEL_URL })).rejects.toMatchObject({
			code: -32000, message: 'rate_limited',
		});
		expect(fetchState.calls).toEqual([]);
	});
});

describe('optimize_model', () => {
	it('returns actionable suggestions derived from the same real inspection', async () => {
		const r = await call('optimize_model', { url: MODEL_URL });
		const s = r.structuredContent;
		expect(s.url).toBe(MODEL_URL);
		expect(Array.isArray(s.suggestions)).toBe(true);
		expect(s.suggestions.length).toBeGreaterThan(0);
		expect(s.info.counts.meshes).toBeGreaterThan(0);

		for (const sug of s.suggestions) {
			expect(typeof sug.id).toBe('string');
			expect(typeof sug.message).toBe('string');
			expect(['info', 'warn', 'critical']).toContain(sug.severity);
			expect(r.content[0].text).toContain(sug.id);
		}
	});

	it('rate-limits on its own bucket, independently of inspect_model', async () => {
		rlState.mcpOptimize = false;
		await expect(call('optimize_model', { url: MODEL_URL })).rejects.toMatchObject({
			code: -32000, message: 'rate_limited',
		});
		expect(fetchState.calls).toEqual([]);

		rlState.mcpOptimize = true;
		const r = await call('optimize_model', { url: MODEL_URL });
		expect(r.structuredContent.suggestions).toBeDefined();
	});

	it('propagates an unexpected fetch fault unwrapped for the dispatcher to sanitize', async () => {
		fetchState.error = new Error('socket hang up');
		await expect(call('optimize_model', { url: MODEL_URL })).rejects.toThrow('socket hang up');
	});
});
