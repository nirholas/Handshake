// api/_lib/evm/rpc.js — endpoint priority and known-dead demotion.
//
// Regression cover for the 2026-07-29 production incident: RPC_URL_ETHEREUM
// was set to eth.llamarpc.com, which Cloudflare bot-walls with a 403 on
// datacenter POSTs. Because an operator override is pinned first, every ENS
// round trip burned a guaranteed-failed request before failing over, and
// GET /api/v1/resolve?name=<x>.eth exceeded its 8s budget and returned 503 on
// every .eth name. The endpoint list now sorts known-hard-fail keyless hosts
// last, so a stale override degrades latency instead of the whole lane.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadModule() {
	vi.resetModules();
	return import('../api/_lib/evm/rpc.js');
}

beforeEach(() => {
	// A clean slate: no operator overrides, no Alchemy key, so the chain's own
	// curated public list is what gets ordered.
	for (const key of ['RPC_URL_ETHEREUM', 'MAINNET_RPC_URL', 'RPC_URL_1', 'ALCHEMY_API_KEY', 'ALCHEMY_ETH_KEY']) {
		delete process.env[key];
	}
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe('isDemotedEndpoint', () => {
	it('flags the hosts that hard-fail a keyless server-side POST', async () => {
		const { isDemotedEndpoint } = await loadModule();
		expect(isDemotedEndpoint('https://eth.llamarpc.com')).toBe(true);
		expect(isDemotedEndpoint('https://cloudflare-eth.com')).toBe(true);
		// Keyless Ankr answers HTTP 200 with an "Unauthorized" JSON-RPC error.
		expect(isDemotedEndpoint('https://rpc.ankr.com/eth')).toBe(true);
	});

	it('does not flag a keyed Ankr url, which carries its key in the path', async () => {
		const { isDemotedEndpoint } = await loadModule();
		expect(isDemotedEndpoint('https://rpc.ankr.com/eth/abc123secretkey')).toBe(false);
	});

	it('leaves healthy endpoints alone and never throws on a malformed url', async () => {
		const { isDemotedEndpoint } = await loadModule();
		expect(isDemotedEndpoint('https://eth.drpc.org')).toBe(false);
		expect(isDemotedEndpoint('https://eth-mainnet.g.alchemy.com/v2/key')).toBe(false);
		expect(isDemotedEndpoint('not a url')).toBe(false);
	});
});

describe('evmRpcEndpoints ordering', () => {
	it('demotes a dead operator override below the healthy public endpoints', async () => {
		process.env.RPC_URL_ETHEREUM = 'https://eth.llamarpc.com';
		const { evmRpcEndpoints, isDemotedEndpoint } = await loadModule();
		const urls = evmRpcEndpoints(1);

		// Kept, but no longer first: this is the exact production misconfiguration.
		// Asserted as an invariant rather than against a named host, since the
		// curated public list in erc8004-chains.js is retuned as endpoints rot.
		expect(urls).toContain('https://eth.llamarpc.com');
		expect(urls[0]).not.toBe('https://eth.llamarpc.com');
		expect(isDemotedEndpoint(urls[0])).toBe(false);

		// Every healthy endpoint is tried before it.
		const deadIndex = urls.indexOf('https://eth.llamarpc.com');
		expect(urls.slice(0, deadIndex).some(isDemotedEndpoint)).toBe(false);
	});

	it('honors a healthy operator override as the first choice', async () => {
		process.env.RPC_URL_ETHEREUM = 'https://my-private-node.example/rpc';
		const { evmRpcEndpoints } = await loadModule();
		expect(evmRpcEndpoints(1)[0]).toBe('https://my-private-node.example/rpc');
	});

	it('keeps every endpoint: demotion is reordering, never dropping', async () => {
		process.env.RPC_URL_ETHEREUM = 'https://eth.llamarpc.com';
		const { evmRpcEndpoints } = await loadModule();
		const withOverride = evmRpcEndpoints(1);
		delete process.env.RPC_URL_ETHEREUM;
		const withoutOverride = (await loadModule()).evmRpcEndpoints(1);

		expect(withOverride).toHaveLength(withoutOverride.length + 1);
		expect(new Set(withOverride).size).toBe(withOverride.length); // still de-duplicated
	});

	it('puts every demoted endpoint after every healthy one', async () => {
		const { evmRpcEndpoints, isDemotedEndpoint } = await loadModule();
		const urls = evmRpcEndpoints(1);
		const firstDemoted = urls.findIndex(isDemotedEndpoint);
		if (firstDemoted === -1) return; // nothing demoted on this chain, nothing to prove
		expect(urls.slice(firstDemoted).every(isDemotedEndpoint)).toBe(true);
	});
});
