// Unit tests for src/vault-fsm.js — the pure state-machine/formatting helpers
// backing the /vault page (prompt 12). No DOM, no network: every branch of
// deriveListingState/nextFlowStep is exercised table-style so the UI's
// buy → settle → unlock progression is provably correct independent of
// mounting the page. See the bnb-chain campaign, work order 12's (vault UI; retired, see git history) "Tests" section.

import { describe, it, expect } from 'vitest';
import { deriveListingState, nextFlowStep, formatBnbAtomic, truncateAddress, pollDelayMs, SALE_STATUS, FLOW_STEPS } from '../src/vault-fsm.js';

describe('deriveListingState', () => {
	it('is unlisted when the contract is not deployed, regardless of other fields', () => {
		expect(deriveListingState({ contractDeployed: false, listingActive: true, saleId: '1', saleStatus: 'Granted' })).toBe('unlisted');
	});
	it('is unlisted when never listed (saleId 0, listing inactive)', () => {
		expect(deriveListingState({ contractDeployed: true, listingActive: false, saleId: 0n })).toBe('unlisted');
	});
	it('is available when listed and no purchase yet', () => {
		expect(deriveListingState({ contractDeployed: true, listingActive: true, saleId: '0' })).toBe('available');
	});
	it('is pending-grant when purchased but not yet Granted', () => {
		expect(deriveListingState({ contractDeployed: true, listingActive: true, saleId: '1', saleStatus: 'Pending' })).toBe('pending-grant');
	});
	it('is unlocked once the sale status is Granted', () => {
		expect(deriveListingState({ contractDeployed: true, listingActive: true, saleId: '1', saleStatus: 'Granted' })).toBe('unlocked');
	});
	it('accepts saleId as bigint, string, or number interchangeably', () => {
		const base = { contractDeployed: true, listingActive: true, saleStatus: 'Granted' };
		expect(deriveListingState({ ...base, saleId: 1n })).toBe('unlocked');
		expect(deriveListingState({ ...base, saleId: '1' })).toBe('unlocked');
		expect(deriveListingState({ ...base, saleId: 1 })).toBe('unlocked');
	});
});

describe('nextFlowStep', () => {
	it('routes to connect when the wallet/session is not ready', () => {
		expect(nextFlowStep({ walletConnected: false, listingState: 'available', hasDecrypted: false })).toBe('connect');
	});
	it('routes unlisted straight through', () => {
		expect(nextFlowStep({ walletConnected: true, listingState: 'unlisted', hasDecrypted: false })).toBe('unlisted');
	});
	it('routes available to buy', () => {
		expect(nextFlowStep({ walletConnected: true, listingState: 'available', hasDecrypted: false })).toBe('buy');
	});
	it('routes pending-grant through unchanged', () => {
		expect(nextFlowStep({ walletConnected: true, listingState: 'pending-grant', hasDecrypted: false })).toBe('pending-grant');
	});
	it('routes unlocked-but-not-yet-decrypted to unlocked (show the Unlock button)', () => {
		expect(nextFlowStep({ walletConnected: true, listingState: 'unlocked', hasDecrypted: false })).toBe('unlocked');
	});
	it('routes unlocked-and-decrypted to viewing (render the model)', () => {
		expect(nextFlowStep({ walletConnected: true, listingState: 'unlocked', hasDecrypted: true })).toBe('viewing');
	});
});

describe('formatBnbAtomic', () => {
	it('formats a whole-BNB atomic value with no fractional remainder', () => {
		expect(formatBnbAtomic('2000000000000000000')).toBe('2 BNB');
	});
	it('formats a fractional atomic value, trimming trailing zeros', () => {
		expect(formatBnbAtomic('1500000000000000000')).toBe('1.5 BNB');
	});
	it('formats zero', () => {
		expect(formatBnbAtomic('0')).toBe('0 BNB');
	});
	it('accepts a bigint directly', () => {
		expect(formatBnbAtomic(1_000_000_000_000_000_000n)).toBe('1 BNB');
	});
	it('never throws on garbage input — returns an em dash', () => {
		expect(formatBnbAtomic('not-a-number')).toBe('—');
		expect(formatBnbAtomic(undefined)).toBe('0 BNB');
	});
});

describe('truncateAddress', () => {
	it('truncates a real EVM address to 0x1234…abcd form', () => {
		expect(truncateAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
	});
	it('passes through a non-address string unchanged', () => {
		expect(truncateAddress('not-an-address')).toBe('not-an-address');
	});
	it('never throws on null/undefined', () => {
		expect(truncateAddress(null)).toBe('');
		expect(truncateAddress(undefined)).toBe('');
	});
});

describe('pollDelayMs', () => {
	it('grows with attempt number and is capped at 8000ms', () => {
		const d0 = pollDelayMs(0);
		const d1 = pollDelayMs(1);
		const d10 = pollDelayMs(10);
		expect(d1).toBeGreaterThan(d0);
		expect(d10).toBeLessThanOrEqual(8000);
	});
	it('never returns a negative or zero delay for attempt 0', () => {
		expect(pollDelayMs(0)).toBeGreaterThan(0);
	});
});

describe('static tables', () => {
	it('SALE_STATUS mirrors the contract enum order', () => {
		expect(SALE_STATUS).toEqual(['Pending', 'Granted', 'Failed', 'Revoked']);
	});
	it('FLOW_STEPS is a well-formed ordered list', () => {
		expect(FLOW_STEPS).toContain('browse');
		expect(FLOW_STEPS).toContain('unlocked');
	});
});
