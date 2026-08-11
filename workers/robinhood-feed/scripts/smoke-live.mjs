// Live end-to-end smoke: the real chain → the real decoders → the real server.
//
// `npm test` is deliberately offline (pure normalizer + retry classifier +
// HTTP/WS/SSE plumbing over committed on-chain fixtures). This script covers
// what only the live chain can prove: that the configured RPCs answer, that the
// SDK's launch/swap decoding still matches the deployed contracts, that ERC-20
// metadata and the ETH price resolve, that the sequencer feed delivers frames,
// and that everything survives the trip out through /recent and SSE.
//
//   npm run smoke:live
//
// It reads the chain only, no keys, no writes, no spend.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
	NOXA_ADDRESSES, noxaTokenLaunchedEvent, subscribeFeed,
} from 'hoodchain';

import { config, redactRpcUrl, CHAIN_ID } from '../src/config.js';
import { hood, probeRpcUrls, resolveMeta, inspectPool, blockTimeMs } from '../src/chain.js';
import { ethPriceUsd } from '../src/eth-price.js';
import { normalizeLaunch, normalizeUniswapSwap } from '../src/normalize.js';
import { createServer } from '../src/server.js';
import { withRpcRetry } from '../src/rpc.js';

const SCAN_STEP = 250_000n; // ~7h of chain time per request at the measured ~100ms/block
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

const step = (msg) => console.log(`\n── ${msg}`);
const ok = (msg) => console.log(`   ok · ${msg}`);

/**
 * Walk backward from the chain head until a window holds a NOXA launch. The
 * launchpads go quiet for long stretches, so "scan the last N blocks" is not a
 * reliable way to find real data; this always finds the newest one that exists.
 */
async function findNewestLaunch(head) {
	for (let to = head; to > NOXA_ADDRESSES.deployBlock; to -= SCAN_STEP) {
		const from = to - SCAN_STEP + 1n > NOXA_ADDRESSES.deployBlock ? to - SCAN_STEP + 1n : NOXA_ADDRESSES.deployBlock;
		const logs = await withRpcRetry(() => hood.public.getLogs({
			address: NOXA_ADDRESSES.launchFactory,
			event: noxaTokenLaunchedEvent,
			fromBlock: from,
			toBlock: to,
		}));
		if (logs.length) return logs[logs.length - 1];
	}
	return null;
}

async function main() {
	step(`RPC reachability (${config.network})`);
	const probes = await probeRpcUrls();
	for (const p of probes) console.log(`   ${p.ok ? 'ok  ' : 'DEAD'} · ${redactRpcUrl(p.url)} · ${p.ok ? `chain_id=${p.chain_id}` : p.error}`);
	assert.ok(probes.some((p) => p.ok), 'no configured RPC answered eth_chainId');

	const chainId = await withRpcRetry(() => hood.public.getChainId());
	assert.equal(chainId, CHAIN_ID, 'connected chain does not match the configured network');
	const head = await withRpcRetry(() => hood.public.getBlockNumber());
	ok(`chain ${chainId} · head ${head}`);

	step('newest real NOXA launch (decoded by the SDK against the live contract)');
	const launchLog = await findNewestLaunch(head);
	assert.ok(launchLog, 'no NOXA launch found in the entire chain history');
	const launch = {
		launchpad: 'noxa',
		token: launchLog.args.token,
		creator: launchLog.args.deployer,
		pool: launchLog.args.pool ?? null,
		blockNumber: launchLog.blockNumber,
		transactionHash: launchLog.transactionHash,
	};
	ok(`block ${launch.blockNumber} · tx ${launch.transactionHash}`);
	console.log(`   (head is ${head - launch.blockNumber} blocks newer, the launchpads idle for long stretches)`);

	step('metadata, block time and ETH price (real reads)');
	const [meta, atMs, ethUsd] = await Promise.all([
		resolveMeta(launch.token), blockTimeMs(launch.blockNumber), ethPriceUsd(),
	]);
	assert.ok(meta.symbol, 'ERC-20 symbol() did not resolve');
	assert.ok(Number.isFinite(atMs) && atMs > 0, 'block timestamp did not resolve');
	assert.ok(ethUsd > 0, 'ETH/USD price did not resolve from any source');
	ok(`symbol=${meta.symbol} · launched ${new Date(atMs).toISOString()} · ETH $${ethUsd.toFixed(2)}`);

	const launchEvent = normalizeLaunch({ launch, name: meta.name, symbol: meta.symbol, ethUsd, atMs });
	assert.equal(launchEvent.mint, launch.token);
	assert.equal(launchEvent.chain_id, CHAIN_ID);
	assert.equal(launchEvent.timestamp, Math.floor(atMs / 1000), 'launch must carry its block time, not now()');
	ok('normalized launch carries the block time, not wall clock');

	step('real Uniswap v3 swap on that launch pool');
	let tradeEvent = null;
	if (launch.pool) {
		const poolInfo = await inspectPool(launch.pool, launch.token);
		assert.ok(poolInfo, 'pool inspection failed (token0/token1 unreadable)');
		const to = launch.blockNumber + SCAN_STEP > head ? head : launch.blockNumber + SCAN_STEP;
		const swaps = await withRpcRetry(() => hood.public.getLogs({
			address: launch.pool, abi: [uniswapSwapEvent], eventName: 'Swap',
			fromBlock: launch.blockNumber, toBlock: to,
		}));
		if (swaps.length) {
			const swapLog = swaps[swaps.length - 1];
			const swapAtMs = await blockTimeMs(swapLog.blockNumber);
			tradeEvent = normalizeUniswapSwap({
				swap: {
					amount0: swapLog.args.amount0, amount1: swapLog.args.amount1,
					recipient: swapLog.args.recipient, sender: swapLog.args.sender,
					transactionHash: swapLog.transactionHash, blockNumber: swapLog.blockNumber,
				},
				token: launch.token, pool: launch.pool,
				coinIsToken0: poolInfo.coinIsToken0,
				quoteSymbol: poolInfo.quoteSymbol, quoteDecimals: poolInfo.quoteDecimals,
				name: meta.name, symbol: meta.symbol, ethUsd, atMs: swapAtMs,
			});
			assert.equal(typeof tradeEvent.is_buy, 'boolean');
			assert.ok(tradeEvent.sol_amount > 0, 'trade carries no native magnitude');
			assert.ok(Number.isFinite(tradeEvent.price_usd), 'trade price did not compute');
			ok(`${tradeEvent.tx_type} · ${tradeEvent.sol_amount} ${tradeEvent.quote_symbol} · $${tradeEvent.usd_amount?.toFixed(4)}`);
		} else {
			ok(`no swaps in the ${SCAN_STEP} blocks after launch, pool ${launch.pool} inspected clean`);
		}
	} else {
		ok('launch carries no pool (Odyssey curve coin), swap leg not applicable');
	}

	step('sequencer feed liveness');
	if (config.useFeed) {
		const frames = await new Promise((resolve) => {
			const seen = [];
			const timer = setTimeout(() => resolve(seen), 20_000);
			subscribeFeed((msg) => {
				seen.push(msg);
				if (seen.length >= 3) { clearTimeout(timer); resolve(seen); }
			}, { url: config.feedUrl }).then((sub) => {
				setTimeout(() => { try { sub.close(); } catch { /* ignore */ } }, 20_500).unref();
			}).catch(() => resolve(seen));
		});
		assert.ok(frames.length > 0, 'sequencer feed delivered no frames in 20s');
		ok(`${frames.length} frames · latest sequence ${frames[frames.length - 1].sequenceNumber}`);
	} else {
		ok('feed disabled by RH_USE_FEED=0');
	}

	step('serve the real events over /recent and SSE');
	const { server, onEvent, close } = createServer({
		health: () => ({ network: config.network, chain_id: CHAIN_ID, smoke: true }),
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const base = `http://127.0.0.1:${server.address().port}`;

	onEvent({ kind: 'launch', data: launchEvent });
	if (tradeEvent) onEvent({ kind: 'trade', data: tradeEvent });

	const health = await fetch(`${base}/healthz`).then((r) => r.json());
	assert.equal(health.ok, true);
	const recent = await fetch(`${base}/recent?limit=10`).then((r) => r.json());
	assert.ok(recent.events.some((e) => e.kind === 'launch' && e.data.mint === launch.token), '/recent lost the launch');
	if (tradeEvent) assert.ok(recent.events.some((e) => e.kind === 'trade'), '/recent lost the trade');
	ok(`/healthz ok · /recent returned ${recent.events.length} real events`);

	const controller = new AbortController();
	const res = await fetch(`${base}/events`, { signal: controller.signal });
	const reader = res.body.getReader();
	const first = new TextDecoder().decode((await reader.read()).value);
	assert.match(first, /"replay":true/, 'SSE did not replay the buffer');
	controller.abort();
	ok('SSE replayed the buffer to a fresh subscriber');

	await close();
	console.log('\nPASS · robinhood-feed live smoke');
}

main().then(() => process.exit(0), (err) => {
	console.error('\nFAIL · robinhood-feed live smoke');
	console.error(err);
	process.exit(1);
});
