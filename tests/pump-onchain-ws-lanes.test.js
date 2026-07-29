import { describe, it, expect } from 'vitest';
import { classifyWsFailure } from '../api/_lib/pump-onchain-trades.js';

// Serving JSON-RPC over HTTP does not imply serving it over a WebSocket. Some
// lanes in the shared RPC chain answer the upgrade with a redirect or a flat
// refusal while their HTTP side is healthy (measured 2026-07-29:
// solana.leorpc.com → 301, solana-mainnet.gateway.tatum.io → 405). web3.js hands
// the socket to rpc-websockets, which retries ANY failure forever — 100 error
// lines an hour against a host that can never serve the stream. The bench policy
// splits "will never work" from "try again shortly"; this pins that split.
describe('classifyWsFailure', () => {
	it('treats an upgrade redirect as structural', () => {
		// The exact message web3.js surfaced in production.
		expect(classifyWsFailure('Unexpected server response: 301')).toBe('structural');
		for (const code of [302, 307, 308]) {
			expect(classifyWsFailure(`Unexpected server response: ${code}`)).toBe('structural');
		}
	});

	it('treats "this host does not do websockets here" as structural', () => {
		for (const code of [401, 403, 404, 405, 410, 501]) {
			expect(classifyWsFailure(`Unexpected server response: ${code}`)).toBe('structural');
		}
	});

	it('treats a throttle as transient so the lane comes back', () => {
		// 429 is the documented QuickNode/Helius ws behaviour under load — the lane
		// is fine, it is just busy, so benching it forever would burn a good lane.
		expect(classifyWsFailure('Unexpected server response: 429')).toBe('transient');
	});

	it('treats gateway and server errors as transient', () => {
		for (const code of [500, 502, 503, 504]) {
			expect(classifyWsFailure(`Unexpected server response: ${code}`)).toBe('transient');
		}
	});

	it('treats transport faults with no status as transient', () => {
		expect(classifyWsFailure('read ECONNRESET')).toBe('transient');
		expect(classifyWsFailure('probe timeout')).toBe('transient');
		expect(classifyWsFailure('subscription delivered no events')).toBe('transient');
		expect(classifyWsFailure('')).toBe('transient');
		expect(classifyWsFailure(undefined)).toBe('transient');
	});

	it('does not read a status out of unrelated digits', () => {
		// Only the ws library's own phrasing carries a status; a stray number in a
		// transport error must not be mistaken for a permanent refusal.
		expect(classifyWsFailure('connect ETIMEDOUT 301.1.1.1:443')).toBe('transient');
	});
});
