// Chain reads: the shared hoodchain client, cached ERC-20 metadata resolution
// (name/symbol via multicall), and one-time Uniswap v3 pool inspection used to
// classify swap direction. Kept separate from normalize.js so the normalizer
// stays pure and testable.

import { createHoodClient, MAINNET_ADDRESSES, TESTNET_ADDRESSES } from 'hoodchain';
import { erc20Abi, fallback, http } from 'viem';
import { config } from './config.js';
import { withRpcRetry } from './rpc.js';

/**
 * Shared read-only client. Multicall batching is on by default in the SDK.
 *
 * The transport is a viem `fallback` over every configured RPC so a provider
 * that is down, throttled or (in Alchemy's case) not enabled for this chain
 * rolls over to the next rung instead of failing the read. `withRpcRetry` on
 * top of that handles the public RPC's transient -32602 load shedding, which
 * viem itself never retries.
 */
export const hood = createHoodClient({
	chain: config.network,
	transport: fallback(
		config.rpcUrls.map((url) => http(url, { retryCount: 2, timeout: 20_000 })),
	),
});

/** Probe every configured RPC once, so a dead rung is visible in the logs. */
export async function probeRpcUrls() {
	return Promise.all(config.rpcUrls.map(async (url) => {
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
				signal: AbortSignal.timeout(10_000),
			});
			const body = await res.json();
			if (body?.error) return { url, ok: false, error: body.error.message };
			return { url, ok: true, chain_id: Number(body?.result ?? 0) };
		} catch (err) {
			return { url, ok: false, error: err?.message || 'unreachable' };
		}
	}));
}

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
		const [n, s] = await withRpcRetry(() => hood.public.multicall({
			contracts: [
				{ address: token, abi: erc20Abi, functionName: 'name' },
				{ address: token, abi: erc20Abi, functionName: 'symbol' },
			],
			allowFailure: true,
		}));
		if (n?.status === 'success') name = n.result;
		if (s?.status === 'success') symbol = s.result;
	} catch {
		/* leave nulls */
	}
	const out = { name, symbol };
	_meta.set(key, out);
	return out;
}

// ── block timestamps ─────────────────────────────────────────────────────────
const _blockTs = new Map(); // blockNumber(string) → ms | null
const BLOCK_TS_CACHE = 2_048;

/**
 * Wall-clock ms for a block, cached (block timestamps are immutable). Every
 * emitted event is stamped with this rather than `Date.now()`: a cold-start
 * backfill replays launches that are hours or weeks old, and stamping those
 * with the current time makes the replay buffer sort wrong and every consumer
 * render them as brand new. Returns null when the block can't be read, in
 * which case the normalizers fall back to now.
 */
export async function blockTimeMs(blockNumber) {
	if (blockNumber === null || blockNumber === undefined) return null;
	const key = String(blockNumber);
	if (_blockTs.has(key)) return _blockTs.get(key);
	let ms = null;
	try {
		const block = await withRpcRetry(() => hood.public.getBlock({ blockNumber: BigInt(blockNumber) }));
		ms = Number(block.timestamp) * 1000;
	} catch {
		ms = null;
	}
	_blockTs.set(key, ms);
	while (_blockTs.size > BLOCK_TS_CACHE) _blockTs.delete(_blockTs.keys().next().value);
	return ms;
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
		const [t0, t1] = await withRpcRetry(() => hood.public.multicall({
			contracts: [
				{ address: pool, abi: poolAbi, functionName: 'token0' },
				{ address: pool, abi: poolAbi, functionName: 'token1' },
			],
			allowFailure: false,
		}));
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
