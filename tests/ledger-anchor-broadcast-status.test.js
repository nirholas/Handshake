// anchorLedgerHead must report a rejected broadcast as what it wrote down
// (api/_lib/ledger-anchor.js).
//
// The helper records two very different outcomes: `pending` when no attester key
// is configured (the commitment is kept locally and the on-chain timestamp is
// deferred, which is fine) and a `failed` row when the memo was actually rejected
// on-chain. It used to RETURN 'pending' for both, so an attester wallet with no
// SOL, whose every send answered "Attempt to debit an account but found no record
// of a prior credit", read to its caller exactly like the benign no-key path.
//
// Pinned here: the returned status matches the persisted row, so the cron above
// it can tell a degraded mode from an outage.
import { test, expect, vi } from 'vitest';

const inserted = [];

vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		const text = strings.join('?');
		if (text.includes('insert into ledger_anchors')) inserted.push(values);
		return Promise.resolve([]);
	},
}));
vi.mock('../api/_lib/attest-event.js', () => ({
	loadAttesterKeypair: () => ({
		publicKey: { toBase58: () => 'Attester1111111111111111111111111111111111' },
	}),
}));
vi.mock('../api/_lib/solana/connection.js', () => ({ solanaConnection: () => ({}) }));
vi.mock('../api/_lib/solana/confirm.js', () => ({
	sendAndConfirm: async () => {
		throw new Error('Simulation failed. Attempt to debit an account but found no record of a prior credit.');
	},
}));

const { anchorLedgerHead } = await import('../api/_lib/ledger-anchor.js');

test('a rejected broadcast returns failed and writes a failed row', async () => {
	const out = await anchorLedgerHead({
		agentId: 'agent-1', network: 'mainnet', headHash: 'hash', throughSeq: 1, entryCount: 1,
	});

	expect(out.status).toBe('failed');
	expect(out.signature).toBeNull();
	expect(out.detail).toContain('record_failed');
	expect(inserted.length).toBe(1);
	expect(inserted[0]).toContain('failed');
});
