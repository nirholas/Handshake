// api/_lib/custody-proof.js, the prover behind POST /api/cron/custody-attest.
// The Merkle primitives themselves are pinned in tests/custody-merkle.test.js;
// this file covers the epoch orchestration around them: the main path persists
// an epoch + leaves and reports the anchor verdict, and the failure paths
// (every balance read failing, an unconfigured attester key) degrade to a
// recorded epoch instead of throwing: the cron must never 500 on an RPC blip
// or a missing key.
//
// I/O is mocked at the module seams (db.js, solana/connection.js,
// attest-event.js): the test never touches a real database or RPC endpoint.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deterministic 64-hex leaf hashes are produced by the REAL computeLeafHash;
// the tree builder runs for real too, so the persisted root is verifiable.

// A syntactically valid base58 address that passes PublicKey construction; the
// test never sends it anywhere, the RPC layer is mocked.
const WALLET_A = 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW';
const WALLET_B = '5YNmS1R9nNSCDzb5a7mMJ1dwK9uBAAF4B2wRqGvvQP7A';

const statements = [];
function sqlMock(strings, ...values) {
	// strings[0] carries the distinguishing table name for every query here.
	const text = strings.join('?');
	statements.push({ text, values });
	if (text.includes('FROM custody_attestation_epochs')) {
		return Promise.resolve([{ max: null }]); // nextEpoch: start at 1
	}
	if (text.includes('FROM agent_identities')) {
		return Promise.resolve([
			{ id: 'agent-a', user_id: 'user-a', address: WALLET_A },
			{ id: 'agent-b', user_id: 'user-b', address: WALLET_B },
		]);
	}
	if (text.includes('FROM agent_custody_events')) {
		return Promise.resolve([]); // no ledger events yet -> 'genesis' head
	}
	return Promise.resolve([]);
}
sqlMock.transaction = async (txs) => {
	for (const t of txs) await t;
	return [];
};

vi.mock('../api/_lib/db.js', () => ({ sql: sqlMock }));

let rpcBalance = 500_000;
vi.mock('../api/_lib/solana/connection.js', () => ({
	solanaConnection: () => ({
		getBalance: async () => {
			if (rpcBalance == null) throw new Error('rpc down');
			return rpcBalance;
		},
	}),
}));

// No ATTEST_AGENT_SECRET_KEY in the test env: the attester key is unconfigured,
// and loadAttesterKeypair throws the same coded error it throws in production.
vi.mock('../api/_lib/attest-event.js', () => ({
	loadAttesterKeypair: () => {
		const err = new Error('ATTEST_AGENT_SECRET_KEY is not configured');
		err.code = 'attester_key_not_configured';
		throw err;
	},
}));

vi.mock('../api/_lib/avatar-wallet.js', () => ({
	explorerTxUrl: (net, sig) => `https://explorer/${net}/${sig}`,
}));

const { runAttestationEpoch, getInclusionProof } = await import('../api/_lib/custody-proof.js');
const { computeLeafHash } = await import('../src/proof-of-custody/merkle.js');

beforeEach(() => {
	statements.length = 0;
	rpcBalance = 500_000;
});

describe('runAttestationEpoch', () => {
	it('snapshots every wallet, persists the epoch and leaves, and reports the anchor verdict', async () => {
		const result = await runAttestationEpoch({ anchor: true });

		expect(result.epoch).toBe(1);
		expect(result.wallet_count).toBe(2);
		expect(result.rpc_failures).toBe(0);
		expect(result.root).toMatch(/^[0-9a-f]{64}$/);
		// No attester key configured: the epoch stands and is re-anchorable later.
		expect(result.anchor_status).toBe('anchor_failed');

		// Epoch row + one leaf insert per wallet, persisted atomically.
		const epochInsert = statements.find((s) => s.text.includes('INSERT INTO custody_attestation_epochs'));
		const leafInserts = statements.filter((s) => s.text.includes('INSERT INTO custody_attestation_leaves'));
		expect(epochInsert?.values?.[1]).toBe('mainnet'); // SNAPSHOT_NETWORK
		expect(leafInserts).toHaveLength(2);
		// markAnchorFailed updates the same epoch row after the key load throws.
		expect(statements.some((s) => s.text.includes('anchor_error'))).toBe(true);

		// The persisted leaf hash matches the shared leaf encoding exactly.
		const expectedLeaf = await computeLeafHash({
			agentId: 'agent-a',
			address: WALLET_A,
			balanceLamports: '500000',
			ledgerHead: 'genesis',
			epoch: 1,
		});
		expect(leafInserts[0].values).toContain(expectedLeaf);
	});

	it('skips a wallet whose balance read fails instead of attesting a guessed zero', async () => {
		rpcBalance = null; // every read throws
		const result = await runAttestationEpoch({ anchor: false });

		expect(result.wallet_count).toBe(0);
		expect(result.root).toBeNull();
		expect(result.rpc_failures).toBe(2);
		expect(result.anchor_status).toBe('empty');

		// The empty epoch is still recorded so the chain of epochs stays contiguous,
		// with a zeroed placeholder root and the 'empty' status folded into the SQL.
		const epochInsert = statements.find((s) => s.text.includes('INSERT INTO custody_attestation_epochs'));
		expect(epochInsert.text).toContain("'empty'");
		expect(statements.some((s) => s.text.includes('custody_attestation_leaves'))).toBe(false);
	});

	it('anchor:false skips the on-chain memo entirely', async () => {
		const result = await runAttestationEpoch({ anchor: false });
		expect(result.anchor_status).toBe('pending');
		expect(result.anchor_signature ?? null).toBeNull();
	});
});

describe('getInclusionProof', () => {
	it('reports a wallet with no leaf in any epoch as excluded, without throwing', async () => {
		const proof = await getInclusionProof('agent-zzz');
		expect(proof.included).toBe(false);
		expect(proof.reason).toBe('no_leaf_yet');
	});
});
