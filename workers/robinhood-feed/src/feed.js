// The firehose orchestrator. Composes the hoodchain SDK watchers (NOXA +
// Odyssey via RPC logs), a dynamic Uniswap v3 Swap watcher over the set of
// tracked pools (NOXA pools from block one, Odyssey pools post-graduation), and
// the Arbitrum sequencer feed used as a sub-second block-tip + gap watchdog.
// Everything is normalized to the pump-compatible shape and handed to onEvent.
//
// Divergence from the pump (PumpPortal) feed, by design:
//  • The sequencer feed carries every L2 tx ~100ms early but decoding trades
//    from its RLP payload is far less reliable than reading decoded event logs.
//    So we use RPC logs for the DECODED events and the feed only for liveness /
//    gap detection. Documented in the README.
//  • Solana `sol_amount` field name is reused for the native ETH magnitude.

import {
	watchLaunches, watchCurveTrades, watchGraduations, getRecentLaunches,
	odysseyTradedEvent, ODYSSEY_ADDRESSES,
} from 'hoodchain';
import { subscribeFeed } from 'hoodchain';
import { config } from './config.js';
import { hood, resolveMeta, inspectPool } from './chain.js';
import { ethPriceUsd } from './eth-price.js';
import {
	normalizeLaunch, normalizeCurveTrade, normalizeUniswapSwap, normalizeGraduation,
} from './normalize.js';

const uniswapSwapEvent = {
	type: 'event',
	name: 'Swap',
	inputs: [
		{ name: 'sender', type: 'address', indexed: true },
		{ name: 'recipient', type: 'address', indexed: true },
		{ name: 'amount0', type: 'int256', indexed: false },
		{ name: 'amount1', type: 'int256', indexed: false },
		{ name: 'sqrtPriceX96', type: 'uint160', indexed: false },
		{ name: 'liquidity', type: 'uint128', indexed: false },
		{ name: 'tick', type: 'int24', indexed: false },
	],
};

const ODYSSEY_FACTORIES = [
	ODYSSEY_ADDRESSES.bondingCurveFactory,
	ODYSSEY_ADDRESSES.reflectionFactory,
	ODYSSEY_ADDRESSES.instantFactory,
];

/**
 * Start the firehose.
 * @param {(ev: { kind: 'launch'|'trade'|'graduation'|'status', data: object }) => void} onEvent
 * @returns {{ stop: () => void, health: () => object }}
 */
export function startFirehose(onEvent) {
	let active = true;
	const unwatchers = [];
	let feedSub = null;
	let swapUnwatch = null;

	// Cross-source dedupe: a launch/trade may surface from both backfill and the
	// live watcher. Key by tx + token + block + a discriminator.
	const seen = new Map(); // key → ts
	function once(key) {
		if (!key) return true;
		if (seen.has(key)) return false;
		seen.set(key, Date.now());
		if (seen.size > config.seenLimit) {
			const drop = Math.floor(config.seenLimit / 4);
			const it = seen.keys();
			for (let i = 0; i < drop; i++) seen.delete(it.next().value);
		}
		return true;
	}

	// Tracked Uniswap pools (insertion-ordered for LRU eviction).
	const pools = new Map(); // pool(lower) → token
	let resubTimer = null;
	function trackPool(pool, token) {
		if (!pool) return;
		const key = pool.toLowerCase();
		if (pools.has(key)) return;
		pools.set(key, token);
		while (pools.size > config.maxTrackedPools) {
			pools.delete(pools.keys().next().value);
		}
		// Debounce re-subscription so a burst of launches re-watches once.
		clearTimeout(resubTimer);
		resubTimer = setTimeout(subscribeSwaps, 300);
	}

	function subscribeSwaps() {
		if (!active || pools.size === 0) return;
		try { swapUnwatch?.(); } catch { /* ignore */ }
		const addresses = [...pools.keys()];
		swapUnwatch = hood.public.watchContractEvent({
			address: addresses,
			abi: [uniswapSwapEvent],
			eventName: 'Swap',
			pollingInterval: config.pollingIntervalMs,
			onError: (err) => onEvent({ kind: 'status', data: { level: 'warn', src: 'swap-watch', message: err?.message } }),
			onLogs: (logs) => { for (const log of logs) handleSwap(log); },
		});
	}

	async function handleSwap(log) {
		const pool = log.address;
		const token = pools.get(pool.toLowerCase());
		if (!token) return;
		const key = `swap:${log.transactionHash}:${log.logIndex}`;
		if (!once(key)) return;
		const [poolInfo, meta, ethUsd] = await Promise.all([
			inspectPool(pool, token), resolveMeta(token), ethPriceUsd(),
		]);
		if (!poolInfo) return;
		const data = normalizeUniswapSwap({
			swap: {
				amount0: log.args.amount0, amount1: log.args.amount1,
				recipient: log.args.recipient, sender: log.args.sender,
				transactionHash: log.transactionHash, blockNumber: log.blockNumber,
			},
			token, pool,
			coinIsToken0: poolInfo.coinIsToken0,
			quoteSymbol: poolInfo.quoteSymbol,
			quoteDecimals: poolInfo.quoteDecimals,
			name: meta.name, symbol: meta.symbol, ethUsd,
		});
		bumpBlock(log.blockNumber);
		if (active) onEvent({ kind: 'trade', data });
	}

	async function emitLaunch(launch) {
		const key = `launch:${launch.transactionHash}:${launch.token}`;
		if (!once(key)) return;
		if (launch.pool) trackPool(launch.pool, launch.token);
		const [meta, ethUsd] = await Promise.all([resolveMeta(launch.token), ethPriceUsd()]);
		bumpBlock(launch.blockNumber);
		if (active) onEvent({ kind: 'launch', data: normalizeLaunch({ launch, name: meta.name, symbol: meta.symbol, ethUsd }) });
	}

	async function emitCurveTrade(trade) {
		const key = `trade:${trade.transactionHash}:${trade.token}:${trade.isBuy}:${trade.tokenAmount}`;
		if (!once(key)) return;
		const [meta, ethUsd] = await Promise.all([resolveMeta(trade.token), ethPriceUsd()]);
		bumpBlock(trade.blockNumber);
		if (active) onEvent({ kind: 'trade', data: normalizeCurveTrade({ trade, name: meta.name, symbol: meta.symbol, ethUsd }) });
	}

	async function emitGraduation(g) {
		const key = `grad:${g.transactionHash}:${g.token}`;
		if (!once(key)) return;
		trackPool(g.pool, g.token);
		const meta = await resolveMeta(g.token);
		bumpBlock(g.blockNumber);
		if (active) onEvent({ kind: 'graduation', data: normalizeGraduation({ grad: g, name: meta.name, symbol: meta.symbol }) });
	}

	// ── liveness + gap watchdog ────────────────────────────────────────────────
	let lastScannedBlock = 0n; // highest block we've processed events up to
	let feedSeq = 0;
	let feedTs = 0;
	let feedFramesAt = 0;
	function bumpBlock(bn) {
		const b = typeof bn === 'bigint' ? bn : BigInt(bn || 0);
		if (b > lastScannedBlock) lastScannedBlock = b;
	}

	async function gapCheck() {
		if (!active) return;
		let head;
		try { head = await hood.public.getBlockNumber(); } catch { return; }
		if (lastScannedBlock === 0n) { lastScannedBlock = head; return; }
		if (head - lastScannedBlock <= BigInt(config.gapCatchupBlocks)) { lastScannedBlock = head; return; }
		// A gap opened (RPC watcher stalled). Backfill launches + curve trades.
		const from = lastScannedBlock + 1n;
		onEvent({ kind: 'status', data: { level: 'info', src: 'gap-fill', from: Number(from), to: Number(head) } });
		try {
			const launches = await getRecentLaunches(hood, { lookbackBlocks: head - from + 1n });
			for (const l of launches) if (l.blockNumber >= from) await emitLaunch(l);
			const logs = await hood.public.getLogs({
				address: ODYSSEY_FACTORIES, event: odysseyTradedEvent, fromBlock: from, toBlock: head,
			});
			for (const log of logs) {
				await emitCurveTrade({
					launchpad: 'odyssey', token: log.args.token, trader: log.args.trader,
					isBuy: log.args.isBuy, tokenAmount: log.args.tokenAmount, quoteAmount: log.args.quoteAmount,
					fee: log.args.fee, blockNumber: log.blockNumber, transactionHash: log.transactionHash,
				});
			}
		} catch (err) {
			onEvent({ kind: 'status', data: { level: 'warn', src: 'gap-fill', message: err?.message } });
		}
		lastScannedBlock = head;
	}

	// ── cold-start backfill: register existing pools + seed the replay buffer ───
	async function backfill() {
		try {
			const launches = await getRecentLaunches(hood, { lookbackBlocks: config.backfillBlocks });
			// Oldest-first so the newest launch lands on top of the replay buffer.
			for (const l of launches) {
				if (l.pool) trackPool(l.pool, l.token);
				await emitLaunch(l);
			}
			onEvent({ kind: 'status', data: { level: 'info', src: 'backfill', launches: launches.length } });
		} catch (err) {
			onEvent({ kind: 'status', data: { level: 'warn', src: 'backfill', message: err?.message } });
		}
	}

	// ── wire everything up ─────────────────────────────────────────────────────
	unwatchers.push(watchLaunches(hood, (l) => { emitLaunch(l).catch(() => {}); }, { pollingInterval: config.pollingIntervalMs, onError: (e) => onEvent({ kind: 'status', data: { level: 'warn', src: 'launch-watch', message: e?.message } }) }));
	unwatchers.push(watchCurveTrades(hood, (t) => { emitCurveTrade(t).catch(() => {}); }, { pollingInterval: config.pollingIntervalMs, onError: (e) => onEvent({ kind: 'status', data: { level: 'warn', src: 'trade-watch', message: e?.message } }) }));
	unwatchers.push(watchGraduations(hood, (g) => { emitGraduation(g).catch(() => {}); }, { pollingInterval: config.pollingIntervalMs, onError: (e) => onEvent({ kind: 'status', data: { level: 'warn', src: 'grad-watch', message: e?.message } }) }));

	if (config.useFeed) {
		subscribeFeed(
			(msg) => { feedSeq = msg.sequenceNumber; feedTs = msg.timestamp; feedFramesAt = Date.now(); },
			{ url: config.feedUrl, onError: (e) => onEvent({ kind: 'status', data: { level: 'warn', src: 'feed', message: e?.message } }), onConnect: () => onEvent({ kind: 'status', data: { level: 'info', src: 'feed', message: 'connected' } }) },
		).then((sub) => { feedSub = sub; }).catch(() => {});
	}

	backfill();
	const gapTimer = setInterval(() => { gapCheck().catch(() => {}); }, 15_000);

	return {
		stop() {
			active = false;
			clearTimeout(resubTimer);
			clearInterval(gapTimer);
			for (const u of unwatchers) { try { u(); } catch { /* ignore */ } }
			try { swapUnwatch?.(); } catch { /* ignore */ }
			try { feedSub?.close(); } catch { /* ignore */ }
		},
		health() {
			return {
				network: config.network,
				chain_id: (config.network === 'testnet' ? 46630 : 4663),
				last_scanned_block: Number(lastScannedBlock),
				tracked_pools: pools.size,
				feed: {
					enabled: config.useFeed,
					last_sequence: feedSeq,
					last_l2_timestamp: feedTs,
					seconds_since_frame: feedFramesAt ? Math.round((Date.now() - feedFramesAt) / 1000) : null,
				},
			};
		},
	};
}
