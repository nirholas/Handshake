// Chain reads: the shared hoodchain client, cached ERC-20 metadata resolution
// (name/symbol via multicall), and one-time Uniswap v3 pool inspection used to
// classify swap direction. Kept separate from normalize.js so the normalizer
// stays pure and testable.

import { createHoodClient, MAINNET_ADDRESSES, TESTNET_ADDRESSES } from 'hoodchain';
import { erc20Abi } from 'viem';
import { config } from './config.js';

/** Shared read-only client. Multicall batching is on by default in the SDK. */
export const hood = createHoodClient({
	chain: config.network,
	rpcUrl: config.rpcUrl,
});

const ADDR = config.network === 'testnet' ? TESTNET_ADDRESSES : MAINNET_ADDRESSES;
const WETH = ADDR.weth.toLowerCase();
const USDG = ADDR.usdg.toLowerCase();

// ── ERC-20 metadata (name/symbol) ────────────────────────────────────────────
const _meta = new Map(); // token(lower) → { name, symbol }

/**
 * Resolve name+symbol for a token, cached forever (immutable on-chain). Never
 * throws — a token that reverts on name()/symbol() resolves to nulls so the
 * feed keeps flowing.
 */
export async function resolveMeta(token) {
	const key = token.toLowerCase();
	const hit = _meta.get(key);
	if (hit) return hit;
	let name = null;
	let symbol = null;
	try {
		const [n, s] = await hood.public.multicall({
			contracts: [
				{ address: token, abi: erc20Abi, functionName: 'name' },
				{ address: token, abi: erc20Abi, functionName: 'symbol' },
			],
			allowFailure: true,
		});
		if (n?.status === 'success') name = n.result;
		if (s?.status === 'success') symbol = s.result;
	} catch {
		/* leave nulls */
	}
	const out = { name, symbol };
	_meta.set(key, out);
	return out;
}

// ── Uniswap v3 pool inspection ───────────────────────────────────────────────
const poolAbi = [
	{ type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];

const _pools = new Map(); // pool(lower) → { token, coinIsToken0, quoteSymbol, quoteDecimals } | null

/**
 * Inspect a Uniswap v3 pool once: which side is the coin, and what the quote
 * asset is (ETH via WETH, or USDG). Returns null if neither side is the given
 * coin or the pool doesn't respond (we then skip watching it).
 */
export async function inspectPool(pool, coinToken) {
	const key = pool.toLowerCase();
	if (_pools.has(key)) return _pools.get(key);
	let info = null;
	try {
		const [t0, t1] = await hood.public.multicall({
			contracts: [
				{ address: pool, abi: poolAbi, functionName: 'token0' },
				{ address: pool, abi: poolAbi, functionName: 'token1' },
			],
			allowFailure: false,
		});
		const a0 = t0.toLowerCase();
		const a1 = t1.toLowerCase();
		const coin = coinToken.toLowerCase();
		const coinIsToken0 = a0 === coin;
		const coinIsToken1 = a1 === coin;
		if (coinIsToken0 || coinIsToken1) {
			const quoteAddr = coinIsToken0 ? a1 : a0;
			const isUsdg = quoteAddr === USDG;
			info = {
				token: coinToken,
				coinIsToken0,
				quoteSymbol: isUsdg ? 'USDG' : quoteAddr === WETH ? 'ETH' : 'ETH',
				quoteDecimals: isUsdg ? 6 : 18,
			};
		}
	} catch {
		info = null;
	}
	_pools.set(key, info);
	return info;
}
