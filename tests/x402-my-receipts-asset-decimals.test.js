/**
 * /api/x402/my-receipts: the amount scale it hands a buyer.
 *
 * A receipt records the settlement `asset` verbatim, so the buyer's client has
 * an atomic amount and an asset address and nothing that says how to divide one
 * by the other. The endpoint resolves that scale server-side from the same env
 * config that builds the 402 accepts, and returns null for anything it does not
 * recognise, at which point the client renders raw atomic units: a $0.001
 * payment reads as "1000".
 *
 * That makes the mapping a coverage problem, not a lookup problem. It shipped
 * covering USDC on Solana, Base, and BSC while the accepts had grown two more
 * assets (USD₮0 on X Layer, $THREE on the Solana rail), so receipts from either
 * rail came back unscaled and nothing failed.
 *
 * So the expectation here is derived, not restated: the accept builders are
 * scanned for every `asset: env.X` they can emit, and each one must resolve.
 * Advertising a new asset without teaching my-receipts its decimals fails this
 * test instead of quietly reaching buyers.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { assetDecimals } from '../api/x402/my-receipts.js';
import { env } from '../api/_lib/env.js';

const here = dirname(fileURLToPath(import.meta.url));
const apiLib = join(here, '..', 'api', '_lib');

// Every module that builds an `accepts[]` entry for a 402 challenge.
const ACCEPT_BUILDERS = [
	join(apiLib, 'x402-spec.js'),
	join(apiLib, 'x402-paid-endpoint.js'),
	join(apiLib, 'x402-xlayer-okx.js'),
	join(apiLib, 'x402', 'a2a-server.js'),
];

function advertisedAssetVars() {
	const found = new Set();
	for (const file of ACCEPT_BUILDERS) {
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(/asset:\s*env\.([A-Z0-9_]+)/g)) found.add(m[1]);
	}
	return [...found].sort();
}

describe('assetDecimals covers every advertised settlement asset', () => {
	it('finds the asset env vars the accept builders can emit', () => {
		const vars = advertisedAssetVars();
		// A scan that matches nothing would make every assertion below vacuous.
		expect(vars.length).toBeGreaterThanOrEqual(4);
		expect(vars).toContain('X402_ASSET_MINT_SOLANA');
		expect(vars).toContain('X402_ASSET_ADDRESS_XLAYER');
		expect(vars).toContain('THREE_TOKEN_MINT');
	});

	it('resolves a scale for each of them', () => {
		const unscaled = advertisedAssetVars()
			.map((name) => [name, env[name]])
			.filter(([, address]) => address)
			.filter(([, address]) => assetDecimals(address) == null)
			.map(([name]) => name);

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
