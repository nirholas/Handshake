// Unit coverage for the MWA error normalizer in solana-mobile/src/mwa-errors.js.
// The contract other three.ws code relies on: a user decline surfaces as
// `code === 4001` (Phantom-shaped) with reason 'USER_REJECTED', while transport
// and configuration faults keep their own actionable reason and never masquerade
// as a cancel.

import { describe, it, expect } from 'vitest';
import { normalizeMwaError, isUserRejection, MwaError } from '../solana-mobile/src/mwa-errors.js';

describe('normalizeMwaError', () => {
	it('is idempotent for an already-normalized error', () => {
		const e = new MwaError('USER_REJECTED');
		expect(normalizeMwaError(e)).toBe(e);
	});

	it.each([
		['protocol ERROR_AUTHORIZATION_FAILED (-1)', { code: -1 }],
		['protocol ERROR_NOT_SIGNED (-3)', { code: -3 }],
		['adapter ERROR_ASSOCIATION_CANCELLED', { code: 'ERROR_ASSOCIATION_CANCELLED' }],
		['already-4001', { code: 4001 }],
		['message-only decline', new Error('User rejected the request')],
	])('maps %s to USER_REJECTED / 4001', (_label, input) => {
		const err = normalizeMwaError(input);
		expect(err).toBeInstanceOf(MwaError);
		expect(err.reason).toBe('USER_REJECTED');
		expect(err.code).toBe(4001);
		expect(isUserRejection(err)).toBe(true);
	});

	it.each([
		['ERROR_WALLET_NOT_FOUND', 'WALLET_NOT_FOUND'],
		['ERROR_BROWSER_NOT_SUPPORTED', 'BROWSER_NOT_SUPPORTED'],
		['ERROR_SECURE_CONTEXT_REQUIRED', 'SECURE_CONTEXT_REQUIRED'],
		['ERROR_SESSION_TIMEOUT', 'SESSION_TIMEOUT'],
		['ERROR_SESSION_CLOSED', 'SESSION_TIMEOUT'],
		['ERROR_INVALID_PROTOCOL_VERSION', 'PROTOCOL_MISMATCH'],
	])('maps adapter %s to reason %s without a 4001', (code, reason) => {
		const err = normalizeMwaError({ code, message: code });
		expect(err.reason).toBe(reason);
		expect(err.code).toBeUndefined();
		expect(err.userMessage).toBeTruthy();
		expect(isUserRejection(err)).toBe(false);
	});

	it('maps invalid-payload protocol codes to INVALID_REQUEST', () => {
		expect(normalizeMwaError({ code: -2 }).reason).toBe('INVALID_REQUEST');
		expect(normalizeMwaError({ code: -5 }).reason).toBe('INVALID_REQUEST');
	});

	it('falls back to UNKNOWN and preserves the original as cause', () => {
		const original = new Error('socket exploded');
		const err = normalizeMwaError(original);
		expect(err.reason).toBe('UNKNOWN');
		expect(err.cause).toBe(original);
		expect(err.userMessage).toMatch(/try again/i);
	});
});
