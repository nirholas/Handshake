/**
 * EVM keyless RPC endpoint hygiene.
 *
 * `CHAINS[].rpcUrls` is the last rung of the failover chain in
 * api/_lib/evm/rpc.js. A dead entry there is not harmless: it is reached on
 * every call that got that far, and a host that accepts the TCP connection and
 * then stalls burns the caller's entire timeout budget rather than failing fast.
 *
 * That is not hypothetical. On 2026-07-29 `/api/v1/resolve` returned 503
 * `ens_unavailable` for every `.eth` name in production. Each endpoint answered
 * an ENS resolve in 229-816 ms on its own, but the chain as a whole took
 * 1154-7066 ms because two rungs were dead — enough to blow the 8 s ENS budget.
 * Two separate causes, both now pinned below:
 *
 *   1. Ankr moved its keyless public RPCs behind auth. Every `rpc.ankr.com/*`
 *      host we listed answers `-32000 Unauthorized` except celo.
 *   2. Hosts that serve a cheap `eth_blockNumber` but time out on an
 *      `eth_call`-class read (eth.drpc.org, "Request timeout on the free plan")
 *      must not lead a chain.
 *
 * These are offline structural checks — they never hit the network, so they
 * cannot flake. Re-probing liveness is a manual step documented on `CHAINS`.
 */

import { describe, it, expect } from 'vitest';
import { CHAINS } from '../api/_lib/erc8004-chains.js';
import { evmRpcEndpoints } from '../api/_lib/evm/rpc.js';

// Hosts proven dead from a datacenter IP. Re-probe with a HEAVY method before
// ever removing an entry from this list.
const DEAD = [
	// Cloudflare bot-wall 403s server-side POSTs.
	'eth.llamarpc.com',
	// Endpoint sunset (-32046).
	'cloudflare-eth.com',
];

// Ankr is dead keyless EXCEPT this one path, which still answered on 2026-07-29.
const ANKR_ALLOWED = ['https://rpc.ankr.com/celo'];

const allUrls = CHAINS.flatMap((c) => c.rpcUrls || []);

describe('keyless RPC endpoint list', () => {
	it('lists no host known to reject or stall server-side POSTs', () => {
		const offenders = allUrls.filter((u) => DEAD.some((h) => u.includes(h)));
		expect(offenders).toEqual([]);
	});

	it('carries no Ankr public RPC beyond the one still answering', () => {
		const ankr = allUrls.filter((u) => u.includes('rpc.ankr.com'));
		expect(ankr).toEqual(ANKR_ALLOWED);
	});

	it('never leaves a chain depending on a single endpoint', () => {
		// The platform rule: no external data source is a single point of failure.
		const thin = CHAINS
			.filter((c) => (c.rpcUrls || []).length < 2)
			.map((c) => `${c.name} (${c.id}): ${JSON.stringify(c.rpcUrls)}`);
		expect(thin).toEqual([]);
	});

	it('does not lead mainnet with the endpoint that times out on heavy reads', () => {
		const eth = CHAINS.find((c) => c.id === 1);
		// eth.drpc.org may stay in the list as a later rung; it must not be first.
		expect(eth.rpcUrls[0]).not.toContain('drpc.org');
	});

	it('uses https for every endpoint and lists no duplicates', () => {
		expect(allUrls.filter((u) => !u.startsWith('https://'))).toEqual([]);
		for (const c of CHAINS) {
			const urls = c.rpcUrls || [];
			expect(new Set(urls).size, `${c.name} has duplicate rpcUrls`).toBe(urls.length);
		}
	});
});

describe('evmRpcEndpoints priority', () => {
	it('pins an explicit primaryUrl ahead of the keyless list', () => {
		const urls = evmRpcEndpoints(1, 'https://my-node.example/rpc');
		expect(urls[0]).toBe('https://my-node.example/rpc');
	});

	it('de-duplicates a primaryUrl that also appears in the keyless list', () => {
		const eth = CHAINS.find((c) => c.id === 1);
		const dupe = eth.rpcUrls[0];
		const urls = evmRpcEndpoints(1, dupe);
		expect(urls.filter((u) => u === dupe)).toHaveLength(1);
	});

	it('still returns the keyless list when no override or key is configured', () => {
		expect(evmRpcEndpoints(1).length).toBeGreaterThanOrEqual(2);
	});
});
