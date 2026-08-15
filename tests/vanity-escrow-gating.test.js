// The money gate on the two x402-paid vanity markets: a bounty or a drop only
// becomes real once its payment actually SETTLED on-chain.
//
// 2026-08-15 audit of api/vanity/*: both create handlers persisted a live record
// BEFORE settlePayment(). x402 verify and settle are two separate round-trips, so
// a proof that verifies can still fail to settle (facilitator error, the payer
// spending the authorization in between). When that happened:
//   • bounties: the bounty was already `open` and indexed, so a worker could grind
//     it and payWinner() would send real USDC out of the platform payout wallet
//     for escrow that was never collected. After expiry the same record could be
//     self-service refunded to the requester's own address instead.
//   • drops: the drop wallet was already funded on-chain from the platform funding
//     wallet, and a direct-seal recipient could still reveal + drain it for free.
// Both handlers now record the row as `escrow_pending` (unindexed, refused by
// every transition) and only activate it after settle; a failed settle voids it,
// and for drops sweeps the funding back first.
//
// These run against each store's in-process fallback (no Redis in CI), which is
// the same state machine the Lua paths implement.

import { describe, it, expect, beforeEach } from 'vitest';
import {
	createBounty,
	activateBounty,
	voidBounty,
	claimBounty,
	markRefundable,
	queryBounties,
	listClaimable,
	bountyStats,
	getBountyRecord,
	__resetMemoryStore as resetBounties,
} from '../api/_lib/vanity-bounty-store.js';
import {
	createDrop,
	activateDrop,
	voidDrop,
	claimDrop,
	markReclaimable,
	listBySender,
	dropStats,
	isTransientDrop,
	getDropRecord,
	__resetMemoryStore as resetDrops,
} from '../api/_lib/sealed-drop-store.js';

const HOUR = 3600_000;

function bountyRecord(over = {}) {
	const now = Date.now();
	return {
		id: 'a1b2c3d4e5f60718',
		protocol: 'three-vanity-bounty/v1',
		pattern: { prefix: 'THREE', suffix: null, ignoreCase: false },
		recipient: 'SoLXXXrecipientXXXpubkeyXXXbase58XXX',
		refundAddress: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		amountAtomics: 500_000,
		asset: 'USDC',
		network: 'solana',
		label: 'audit fixture',
		createdAt: now,
		expiresAt: now + 48 * HOUR,
		status: 'escrow_pending',
		...over,
	};
}

function dropRecord(over = {}) {
	const now = Date.now();
	return {
		id: 'a1b2c3d4e5f607182930a1b2',
		protocol: 'three-drop/v1',
		address: 'THREEsynthetic1111111111111111111111111111',
		asset: 'SOL',
		amount: '0.01',
		amountAtomics: '10000000',
		network: 'solana',
		sealMode: 'claim-time',
		claimTokenHash: 'f'.repeat(64),
		sealedSecret: { scheme: 'x25519-hkdf-sha256-aes256gcm/v1', ct: 'opaque' },
		senderTag: 'audit-tag',
		createdAt: now,
		expiresAt: now + 24 * HOUR,
		status: 'escrow_pending',
		...over,
	};
}

describe('grind bounties: escrow settles before the bounty is real', () => {
	beforeEach(() => resetBounties());

	it('keeps a pending bounty off the board, the claim queue, and the stats', async () => {
		await createBounty(bountyRecord());

		expect(await listClaimable(30)).toEqual([]);
		expect((await queryBounties({ status: 'open' })).total).toBe(0);
		// status=all must hide it too: an unfunded row is not a bounty in any view.
		expect((await queryBounties({ status: 'all' })).total).toBe(0);
		expect(await bountyStats()).toMatchObject({ open: 0, openEscrowAtomics: 0, total: 0 });
	});

	it('refuses to settle a pending bounty to a worker', async () => {
		const rec = bountyRecord();
		await createBounty(rec);

		const outcome = await claimBounty({
			id: rec.id,
			claimDigest: 'deadbeef',
			winnerAddress: 'THREEsynthetic1111111111111111111111111111',
			workerId: 'worker-1',
			sealedSecret: { ct: 'opaque' },
		});

		expect(outcome).toBe('closed');
		expect((await getBountyRecord(rec.id)).status).toBe('escrow_pending');
	});

	it('refuses to refund a pending bounty, even once it has expired', async () => {
		const rec = bountyRecord({ expiresAt: Date.now() - HOUR });
		await createBounty(rec);

		expect(await markRefundable(rec.id)).toBe('ineligible');
		expect((await getBountyRecord(rec.id)).status).toBe('escrow_pending');
	});

	it('goes live, indexed, with its settlement tx once the escrow lands', async () => {
		const rec = bountyRecord();
		await createBounty(rec);

		expect(await activateBounty({ id: rec.id, escrowTx: 'tx-escrow-1', escrowNetwork: 'solana' })).toBe('live');

		const stored = await getBountyRecord(rec.id);
		expect(stored.status).toBe('open');
		expect(stored.escrowTx).toBe('tx-escrow-1');
		expect((await listClaimable(30)).map((b) => b.id)).toEqual([rec.id]);
		expect(await bountyStats()).toMatchObject({ open: 1, openEscrowAtomics: 500_000, total: 1 });
		// Idempotent: a retried activation does not disturb a live bounty.
		expect(await activateBounty({ id: rec.id, escrowTx: 'tx-escrow-1' })).toBe('live');
	});

	it('voids a bounty whose escrow never settled, permanently', async () => {
		const rec = bountyRecord();
		await createBounty(rec);

		expect(await voidBounty({ id: rec.id, reason: 'settle failed' })).toBe('void');
		expect(await voidBounty({ id: rec.id })).toBe('void'); // idempotent
		// A voided bounty can never be resurrected into a live one.
		expect(await activateBounty({ id: rec.id, escrowTx: 'tx-late' })).toBe('ineligible');
		expect(await listClaimable(30)).toEqual([]);
		expect((await getBountyRecord(rec.id)).voidReason).toBe('settle failed');
	});

	it('never activates or voids a bounty that does not exist', async () => {
		expect(await activateBounty({ id: 'ffffffff', escrowTx: 'x' })).toBe('missing');
		expect(await voidBounty({ id: 'ffffffff' })).toBe('missing');
	});
});

describe('sealed drops: the create fee settles before the drop is claimable', () => {
	beforeEach(() => resetDrops());

	it('hides a pending drop from the sender list and the stats', async () => {
		const rec = dropRecord();
		await createDrop(rec);

		expect(isTransientDrop(await getDropRecord(rec.id))).toBe(true);
		expect(await listBySender('audit-tag')).toEqual([]);
		expect(await dropStats()).toMatchObject({ funded: 0, total: 0 });
	});

	it('refuses to release a pending drop to a claimant', async () => {
		const rec = dropRecord();
		await createDrop(rec);

		expect(await claimDrop({ id: rec.id, claimerTag: 'f'.repeat(64) })).toBe('closed');
		expect((await getDropRecord(rec.id)).status).toBe('escrow_pending');
	});

	it('refuses to reclaim a pending drop, even once it has expired', async () => {
		const rec = dropRecord({ expiresAt: Date.now() - HOUR });
		await createDrop(rec);

		expect(await markReclaimable(rec.id)).toBe('ineligible');
	});

	it('goes live and claimable once the fee lands', async () => {
		const rec = dropRecord();
		await createDrop(rec);

		expect(await activateDrop({ id: rec.id, escrowTx: 'tx-fee-1' })).toBe('live');

		const stored = await getDropRecord(rec.id);
		expect(stored.status).toBe('funded');
		expect(stored.escrowTx).toBe('tx-fee-1');
		expect(isTransientDrop(stored)).toBe(false);
		expect((await listBySender('audit-tag')).map((d) => d.id)).toEqual([rec.id]);
		expect(await dropStats()).toMatchObject({ funded: 1, total: 1 });
		expect(await claimDrop({ id: rec.id, claimerTag: 'f'.repeat(64) })).toBe('won');
	});

	it('voids a drop whose fee never settled, permanently', async () => {
		const rec = dropRecord();
		await createDrop(rec);

		expect(await voidDrop({ id: rec.id, reason: 'settle failed' })).toBe('void');
		expect(await voidDrop({ id: rec.id })).toBe('void'); // idempotent
		expect(await activateDrop({ id: rec.id, escrowTx: 'tx-late' })).toBe('ineligible');
		expect(await claimDrop({ id: rec.id, claimerTag: 'f'.repeat(64) })).toBe('closed');
		expect(await dropStats()).toMatchObject({ funded: 0, total: 0 });
	});

	it('never activates or voids a drop that does not exist', async () => {
		expect(await activateDrop({ id: 'a'.repeat(24) })).toBe('missing');
		expect(await voidDrop({ id: 'a'.repeat(24) })).toBe('missing');
	});
});
