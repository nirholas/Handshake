// Runtime configuration for the Robinhood Chain firehose. Every knob is an env
// var with a safe default so `npm start` works with zero config against the
// public mainnet RPC + sequencer feed.

const num = (v, d) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : d;
};

const network = process.env.RH_NETWORK === 'testnet' ? 'testnet' : 'mainnet';

// Optional Alchemy accelerator. When the Robinhood network is enabled on the
// Alchemy app, an `eth_subscribe`-capable WSS transport removes RPC polling
// latency. Absent that, the SDK watchers poll the public RPC and the sequencer
// feed provides the sub-second liveness signal — the feed works with no key.
const alchemyKey = process.env.ALCHEMY_API_KEY || process.env.RH_ALCHEMY_KEY || '';
const alchemyHttp = alchemyKey && network === 'mainnet'
	? `https://robinhood-mainnet.g.alchemy.com/v2/${alchemyKey}`
	: '';

const publicRpc = network === 'testnet'
	? 'https://rpc.testnet.chain.robinhood.com'
	: 'https://rpc.mainnet.chain.robinhood.com';

// Preference order for the viem fallback transport: an explicit override wins,
// then the Alchemy accelerator, then the public RPC as the always-present last
// resort. The public RPC stays in the list even when an override is set: an
// ALCHEMY_API_KEY whose app has the Robinhood network disabled answers EVERY
// call with -32600 (verified live), and without a fallback rung that single
// env var would silently take the whole worker down.
const rpcUrls = [...new Set([process.env.RH_RPC_URL, alchemyHttp, publicRpc].filter(Boolean))];

export const config = {
	network,
	/** Every HTTP RPC the client may use, most-preferred first. */
	rpcUrls,
	/** Most-preferred HTTP RPC (logging + health reporting). */
	rpcUrl: rpcUrls[0],
	/** Arbitrum Nitro sequencer feed — no auth, sub-second block-tip signal. */
	feedUrl: process.env.RH_FEED_URL
		|| (network === 'testnet'
			? 'wss://feed.testnet.chain.robinhood.com'
			: 'wss://feed.mainnet.chain.robinhood.com'),
	/** Whether to consume the sequencer feed for the block-tip / gap watchdog. */
	useFeed: process.env.RH_USE_FEED !== '0',
	/** RPC log poll interval (ms) for the SDK watchers. */
	pollingIntervalMs: num(process.env.RH_POLL_MS, 2_000),
	/** HTTP server port. */
	port: num(process.env.PORT, 8788),
	/** Cross-emit dedupe window (events remembered by log key). */
	seenLimit: num(process.env.RH_SEEN_LIMIT, 4_000),
	/** Replay-buffer depth per event kind (served to fresh subscribers). */
	bufferLimit: num(process.env.RH_BUFFER_LIMIT, 40),
	/** Cap on live Uniswap pools we watch for post-graduation / NOXA swaps. */
	maxTrackedPools: num(process.env.RH_MAX_POOLS, 400),
	/**
	 * If the chain head advances this many blocks past the highest block the RPC
	 * watchers have reported, run a catch-up eth_getLogs to gap-fill. Robinhood
	 * Chain produces a block every ~100ms and gapCheck() ticks every 15s, so
	 * ~150 blocks pass per tick under completely normal conditions — the
	 * threshold must clear that comfortably or every routine tick misreads
	 * itself as a stalled watcher and re-scans needlessly. 2 000 blocks ≈ 3.3
	 * minutes of chain time, well past one poll tick but tight enough to catch
	 * a genuinely stuck RPC watcher quickly.
	 */
	gapCatchupBlocks: num(process.env.RH_GAP_BLOCKS, 2_000),
	/** Backfill this many blocks of launches on cold start so a fresh subscriber sees history. */
	backfillBlocks: BigInt(num(process.env.RH_BACKFILL_BLOCKS, 200_000)),
};

/**
 * An RPC URL safe to log or serve from /healthz. A provider key lives in the
 * URL path (Alchemy) or query string, and /healthz is public once the worker is
 * deployed, so both are masked before the URL ever leaves the process.
 */
export function redactRpcUrl(url) {
	try {
		const u = new URL(url);
		for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '***');
		const parts = u.pathname.split('/');
		const last = parts[parts.length - 1];
		if (last && last.length >= 16) parts[parts.length - 1] = '***';
		u.pathname = parts.join('/');
		return u.toString();
	} catch {
		return 'invalid-url';
	}
}

export const CHAIN_ID = network === 'testnet' ? 46630 : 4663;
export const EXPLORER_BASE = network === 'testnet'
	? 'https://explorer.testnet.chain.robinhood.com'
	: 'https://robinhoodchain.blockscout.com';
