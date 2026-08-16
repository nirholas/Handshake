// The Metaplex identity scan has two failure modes that both look like success
// from outside: the cron returns HTTP 200, Cloud Scheduler discards the body, and
// nothing reaches solana_agents_index. Production ran in both states at once, and
// the only symptom was a directory that stopped growing (last upsert 2026-08-06,
// discovered 2026-08-16 with the cron firing cleanly every 30 minutes since).
//
//   1. Lane pinning. Enumeration is getProgramAccounts, the method free lanes
//      refuse first, and the scan used solanaRpcEndpoints()[0] raw with no
//      failover. Lane 0 is SOLANA_RPC_URL, which is rpc.magicblock.app, which
//      answers gPA with 403 "Your IP or provider is blocked from this endpoint".
//   2. Discriminator. Both GPA builders register `key` at offset 0 and neither
//      filtered on it, so one version's deserializer was handed every account in
//      the program. Measured against mainnet: 1503 v2 + 68 v1 = 1571 total. The
//      v2 scan threw on the first v1 account; the v1 scan silently accepted all
//      1571 and read v2 bytes through the v1 layout.
//
// These pin both: the scan builds its umi on a rotating Connection, and each
// builder is filtered to its own key.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const rotatingConnection = { tag: 'rotating-connection' };
const createUmiCalls = [];
const whereFieldCalls = [];

vi.mock('../api/_lib/db.js', () => ({
	sql: Object.assign(async () => [], { unsafe: async () => [] }),
}));

vi.mock('../api/_lib/solana/connection.js', () => ({
	// Lane 0 is the refusing one, exactly as in production. A scan that reaches
	// for this URL instead of the rotating connection is the bug being pinned.
	solanaRpcEndpoints: () => ['https://rpc.magicblock.app/mainnet', 'https://api.mainnet-beta.solana.com'],
	solanaConnection: vi.fn(() => rotatingConnection),
}));

function fakeGpaBuilder(label) {
	const builder = {
		whereField(field, value) {
			whereFieldCalls.push({ label, field, value });
			return builder;
		},
		getDeserialized: async () => [],
	};
	return builder;
}

vi.mock('@metaplex-foundation/umi-bundle-defaults', () => ({
	createUmi: (endpointOrConnection) => {
		createUmiCalls.push(endpointOrConnection);
		return { programs: { add: () => {} } };
	},
}));

vi.mock('@metaplex-foundation/umi', () => ({ publicKey: (v) => v }));

vi.mock('@metaplex-foundation/mpl-agent-registry', () => ({
	getAgentIdentityV2GpaBuilder: () => fakeGpaBuilder('v2'),
	getAgentIdentityV1GpaBuilder: () => fakeGpaBuilder('v1'),
}));

const { crawlMetaplexAgents } = await import('../api/_lib/solana-agents-crawl.js');
const { solanaConnection } = await import('../api/_lib/solana/connection.js');

describe('crawlMetaplexAgents enumerates over the rotating lane chain', () => {
	beforeEach(() => {
		createUmiCalls.length = 0;
		whereFieldCalls.length = 0;
		solanaConnection.mockClear();
	});

	it('builds umi on a rotating Connection, never on the raw lane-0 URL', async () => {
		await crawlMetaplexAgents({ deadline: Date.now() + 5_000 });

		expect(solanaConnection).toHaveBeenCalledWith({ network: 'mainnet', commitment: 'confirmed' });
		expect(createUmiCalls).toEqual([rotatingConnection]);
		// The precise regression: handing createUmi a string pins one lane and
		// loses every failover signal the chain already knows how to act on.
		expect(createUmiCalls.some((arg) => typeof arg === 'string')).toBe(false);
	});

	it('filters each version to its own key discriminator', async () => {
		await crawlMetaplexAgents({ deadline: Date.now() + 5_000 });

		expect(whereFieldCalls).toEqual([
			{ label: 'v2', field: 'key', value: 2 },
			{ label: 'v1', field: 'key', value: 1 },
		]);
	});

	it('gives the two versions different keys, so the scans stay disjoint', async () => {
		await crawlMetaplexAgents({ deadline: Date.now() + 5_000 });

		const keys = whereFieldCalls.map((c) => c.value);
		expect(new Set(keys).size).toBe(keys.length);
		// 0 is Uninitialized on chain: filtering on it would scan nothing.
		expect(keys).not.toContain(0);
	});
});
