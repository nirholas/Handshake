// Storage layer for the x402 offer-receipt log.
//
// Two behaviours here are load-bearing for the Receipt Vault (/receipts) and
// both were previously wrong:
//
//   1. The signed artifact omits the settlement tx whenever the endpoint
//      declares includeTxHash=false (spec §5.2 privacy default). The storage
//      layer read the tx from the *payload* only, so our own audit trail lost
//      it for every privacy-preserving endpoint — which is all of them by
//      default. The settle response still carries it, and the buyer is
//      entitled to their own.
//   2. The amount was never recorded at all, so a buyer could see WHAT they
//      bought but never what it cost.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlState = { calls: [], queue: [] };

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		sqlState.calls.push({ query: strings.join('?'), values });
		return sqlState.queue.length ? sqlState.queue.shift() : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

// The real extractor validates a full JWS/EIP-712 artifact; these tests are
// about what the storage layer does with the extracted payload, so return the
// artifact's own payload verbatim.
vi.mock('@x402/extensions', () => ({
	extractReceiptPayload: (signed) => signed.payload,
}));

const { recordReceipt, listReceiptsForPayer } = await import(
	'../api/_lib/x402/receipt-storage.js'
);

const PAYER = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const SETTLE_TX = '5xTr4nsAcT10nS1gNaTuReF0rTeSt1nGpUrP0SeS0nLy';

function signedReceipt(payload = {}) {
	return { format: 'jws', signature: 'sig', payload: { version: 1, ...payload } };
}

/** Column list → value, for the single insert the call under test performed. */
function insertedValues() {
	const call = sqlState.calls.at(-1);
	const cols = call.query
		.slice(call.query.indexOf('(') + 1, call.query.indexOf(')'))
		.split(',')
		.map((c) => c.trim());
	return Object.fromEntries(cols.map((c, i) => [c, call.values[i]]));
}

beforeEach(() => {
	sqlState.calls.length = 0;
	sqlState.queue.length = 0;
});

describe('recordReceipt', () => {
	it('falls back to the settle transaction when the payload omits it for privacy', async () => {
		recordReceipt({
			resourceUrl: 'https://three.ws/api/x402/token-intel',
			// includeTxHash=false: the signed payload carries no transaction.
			signedReceipt: signedReceipt({ network: 'solana', payer: PAYER }),
			settled: { payer: PAYER, network: 'solana', transaction: SETTLE_TX },
		});
		expect(insertedValues().transaction).toBe(SETTLE_TX);
	});

	it('prefers the payload transaction when the receipt does carry one', async () => {
		recordReceipt({
			resourceUrl: 'https://three.ws/api/x402/token-intel',
			signedReceipt: signedReceipt({ network: 'solana', transaction: 'from-payload' }),
			settled: { payer: PAYER, network: 'solana', transaction: SETTLE_TX },
		});
		expect(insertedValues().transaction).toBe('from-payload');
	});

	it('records the settled amount and asset so the buyer can see what it cost', async () => {
		recordReceipt({
			resourceUrl: 'https://three.ws/api/x402/token-intel',
			signedReceipt: signedReceipt({ network: 'solana' }),
			settled: { payer: PAYER, network: 'solana', transaction: SETTLE_TX },
			payment: { amountAtomics: 10000, asset: 'the-settlement-asset' },
		});
		const v = insertedValues();
		// Stored as text: the atomic amount must survive without float rounding.
		expect(v.amount_atomics).toBe('10000');
		expect(v.asset).toBe('the-settlement-asset');
	});

	it('writes nulls rather than guessing when no payment context is supplied', async () => {
		recordReceipt({
			resourceUrl: 'https://three.ws/api/x402/token-intel',
			signedReceipt: signedReceipt({ network: 'solana' }),
			settled: { payer: PAYER, network: 'solana' },
		});
		const v = insertedValues();
		expect(v.amount_atomics).toBe(null);
		expect(v.asset).toBe(null);
		expect(v.transaction).toBe(null);
	});

	it('lower-cases EVM payers and leaves Solana base58 verbatim', async () => {
		recordReceipt({
			resourceUrl: 'https://three.ws/x',
			signedReceipt: signedReceipt({ network: 'eip155:8453' }),
			settled: { payer: '0xAbCdEf0123456789aBcDeF0123456789ABCDEF01', network: 'base' },
		});
		expect(insertedValues().payer).toBe('0xabcdef0123456789abcdef0123456789abcdef01');

		recordReceipt({
			resourceUrl: 'https://three.ws/x',
			signedReceipt: signedReceipt({ network: 'solana' }),
			settled: { payer: PAYER, network: 'solana' },
		});
		expect(insertedValues().payer).toBe(PAYER);
	});

	it('drops the write when there is no payer to key it by', async () => {
		recordReceipt({
			resourceUrl: 'https://three.ws/x',
			signedReceipt: signedReceipt({ network: 'solana' }),
			settled: { network: 'solana' },
		});
		expect(sqlState.calls).toHaveLength(0);
	});
});

describe('listReceiptsForPayer', () => {
	it('maps the settlement columns into the buyer-facing shape', async () => {
		sqlState.queue.push([
			{
				id: 'r1',
				payer: PAYER,
				network: 'solana',
				resource_url: 'https://three.ws/api/x402/token-intel',
				format: 'jws',
				receipt: { format: 'jws' },
				transaction: SETTLE_TX,
				amount_atomics: '10000',
				asset: 'the-settlement-asset',
				issued_at: new Date('2026-07-28T00:00:00.000Z'),
			},
		]);
		const [row] = await listReceiptsForPayer({ payer: PAYER });
		expect(row.amountAtomics).toBe('10000');
		expect(row.asset).toBe('the-settlement-asset');
		expect(row.transaction).toBe(SETTLE_TX);
		expect(row.issuedAt).toBe('2026-07-28T00:00:00.000Z');
	});

	it('reports rows written before settlement capture as null, not zero', async () => {
		sqlState.queue.push([
			{
				id: 'r0',
				payer: PAYER,
				network: 'solana',
				resource_url: 'https://three.ws/x',
				format: 'jws',
				receipt: {},
				transaction: null,
				amount_atomics: null,
				asset: null,
				issued_at: '2026-07-01T00:00:00.000Z',
			},
		]);
		const [row] = await listReceiptsForPayer({ payer: PAYER });
		expect(row.amountAtomics).toBe(null);
		expect(row.asset).toBe(null);
	});

	it('returns nothing for a blank payer instead of querying', async () => {
		expect(await listReceiptsForPayer({ payer: '' })).toEqual([]);
		expect(sqlState.calls).toHaveLength(0);
	});
});
