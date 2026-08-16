// /bnb-latency — the live block-race proof page. Polls /api/bnb/latency
// (which wraps probeBlockTime + the same real-RPC technique for Base,
// Ethereum, and Solana — api/_lib/bnb/latency-lanes.js) every few seconds
// and renders four racing lanes, each showing a genuinely fresh measurement
// on every tick. No hardcoded "0.45s" anywhere in this file: every number
// on screen traces back to the most recent successful probe.
//
// See the bnb-chain campaign, work order 17 (latency proof page; retired, see git history), and 00-CONTEXT.md (verified
// fact #3 — 0.45s blocks live; never claim BEP-670's 250ms target).

import { escapeHtml as esc } from './shared/coin-format.js';
import {
	formatBlockTime,
	formatBlockNumber,
	laneState,
	headlineState,
	ageLabel,
	measuredAtMs,
	allLanesDown,
	sparklineBars,
	speedupRatio,
} from './bnb-latency-helpers.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 5000;
const AGE_TICK_MS = 1000;
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

/** @type {Record<string, { hasFetchedOnce: boolean, history: number[], last: any, lastLiveAt: number|null }>} */
const laneStore = {};
for (const id of LANE_ORDER) laneStore[id] = { hasFetchedOnce: false, history: [], last: null, lastLiveAt: null };

let pollTimer = null;
let ageTimer = null;
/** @type {Promise<void>|null} the in-flight poll, shared by the retry button. */
let inFlight = null;
// Epoch ms of the last poll that actually measured something. The "Updated"
// stamp and every staleness label age off THIS, never off the last request:
// a request that came back with four dead lanes measured nothing.
let lastSuccessAt = null;

function renderSkeleton() {
	const grid = $('bnbl-grid');
	grid.innerHTML = LANE_ORDER.map(
		(id) => `
		<article class="bnbl-lane" data-lane="${id}">
			<div class="bnbl-lane-head">
				<span class="bnbl-lane-name">${esc(LANE_META[id].label)}</span>
				<span class="bnbl-lane-status" data-state="measuring" role="status">Measuring…</span>
			</div>
			<p class="bnbl-lane-kicker">${esc(LANE_META[id].kicker)}</p>
			<div class="bnbl-lane-num">
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
	// The pill is a role="status" region, so only write when the state really
	// changed: rewriting the same word every 5s would make a screen reader
	// re-announce all four lanes twelve times a minute.
	const pillText = state === 'live' ? 'Live' : state === 'reconnecting' ? 'Reconnecting…' : 'Measuring…';
	if (pill.textContent !== pillText) pill.textContent = pillText;

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
		// A lane that has never returned a reading has no "last live" to point
		// at, so say that plainly instead of referring to a number that isn't
		// on screen.
		metaEl.textContent = store.lastLiveAt
			? `RPC unreachable right now, still trying. Last live reading ${ageLabel(Date.now() - store.lastLiveAt)}.`
			: 'RPC unreachable right now, still trying. No successful sample from this chain yet.';
	} else {
		metaEl.textContent = 'Sampling real blocks off a public RPC — first read lands in a few seconds…';
	}
}

// The headline is the page's loudest claim, so it is the one number that must
// never keep reading "live" through an outage. `bnbLane` is the CURRENT poll's
// BNB lane (possibly failed); the last good reading comes from the store.
function renderHeadline(bnbLane) {
	const el = $('bnbl-headline-num');
	const sub = $('bnbl-headline-sub');
	if (!el || !sub) return;
	const store = laneStore.bnb;
	const previous = store.last;
	const state = headlineState({
		hasFetchedOnce: store.hasFetchedOnce,
		ok: Boolean(bnbLane?.ok),
		hasSample: Boolean(bnbLane?.ok) && bnbLane.avgBlockTimeMs > 0,
		hasPrevious: Boolean(previous),
	});

	// Dim anything that is not a live reading, so a placeholder dash or an aged
	// number can never be mistaken for the current measurement.
	el.classList.toggle('bnbl-stale', state === 'stale' || state === 'unavailable');
	if (state === 'live') {
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
			: bnbLane.sampleBlocks
				? `sampled ${bnbLane.sampleBlocks} real blocks off a public BSC RPC`
				: 'measured off a public BSC RPC on this poll';
	} else if (state === 'stale') {
		// Show the old number, visibly marked old, with its real age. The
		// speedup claims are dropped: comparing a stale BNB reading against a
		// live one would be exactly the fabricated number this page refuses.
		el.innerHTML = `${esc(formatBlockTime(previous.avgBlockTimeMs))}<span class="unit">last measured</span>`;
		sub.textContent = `BSC RPC unreachable right now, reconnecting. This reading is from ${ageLabel(Date.now() - (store.lastLiveAt ?? Date.now()))}, not live.`;
	} else if (state === 'unavailable') {
		el.innerHTML = `${esc(formatBlockTime(null))}<span class="unit">no reading yet</span>`;
		sub.textContent = 'No public BSC RPC has answered yet. Retrying every few seconds.';
	} else {
		el.innerHTML = `<span class="bnbl-spinner" aria-hidden="true"></span>`;
		sub.textContent = 'Measuring live BNB Chain block time from a public RPC…';
	}
}

// Ages off the last poll that actually measured something, and is re-rendered
// on a ticker so a stalled page visibly ages instead of freezing on
// "Updated just now".
function renderUpdated() {
	const el = $('bnbl-updated');
	if (!el) return;
	el.textContent = lastSuccessAt ? `Updated ${ageLabel(Date.now() - lastSuccessAt)}` : '';
}

function renderPageError(show) {
	const err = $('bnbl-page-error');
	if (!err) return;
	err.hidden = !show;
}

/** The most recent poll's lanes, so the age ticker can re-render them. */
let lastLanes = [];

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
			store.lastLiveAt = measuredAtMs(lane.measuredAt);
			anyLive = true;
		}
		renderLane(lane);
	}
	lastLanes = payload.lanes;
	if (anyLive) lastSuccessAt = measuredAtMs(payload.measuredAt);
	renderHeadline(payload.lanes.find((l) => l.id === 'bnb'));
	renderUpdated();
	// Every lane down is an outage the user can act on (retry), whether it
	// started on the first poll or after an hour of racing. Gating this on
	// "no lane has ever been live" kept the banner, and its retry button,
	// permanently unreachable once the page had loaded once.
	renderPageError(allLanesDown(payload.lanes));
}

// Staleness is a function of wall-clock time, not of poll results: without
// this, an outage's "last measured 4s ago" would sit frozen at 4s forever.
function tickAges() {
	renderUpdated();
	const bnbLane = lastLanes.find((l) => l.id === 'bnb');
	if (!(bnbLane?.ok && bnbLane.avgBlockTimeMs > 0)) renderHeadline(bnbLane);
	for (const lane of lastLanes) {
		if (!lane.ok && laneStore[lane.id]) renderLane(lane);
	}
}

async function poll() {
	// Return the running request rather than a resolved promise, so the retry
	// button awaits real work even when it lands mid-poll.
	if (inFlight) return inFlight;
	inFlight = runPoll().finally(() => {
		inFlight = null;
	});
	return inFlight;
}

async function runPoll() {
	try {
		const res = await fetch('/api/bnb/latency', {
			headers: { accept: 'application/json' },
			// The endpoint ships stale-while-revalidate for crawlers and shared
			// caches, which let the browser replay a body up to 15s old while
			// this page claims a fresh measurement. A poll on a live race has to
			// go to the network; the endpoint's own 4s cache is what protects
			// the upstream RPCs from the traffic.
			cache: 'no-store',
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const payload = await res.json();
		applyPayload(payload);
	} catch {
		// A total network failure (not just a down chain: the endpoint itself
		// unreachable) marks every lane reconnecting via a synthetic all-down
		// payload, the same rendering path a partial outage takes.
		applyPayload({ lanes: LANE_ORDER.map((id) => ({ id, ok: false })), measuredAt: null });
	}
}

function startPolling() {
	poll();
	pollTimer = window.setInterval(poll, POLL_MS);
	ageTimer = window.setInterval(tickAges, AGE_TICK_MS);
}

function stopPolling() {
	if (pollTimer) window.clearInterval(pollTimer);
	if (ageTimer) window.clearInterval(ageTimer);
	pollTimer = null;
	ageTimer = null;
}

async function retry(btn) {
	// Leave the outage banner up until the retry actually resolves: hiding it
	// on click would flash success the page has not earned yet.
	const label = btn.textContent;
	btn.disabled = true;
	btn.textContent = 'Retrying…';
	try {
		// Wait out a poll that was already running, then make a genuinely new
		// attempt. Piggybacking on a request that started before the click
		// would report that older request's failure as the retry's result.
		if (inFlight) await inFlight;
		await poll();
	} finally {
		btn.disabled = false;
		btn.textContent = label;
	}
}

function init() {
	renderSkeleton();
	const retryBtn = $('bnbl-retry');
	if (retryBtn) retryBtn.addEventListener('click', () => retry(retryBtn));
	startPolling();
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			stopPolling();
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
