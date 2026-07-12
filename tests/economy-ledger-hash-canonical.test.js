// hashEntry must produce the SAME hash whether master_sol_after arrives as the
// JS number the write path holds (0.30223827) or the Postgres numeric(_,9)
// string the verify path reads ("0.302238270"). Before canonicalization the
// trailing-zero difference made every ledger row's content hash mismatch, which
// verifyChain surfaced as a spurious "tamper".

import { describe, it, expect } from 'vitest';
import { hashEntry } from '../api/_lib/economy-ledger.js';

const base = {
	seq: 42,
	ts: '2026-07-12T09:35:00.000Z',
	master_pubkey: 'MASTER',
	event: 'sweep',
	target_pubkey: null,
	lamports: 0,
	tx_signature: null,
	reason: null,
};

describe('hashEntry — master_sol_after canonicalization', () => {
	it('hashes a JS number and its DB scale-9 string identically', () => {
		const fromWrite = hashEntry('prev', { ...base, master_sol_after: 0.30223827 });
		const fromDb = hashEntry('prev', { ...base, master_sol_after: '0.302238270' });
		expect(fromWrite).toBe(fromDb);
	});

	it('treats a whole number and its padded form identically', () => {
		expect(hashEntry('p', { ...base, master_sol_after: 0 })).toBe(
			hashEntry('p', { ...base, master_sol_after: '0.000000000' }),
		);
		expect(hashEntry('p', { ...base, master_sol_after: 1 })).toBe(
			hashEntry('p', { ...base, master_sol_after: '1.000000000' }),
		);
	});

	it('null and empty hash the same (absent value)', () => {
		expect(hashEntry('p', { ...base, master_sol_after: null })).toBe(
			hashEntry('p', { ...base, master_sol_after: '' }),
		);
	});

	it('distinguishes genuinely different amounts', () => {
		expect(hashEntry('p', { ...base, master_sol_after: 0.5 })).not.toBe(
			hashEntry('p', { ...base, master_sol_after: 0.6 }),
		);
	});
});
