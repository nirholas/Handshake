// Author earnings surface for per-call skill royalties (Roadmap phase 3).
//
// The split math and the accrual writer are covered in tests/skill-royalty.test.js.
// This suite covers the READ side: MonetizationService.getCreatorSalesData, which
// backs /api/users/me/earnings and the Creator Studio royalty ledger, plus the
// presentation helpers that turn a ledger row into something an author can
// reconcile against the chain.
//
// The regression that motivates most of it: royalty_ledger.agent_id is NULL for
// every accrual on the platform's own x402 rail (the caller is a paying wallet,
// not a registered agent), so an INNER JOIN on agent_identities silently dropped
// 100% of per-call royalties from the surface. Authors earning real USDC saw an
// empty ledger and a $0 total.

import { describe, it, expect } from 'vitest';
import { MonetizationService } from '../api/_lib/services/MonetizationService.js';
import { railLabel, ledgerToCsv, groupLedgerByStatus } from '../src/dashboard-next/pages/creator-helpers.js';

// Queue-driven tagged-template stub, injected through the service's `deps.sql`
// seam. Records every query so the join shape itself can be asserted.
function makeSql(queue) {
	const calls = [];
	const sql = async (strings, ...values) => {
		calls.push({ query: Array.isArray(strings) ? strings.join('?') : String(strings), values });
		return queue.length ? queue.shift() : [];
	};
	sql.calls = calls;
	return sql;
}

const AUTHOR = 'author-1';

// One settled accrual from the x402 rail: no agent, full settlement provenance.
const X402_ROW = {
	id: 'ledger-x402',
	price_usd: '0.243750',
	status: 'settled',
	created_at: '2026-08-13T12:00:00.000Z',
	settled_at: '2026-08-13T12:00:01.000Z',
	source: 'x402',
	network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	tx_hash: '5xTxSignature',
	platform_fee_usd: '0.006250',
	skill_name: 'Wallet Balance',
	skill_slug: 'wallet-balance',
	agent_name: null,
};

// One in-process runtime accrual: has an agent, no chain provenance yet.
const RUNTIME_ROW = {
	id: 'ledger-runtime',
	price_usd: '0.100000',
	status: 'pending',
	created_at: '2026-08-13T11:00:00.000Z',
	settled_at: null,
	source: 'skill-runtime',
	network: null,
	tx_hash: null,
	platform_fee_usd: null,
	skill_name: 'Summarize',
	skill_slug: 'summarize',
	agent_name: 'Scout',
};

describe('getCreatorSalesData — both royalty lanes reach the author', () => {
	it('LEFT JOINs agent_identities so x402 accruals are not dropped', async () => {
		const sql = makeSql([[X402_ROW], []]);
		await new MonetizationService(AUTHOR, { sql }).getCreatorSalesData();

		const ledgerQuery = sql.calls[0].query;
		expect(ledgerQuery).toMatch(/LEFT JOIN agent_identities/i);
		// An inner join here is the exact bug: it discards every NULL agent_id.
		expect(ledgerQuery).not.toMatch(/\n\s*JOIN agent_identities/i);
	});

	it('returns the x402 accrual with its settlement provenance', async () => {
		const sql = makeSql([[X402_ROW], []]);
		const data = await new MonetizationService(AUTHOR, { sql }).getCreatorSalesData();

		expect(data.entries).toHaveLength(1);
		const [entry] = data.entries;
		expect(entry.source).toBe('x402');
		expect(entry.skill_name).toBe('Wallet Balance');
		expect(entry.skill_slug).toBe('wallet-balance');
		expect(entry.price_usd).toBe(0.24375);
		expect(entry.platform_fee_usd).toBe(0.00625);
		expect(entry.network).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
		expect(entry.tx_hash).toBe('5xTxSignature');
		expect(entry.agent_name).toBeNull();
	});

	it('defaults a row with no recorded source to the runtime lane', async () => {
		const sql = makeSql([[{ ...RUNTIME_ROW, source: null }], []]);
		const data = await new MonetizationService(AUTHOR, { sql }).getCreatorSalesData();
		expect(data.entries[0].source).toBe('skill-runtime');
	});

	it('separates pending, settling and settled totals', async () => {
		const rows = [
			X402_ROW,
			RUNTIME_ROW,
			{ ...RUNTIME_ROW, id: 'ledger-settling', status: 'settling', price_usd: '0.050000' },
		];
		const sql = makeSql([rows, []]);
		const data = await new MonetizationService(AUTHOR, { sql }).getCreatorSalesData();

		expect(data.pending_usd).toBeCloseTo(0.1, 6);
		expect(data.settling_usd).toBeCloseTo(0.05, 6);
		expect(data.settled_usd).toBeCloseTo(0.24375, 6);
	});

	it('sums the platform cut and treats a null fee as zero', async () => {
		const sql = makeSql([[X402_ROW, RUNTIME_ROW], []]);
		const data = await new MonetizationService(AUTHOR, { sql }).getCreatorSalesData();
		expect(data.platform_fee_usd).toBeCloseTo(0.00625, 6);
	});

	it('keeps asset sales in the same feed with a distinct source', async () => {
		const assetRow = {
			id: 'asset-1',
			item_type: 'avatar',
			item_id: 'avatar-1',
			amount: '2500000',
			currency_mint: null,
			confirmed_at: '2026-08-13T13:00:00.000Z',
			created_at: '2026-08-13T13:00:00.000Z',
			status: 'confirmed',
			item_name: 'Knight',
		};
		const sql = makeSql([[X402_ROW], [assetRow]]);
		const data = await new MonetizationService(AUTHOR, { sql }).getCreatorSalesData();

		const asset = data.entries.find((e) => e.kind === 'avatar');
		expect(asset.source).toBe('asset-sale');
		expect(asset.price_usd).toBe(2.5);
		// Asset revenue tops up the settled total alongside settled royalties.
		expect(data.settled_usd).toBeCloseTo(2.74375, 6);
	});

	it('requires an authenticated author', async () => {
		const sql = makeSql([]);
		await expect(new MonetizationService(null, { sql }).getCreatorSalesData()).rejects.toMatchObject({ status: 401 });
	});
});

describe('the ledger entry a Creator Studio row is built from', () => {
	it('survives the round trip into the CSV export the author downloads', async () => {
		const sql = makeSql([[X402_ROW], []]);
		const data = await new MonetizationService(AUTHOR, { sql }).getCreatorSalesData();
		const row = ledgerToCsv(data.entries, { networkLabel: () => 'Solana' }).split('\n')[1];

		expect(row).toContain(railLabel('x402'));
		expect(row).toContain('Solana');
		expect(row).toContain('5xTxSignature');
		expect(row).toContain('0.243750');
	});

	it('buckets a settled per-call royalty as settled', async () => {
		const sql = makeSql([[X402_ROW, RUNTIME_ROW], []]);
		const data = await new MonetizationService(AUTHOR, { sql }).getCreatorSalesData();
		const { totals, buckets } = groupLedgerByStatus(data.entries);

		expect(totals.settled).toBeCloseTo(0.24375, 6);
		expect(totals.pending).toBeCloseTo(0.1, 6);
		expect(buckets.settled[0].source).toBe('x402');
	});
});
