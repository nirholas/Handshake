// The metadata half of the Metaplex crawl failed the same silent way the account
// scan did, and for ten days nobody could see it: the cron answered 200 every 30
// minutes while all 1571 rows in solana_agents_index carried
// metadata_error = 'das fetch failed' and no name, image, or GLB.
//
// getAsset is a vendor extension, not core JSON-RPC. Two consequences the old
// code collapsed into one boolean:
//   1. A lane that does not implement it replies HTTP 200 with JSON-RPC -32601.
//      Pinning lane 0 therefore recorded "no metadata" for every account forever.
//   2. A lane that DOES implement it says no the same way once it rate limits
//      (api.mainnet-beta.solana.com serves ~15 calls, then -32000). Treating that
//      as "this lane cannot serve DAS" abandons the only working lane in the chain.
//
// These pin the three-way classification: rotate past unsupported, retry through
// throttled, and never spend the structural upsert's budget on the metered leg.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const ACCOUNTS = [
	{ publicKey: 'ref-one', asset: 'asset-one' },
	{ publicKey: 'ref-two', asset: 'asset-two' },
];

const LANE_UNSUPPORTED = 'https://unsupported.example';
const LANE_SERVING = 'https://serving.example';

let freshRefs = [];
const upserts = [];

vi.mock('../api/_lib/db.js', () => ({
	sql: Object.assign(
		async (strings, ...values) => {
			const text = Array.isArray(strings) ? strings.join('?') : String(strings);
			if (text.includes('last_metadata_at >')) return freshRefs.map((ref) => ({ ref }));
			if (text.includes('INSERT INTO solana_agents_index')) {
				upserts.push({ ref: values[1], name: values[6], enriched: values[19] });
			}
			return [];
		},
		{ unsafe: async () => [] },
	),
}));

vi.mock('../api/_lib/solana/connection.js', () => ({
	solanaRpcEndpoints: () => [LANE_UNSUPPORTED, LANE_SERVING],
	solanaConnection: vi.fn(() => ({ tag: 'rotating-connection' })),
}));

function gpaBuilder(accounts) {
	const builder = {
		whereField: () => builder,
		getDeserialized: async () => accounts,
	};
	return builder;
}

vi.mock('@metaplex-foundation/umi-bundle-defaults', () => ({
	createUmi: () => ({ programs: { add: () => {} } }),
}));
vi.mock('@metaplex-foundation/umi', () => ({ publicKey: (v) => v }));
vi.mock('@metaplex-foundation/mpl-agent-registry', () => ({
	// All accounts come back on the v2 builder so each test drives a known count.
	getAgentIdentityV2GpaBuilder: () => gpaBuilder(ACCOUNTS),
	getAgentIdentityV1GpaBuilder: () => gpaBuilder([]),
}));

const { crawlMetaplexAgents } = await import('../api/_lib/solana-agents-crawl.js');

const rpcError = (code, message) => ({ ok: true, status: 200, json: async () => ({ error: { code, message } }) });
const rpcResult = (name) => ({
	ok: true,
	status: 200,
	json: async () => ({ result: { id: 'asset', content: { metadata: { name }, json_uri: 'https://x.test/m.json' } } }),
});

/** Install a fetch stub that answers per lane URL, recording every call. */
function stubFetch(perLane) {
	const calls = [];
	vi.stubGlobal('fetch', vi.fn(async (url) => {
		calls.push(String(url));
		return perLane(String(url), calls.filter((c) => c === String(url)).length);
	}));
	return calls;
}

describe('DAS enrichment rotates the lane chain', () => {
	beforeEach(() => {
		freshRefs = [];
		upserts.length = 0;
		vi.unstubAllGlobals();
	});

	it('skips a lane that does not implement getAsset and sticks to one that does', async () => {
		const calls = stubFetch((url) =>
			url === LANE_UNSUPPORTED
				? rpcError(-32601, 'Method not found')
				: rpcResult('Indexed Agent'));

		const report = await crawlMetaplexAgents({ deadline: Date.now() + 20_000 });

		expect(report.enriched).toBe(2);
		expect(report.dasLane).toBe(LANE_SERVING);
		// The unsupported lane is asked exactly once for the whole run, not once
		// per account: a -32601 is a capability answer, and re-asking is pure latency.
		expect(calls.filter((c) => c === LANE_UNSUPPORTED)).toHaveLength(1);
		expect(report.errors).toEqual([]);
	});

	it('treats a rate limit as transient and keeps the lane', async () => {
		// First ask throttles, every later ask serves. A lane classifier that read
		// -32000 as "cannot serve DAS" would drop the only working lane here.
		const calls = stubFetch((url, nth) => {
			if (url === LANE_UNSUPPORTED) return rpcError(-32601, 'Method not found');
			return nth === 1 ? rpcError(-32000, 'Too many requests') : rpcResult('Indexed Agent');
		});

		const report = await crawlMetaplexAgents({ deadline: Date.now() + 20_000 });

		expect(report.enriched).toBe(2);
		expect(report.dasLane).toBe(LANE_SERVING);
		expect(report.dasThrottled).toBe(1);
		expect(calls.filter((c) => c === LANE_SERVING).length).toBeGreaterThan(2);
	});

	it('reports a chain with no DAS provider instead of failing silently', async () => {
		stubFetch(() => rpcError(-32601, 'Method not found'));

		const report = await crawlMetaplexAgents({ deadline: Date.now() + 20_000 });

		expect(report.enriched).toBe(0);
		expect(report.dasLane).toBeNull();
		expect(report.errors).toContainEqual({
			stage: 'das',
			error: 'no mainnet RPC lane serves getAsset; rows upserted without metadata',
		});
		// The structural leg still covered the whole registry: a metadata outage
		// must never cost the directory its account rows or their last_seen_at.
		expect(report.upserted).toBe(ACCOUNTS.length);
	});

	it('does not re-fetch metadata that is already fresh', async () => {
		freshRefs = ['ref-one', 'ref-two'];
		const calls = stubFetch(() => rpcResult('Indexed Agent'));

		const report = await crawlMetaplexAgents({ deadline: Date.now() + 20_000 });

		expect(report.enrichAttempted).toBe(0);
		expect(calls).toEqual([]);
		// Still upserted: the structural pass is what keeps last_seen_at honest.
		expect(report.upserted).toBe(ACCOUNTS.length);
	});
});
