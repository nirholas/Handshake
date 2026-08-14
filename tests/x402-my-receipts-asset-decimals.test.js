/**
 * /api/x402/my-receipts: the amount scale it hands a buyer.
 *
 * A receipt records the settlement `asset` verbatim, so the buyer's client has
 * an atomic amount and an asset address and nothing that says how to divide
 * one by the other. The endpoint resolves that scale server-side from the same
 * env config that builds the 402 accepts, and returns null for anything it does
 * not recognise, at which point the client renders raw atomic units: a $0.001
 * payment reads as "1000".
 *
 * That makes the mapping a coverage problem, not a lookup problem. It shipped
 * covering USDC on Solana, Base, and BSC while the accepts list had grown two
 * more assets (USD₮0 on X Layer, $THREE on the Solana rail), so receipts from
 * either rail came back unscaled. This test derives the expectation from
 * buildExactRequirements rather than restating a list, so the next asset added
 * to an accept fails here instead of silently reaching buyers unscaled.
 */

import { describe, it, expect, beforeAll } from 'vitest';

// Receiver + fee-payer addresses gate which accepts are advertised at all.
// Synthetic values: nothing here verifies or settles a payment.
beforeAll(() => {
	process.env.X402_PAY_TO_SOLANA ||= 'THREEsyntheticReceiver11111111111111111111111';
	process.env.X402_FEE_PAYER_SOLANA ||= 'THREEsyntheticFeePayer111111111111111111111111';
	process.env.X402_RING_SELF_PAY ||= 'true';
	process.env.X402_PAY_TO_BASE ||= '0x1111111111111111111111111111111111111111';
	process.env.X402_PAY_TO_BSC ||= '0x2222222222222222222222222222222222222222';
	process.env.X402_PAY_TO_XLAYER ||= '0x3333333333333333333333333333333333333333';
});

const { assetDecimals } = await import('../api/x402/my-receipts.js');
const { buildExactRequirements } = await import('../api/_lib/x402-spec.js');
const { env } = await import('../api/_lib/env.js');

describe('assetDecimals covers every advertised settlement asset', () => {
	it('resolves a scale for each asset in the live 402 accepts', () => {
		const accepts = buildExactRequirements('https://three.ws/api/x402/notify');
		expect(accepts.length).toBeGreaterThan(0);

		const unscaled = accepts
			.map((a) => a.asset)
			.filter(Boolean)
			.filter((asset) => assetDecimals(asset) == null);

		expect(unscaled).toEqual([]);
	});

	it('scales $THREE by its own decimals, not a hardcoded 6', () => {
		expect(assetDecimals(env.THREE_TOKEN_MINT)).toBe(env.THREE_TOKEN_DECIMALS);
	});

	it('matches an asset address case-insensitively (EVM checksums vary)', () => {
		expect(assetDecimals(env.X402_ASSET_ADDRESS_BASE.toUpperCase())).toBe(6);
		expect(assetDecimals(env.X402_ASSET_ADDRESS_XLAYER.toLowerCase())).toBe(6);
	});

	it('returns null for an asset this deployment never pays in', () => {
		expect(assetDecimals('THREEsyntheticUnknownAsset11111111111111111')).toBeNull();
		expect(assetDecimals('')).toBeNull();
		expect(assetDecimals(null)).toBeNull();
	});
});
