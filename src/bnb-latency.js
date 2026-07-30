// /bnb-latency — the live block-race proof page. Polls /api/bnb/latency
// (which wraps probeBlockTime + the same real-RPC technique for Base,
// Ethereum, and Solana — api/_lib/bnb/latency-lanes.js) every few seconds
// and renders four racing lanes, each showing a genuinely fresh measurement
// on every tick. No hardcoded "0.45s" anywhere in this file: every number
// on screen traces back to the most recent successful probe.
//
// See the bnb-chain campaign, work order 17 (latency proof page; retired, see git history), and 00-CONTEXT.md (verified
// fact #3 — 0.45s blocks live; never claim BEP-670's 250ms target).

import { escapeHtml as esc, timeAgo } from './shared/coin-format.js';
import {
	formatBlockTime,
	formatBlockNumber,
	laneState,
	allLanesDown,
	sparklineBars,
	speedupRatio,
} from './bnb-latency-helpers.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 5000;
const MAX_HISTORY = 24;

const prefersReducedMotion =
	typeof window !== 'undefined' &&
	window.matchMedia &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Static lane metadata (icon/labels) merged with each poll's live measurement.
const LANE_META = {
	bnb: { label: 'BNB Chain', kicker: 'Fermi hardfork · chainId 56' },
	base: { label: 'Base', kicker: 'OP Stack L2 · chainId 8453' },
	ethereum: { label: 'Ethereum', kicker: 'Mainnet L1 · chainId 1' },
	solana: { label: 'Solana', kicker: 'Slot cadence · non-EVM' },
};
const LANE_ORDER = ['bnb', 'base', 'ethereum', 'solana'];

/** @type {Record<string, { hasFetchedOnce: boolean, history: number[], last: any }>} */
const laneStore = {};
for (const id of LANE_ORDER) laneStore[id] = { hasFetchedOnce: false, history: [], last: null };

let pollTimer = null;
let inFlight = false;

function renderSkeleton() {
	const grid = $('bnbl-grid');
	grid.innerHTML = LANE_ORDER.map(
		(id) => `
		<article class="bnbl-lane" data-lane="${id}">
			<div class="bnbl-lane-head">
				<span class="bnbl-lane-name">${esc(LANE_META[id].label)}</span>
				<span class="bnbl-lane-status" data-state="measuring">Measuring…</span>
			</div>
			<p class="bnbl-lane-kicker">${esc(LANE_META[id].kicker)}</p>
			<div class="bnbl-lane-num" aria-live="polite">
				<span class="bnbl-spinner" aria-hidden="true"></span>
			</div>
			<div class="bnbl-sparkline" data-sparkline aria-hidden="true"></div>
			<p class="bnbl-lane-meta" data-meta>Waiting for the first sample…</p>
		</article>`,
	).join('');
}

function sparklineHtml(values) {
	const bars = sparklineBars(values, { maxBars: MAX_HISTORY });
	if (bars.length === 0) {
		return '<span class="bnbl-sparkline-empty">—</span>';
	}
	return bars.map((h) => `<span class="bnbl-bar" style="height:${h}%"></span>`).join('');
}

function renderLane(lane) {
	const el = document.querySelector(`.bnbl-lane[data-lane="${lane.id}"]`);
	if (!el) return;
	const store = laneStore[lane.id];
	const state = laneState({ hasFetchedOnce: store.hasFetchedOnce, ok: lane.ok, hasSample: lane.ok && lane.avgBlockTimeMs > 0 });

	el.dataset.state = state;
	const pill = el.querySelector('.bnbl-lane-status');
	pill.dataset.state = state;
	pill.textContent = state === 'live' ? 'Live' : state === 'reconnecting' ? 'Reconnecting…' : 'Measuring…';

	const numEl = el.querySelector('.bnbl-lane-num');
	if (state === 'live') {
		numEl.innerHTML = `${esc(formatBlockTime(lane.avgBlockTimeMs))}<span class="unit">avg</span>`;
		if (!prefersReducedMotion) {
			el.classList.remove('bnbl-tick');
			// Force reflow so the animation can re-trigger on every fresh sample.
			void el.offsetWidth;
			el.classList.add('bnbl-tick');
		}
	} else if (state === 'reconnecting') {
		numEl.innerHTML = `<span class="bnbl-lane-num-stale">${esc(formatBlockTime(store.last?.avgBlockTimeMs ?? null))}</span>`;
	} else {
		numEl.innerHTML = `<span class="bnbl-spinner" aria-hidden="true"></span>`;
	}

	const sparkEl = el.querySelector('[data-sparkline]');
	sparkEl.innerHTML = sparklineHtml(store.history);

	const metaEl = el.querySelector('[data-meta]');
	if (state === 'live') {
		const label = lane.id === 'solana' ? 'slot' : 'block';
		metaEl.textContent = `latest ${label} ${formatBlockNumber(lane.latestBlock)} · sampled ${lane.sampleBlocks ?? '—'} real ${label}s`;
	} else if (state === 'reconnecting') {
		metaEl.textContent = `RPC unreachable right now — still trying, last live ${store.lastLiveAt ? timeAgo(store.lastLiveAt) : 'reading above'}`;
	} else {
		metaEl.textContent = 'Sampling real blocks off a public RPC — first read lands in a few seconds…';
	}
}

function renderHeadline(bnbLane) {
	const el = $('bnbl-headline-num');
	const sub = $('bnbl-headline-sub');
	if (!el) return;
	if (bnbLane?.ok && bnbLane.avgBlockTimeMs > 0) {
		el.innerHTML = `${esc(formatBlockTime(bnbLane.avgBlockTimeMs))}<span class="unit">avg block time</span>`;
		const base = laneStore.base.last;
		const eth = laneStore.ethereum.last;
		const bits = [];
		const vsBase = base?.ok ? speedupRatio(bnbLane.avgBlockTimeMs, base.avgBlockTimeMs) : null;
		const vsEth = eth?.ok ? speedupRatio(bnbLane.avgBlockTimeMs, eth.avgBlockTimeMs) : null;
		if (vsBase) bits.push(`${esc(vsBase)} faster than Base's live average`);
		if (vsEth) bits.push(`${esc(vsEth)} faster than Ethereum's live average`);
		sub.textContent = bits.length
			? bits.join(' · ')
			: `sampled ${bnbLane.sampleBlocks ?? '—'} real blocks off a public BSC RPC, updated ${timeAgo(bnbLane.measuredAt)}`;
	} else {
		el.innerHTML = `<span class="bnbl-spinner" aria-hidden="true"></span>`;
		sub.textContent = 'Measuring live BNB Chain block time from a public RPC…';
	}
}

function renderUpdated(measuredAt) {
	const el = $('bnbl-updated');
	if (el && measuredAt) el.textContent = `Updated ${timeAgo(measuredAt)}`;
}

function renderPageError(show) {
	const err = $('bnbl-page-error');
	const race = $('bnbl-race');
	if (!err || !race) return;
	err.hidden = !show;
	race.setAttribute('aria-hidden', show ? 'true' : 'false');
}

function applyPayload(payload) {
	let anyLive = false;
	for (const lane of payload.lanes) {
		const store = laneStore[lane.id];
		if (!store) continue;
		store.hasFetchedOnce = true;
		if (lane.ok && lane.avgBlockTimeMs > 0) {
			store.history.push(lane.avgBlockTimeMs);
			if (store.history.length > MAX_HISTORY) store.history.shift();
			store.last = lane;
			store.lastLiveAt = lane.measuredAt;
			anyLive = true;
		}
		renderLane(lane);
	}
	const bnbLane = payload.lanes.find((l) => l.id === 'bnb');
	renderHeadline(bnbLane?.ok ? bnbLane : laneStore.bnb.last);
	renderUpdated(payload.measuredAt);
	renderPageError(allLanesDown(payload.lanes) && !anyLive && !Object.values(laneStore).some((s) => s.last));
}

async function poll() {
	if (inFlight) return;
	inFlight = true;
	try {
		const res = await fetch('/api/bnb/latency', {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const payload = await res.json();
		applyPayload(payload);
	} catch {
		// A total network failure (not just a down chain — the endpoint itself
		// unreachable): mark every lane reconnecting/measuring via a synthetic
		// all-down payload, same rendering path as a partial outage.
		const synthetic = { lanes: LANE_ORDER.map((id) => ({ id, ok: false })), measuredAt: null };
		applyPayload(synthetic);
	} finally {
		inFlight = false;
	}
}

function startPolling() {
	poll();
	pollTimer = window.setInterval(poll, POLL_MS);
}

function retry() {
	renderPageError(false);
	poll();
}

function init() {
	renderSkeleton();
	const retryBtn = $('bnbl-retry');
	if (retryBtn) retryBtn.addEventListener('click', retry);
	startPolling();
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			if (pollTimer) window.clearInterval(pollTimer);
			pollTimer = null;
		} else if (!pollTimer) {
			startPolling();
		}
	});
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
