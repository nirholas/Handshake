// The address-only pre-filter that decides whether a mint can carry a pump.fun
// bonding curve at all.
//
// It exists in two copies on purpose — one in the API (api/_lib/pump-curve-view.js,
// guarding an RPC read and a 300s-cached 404) and one in the browser widget
// (src/widgets/bonding-curve.js, guarding the request itself). They must agree:
// a mint the server would answer for and the widget refuses to ask about renders
// as permanently empty, and the reverse produces a 404 storm.
//
// The case that matters here is three.ws's own launches. pump.fun grinds its
// mints to END in "pump"; three.ws grinds its own to CARRY the "3ws" mark as a
// PREFIX (src/solana/vanity/brand.js). Every agent token this platform mints
// therefore fails a suffix-only test, which is what used to make the curve read
// for our own coins impossible.

import { describe, it, expect } from 'vitest';
import { isPumpMint as isPumpMintServer } from '../api/_lib/pump-curve-view.js';
import { isPumpMint as isPumpMintClient } from '../src/widgets/bonding-curve.js';
import { THREE_WS_MARK } from '../src/solana/vanity/brand.js';

// Every gate must answer identically on both sides of the wire.
const GATES = [
	['api/_lib/pump-curve-view.js', isPumpMintServer],
	['src/widgets/bonding-curve.js', isPumpMintClient],
];

const THREE_WS_LAUNCH = '3wsSynthetic11111111111111111111111111111';
const PUMP_LAUNCH = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

describe.each(GATES)('isPumpMint (%s)', (_label, isPumpMint) => {
	it('accepts a three.ws-marked mint, which is what every agent token is', () => {
		expect(isPumpMint(THREE_WS_LAUNCH)).toBe(true);
	});

	it('accepts the mark case-insensitively, matching how it is ground', () => {
		expect(isPumpMint(`${THREE_WS_MARK.toUpperCase()}Synthetic1111111111111111111111111`)).toBe(true);
	});

	it('still accepts a pump.fun-ground mint', () => {
		expect(isPumpMint(PUMP_LAUNCH)).toBe(true);
	});

	it('rejects settlement and native tokens, which never carry a curve', () => {
		expect(isPumpMint(USDC_MAINNET)).toBe(false);
		expect(isPumpMint(USDC_DEVNET)).toBe(false);
		expect(isPumpMint(WRAPPED_SOL)).toBe(false);
	});

	it('rejects an unrelated address so a stray mount cannot start a 404 storm', () => {
		expect(isPumpMint('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe(false);
	});

	it('rejects non-string input', () => {
		expect(isPumpMint('')).toBe(false);
		expect(isPumpMint(null)).toBe(false);
		expect(isPumpMint(undefined)).toBe(false);
	});
});
