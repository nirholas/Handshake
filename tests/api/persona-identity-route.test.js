// Tests for GET /api/mcp3d/persona-identity, the live chain-state feed the
// embodiment embed polls (only when opened with ?wallet=1) so the body's
// aura/cosmetic/muted-state/nameplate track current chain state.
//
// Every network boundary the identity read touches is stubbed, so these tests
// exercise the route's own contract (status codes, response shape, CORS, cache
// headers, leak-proofing) deterministically instead of depending on a live RPC,
// attestation DB, price feed, or SNS lookup. The persona itself round-trips
// through the real filesystem backend (no DB, no R2).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';
process.env.JWT_SECRET ||= 'test-jwt-secret-not-a-real-secret-0123456789';
process.env.PERSONA_WALLET_SECRET ||= 'test-persona-wallet-secret-0123456789';

vi.mock('../../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: () => ({
		getBalance: vi.fn(async () => { throw new Error('rpc unavailable in test'); }),
		getTokenAccountBalance: vi.fn(async () => { throw new Error('rpc unavailable in test'); }),
	}),
}));
vi.mock('../../api/_lib/portfolio.js', () => ({
	valuateHoldings: vi.fn(async () => { throw new Error('portfolio rpc unavailable in test'); }),
}));
vi.mock('../../api/_mcp/tools/solana.js', () => ({
	solanaReputation: vi.fn(async () => { throw new Error('no db in test'); }),
}));
vi.mock('../../api/_lib/avatar-wallet.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, solUsdPrice: vi.fn(async () => { throw new Error('no price feed in test'); }) };
});

// The nameplate read goes out through global fetch to the SNS API; keep it off
// the network so a sandboxed run is instant and offline-safe.
const realFetch = globalThis.fetch;
globalThis.fetch = vi.fn(async () => { throw new Error('sns unavailable in test'); });

const { createPersona } = await import('../../api/_lib/persona-store.js');
const { default: handler } = await import('../../api/mcp3d/persona-identity.js');

let tmpDir;
const saved = {};
let personaId;

beforeAll(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-identity-route-test-'));
	for (const k of ['PERSONA_STORE_DIR', 'DATABASE_URL', 'S3_BUCKET', 'S3_PUBLIC_DOMAIN']) saved[k] = process.env[k];
	process.env.PERSONA_STORE_DIR = tmpDir;
	delete process.env.DATABASE_URL;
	delete process.env.S3_BUCKET;
	delete process.env.S3_PUBLIC_DOMAIN;
	const rec = await createPersona({
		name: 'Nova',
		glbUrl: 'https://three.ws/cdn/creations/nova.glb',
		glbKey: 'creations/nova.glb',
		ownerId: 'secret-owner',
	});
	personaId = rec.id;
});

afterAll(async () => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	globalThis.fetch = realFetch;
	if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeReq({ method = 'GET', url = '/' } = {}) {
	const req = Readable.from([]);
	req.method = method;
	req.url = url;
	req.headers = { host: 'three.ws' };
	return req;
}
function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(chunk) { if (chunk !== undefined) this.body += chunk; this.writableEnded = true; },
	};
}
async function invoke(url, method = 'GET') {
	const req = makeReq({ url, method });
	const res = makeRes();
	await handler(req, res);
	return { res, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

describe('GET /api/mcp3d/persona-identity', () => {
	it('resolves a known persona to its public projection plus the live identity read', async () => {
		const { status, body, res } = await invoke(`/api/mcp3d/persona-identity?id=${personaId}`);
		expect(status).toBe(200);
		// The persona body itself, nested; the identity fields spread at the top
		// level because that is exactly what EmbodimentStage.setChainState() reads.
		expect(body.persona.persona_id).toBe(personaId);
		expect(body.persona.name).toBe('Nova');
		expect(body.persona_id).toBe(personaId);
		expect(body.network).toBe('mainnet');
		expect(body.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
		expect(body.explorer).toContain(body.address);
		for (const k of ['balances', 'reputation', 'holdings', 'nameplate', 'visual', 'caps', 'fetched_at']) {
			expect(body[k]).toBeDefined();
		}
		// Every tier has a designed value even when every upstream is down.
		expect(body.visual.reputation_tier).toBe('unranked');
		expect(body.visual.holdings_tier).toBe('none');
		// CORS + a short shared cache so the cross-origin embed can poll it.
		expect(res.headers['access-control-allow-origin']).toBe('*');
		expect(res.headers['cache-control']).toMatch(/s-maxage=15/);
		expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
	});

	it('never leaks the storage key, the owner id, or any secret material', async () => {
		const { res } = await invoke(`/api/mcp3d/persona-identity?id=${personaId}`);
		expect(res.body).not.toContain('secret-owner');
		expect(res.body).not.toContain('glb_key');
		expect(res.body).not.toMatch(/secretKey|private_key|privateKey/i);
		expect(res.body).not.toContain(process.env.PERSONA_WALLET_SECRET);
	});

	it('honors ?network=devnet and coerces anything else to mainnet', async () => {
		const dev = await invoke(`/api/mcp3d/persona-identity?id=${personaId}&network=devnet`);
		expect(dev.body.network).toBe('devnet');
		const bogus = await invoke(`/api/mcp3d/persona-identity?id=${personaId}&network=fantasynet`);
		expect(bogus.status).toBe(200);
		expect(bogus.body.network).toBe('mainnet');
		// Same persona, same derived wallet, regardless of which network is read.
		expect(dev.body.address).toBe(bogus.body.address);
	});

	it('400 on a malformed id', async () => {
		const { status, body } = await invoke('/api/mcp3d/persona-identity?id=not-a-persona');
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_id');
	});

	it('400 when the id is missing entirely', async () => {
		const { status, body } = await invoke('/api/mcp3d/persona-identity');
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_id');
	});

	it('404 on a well-formed but unknown id', async () => {
		const { status, body } = await invoke('/api/mcp3d/persona-identity?id=persona_deadbeefdeadbeefdead');
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('405 on a non-GET method, and says which methods are allowed', async () => {
		const { status, body, res } = await invoke(`/api/mcp3d/persona-identity?id=${personaId}`, 'POST');
		expect(status).toBe(405);
		expect(body.error).toBe('method_not_allowed');
		expect(res.headers.allow).toBe('GET, HEAD, OPTIONS');
	});

	it('503 wallet_unavailable when no persona wallet secret is configured', async () => {
		const keys = ['PERSONA_WALLET_SECRET', 'WALLET_ENCRYPTION_KEY', 'JWT_SECRET'];
		const kept = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
		for (const k of keys) delete process.env[k];
		try {
			const { status, body } = await invoke(`/api/mcp3d/persona-identity?id=${personaId}`);
			expect(status).toBe(503);
			expect(body.error).toBe('wallet_unavailable');
			// A config fault is reported as a config fault, never as a stack trace.
			expect(body.message).not.toMatch(/secret|stack|Error:/i);
		} finally {
			for (const [k, v] of Object.entries(kept)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});
});
