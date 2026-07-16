import { rpcCall, hexToNumber, word, decodeInt256 } from './rpc.js';
import '../../docs/assets/status-core.js';

const { isUsMarketOpen } = globalThis.StatusCore;

const LATEST_ROUND_DATA = '0xfeaf968c'; // latestRoundData()

/**
 * One probe cycle. Fires all independent probes in parallel, derives the
 * per-component observations that status-core evaluators consume, and
 * returns them together with the samples to persist.
 *
 * `state` carries cross-cycle memory (previous head, latency windows).
 */
export async function runProbeCycle({ config, feedWatcher, state, includeChainlink }) {
  const now = Date.now();

  const [publicRpc, alchemyRpc, latestBlock, feeHistory, blockscout, l1Head, chainlink] =
    await Promise.all([
      probeRpc(config.rpcUrl),
      config.alchemyUrl ? probeRpc(config.alchemyUrl) : Promise.resolve(null),
      rpcCall(config.rpcUrl, 'eth_getBlockByNumber', ['latest', false]),
      rpcCall(config.rpcUrl, 'eth_feeHistory', ['0x80', 'latest', []]),
      probeBlockscout(config.blockscoutUrl),
      rpcCall(config.l1RpcUrl, 'eth_blockNumber', [], 10_000),
      includeChainlink ? probeChainlink(config) : Promise.resolve(undefined),
    ]);

  // --- RPC latency windows (median over ~5 min drives the degraded rule) ---
  const observations = {};
  observations.rpc_public = withLatencyWindow(state, 'rpc_public', publicRpc);
  if (alchemyRpc) {
    observations.rpc_alchemy = withLatencyWindow(state, 'rpc_alchemy', alchemyRpc);
  }

  // --- Block production ---
  let blocksObs = { ok: false, headAgeSec: null, blocksPerMin: null };
  let head = null;
  let headAgeSec = null;
  if (latestBlock.ok && latestBlock.result) {
    head = hexToNumber(latestBlock.result.number);
    const headTs = hexToNumber(latestBlock.result.timestamp);
    headAgeSec = Math.max(0, now / 1000 - headTs);
    let blocksPerMin = null;
    if (state.prevHead && head >= state.prevHead.height && now > state.prevHead.t) {
      blocksPerMin = ((head - state.prevHead.height) / (now - state.prevHead.t)) * 60_000;
    }
    blocksObs = {
      ok: true,
      headAgeSec,
      blocksPerMin,
      height: head,
      l1BlockNumber: hexToNumber(latestBlock.result.l1BlockNumber),
      baseFeeWei: hexToNumber(latestBlock.result.baseFeePerGas),
    };
  }
  observations.blocks = blocksObs;
  const headAdvancing = head !== null && state.prevHead ? head > state.prevHead.height : true;
  if (head !== null) state.prevHead = { height: head, t: now };

  // --- Sequencer feed ---
  observations.feed = feedWatcher.snapshot(head, headAdvancing, now);

  // --- Settlement: the chain's view of Ethereum vs the real Ethereum head ---
  let settlementObs = { ok: false, lagL1Blocks: null };
  if (l1Head.ok && blocksObs.ok && Number.isFinite(blocksObs.l1BlockNumber)) {
    const realL1 = hexToNumber(l1Head.result);
    settlementObs = {
      ok: true,
      lagL1Blocks: Math.max(0, realL1 - blocksObs.l1BlockNumber),
      chainL1View: blocksObs.l1BlockNumber,
      l1Head: realL1,
    };
  } else if (!l1Head.ok) {
    settlementObs.error = l1Head.error;
  }
  observations.settlement = settlementObs;

  // --- Blockscout ---
  observations.blockscout = blockscout;

  // --- Gas (informational: no incidents, methodology documents this) ---
  let gasObs = null;
  if (feeHistory.ok && Array.isArray(feeHistory.result?.baseFeePerGas)) {
    const fees = feeHistory.result.baseFeePerGas.map((h) => hexToNumber(h) / 1e9);
    const sorted = [...fees].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    gasObs = {
      ok: true,
      currentGwei: fees[fees.length - 1],
      p50Gwei: pct(50),
      p95Gwei: pct(95),
      blocks: fees.length,
    };
  }
  observations.gas = gasObs;

  // --- Chainlink Stock Token feed freshness (sampled every 5 min) ---
  if (chainlink !== undefined) observations.chainlink = chainlink;

  // --- Samples to persist ---
  const samples = [];
  samples.push([
    'rpc_public',
    now,
    publicRpc.ok,
    round1(publicRpc.latencyMs),
    { block: publicRpc.block, error: publicRpc.error },
  ]);
  if (alchemyRpc) {
    samples.push([
      'rpc_alchemy',
      now,
      alchemyRpc.ok,
      round1(alchemyRpc.latencyMs),
      { block: alchemyRpc.block, error: alchemyRpc.error },
    ]);
  }
  samples.push([
    'block_height',
    now,
    blocksObs.ok && headAgeSec !== null && headAgeSec < 300,
    blocksObs.height ?? null,
    {
      headAgeSec: round1(blocksObs.headAgeSec),
      blocksPerMin: round1(blocksObs.blocksPerMin),
    },
  ]);
  if (Number.isFinite(blocksObs.blocksPerMin)) {
    samples.push(['blocks_per_min', now, true, round1(blocksObs.blocksPerMin), null]);
  }
  const feedOk =
    observations.feed.connected &&
    !(observations.feed.silenceSec > 60 && headAdvancing) &&
    !(observations.feed.lagBlocks > 50);
  samples.push([
    'feed',
    now,
    feedOk,
    observations.feed.messagesPerMin,
    {
      lagBlocks: observations.feed.lagBlocks,
      connected: observations.feed.connected,
      silenceSec: round1(observations.feed.silenceSec),
    },
  ]);
  samples.push([
    'settlement_lag',
    now,
    settlementObs.ok,
    settlementObs.lagL1Blocks,
    settlementObs.ok
      ? { chainL1View: settlementObs.chainL1View, l1Head: settlementObs.l1Head }
      : { error: settlementObs.error },
  ]);
  samples.push([
    'blockscout',
    now,
    blockscout.ok,
    round1(blockscout.latencyMs),
    blockscout.error ? { error: blockscout.error } : null,
  ]);
  if (gasObs) {
    samples.push([
      'gas_basefee',
      now,
      true,
      round3(gasObs.currentGwei),
      { p50Gwei: round3(gasObs.p50Gwei), p95Gwei: round3(gasObs.p95Gwei) },
    ]);
  }
  if (chainlink !== undefined && chainlink !== null) {
    samples.push([
      'chainlink',
      now,
      chainlink.ok,
      chainlink.maxAgeSec !== null ? Math.round(chainlink.maxAgeSec) : null,
      { feeds: chainlink.feeds, marketOpen: chainlink.marketOpen, error: chainlink.error },
    ]);
  }

  return { observations, samples, now };
}

function withLatencyWindow(state, key, probe) {
  state.latencyWindows ??= {};
  const win = (state.latencyWindows[key] ??= []);
  if (probe.ok) {
    win.push(probe.latencyMs);
    if (win.length > 10) win.shift();
  }
  return { ...probe, recentLatencies: [...win] };
}

async function probeRpc(url) {
  const res = await rpcCall(url, 'eth_blockNumber');
  if (!res.ok) return { ok: false, error: res.error, latencyMs: res.latencyMs, block: null };
  return { ok: true, latencyMs: res.latencyMs, block: hexToNumber(res.result) };
}

async function probeBlockscout(baseUrl) {
  const started = performance.now();
  try {
    const res = await fetch(`${baseUrl}/api/v2/stats`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' },
    });
    const latencyMs = performance.now() - started;
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, latencyMs };
    const body = await res.json();
    return {
      ok: true,
      latencyMs,
      totalBlocks: Number(body.total_blocks) || null,
      averageBlockTimeMs: Number(body.average_block_time) || null,
    };
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'timeout after 10000ms' : err.message;
    return { ok: false, error: msg, latencyMs: performance.now() - started };
  }
}

async function probeChainlink(config) {
  const now = Date.now();
  const marketOpen = isUsMarketOpen(new Date(now));
  const results = await Promise.all(
    config.chainlinkFeeds.map(async (feed) => {
      const res = await rpcCall(config.rpcUrl, 'eth_call', [
        { to: feed.address, data: LATEST_ROUND_DATA },
        'latest',
      ]);
      if (!res.ok || typeof res.result !== 'string' || res.result.length < 2 + 5 * 64) {
        return { symbol: feed.symbol, ok: false, error: res.error || 'short return data' };
      }
      // latestRoundData() -> (roundId, answer, startedAt, updatedAt, answeredInRound)
      const answer = decodeInt256(word(res.result, 1));
      const updatedAt = Number(BigInt(word(res.result, 3)));
      return {
        symbol: feed.symbol,
        ok: true,
        price: Number(answer) / 1e8,
        updatedAt,
        ageSec: Math.max(0, now / 1000 - updatedAt),
      };
    })
  );
  const okFeeds = results.filter((r) => r.ok);
  if (okFeeds.length === 0) {
    return { ok: false, maxAgeSec: null, marketOpen, feeds: results, error: results[0]?.error };
  }
  const maxAgeSec = Math.max(...okFeeds.map((r) => r.ageSec));
  const staleFeeds = okFeeds.filter((r) => r.ageSec > 1800).map((r) => r.symbol);
  return { ok: true, maxAgeSec, marketOpen, staleFeeds, feeds: results };
}

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const round3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
