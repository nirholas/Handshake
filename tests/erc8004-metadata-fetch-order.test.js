// fetchAgentMetadata resolution order.
//
// An agent's registration JSON is hosted wherever its registrant put it, and
// most of those hosts send no Access-Control-Allow-Origin. A browser cannot
// fail that request quietly: it logs "blocked by CORS policy" and a failed
// request BEFORE the promise rejects, so attempting the direct fetch first made
// every such agent open its page with two console errors even though the agent
// then loaded fine through the proxy. These pin the order (proxy first for a
// cross-origin URI, direct first for a same-origin one) and the fallback that
// keeps the second rung alive.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('ethers', () => ({
	BrowserProvider: class {},
	Contract: class {},
	JsonRpcProvider: class {},
}));

const { fetchAgentMetadata } = await import('../src/erc8004/queries.js');

const ORIGIN = 'https://three.ws';
const CARD = { name: 'GetDigitalCraft', service: [] };

let calls;
function stubFetch(handlers) {
	globalThis.fetch = vi.fn(async (url) => {
		calls.push(String(url));
		for (const [pattern, reply] of handlers) {
			if (String(url).includes(pattern)) return reply();
		}
		throw new TypeError('Failed to fetch');
	});
}

const okJson = (body) => () => ({ ok: true, status: 200, json: async () => body });
const corsBlocked = () => () => {
	throw new TypeError('Failed to fetch');
};

beforeEach(() => {
	calls = [];
	globalThis.location = new URL(`${ORIGIN}/app`);
});

describe('cross-origin registration URI', () => {
	const uri = 'https://x402render.example/.well-known/agent-card.json';

	it('asks our proxy before ever touching the third-party host', async () => {
		stubFetch([['/api/erc8004/metadata', okJson({ data: CARD, resolvedUrl: uri })]]);
		const out = await fetchAgentMetadata(uri);
		expect(out.ok).toBe(true);
		expect(out.data).toEqual(CARD);
		expect(out.viaProxy).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain('/api/erc8004/metadata');
		expect(calls[0]).not.toContain('x402render.example/.well-known');
	});

	it('falls back to the direct fetch when our proxy is the one that fails', async () => {
		stubFetch([
			['/api/erc8004/metadata', () => ({ ok: false, status: 502, json: async () => ({ error: 'upstream_failed' }) })],
			['x402render.example', okJson(CARD)],
		]);
		const out = await fetchAgentMetadata(uri);
		expect(out.ok).toBe(true);
		expect(out.data).toEqual(CARD);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toContain('x402render.example');
	});

	it('reports the proxy failure when both rungs fail', async () => {
		stubFetch([
			['/api/erc8004/metadata', () => ({ ok: false, status: 502, json: async () => ({ error_description: 'upstream refused' }) })],
			['x402render.example', corsBlocked()],
		]);
		const out = await fetchAgentMetadata(uri);
		expect(out.ok).toBe(false);
		expect(out.error).toBe('upstream refused');
	});
});

describe('same-origin registration URI', () => {
	it('fetches directly and never pays for the proxy hop', async () => {
		stubFetch([[`${ORIGIN}/a/sol/x/.well-known`, okJson(CARD)]]);
		const out = await fetchAgentMetadata(`${ORIGIN}/a/sol/x/.well-known/agent-card.json`);
		expect(out.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]).not.toContain('/api/erc8004/metadata');
	});
});

describe('inline data URI', () => {
	it('parses without any network call at all', async () => {
		stubFetch([]);
		const payload = encodeURIComponent(JSON.stringify(CARD));
		const out = await fetchAgentMetadata(`data:application/json,${payload}`);
		expect(out.ok).toBe(true);
		expect(out.data).toEqual(CARD);
		expect(calls).toHaveLength(0);
	});
});
