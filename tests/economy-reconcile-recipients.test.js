// masterOutboundRecipients: extract the SOL recipients of a master's tx so the
// reconciler can tell an internal topup (recipient ∈ controlled set) from a real
// external leak. Guards the fix that stopped internal topups from firing
// "rotate the key" criticals.

import { describe, it, expect, vi } from 'vitest';

// The module pulls in DB/env at import; stub the heavy deps so the pure helper
// can be imported in isolation.
vi.mock('../api/_lib/db.js', () => ({ sql: vi.fn(async () => []) }));
vi.mock('../api/_lib/db-retry.js', () => ({ withDbRetry: (fn) => fn() }));
vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn(async () => {}) }));
vi.mock('../api/_lib/economy-master.js', () => ({ ECONOMY_MASTER_ADDRESS: 'MASTER', RESERVE_SOL: 0.1 }));
vi.mock('../api/_lib/solana-signers.js', () => ({ SOLANA_SIGNERS: [], resolveSignerPubkey: vi.fn(async () => ({ pubkey: null })) }));

const { masterOutboundRecipients } = await import('../api/cron/economy-reconcile.js');

function tx(keys, pre, post) {
	return { transaction: { message: { accountKeys: keys } }, meta: { preBalances: pre, postBalances: post } };
}

describe('masterOutboundRecipients', () => {
	it('returns accounts that gained lamports, excluding the master', () => {
		// master pays 0.5 SOL to RECIP; master also pays the fee (loses a bit more)
		const t = tx(['MASTER', 'RECIP'], [1_000_000_000, 0], [499_995_000, 500_000_000]);
		expect(masterOutboundRecipients(t, 'MASTER')).toEqual(['RECIP']);
	});

	it('lists multiple recipients', () => {
		const t = tx(['MASTER', 'A', 'B'], [1e9, 0, 0], [0, 400_000_000, 599_995_000]);
		expect(masterOutboundRecipients(t, 'MASTER').sort()).toEqual(['A', 'B']);
	});

	it('ignores accounts that did not gain (or lost) lamports', () => {
		const t = tx(['MASTER', 'RECIP', 'UNCHANGED'], [1e9, 0, 5], [0, 999_995_000, 5]);
		expect(masterOutboundRecipients(t, 'MASTER')).toEqual(['RECIP']);
	});

	it('handles jsonParsed accountKeys as {pubkey} objects', () => {
		const t = {
			transaction: { message: { accountKeys: [{ pubkey: 'MASTER' }, { pubkey: 'RECIP' }] } },
			meta: { preBalances: [1e9, 0], postBalances: [0, 999_995_000] },
		};
		expect(masterOutboundRecipients(t, 'MASTER')).toEqual(['RECIP']);
	});

	it('returns [] on malformed input', () => {
		expect(masterOutboundRecipients(null, 'MASTER')).toEqual([]);
		expect(masterOutboundRecipients({}, 'MASTER')).toEqual([]);
		expect(masterOutboundRecipients(tx(['MASTER'], null, null), 'MASTER')).toEqual([]);
	});
});
