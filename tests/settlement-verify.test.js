// Settlement verification (security review M4): a stage tip and an IRL pay are
// recorded from a client-supplied signature, so the signature has to prove
// itself. Before this, only its SHAPE was checked, which meant a well-formed but
// unrelated signature with a huge amount bought the top of a stage leaderboard.
//
// These cases cover every branch that decides an outcome WITHOUT touching an RPC:
// the shape gate, the chain/asset agreement, the amount gate, and the
// no-known-destination rule. The on-chain paths are exercised against the live
// chains by the sweep, not mocked into a fake "verified" here.

import { describe, it, expect } from 'vitest';
import { verifySettlement, USDC_BASE, THREE_MINT } from '../api/_lib/settlement-verify.js';

const SOL_SIG = '5'.repeat(64);          // base58, in the 43-88 char signature range
const EVM_TX = `0x${'a'.repeat(64)}`;
const SOL_WALLET = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const EVM_WALLET = `0x${'b'.repeat(40)}`;

describe('verifySettlement: rejects before it ever asks a chain', () => {
	it('rejects a signature that is neither a Solana sig nor an EVM tx hash', async () => {
		const r = await verifySettlement({
			signature: 'not-a-signature', mint: THREE_MINT, amountAtomic: 1n, recipients: [SOL_WALLET],
		});
		expect(r.status).toBe('mismatch');
		expect(r.reason).toMatch(/settlement signature/i);
	});

	it('rejects an empty signature', async () => {
		const r = await verifySettlement({ signature: '', mint: THREE_MINT, amountAtomic: 1n, recipients: [SOL_WALLET] });
		expect(r.status).toBe('mismatch');
	});

	it('rejects a non-positive amount', async () => {
		const r = await verifySettlement({ signature: SOL_SIG, mint: THREE_MINT, amountAtomic: 0n, recipients: [SOL_WALLET] });
		expect(r.status).toBe('mismatch');
		expect(r.reason).toMatch(/positive/i);
	});

	it('rejects a non-integer amount', async () => {
		const r = await verifySettlement({ signature: SOL_SIG, mint: THREE_MINT, amountAtomic: 1.5, recipients: [SOL_WALLET] });
		expect(r.status).toBe('mismatch');
		expect(r.reason).toMatch(/atomic units/i);
	});

	it('refuses to settle an EVM asset with a Solana signature', async () => {
		const r = await verifySettlement({ signature: SOL_SIG, mint: USDC_BASE, amountAtomic: 1n, recipients: [EVM_WALLET] });
		expect(r.status).toBe('mismatch');
		expect(r.reason).toMatch(/cannot settle an EVM asset/i);
	});

	it('refuses to settle a Solana asset with an EVM tx hash', async () => {
		const r = await verifySettlement({ signature: EVM_TX, mint: THREE_MINT, amountAtomic: 1n, recipients: [EVM_WALLET] });
		expect(r.status).toBe('mismatch');
		expect(r.reason).toMatch(/only settle USDC on Base/i);
	});

	it('refuses to verify against an agent with no payout wallet on record', async () => {
		const r = await verifySettlement({ signature: SOL_SIG, mint: THREE_MINT, amountAtomic: 1n, recipients: [] });
		expect(r.status).toBe('mismatch');
		expect(r.reason).toMatch(/no payout wallet/i);
	});

	it('does not fall back to any-recipient unless the caller opted in', async () => {
		const strict = await verifySettlement({ signature: SOL_SIG, mint: THREE_MINT, amountAtomic: 1n, recipients: [null, ''] });
		expect(strict.status).toBe('mismatch');
		expect(strict.reason).toMatch(/no payout wallet/i);
	});

	it('ignores blank recipients when deciding whether a destination is known', async () => {
		const r = await verifySettlement({
			signature: 'still-not-a-signature', mint: THREE_MINT, amountAtomic: 1n,
			recipients: ['', null, undefined], allowAnyRecipient: true,
		});
		// Opted in, so the missing destination is not the objection: the shape is.
		expect(r.status).toBe('mismatch');
		expect(r.reason).toMatch(/settlement signature/i);
	});
});
