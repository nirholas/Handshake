// Billing contract for POST /api/x402/auth-health.
//
// paidEndpoint delivers before it settles: whatever the handler RETURNS becomes
// the buyer's paid response and the payment settles behind it, while a thrown
// error lands before settlement and costs the caller nothing. An unsupported
// mode used to be *returned* as { error: 'unsupported_mode' }, which billed
// $0.001 for a 200 that carried no health check at all. It must throw.

import { describe, it, expect } from 'vitest';
import { __test__ } from '../../api/x402/auth-health.js';

const { resolveMode } = __test__;

describe('auth-health resolveMode', () => {
	it('accepts the supported mode and defaults an absent one', () => {
		expect(resolveMode({ mode: 'session_lifecycle' })).toBe('session_lifecycle');
		expect(resolveMode({})).toBe('session_lifecycle');
		expect(resolveMode(undefined)).toBe('session_lifecycle');
	});

	it('tolerates surrounding whitespace rather than charging for a typo', () => {
		expect(resolveMode({ mode: '  session_lifecycle  ' })).toBe('session_lifecycle');
	});

	it('throws a 400 on an unsupported mode instead of returning an error body', () => {
		let thrown;
		try {
			resolveMode({ mode: 'drop_tables' });
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect(thrown.status).toBe(400);
		expect(thrown.code).toBe('unsupported_mode');
		expect(thrown.message).toContain('drop_tables');
	});

	it('treats a non-string mode as absent, but an empty string as a real typo', () => {
		expect(resolveMode({ mode: 42 })).toBe('session_lifecycle');
		expect(() => resolveMode({ mode: '' })).toThrow(/unsupported mode/);
	});
});
