// A pruned attestation cursor used to wedge one agent's crawl forever: the cron
// stores only the newest signature it saw, presents it back as
// getSignaturesForAddress({ until }), and the RPC fails the WHOLE call with
// "Transaction <sig> not found" once that signature leaves its ledger. Every
// later tick replayed the same dead signature, so the agent stopped indexing
// permanently while the cron kept reporting 200 (the handler catches per agent).
// These cover the recovery: detect that class of error, re-scan from the head.

import { describe, it, expect } from 'vitest';
import { isPrunedCursorError, signaturesSinceCursor } from '../api/_lib/solana/cursor-recovery.js';

// The message shape a Solana RPC actually returns for a pruned `until`.
const PRUNED = new Error(
	'failed to get signatures for address: Transaction 4q3xLaQ6U76xRPQfXBK9FebjS26tEWzvT7pUonQcDFubovFy6dAohpZWpwHGg6hfJc6EoXVKUL4U9NfMo6vCKU2g not found',
);

describe('isPrunedCursorError', () => {
	it('matches the RPC message for a cursor the node no longer has', () => {
		expect(isPrunedCursorError(PRUNED)).toBe(true);
		expect(isPrunedCursorError(new Error('Transaction abc123 not found'))).toBe(true);
	});

	it('does not swallow unrelated RPC failures', () => {
		expect(isPrunedCursorError(new Error('429 Too Many Requests'))).toBe(false);
		expect(isPrunedCursorError(new Error('fetch failed'))).toBe(false);
		expect(isPrunedCursorError(null)).toBe(false);
	});
});

describe('signaturesSinceCursor', () => {
	const KEY = 'AgentAsset1111111111111111111111111111111111';
	const SIGS = [{ signature: 'newest' }, { signature: 'older' }];

	it('passes the cursor through on the happy path and reports no reset', async () => {
		const calls = [];
		const conn = {
			async getSignaturesForAddress(key, opts) {
				calls.push(opts);
				return SIGS;
			},
		};
		const out = await signaturesSinceCursor(conn, KEY, 200, 'cursor-sig');
		expect(out).toEqual({ sigs: SIGS, cursorReset: false });
		expect(calls).toEqual([{ limit: 200, until: 'cursor-sig' }]);
	});

	it('re-scans from the head when the cursor has been pruned', async () => {
		const calls = [];
		const conn = {
			async getSignaturesForAddress(key, opts) {
				calls.push(opts);
				if (opts.until) throw PRUNED;
				return SIGS;
			},
		};
		const out = await signaturesSinceCursor(conn, KEY, 200, 'pruned-sig');
		expect(out).toEqual({ sigs: SIGS, cursorReset: true });
		// The second attempt drops `until` entirely. That is what breaks the stall.
		expect(calls).toEqual([{ limit: 200, until: 'pruned-sig' }, { limit: 200 }]);
	});

	it('rethrows an unrelated failure instead of masking it as a reset', async () => {
		const conn = {
			async getSignaturesForAddress() {
				throw new Error('429 Too Many Requests');
			},
		};
		await expect(signaturesSinceCursor(conn, KEY, 200, 'cursor-sig')).rejects.toThrow('429');
	});

	it('does not retry when there was no cursor to begin with', async () => {
		let calls = 0;
		const conn = {
			async getSignaturesForAddress() {
				calls += 1;
				throw PRUNED;
			},
		};
		await expect(signaturesSinceCursor(conn, KEY, 200, undefined)).rejects.toThrow('not found');
		expect(calls).toBe(1);
	});
});
