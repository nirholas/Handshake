import { describe, it, expect } from 'vitest';

import {
	isPlausibleAddress,
	classifyPayer,
	atomicsToUsdc,
	revenueSplit,
} from '../api/_lib/x402/revenue-split.js';

// A tagged-template stub standing in for _lib/db.js's `sql`. It routes on the
// query text so one stub can serve both the ring-wallet registry lookups and
// the settlement aggregate, exactly as the real tag does.
function makeSql({ ringPubkeys = [], settlements = [] } = {}) {
	return function sql(strings) {
		const text = strings.join(' ');
		if (text.includes('count(*)::int AS c') && text.includes('x402_ring_wallets')) {
			return Promise.resolve([{ c: ringPubkeys.length }]);
		}
		if (text.includes('x402_ring_wallets')) {
			return Promise.resolve(ringPubkeys.map((pubkey) => ({ pubkey })));
		}
		if (text.includes('x402_audit_log')) return Promise.resolve(settlements);
		return Promise.resolve([]);
	};
}

const RING = 'X4o2UuVNMxnrgkzVy97kPF5gmS6CLRCVJGB48VastML';
const BUYER_EVM = '0xC533Bf5268A2F64aDDe58dcE380651f70Aa92D7A';
const BUYER_SOL = '5uShZo7i8JqT7YuWR4iqheydkrVgBtno4XNUboP7Knm2';

describe('revenue-split: address plausibility', () => {
	it('accepts real Solana and EVM addresses', () => {
		expect(isPlausibleAddress(RING)).toBe(true);
		expect(isPlausibleAddress(BUYER_EVM)).toBe(true);
	});

	it('rejects the ledger artifacts that must never count as buyers', () => {
		// 'PAYER' is a literal written by a replay/self-test path and is present
		// in the real production ledger. Counting it as an external customer
		// would fabricate traction out of a string.
		expect(isPlausibleAddress('PAYER')).toBe(false);
		expect(isPlausibleAddress('')).toBe(false);
		expect(isPlausibleAddress(null)).toBe(false);
		expect(isPlausibleAddress('0xdeadbeef')).toBe(false);
	});
});

describe('revenue-split: payer classification', () => {
	const controlled = new Set([RING]);

	it('buckets controlled, external and synthetic payers apart', () => {
		expect(classifyPayer(RING, controlled)).toBe('internal');
		expect(classifyPayer(BUYER_EVM, controlled)).toBe('external');
		expect(classifyPayer('PAYER', controlled)).toBe('synthetic');
	});
});

describe('revenue-split: atomics formatting', () => {
	it('renders 6dp USDC without floating point', () => {
		expect(atomicsToUsdc(0n)).toBe('0.000000');
		expect(atomicsToUsdc(1000n)).toBe('0.001000');
		expect(atomicsToUsdc(972_088_000n)).toBe('972.088000');
	});
});

describe('revenueSplit', () => {
	it('keeps ring volume out of the external figure', async () => {
		const split = await revenueSplit({
			sql: makeSql({
				ringPubkeys: [RING],
				settlements: [
					{ payer: RING, route: '/api/x402/echo', calls: 1000, atomics: '1000000' },
					{ payer: BUYER_EVM, route: '/api/x402/skill-marketplace', calls: 2, atomics: '2000' },
					{ payer: 'PAYER', route: '/api/x402/replay-test', calls: 2, atomics: '2000' },
				],
			}),
		});

		expect(split.total.calls).toBe(1004);
		expect(split.internal.calls).toBe(1000);
		expect(split.external.calls).toBe(2);
		expect(split.external.volume_usdc).toBe('0.002000');
		expect(split.external.unique_payers).toBe(1);
		expect(split.synthetic.calls).toBe(2);
		expect(split.confident).toBe(true);
	});

	it('attributes external volume by route', async () => {
		const split = await revenueSplit({
			sql: makeSql({
				ringPubkeys: [RING],
				settlements: [
					{ payer: BUYER_EVM, route: '/api/x402/forge', calls: 5, atomics: '50000' },
					{ payer: BUYER_SOL, route: '/api/x402/crypto-intel', calls: 1, atomics: '1000' },
				],
			}),
		});

		expect(split.external.routes[0]).toEqual({
			route: '/api/x402/forge',
			calls: 5,
			volume_usdc: '0.050000',
		});
		expect(split.external.unique_payers).toBe(2);
	});

	it('refuses confidence when the controlled-wallet registry is empty', async () => {
		// The dangerous failure: with no registry rows, ring wallets classify as
		// external and the headline number inflates. The split must say so.
		const split = await revenueSplit({
			sql: makeSql({
				ringPubkeys: [],
				settlements: [{ payer: RING, route: '/api/x402/echo', calls: 1000, atomics: '1000000' }],
			}),
		});

		expect(split.confident).toBe(false);
		expect(split.confidence_note).toMatch(/misclassify as external/);
	});

	it('reports a real zero rather than dividing by nothing on an empty window', async () => {
		const split = await revenueSplit({ sql: makeSql({ ringPubkeys: [RING], settlements: [] }) });
		expect(split.total.calls).toBe(0);
		expect(split.external.share_of_calls).toBe(0);
		expect(split.external.volume_usdc).toBe('0.000000');
		expect(split.external.routes).toEqual([]);
	});
});
