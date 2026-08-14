// /api/nft/resolve: the EVM chain gate and the Alchemy NFT URL it builds.
//
// The handler used to carry its own hand-copied Alchemy host map. Two things
// went wrong with the copy and neither was visible from the outside:
//
//   1. It lost polygon-amoy (80002) and avax-fuji (43113). Both are in the RPC
//      module's host map and both have public RPCs in the chain registry, so
//      the keyless on-chain rung could have read them. The gate rejected them
//      400 "unsupported evm chainId" before either rung ran.
//   2. It read process.env.ALCHEMY_API_KEY directly, ignoring the per-chain
//      overrides (ALCHEMY_BASE_KEY and friends) that api/_lib/evm/rpc.js honors.
//      A deployment provisioned that way had a working RPC lane and a dead NFT
//      lane on the same chain.
//
// Both host maps now come from one place. These tests pin that: the NFT base
// URL is derived from the same table and the same key resolution as the JSON-RPC
// URL, and the gate admits every chain the platform can actually reach.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const ALCHEMY_KEYS = [
	'ALCHEMY_API_KEY',
	'ALCHEMY_ETH_KEY',
	'ALCHEMY_OPT_KEY',
	'ALCHEMY_POLYGON_KEY',
	'ALCHEMY_BASE_KEY',
	'ALCHEMY_ARB_KEY',
];

async function loadModule() {
	vi.resetModules();
	return import('../api/_lib/evm/rpc.js');
}

beforeEach(() => {
	for (const key of ALCHEMY_KEYS) delete process.env[key];
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe('alchemyNftBaseUrl', () => {
	it('builds the v3 NFT base URL on the same host the JSON-RPC lane uses', async () => {
		process.env.ALCHEMY_API_KEY = 'shared-key';
		const { alchemyNftBaseUrl } = await loadModule();
		expect(alchemyNftBaseUrl(8453)).toBe('https://base-mainnet.g.alchemy.com/nft/v3/shared-key');
		expect(alchemyNftBaseUrl(1)).toBe('https://eth-mainnet.g.alchemy.com/nft/v3/shared-key');
	});

	it('honors the per-chain key override ahead of the shared key', async () => {
		process.env.ALCHEMY_API_KEY = 'shared-key';
		process.env.ALCHEMY_BASE_KEY = 'base-only-key';
		const { alchemyNftBaseUrl } = await loadModule();
		expect(alchemyNftBaseUrl(8453)).toBe('https://base-mainnet.g.alchemy.com/nft/v3/base-only-key');
		// A chain with no override still falls back to the shared key.
		expect(alchemyNftBaseUrl(59144)).toBe('https://linea-mainnet.g.alchemy.com/nft/v3/shared-key');
	});

	it('returns null when no key is configured, so the caller can fail over', async () => {
		const { alchemyNftBaseUrl } = await loadModule();
		expect(alchemyNftBaseUrl(8453)).toBeNull();
	});

	it('returns null for a chain Alchemy publishes no host for', async () => {
		process.env.ALCHEMY_API_KEY = 'shared-key';
		const { alchemyNftBaseUrl, alchemySupportsChain } = await loadModule();
		expect(alchemySupportsChain(999999)).toBe(false);
		expect(alchemyNftBaseUrl(999999)).toBeNull();
	});
});

describe('the EVM chain gate', () => {
	// The handler admits a chainId when evmRpcEndpoints() can name at least one
	// endpoint for it, because that is exactly what the keyless rung needs.
	it('admits the testnets the old hand-copied host map dropped', async () => {
		const { evmRpcEndpoints, alchemySupportsChain } = await loadModule();
		for (const chainId of [80002, 43113]) {
			expect(alchemySupportsChain(chainId)).toBe(true);
			expect(evmRpcEndpoints(chainId).length).toBeGreaterThan(0);
		}
	});

	it('admits every chain Alchemy indexes, key or no key', async () => {
		const { evmRpcEndpoints, alchemySupportsChain } = await loadModule();
		const indexed = [1, 10, 56, 137, 324, 8453, 42161, 43114, 59144, 534352, 84532, 421614, 43113, 80002, 11155111, 11155420];
		for (const chainId of indexed) {
			expect(alchemySupportsChain(chainId)).toBe(true);
			expect(evmRpcEndpoints(chainId).length, `chain ${chainId} has no reachable endpoint`).toBeGreaterThan(0);
		}
	});

	it('rejects a chainId nothing in the stack has an endpoint for', async () => {
		const { evmRpcEndpoints } = await loadModule();
		expect(evmRpcEndpoints(999999)).toHaveLength(0);
	});
});
