/**
 * hood-status front end.
 *
 * Two data paths, one page:
 *  - worker mode: reads /api/status + /api/history from the probe worker
 *    (90-day uptime bars, sparklines, incident history).
 *  - direct-probe mode: if no worker is configured or it is unreachable,
 *    the browser probes the chain itself (RPC, sequencer feed, Blockscout,
 *    Chainlink feeds, L1 view) using the exact same threshold rules from
 *    status-core.js. Live health without any backend.
 */
/* global StatusCore */
const { evaluators, clampSeverity, worstStatus, STATUS_LABELS, THRESHOLDS, isUsMarketOpen } =
  window.StatusCore;

const CFG = window.HOOD_STATUS_CONFIG;
const qs = new URLSearchParams(location.search);
const WORKER_URL = (
  qs.get('worker') ??
  localStorage.getItem('hood-status:worker') ??
  CFG.workerUrl ??
  ''
).replace(/\/$/, '');

const $ = (id) => document.getElementById(id);
const fmtInt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '?');
const fmt1 = (n) => (Number.isFinite(n) ? (Math.round(n * 10) / 10).toLocaleString('en-US') : '?');

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function duration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 6) / 10;
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// ---------------------------------------------------------------- theme

$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('hood-status:theme', next);
});

// ------------------------------------------------- live feed ticker (both modes)

const feedState = {
  connected: false,
  lastMessageAt: null,
  lastSeq: null,
  messageTimes: [],
  seqSamples: [], // rolling {t, seq} for feed-derived blocks/min
  error: null,
};

/** Blocks/min derived from feed sequence numbers (needs >= 10s of data). */
function feedBpm() {
  const s = feedState.seqSamples;
  if (s.length < 2) return null;
  const dt = s[s.length - 1].t - s[0].t;
  if (dt < 10_000) return null;
  return ((s[s.length - 1].seq - s[0].seq) / dt) * 60_000;
}

function connectFeed() {
  let ws;
  try {
    ws = new WebSocket(CFG.feedUrl);
  } catch (err) {
    feedState.error = err.message;
    setTimeout(connectFeed, 5000);
    return;
  }
  ws.onopen = () => {
    feedState.connected = true;
    feedState.error = null;
  };
  ws.onmessage = (ev) => {
    const now = Date.now();
    feedState.lastMessageAt = now;
    feedState.messageTimes.push(now);
    while (feedState.messageTimes.length && feedState.messageTimes[0] < now - 60000) {
      feedState.messageTimes.shift();
    }
    try {
      const frame = JSON.parse(ev.data);
      const msgs = frame?.messages;
      if (Array.isArray(msgs) && msgs.length) {
        const seq = msgs[msgs.length - 1].sequenceNumber;
        if (Number.isFinite(seq)) {
          feedState.lastSeq = seq;
          feedState.seqSamples.push({ t: now, seq });
          while (feedState.seqSamples.length && feedState.seqSamples[0].t < now - 120_000) {
            feedState.seqSamples.shift();
          }
          $('stat-height').classList.remove('skeleton');
          $('stat-height').textContent = fmtInt(seq);
          $('stat-height-hint').textContent = 'live from sequencer feed';
        }
      }
    } catch {
      /* keepalive frame */
    }
  };
  ws.onerror = () => {
    feedState.error = 'websocket error';
  };
  ws.onclose = () => {
    feedState.connected = false;
    setTimeout(connectFeed, 5000);
  };
}
connectFeed();

// ---------------------------------------------------------------- rpc helpers

let rpcId = 1;
async function rpc(url, method, params = [], timeoutMs = 8000) {
  const started = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const latencyMs = performance.now() - started;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${body.error.code}: ${body.error.message}`);
  return { result: body.result, latencyMs };
}
const hexNum = (h) => (typeof h === 'string' ? parseInt(h, 16) : NaN);

// ---------------------------------------------------------------- rendering

function setBanner(status, subText, mode) {
  const banner = $('banner');
  banner.className = `banner s-${status}`;
  $('banner-title').textContent = STATUS_LABELS[status] ?? 'Status unknown';
  $('banner-sub').textContent = subText;
  const pill = $('mode-pill');
  if (mode === 'direct') {
    pill.textContent = 'direct probe mode';
    pill.className = 'mode-pill direct';
    pill.title =
      'The probe worker is unreachable, so this page is probing the chain directly from your browser using the same published thresholds.';
  } else {
    pill.textContent = 'live';
    pill.className = 'mode-pill';
    pill.title = 'Served by the hood-status probe worker.';
  }
}

function statusChip(status) {
  const chip = el('span', `status-chip s-${status}`);
  chip.textContent = status;
  return chip;
}

function uptimeBars(days) {
  const wrap = el('div', 'uptime-bars');
  wrap.setAttribute('role', 'img');
  const known = days.filter((d) => d.uptime !== null);
  wrap.setAttribute(
    'aria-label',
    known.length
      ? `90-day uptime, ${known.length} days of data`
      : '90-day uptime, no data collected yet'
  );
  for (const d of days) {
    const bar = el('span', 'bar');
    if (d.uptime === null) {
      bar.title = `${d.date}: no data`;
    } else {
      bar.className = `bar ${d.uptime >= 99.5 ? 'u-ok' : d.uptime >= 97 ? 'u-warn' : 'u-bad'}`;
      bar.title = `${d.date}: ${d.uptime}% (${d.samples} probes)`;
    }
    wrap.appendChild(bar);
  }
  return wrap;
}

function sparkline(buckets) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('viewBox', '0 0 400 36');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const pts = buckets.filter((b) => b.avg !== null);
  if (pts.length < 2) return svg;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const vmax = Math.max(...pts.map((p) => p.avg)) || 1;
  const vmin = Math.min(...pts.map((p) => p.avg));
  const span = vmax - vmin || 1;
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * 396 + 2;
  const y = (v) => 32 - ((v - vmin) / span) * 26;
  let d = '';
  for (const p of pts) d += `${d ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.avg).toFixed(1)}`;
  const area = document.createElementNS(ns, 'path');
  area.setAttribute('class', 'area');
  area.setAttribute('d', `${d}L${x(t1).toFixed(1)},34L${x(t0).toFixed(1)},34Z`);
  const line = document.createElementNS(ns, 'path');
  line.setAttribute('class', 'line');
  line.setAttribute('d', d);
  svg.appendChild(area);
  svg.appendChild(line);
  return svg;
}

function metricSummary(id, m) {
  if (!m) return '';
  switch (id) {
    case 'rpc_public':
    case 'rpc_alchemy':
      return m.latencyMs !== null ? `${fmt1(m.latencyMs)} ms` : '';
    case 'blocks':
      return `${fmt1(m.blocksPerMin)}/min · head ${fmt1(m.headAgeSec)}s old`;
    case 'feed':
      return m.connected
        ? `${fmtInt(m.messagesPerMin)} msg/min · lag ${m.lagBlocks ?? '?'} blocks`
        : 'disconnected';
    case 'settlement':
      return m ? `L1 view lag ${m.lagL1Blocks} blocks` : '';
    case 'blockscout':
      return m.latencyMs !== null ? `${fmt1(m.latencyMs)} ms` : '';
    case 'chainlink':
      return m.marketOpen === null
        ? ''
        : m.marketOpen
          ? `market open · stalest ${fmt1((m.maxAgeSec ?? 0) / 60)}m`
          : 'US market closed · staleness expected';
    default:
      return '';
  }
}

const SPARK_METRIC = {
  rpc_public: 'rpc_public',
  rpc_alchemy: 'rpc_alchemy',
  blocks: 'blocks_per_min',
  feed: 'feed',
  settlement: 'settlement_lag',
  blockscout: 'blockscout',
  chainlink: 'chainlink',
};

function renderComponents(components, { withHistory }) {
  const root = $('components');
  root.replaceChildren();
  for (const c of components) {
    const row = el('div', 'component');
    const head = el('div', 'row');
    head.appendChild(el('span', 'name', c.name));
    const current = metricSummary(c.id, c.metrics);
    if (current) head.appendChild(el('span', 'current', current));
    head.appendChild(el('span', 'spacer'));
    if (withHistory && c.uptimePct90d !== null && c.uptimePct90d !== undefined) {
      head.appendChild(el('span', 'current', `${c.uptimePct90d}% uptime`));
    }
    head.appendChild(statusChip(c.status));
    row.appendChild(head);
    if (c.reason && c.status !== 'operational') {
      row.appendChild(el('div', 'reason', c.reason));
    }
    if (withHistory && c.uptime90d) {
      row.appendChild(uptimeBars(c.uptime90d));
      const meta = el('div', 'uptime-meta');
      meta.appendChild(el('span', null, '90 days ago'));
      meta.appendChild(el('span', null, 'today'));
      row.appendChild(meta);
      const sparkHost = el('div');
      sparkHost.dataset.spark = SPARK_METRIC[c.id] ?? '';
      row.appendChild(sparkHost);
    }
    root.appendChild(row);
  }
}

function renderChainlink(metrics) {
  const section = $('chainlink-section');
  if (!metrics || !metrics.feeds?.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $('chainlink-aside').textContent = metrics.marketOpen
    ? 'US market open'
    : 'US market closed, prices from last session';
  const grid = $('feeds-grid');
  grid.replaceChildren();
  for (const f of metrics.feeds) {
    const tile = el('div', 'feed-tile');
    tile.appendChild(el('div', 'sym', f.symbol));
    tile.appendChild(
      el('div', 'px', `$${f.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
    );
    tile.appendChild(el('div', 'age', `updated ${duration(f.ageSec * 1000)} ago`));
    grid.appendChild(tile);
  }
}

function renderIncidents(incidents, mode) {
  const root = $('incidents');
  root.replaceChildren();
  if (mode === 'direct') {
    const n = el('div', 'notice');
    n.innerHTML =
      '<strong>Incident history lives on the probe worker.</strong> This page is in direct probe mode, so only live health is shown. Once the worker is reachable again the 90-day incident log returns.';
    root.appendChild(n);
    $('incidents-aside').textContent = '';
    return;
  }
  const all = [
    ...incidents.open.map((i) => ({ ...i, isOpen: true })),
    ...incidents.recent.filter((i) => i.endedAt !== null),
  ];
  $('incidents-aside').textContent = `${incidents.open.length} open`;
  if (all.length === 0) {
    const n = el('div', 'notice');
    n.innerHTML =
      '<strong>No incidents recorded.</strong> Every probe cycle since this worker started has been within thresholds. Incidents appear here the moment the state machine opens one.';
    root.appendChild(n);
    return;
  }
  for (const i of all.slice(0, 25)) {
    const card = el('div', `incident${i.isOpen ? ' open' : ''}`);
    const row = el('div', 'row');
    row.appendChild(statusChip(i.isOpen ? i.severity : 'operational'));
    row.appendChild(el('span', 'component-name', i.component));
    const when = i.isOpen
      ? `started ${ago(i.startedAt)} · ongoing`
      : `${ago(i.startedAt)} · lasted ${duration(i.endedAt - i.startedAt)}`;
    row.appendChild(el('span', 'when', when));
    card.appendChild(row);
    if (i.reason) card.appendChild(el('div', 'reason', i.reason));
    root.appendChild(card);
  }
}

function renderStrip({ height, bpm, rpcMs, rpcSource, gas }) {
  if (Number.isFinite(height) && !feedState.connected) {
    $('stat-height').classList.remove('skeleton');
    $('stat-height').textContent = fmtInt(height);
    $('stat-height-hint').textContent = 'from RPC (feed reconnecting)';
  } else if (feedState.connected) {
    $('stat-height-hint').textContent = 'live from sequencer feed';
  }
  const bpmEl = $('stat-bpm');
  bpmEl.replaceChildren();
  bpmEl.append(fmt1(bpm) ?? '?');
  const rpcEl = $('stat-rpc');
  rpcEl.replaceChildren();
  rpcEl.append(String(Math.round(rpcMs ?? NaN) || '?'), ' ');
  rpcEl.appendChild(el('span', 'unit', 'ms'));
  if (rpcSource) $('stat-rpc-hint').textContent = rpcSource;
  const gasEl = $('stat-gas');
  gasEl.replaceChildren();
  gasEl.append(gas?.currentGwei !== undefined ? fmtGwei(gas.currentGwei) : '?', ' ');
  gasEl.appendChild(el('span', 'unit', 'gwei'));
  if (gas?.p50Gwei !== undefined) {
    $('stat-gas-hint').textContent = `p50 ${fmtGwei(gas.p50Gwei)} · p95 ${fmtGwei(gas.p95Gwei)} (last 128 blocks)`;
  }
}

const fmtGwei = (v) => (Number.isFinite(v) ? (v >= 10 ? v.toFixed(1) : v.toPrecision(2)) : '?');

// ---------------------------------------------------------------- worker mode

async function fetchWorkerStatus() {
  const res = await fetch(`${WORKER_URL}/api/status`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`worker HTTP ${res.status}`);
  return res.json();
}

async function hydrateSparklines() {
  const hosts = document.querySelectorAll('[data-spark]');
  await Promise.all(
    [...hosts].map(async (host) => {
      const metric = host.dataset.spark;
      if (!metric) return;
      try {
        const res = await fetch(
          `${WORKER_URL}/api/history?metric=${encodeURIComponent(metric)}&window=24h`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (!res.ok) return;
        const h = await res.json();
        if (h.buckets?.length >= 2) host.replaceChildren(sparkline(h.buckets));
      } catch {
        /* sparkline is progressive enhancement */
      }
    })
  );
}

function renderWorkerStatus(s) {
  const openCount = s.incidents.open.length;
  const collectedFor = Date.now() - s.meta.workerStartedAt;
  setBanner(
    s.overall.status,
    openCount
      ? `${openCount} open incident${openCount > 1 ? 's' : ''} · updated ${ago(s.generatedAt)}`
      : `updated ${ago(s.generatedAt)} · probing every ${Math.round(s.meta.probeIntervalMs / 1000)}s`,
    'worker'
  );
  const blocks = s.components.find((c) => c.id === 'blocks');
  const rpcC = s.components.find((c) => c.id === 'rpc_public');
  renderStrip({
    height: blocks?.metrics?.height,
    bpm: blocks?.metrics?.blocksPerMin,
    rpcMs: rpcC?.metrics?.latencyMs,
    rpcSource: 'public RPC, from probe worker',
    gas: s.gas,
  });
  renderComponents(s.components, { withHistory: true });
  $('components-aside').textContent = `${fmtInt(s.meta.samplesCollected)} probes on record`;
  $('history-notice').hidden = collectedFor > 86_400_000;
  if (collectedFor <= 86_400_000) {
    $('history-notice').innerHTML =
      `<strong>Young worker:</strong> this probe worker started collecting ${duration(collectedFor)} ago. Uptime bars fill in as the 90-day window accumulates; days without data stay gray rather than pretending to be green.`;
  }
  renderChainlink(s.components.find((c) => c.id === 'chainlink')?.metrics);
  renderIncidents(s.incidents, 'worker');
  hydrateSparklines();
}

// ---------------------------------------------------------------- direct mode

const direct = {
  prevHead: null,
  latencies: [],
};

async function directProbe() {
  const now = Date.now();
  const [head, block, gas, scout, l1, feeds] = await Promise.allSettled([
    rpc(CFG.rpcUrl, 'eth_blockNumber'),
    rpc(CFG.rpcUrl, 'eth_getBlockByNumber', ['latest', false]),
    rpc(CFG.rpcUrl, 'eth_feeHistory', ['0x80', 'latest', []]),
    (async () => {
      const started = performance.now();
      const res = await fetch(`${CFG.blockscoutUrl}/api/v2/stats`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
      return { latencyMs: performance.now() - started };
    })(),
    rpc(CFG.l1RpcUrl, 'eth_blockNumber', [], 8000),
    Promise.allSettled(
      CFG.chainlinkFeeds.map(async (f) => {
        const { result } = await rpc(CFG.rpcUrl, 'eth_call', [
          { to: f.address, data: '0xfeaf968c' },
          'latest',
        ]);
        const word = (i) => result.slice(2 + i * 64, 2 + (i + 1) * 64);
        const updatedAt = parseInt(word(3), 16);
        return {
          symbol: f.symbol,
          ok: true,
          price: Number(BigInt('0x' + word(1))) / 1e8,
          ageSec: Math.max(0, now / 1000 - updatedAt),
        };
      })
    ),
  ]);

  // --- observations, same shapes the worker feeds into status-core ---
  const obs = {};

  if (head.status === 'fulfilled') {
    direct.latencies.push(head.value.latencyMs);
    if (direct.latencies.length > 10) direct.latencies.shift();
    obs.rpc = {
      ok: true,
      latencyMs: head.value.latencyMs,
      recentLatencies: [...direct.latencies],
      block: hexNum(head.value.result),
    };
  } else {
    obs.rpc = { ok: false, error: head.reason.message, latencyMs: null };
  }

  let height = null;
  let headAdvancing = true;
  if (block.status === 'fulfilled' && block.value.result) {
    const b = block.value.result;
    height = hexNum(b.number);
    const headAgeSec = Math.max(0, now / 1000 - hexNum(b.timestamp));
    let blocksPerMin = null;
    if (direct.prevHead && now > direct.prevHead.t) {
      blocksPerMin = ((height - direct.prevHead.height) / (now - direct.prevHead.t)) * 60000;
      headAdvancing = height > direct.prevHead.height;
    }
    if (blocksPerMin === null) blocksPerMin = feedBpm(); // instant first paint
    obs.blocks = {
      ok: true,
      headAgeSec,
      blocksPerMin,
      height,
      l1BlockNumber: hexNum(b.l1BlockNumber),
    };
    direct.prevHead = { height, t: now };
  } else {
    obs.blocks = { ok: false, headAgeSec: null, blocksPerMin: null };
  }

  obs.feed = {
    connected: feedState.connected,
    error: feedState.error,
    silenceSec: feedState.lastMessageAt ? (now - feedState.lastMessageAt) / 1000 : null,
    lagBlocks:
      Number.isFinite(height) && Number.isFinite(feedState.lastSeq)
        ? Math.max(0, height - feedState.lastSeq)
        : null,
    headAdvancing,
    messagesPerMin: feedState.messageTimes.length,
  };

  if (l1.status === 'fulfilled' && obs.blocks.ok && Number.isFinite(obs.blocks.l1BlockNumber)) {
    obs.settlement = {
      ok: true,
      lagL1Blocks: Math.max(0, hexNum(l1.value.result) - obs.blocks.l1BlockNumber),
    };
  } else {
    obs.settlement = { ok: false, lagL1Blocks: null };
  }

  obs.blockscout =
    scout.status === 'fulfilled'
      ? { ok: true, latencyMs: scout.value.latencyMs }
      : { ok: false, error: scout.reason.message, latencyMs: null };

  const feedResults =
    feeds.status === 'fulfilled'
      ? feeds.value.map((r, i) =>
          r.status === 'fulfilled'
            ? r.value
            : { symbol: CFG.chainlinkFeeds[i].symbol, ok: false }
        )
      : [];
  const okFeeds = feedResults.filter((r) => r.ok);
  const marketOpen = isUsMarketOpen(new Date(now));
  obs.chainlink = okFeeds.length
    ? {
        ok: true,
        maxAgeSec: Math.max(...okFeeds.map((r) => r.ageSec)),
        marketOpen,
        staleFeeds: okFeeds.filter((r) => r.ageSec > 1800).map((r) => r.symbol),
        feeds: okFeeds,
      }
    : { ok: false, maxAgeSec: null, marketOpen };

  let gasMetrics = null;
  if (gas.status === 'fulfilled' && Array.isArray(gas.value.result?.baseFeePerGas)) {
    const fees = gas.value.result.baseFeePerGas.map((h) => hexNum(h) / 1e9);
    const sorted = [...fees].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    gasMetrics = { currentGwei: fees[fees.length - 1], p50Gwei: pct(50), p95Gwei: pct(95) };
  }

  // --- evaluate with the published thresholds ---
  const components = [
    { id: 'rpc_public', name: 'Public RPC', o: obs.rpc, ev: 'rpc' },
    { id: 'blocks', name: 'Block production', o: obs.blocks, ev: 'blocks' },
    { id: 'feed', name: 'Sequencer feed', o: obs.feed, ev: 'feed' },
    { id: 'settlement', name: 'Settlement (L1 view)', o: obs.settlement, ev: 'settlement' },
    { id: 'blockscout', name: 'Blockscout explorer', o: obs.blockscout, ev: 'blockscout' },
    { id: 'chainlink', name: 'Chainlink stock feeds', o: obs.chainlink, ev: 'chainlink' },
  ].map((c) => {
    const r = evaluators[c.ev](c.o);
    const status = clampSeverity(r.status, THRESHOLDS[c.ev]?.maxSeverity);
    return {
      id: c.id,
      name: c.name,
      status,
      reason: r.reason,
      metrics: directMetrics(c.id, c.o),
    };
  });

  const overall = worstStatus(components.map((c) => c.status));
  setBanner(
    overall,
    `probed from your browser just now · no backend involved`,
    'direct'
  );
  renderStrip({
    height,
    bpm: obs.blocks.blocksPerMin,
    rpcMs: obs.rpc.latencyMs,
    rpcSource: 'public RPC, probed from your browser',
    gas: gasMetrics,
  });
  renderComponents(components, { withHistory: false });
  $('components-aside').textContent = 'live browser probes, same thresholds as the worker';
  const notice = $('history-notice');
  notice.hidden = false;
  notice.innerHTML = WORKER_URL
    ? '<strong>Direct probe mode.</strong> The probe worker is unreachable, so this page is measuring the chain from your browser with the same published thresholds. 90-day uptime bars and incident history resume when the worker is back.'
    : '<strong>Direct probe mode.</strong> No probe worker is configured for this deployment, so this page measures the chain live from your browser. Deploy the worker (see the README) to add 90-day uptime bars and incident history.';
  renderChainlink(
    obs.chainlink.ok
      ? { marketOpen, maxAgeSec: obs.chainlink.maxAgeSec, feeds: obs.chainlink.feeds }
      : null
  );
  renderIncidents(null, 'direct');
}

function directMetrics(id, o) {
  switch (id) {
    case 'rpc_public':
      return o.ok ? { latencyMs: o.latencyMs, block: o.block } : null;
    case 'blocks':
      return o.ok
        ? { height: o.height, headAgeSec: o.headAgeSec, blocksPerMin: o.blocksPerMin }
        : null;
    case 'feed':
      return {
        connected: o.connected,
        messagesPerMin: o.messagesPerMin,
        lagBlocks: o.lagBlocks,
      };
    case 'settlement':
      return o.ok ? { lagL1Blocks: o.lagL1Blocks } : null;
    case 'blockscout':
      return o.ok ? { latencyMs: o.latencyMs } : null;
    case 'chainlink':
      return o.ok ? { marketOpen: o.marketOpen, maxAgeSec: o.maxAgeSec, feeds: o.feeds } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- main loop

let mode = WORKER_URL ? 'worker' : 'direct';

async function tick() {
  if (mode === 'worker') {
    try {
      renderWorkerStatus(await fetchWorkerStatus());
      return;
    } catch {
      mode = 'direct'; // designed degradation, not a dead page
    }
  }
  try {
    await directProbe();
    if (!direct.refreshScheduled) {
      // One early refresh so feed-derived blocks/min replaces the first
      // paint's placeholder as soon as 10s of feed data exists.
      direct.refreshScheduled = true;
      setTimeout(() => directProbe().catch(() => {}), 12_000);
    }
  } catch (err) {
    setBanner('unknown', `probes failed from this browser: ${err.message}`, 'direct');
  }
  if (WORKER_URL) {
    // Keep trying the worker in the background; recover when it returns.
    fetchWorkerStatus()
      .then(() => {
        mode = 'worker';
      })
      .catch(() => {});
  }
}

tick();
setInterval(tick, 30000);
