// GET /api/v1/agents/:caip, the ERC-8004 / Card v1 agent resolver.
//
// The first block is the regression guard that matters most: the ref carries a
// "/" before the tokenId, and the API dispatcher rejects any path segment that
// percent-decodes to contain a separator (the guard that stops
// "%2f..%2f..%2fvite.config" traversal). A whole-ref encodeURIComponent
// therefore produces "%2F" and 404s before any handler runs, which is what the
// docs used to tell callers to send and what src/erc8004/badge.js used to
// build. These tests resolve through the REAL production resolver
// (server/route-resolve.mjs, the same module server/index.mjs dispatches with)
// so a rename back to a single-segment [caip].js fails here instead of in
// production.
//
// The rest exercises the handler itself against a stubbed chain read: the
// success path, an unparseable ref (400), an unsupported chain (400), a
// registry that differs from the canonical deployment (400), a chain-read miss
// (404), and the rate limit (429).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiSegments, resolveApi } from '../../server/route-resolve.mjs';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../api');

const REGISTRY = '0x8004A169Ff0A8Ff2Ea3b5D0a3F4a1E3D3f6a1e3D';
const OWNER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const REF = `eip155:8453:${REGISTRY}/1`;

// ── Routing: does the documented URL actually reach a handler? ───────────────

function resolvePath(pathname) {
	const segments = apiSegments(pathname);
	if (!segments) return null;
	return resolveApi(API_ROOT, segments, {});
}

describe('/api/v1/agents/:caip routing', () => {
	it('routes a ref whose "/" is a real path separator', () => {
		const hit = resolvePath(`/api/v1/agents/${REF}`);
		expect(hit).not.toBeNull();
		expect(path.basename(hit.file)).toBe('[...caip].js');
		expect(hit.params.caip).toBe(REF);
	});

	it('routes the ref with percent-encoded colons, decoding them back', () => {
		const hit = resolvePath(`/api/v1/agents/eip155%3A8453%3A${REGISTRY}/1`);
		expect(hit).not.toBeNull();
		expect(hit.params.caip).toBe(REF);
	});

	it('still refuses a percent-encoded slash, so the traversal guard holds', () => {
		// This is the shape a whole-ref encodeURIComponent produces. It must stay
		// unroutable: the same rule stops "%2f..%2f..%2fvite.config".
		expect(apiSegments(`/api/v1/agents/${encodeURIComponent(REF)}`)).toBeNull();
		expect(apiSegments('/api/v1/agents/%2e%2e%2f%2e%2e%2fvite.config')).toBeNull();
	});
});

// ── Handler ─────────────────────────────────────────────────────────────────

let quotaOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcpIp: async () =>
			quotaOk
				? { success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 }
				: { success: false, limit: 60, remaining: 0, reset: Date.now() + 60_000 },
	},
	clientIp: () => '203.0.113.9',
}));

let chainResult = null;
vi.mock('../../api/_lib/onchain.js', () => ({
	resolveOnChainAgent: async () => chainResult,
	resolveURI: (uri) => uri,
}));

// The card's model.uri is attacker-authored, so the handler fetches it through
// the SSRF guard. Stub that boundary so no test opens a socket.
let modelBytes = null;
vi.mock('../../api/_lib/ssrf-guard.js', () => ({
	fetchSafePublicUrl: async () =>
		modelBytes
			? { ok: true, arrayBuffer: async () => modelBytes }
			: { ok: false, arrayBuffer: async () => new ArrayBuffer(0) },
}));

beforeEach(() => {
	quotaOk = true;
	modelBytes = null;
	chainResult = {
		chainId: 8453,
		agentId: '1',
		registry: REGISTRY,
		owner: OWNER,
		tokenURI: 'ipfs://bafyagentcard',
		manifest: {
			type: ['https://three.ws/specs/3d-agent-card-v1'],
			name: 'Test Agent',
		},
	};
});
afterEach(() => {
	vi.restoreAllMocks();
});

function makeReq(caip, { method = 'GET' } = {}) {
	const stream = Readable.from([]);
	stream.method = method;
	stream.url = `/api/v1/agents/${caip}`;
	stream.headers = { host: 'three.ws' };
	stream.query = { caip };
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}

async function dispatch(req, res) {
	const mod = await import('../../api/v1/agents/[...caip].js');
	await mod.default(req, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

describe('GET /api/v1/agents/:caip handler', () => {
	it('resolves an agent and reports the card schema', async () => {
		const { res, body } = await dispatch(makeReq(REF), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.ref).toBe(`eip155:8453:${REGISTRY}/1`);
		expect(body.chainId).toBe(8453);
		expect(body.agentId).toBe('1');
		expect(body.owner).toBe(OWNER);
		expect(body.card.name).toBe('Test Agent');
		expect(body.verified).toEqual({ modelSha256: null, cardSchema: '3d-agent-card-v1' });
		expect(res.getHeader('cache-control')).toMatch(/s-maxage=300/);
	});

	it('accepts the array form a catch-all param can take', async () => {
		const req = makeReq(REF);
		req.query = { caip: [`eip155:8453:${REGISTRY}`, '1'] };
		const { res } = await dispatch(req, makeRes());
		expect(res.statusCode).toBe(200);
	});

	it('verifies the card model hash against the fetched bytes', async () => {
		const bytes = new TextEncoder().encode('glb-bytes');
		const digest = await crypto.subtle.digest('SHA-256', bytes);
		const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
		modelBytes = bytes.buffer;
		chainResult.manifest.model = { uri: 'https://three.ws/cdn/a.glb', sha256: hex };

		const { body } = await dispatch(makeReq(REF), makeRes());
		expect(body.verified.modelSha256).toBe(true);
	});

	it('reports a mismatched model hash as false rather than failing the request', async () => {
		modelBytes = new TextEncoder().encode('different-bytes').buffer;
		chainResult.manifest.model = { uri: 'https://three.ws/cdn/a.glb', sha256: 'deadbeef' };

		const { res, body } = await dispatch(makeReq(REF), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.verified.modelSha256).toBe(false);
	});

	it('rejects a ref that is not a CAIP agent ref with 400', async () => {
		const { res, body } = await dispatch(makeReq('notacaip'), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_caip');
	});

	it('rejects an unsupported chain with 400', async () => {
		chainResult = { error: 'unsupported_chain' };
		const { res, body } = await dispatch(makeReq(`eip155:999999:${REGISTRY}/1`), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('unsupported_chain');
	});

	it('returns 404 (never 500) when the chain read finds no such agent', async () => {
		chainResult = { error: 'chain_read: execution reverted' };
		const { res, body } = await dispatch(makeReq(REF), makeRes());
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('rejects a registry that differs from the canonical deployment with 400', async () => {
		const { res, body } = await dispatch(
			makeReq('eip155:8453:0x00000000000000000000000000000000deadbeef/1'),
			makeRes(),
		);
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('registry_mismatch');
	});

	it('rate-limits per IP with 429', async () => {
		quotaOk = false;
		const { res } = await dispatch(makeReq(REF), makeRes());
		expect(res.statusCode).toBe(429);
	});
});
