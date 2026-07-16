/**
 * status-core.js: shared, dependency-free status logic for hood-status.
 *
 * This single module is imported by BOTH the probe worker (Node) and the
 * static front end (browser, direct-probe mode), so the published thresholds
 * on the methodology page are literally the code that runs everywhere.
 *
 * Everything here is pure: no I/O, no globals, no timers.
 */

(function () {
/** Component status levels, worst to best. */
const LEVELS = ['down', 'degraded', 'unknown', 'operational'];

const RANK = { down: 0, degraded: 1, unknown: 2, operational: 3 };

/** Worst status wins for the overall banner. */
function worstStatus(statuses) {
  let worst = 'operational';
  let sawKnown = false;
  for (const s of statuses) {
    if (s === 'unknown') continue;
    sawKnown = true;
    if (RANK[s] < RANK[worst]) worst = s;
  }
  if (!sawKnown) return 'unknown';
  return worst;
}

/**
 * Published threshold rules. These numbers ARE the methodology page.
 * Change them here and the worker, the browser fallback, and the docs all
 * follow.
 */
const THRESHOLDS = {
  rpc: {
    timeoutMs: 8000,
    degradedLatencyMs: 1500, // median over the evaluation window
    windowSamples: 10, // ~5 minutes at a 30s cadence
  },
  blocks: {
    // Robinhood Chain targets ~100ms blocks and normally produces hundreds
    // of blocks per minute. Arbitrum-lineage chains only mint blocks when
    // there is activity, so a brief lull is possible in principle; on this
    // chain sustained silence means the sequencer is not sequencing.
    degradedHeadAgeSec: 120,
    downHeadAgeSec: 300,
    degradedBlocksPerMin: 1, // below this = degraded (if head is also stale)
  },
  feed: {
    // Sequencer feed: a healthy feed delivers messages continuously while
    // the chain produces blocks.
    degradedLagBlocks: 50, // feed sequence number behind RPC head
    staleSilenceSec: 60, // no message for this long while head advanced
  },
  settlement: {
    // The chain's view of Ethereum L1 (block.l1BlockNumber) normally trails
    // the real L1 head by 0-2 blocks. A growing gap means the sequencer has
    // stopped ingesting parent-chain blocks; deposits stall first.
    degradedLagL1Blocks: 50, // ~10 minutes of L1 blocks
    downLagL1Blocks: 300, // ~1 hour
  },
  blockscout: {
    timeoutMs: 10000,
    // Explorer is not consensus-critical: it can be degraded, never "down"
    // for the chain overall.
    maxSeverity: 'degraded',
  },
  chainlink: {
    // Stock Token feeds update during US market hours. Outside market hours
    // staleness is EXPECTED and reported as informational, never an
    // incident. During market hours a feed older than this is degraded.
    degradedAgeSecMarketOpen: 1800, // 30 minutes
    // No exchange-holiday calendar is bundled: on a US market holiday the
    // feeds legitimately idle during "market hours". To stay honest rather
    // than noisy, Chainlink freshness is capped at "degraded" and the
    // methodology page documents the holiday caveat.
    maxSeverity: 'degraded',
  },
  incident: {
    openAfter: 3, // consecutive bad evaluations before an incident opens
    closeAfter: 4, // consecutive good evaluations before it closes
    unknownAfter: 2, // consecutive missing probes before publishing unknown
  },
};

/**
 * US equity market hours (NYSE/Nasdaq regular session, 09:30-16:00 ET),
 * DST-correct via the IANA timezone database. Weekends are closed. Exchange
 * holidays are NOT modeled (documented limitation).
 */
function isUsMarketOpen(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hour = Number(get('hour')) % 24; // Intl may emit "24" for midnight
  const minute = Number(get('minute'));
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Evaluate one probe cycle's result for a component into a status.
 * Each evaluator takes the latest probe observation (already parsed) and
 * returns { status, reason }. `null`/missing observation => unknown.
 */
const evaluators = {
  /**
   * @param {{ ok: boolean, latencyMs: number|null, recentLatencies?: number[] }} obs
   */
  rpc(obs) {
    if (!obs) return { status: 'unknown', reason: 'no probe data' };
    if (!obs.ok) return { status: 'down', reason: obs.error || 'RPC request failed' };
    const window = obs.recentLatencies?.length ? obs.recentLatencies : [obs.latencyMs];
    const med = median(window.filter((v) => Number.isFinite(v)));
    if (med !== null && med > THRESHOLDS.rpc.degradedLatencyMs) {
      return {
        status: 'degraded',
        reason: `median latency ${Math.round(med)}ms > ${THRESHOLDS.rpc.degradedLatencyMs}ms`,
      };
    }
    return { status: 'operational', reason: null };
  },

  /**
   * @param {{ ok: boolean, headAgeSec: number|null, blocksPerMin: number|null }} obs
   */
  blocks(obs) {
    if (!obs || !obs.ok || !Number.isFinite(obs.headAgeSec)) {
      return { status: 'unknown', reason: 'head not observable' };
    }
    const t = THRESHOLDS.blocks;
    if (obs.headAgeSec >= t.downHeadAgeSec) {
      return {
        status: 'down',
        reason: `no new block for ${Math.round(obs.headAgeSec)}s (threshold ${t.downHeadAgeSec}s)`,
      };
    }
    if (obs.headAgeSec >= t.degradedHeadAgeSec) {
      return {
        status: 'degraded',
        reason: `latest block is ${Math.round(obs.headAgeSec)}s old (threshold ${t.degradedHeadAgeSec}s)`,
      };
    }
    if (
      Number.isFinite(obs.blocksPerMin) &&
      obs.blocksPerMin < t.degradedBlocksPerMin &&
      obs.headAgeSec > 60
    ) {
      return {
        status: 'degraded',
        reason: `block production ${obs.blocksPerMin.toFixed(1)}/min with a ${Math.round(obs.headAgeSec)}s-old head`,
      };
    }
    return { status: 'operational', reason: null };
  },

  /**
   * @param {{ connected: boolean, silenceSec: number|null, lagBlocks: number|null, headAdvancing: boolean }} obs
   */
  feed(obs) {
    if (!obs) return { status: 'unknown', reason: 'no probe data' };
    if (!obs.connected) {
      return { status: 'down', reason: obs.error || 'sequencer feed not connected' };
    }
    const t = THRESHOLDS.feed;
    if (
      Number.isFinite(obs.silenceSec) &&
      obs.silenceSec > t.staleSilenceSec &&
      obs.headAdvancing
    ) {
      return {
        status: 'degraded',
        reason: `connected but silent for ${Math.round(obs.silenceSec)}s while the chain head advanced`,
      };
    }
    if (Number.isFinite(obs.lagBlocks) && obs.lagBlocks > t.degradedLagBlocks) {
      return {
        status: 'degraded',
        reason: `feed is ${obs.lagBlocks} blocks behind the RPC head (threshold ${t.degradedLagBlocks})`,
      };
    }
    return { status: 'operational', reason: null };
  },

  /**
   * @param {{ ok: boolean, lagL1Blocks: number|null }} obs
   */
  settlement(obs) {
    if (!obs || !obs.ok || !Number.isFinite(obs.lagL1Blocks)) {
      return { status: 'unknown', reason: 'parent-chain head not observable' };
    }
    const t = THRESHOLDS.settlement;
    if (obs.lagL1Blocks >= t.downLagL1Blocks) {
      return {
        status: 'down',
        reason: `chain's L1 view is ${obs.lagL1Blocks} Ethereum blocks behind (threshold ${t.downLagL1Blocks})`,
      };
    }
    if (obs.lagL1Blocks >= t.degradedLagL1Blocks) {
      return {
        status: 'degraded',
        reason: `chain's L1 view is ${obs.lagL1Blocks} Ethereum blocks behind (threshold ${t.degradedLagL1Blocks})`,
      };
    }
    return { status: 'operational', reason: null };
  },

  /**
   * @param {{ ok: boolean, latencyMs: number|null }} obs
   */
  blockscout(obs) {
    if (!obs) return { status: 'unknown', reason: 'no probe data' };
    if (!obs.ok) {
      return { status: 'degraded', reason: obs.error || 'explorer API unreachable' };
    }
    return { status: 'operational', reason: null };
  },

  /**
   * @param {{ ok: boolean, maxAgeSec: number|null, marketOpen: boolean, staleFeeds?: string[] }} obs
   */
  chainlink(obs) {
    if (!obs || !obs.ok || !Number.isFinite(obs.maxAgeSec)) {
      return { status: 'unknown', reason: 'feed reads failed' };
    }
    const t = THRESHOLDS.chainlink;
    if (!obs.marketOpen) {
      // Expected staleness: US market closed. Informational, always green.
      return { status: 'operational', reason: null };
    }
    if (obs.maxAgeSec > t.degradedAgeSecMarketOpen) {
      const which = obs.staleFeeds?.length ? ` (${obs.staleFeeds.join(', ')})` : '';
      return {
        status: 'degraded',
        reason: `stalest feed is ${Math.round(obs.maxAgeSec / 60)}min old during market hours${which}`,
      };
    }
    return { status: 'operational', reason: null };
  },
};

/**
 * Incident state machine with flap suppression.
 *
 * One instance per component. Raw evaluations stream in via step(); the
 * machine publishes a debounced status and emits open/close/severity events
 * that the caller persists.
 *
 * Rules (see THRESHOLDS.incident):
 * - A bad status (degraded/down) must persist `openAfter` consecutive steps
 *   before it is published and an incident opens.
 * - Recovery must persist `closeAfter` consecutive steps before the
 *   incident closes.
 * - `unknown` publishes after `unknownAfter` consecutive steps but never
 *   opens an incident; an open incident stays open through unknown gaps.
 * - Severity escalation inside an open incident (degraded -> down) applies
 *   after `openAfter` consecutive steps at the worse level; de-escalation
 *   likewise.
 */
class IncidentMachine {
  constructor({ published = 'operational', opts = THRESHOLDS.incident } = {}) {
    this.published = published;
    this.opts = opts;
    this.candidate = null;
    this.candidateCount = 0;
  }

  /**
   * @param {'operational'|'degraded'|'down'|'unknown'} status raw evaluation
   * @param {string|null} reason
   * @param {number} t epoch ms
   * @returns {{ published: string, event: null | { type: 'open'|'close'|'severity', severity?: string, reason?: string|null, t: number } }}
   */
  step(status, reason, t) {
    if (status === this.published) {
      this.candidate = null;
      this.candidateCount = 0;
      return { published: this.published, event: null };
    }
    if (status === this.candidate) {
      this.candidateCount += 1;
    } else {
      this.candidate = status;
      this.candidateCount = 1;
    }

    const needed = this.#needed(status);
    if (this.candidateCount < needed) {
      return { published: this.published, event: null };
    }

    const prev = this.published;
    this.published = status;
    this.candidate = null;
    this.candidateCount = 0;

    const wasIncident = prev === 'degraded' || prev === 'down';
    const isIncident = status === 'degraded' || status === 'down';

    let event = null;
    if (!wasIncident && isIncident) {
      event = { type: 'open', severity: status, reason, t };
    } else if (wasIncident && status === 'operational') {
      event = { type: 'close', t };
    } else if (wasIncident && isIncident && prev !== status) {
      event = { type: 'severity', severity: status, reason, t };
    }
    // unknown transitions publish but never touch incidents.
    return { published: this.published, event };
  }

  #needed(status) {
    const o = this.opts;
    if (status === 'unknown') return o.unknownAfter;
    if (status === 'operational') return this.published === 'unknown' ? 1 : o.closeAfter;
    return o.openAfter; // degraded or down, including severity changes
  }
}

/** Component registry: id, display name, which metric drives its uptime. */
const COMPONENTS = [
  { id: 'rpc_public', name: 'Public RPC', metric: 'rpc_public', evaluator: 'rpc', core: true },
  { id: 'rpc_alchemy', name: 'Alchemy RPC', metric: 'rpc_alchemy', evaluator: 'rpc', core: false, optional: true },
  { id: 'blocks', name: 'Block production', metric: 'block_height', evaluator: 'blocks', core: true },
  { id: 'feed', name: 'Sequencer feed', metric: 'feed', evaluator: 'feed', core: true },
  { id: 'settlement', name: 'Settlement (L1 view)', metric: 'settlement_lag', evaluator: 'settlement', core: true },
  { id: 'blockscout', name: 'Blockscout explorer', metric: 'blockscout', evaluator: 'blockscout', core: false },
  { id: 'chainlink', name: 'Chainlink stock feeds', metric: 'chainlink', evaluator: 'chainlink', core: false },
];

/** Human labels for the banner. */
const STATUS_LABELS = {
  operational: 'All systems operational',
  degraded: 'Degraded performance',
  down: 'Major outage',
  unknown: 'Status unknown',
};

/** Clamp a status to a component's maximum severity (explorer, chainlink). */
function clampSeverity(status, maxSeverity) {
  if (!maxSeverity) return status;
  if (status === 'down' && maxSeverity === 'degraded') return 'degraded';
  return status;
}

/**
 * Universal exposure: this file is a CLASSIC script (no import/export) so it
 * loads from file:// in any browser, and Node imports it for its side effect:
 *   import '../../docs/assets/status-core.js'
 *   const { evaluators } = globalThis.StatusCore
 */
globalThis.StatusCore = {
  LEVELS,
  worstStatus,
  THRESHOLDS,
  isUsMarketOpen,
  evaluators,
  IncidentMachine,
  COMPONENTS,
  STATUS_LABELS,
  clampSeverity,
};
})();
