import { describe, it, expect } from 'vitest';
import { isUnrecoverableSecret } from '../api/_lib/agent-pumpfun.js';

// Guards the self-heal in loadAgentForSigning: a custodial wallet encrypted under a
// retired key (the WALLET_ENCRYPTION_KEY that changed during the Vercel→Cloud Run
// migration) is re-provisioned with the current key instead of failing every launch
// forever. This MUST fire only on a definitive, permanent decrypt failure — never on
// a transient fault, or the launcher would silently re-key a wallet whose funds were
// still recoverable.

describe('isUnrecoverableSecret', () => {
	it('fires on AES-GCM auth failure (retired/wrong key)', () => {
		expect(isUnrecoverableSecret({ name: 'OperationError', message: 'The operation failed' })).toBe(true);
	});

	it('fires on a corrupt/invalid stored secret', () => {
		expect(isUnrecoverableSecret(new Error('bad secret key size'))).toBe(true);
		expect(isUnrecoverableSecret(new Error('[secret-box] v2 decrypt failed: no candidate key available'))).toBe(true);
	});

	it('does NOT fire on a transient/network error (would strand recoverable funds)', () => {
		expect(isUnrecoverableSecret(new Error('connection reset'))).toBe(false);
		expect(isUnrecoverableSecret(new Error('fetch failed'))).toBe(false);
	});

	it('does NOT fire on an unrelated programming error', () => {
		expect(isUnrecoverableSecret({ name: 'TypeError', message: 'x is undefined' })).toBe(false);
		expect(isUnrecoverableSecret(null)).toBe(false);
		expect(isUnrecoverableSecret(undefined)).toBe(false);
	});
});
