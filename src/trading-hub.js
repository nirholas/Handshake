// /trading, the autonomous-trading control room.
//
// One entry point for a system that was spread across twenty pages with no
// front door: live fleet vitals, the agent scoreboard, and a directory of every
// trading surface and doc.
//
// All numbers come from real endpoints (/api/sniper/status,
// /api/sniper/leaderboard). Nothing here is simulated or seeded: when the fleet
// has not traded, the page says so rather than inventing a row.

import { escapeHtml as esc } from './shared/coin-format.js';
import { SURFACES, LEARN } from './trading-hub-data.js';
import { describeFleet, formatSol, formatPct, formatAgo, sparkPath } from './trading-hub-format.js';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 30_000;
const BOARD_LIMIT = 6;

let timer = null;

async function getJson(url, { signal } = {}) {
	const res = await fetch(url, { headers: { accept: 'application/json' }, signal });
	if (!res.ok) {
		const err = new Error(`fetch ${url} -> ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

// ── status pill ─────────────────────────────────────────────────────────────

function renderPill(status) {
	const el = $('th-status-pill');
	if (!el) return;
	const d = describeFleet(status);
	el.className = `th-pill th-pill-${d.tone}`;
	el.innerHTML = `<span class="th-dot" aria-hidden="true"></span><span class="th-pill-text">${esc(d.label)}</span>`;
	el.setAttribute('title', d.detail);
}

function renderPillError() {
	const el = $('th-status-pill');
	if (!el) return;
	el.className = 'th-pill th-pill-unknown';
	el.innerHTML =
		'<span class="th-dot" aria-hidden="true"></span><span class="th-pill-text">Fleet status unavailable</span>';
	el.setAttribute('title', 'The status endpoint did not respond. The fleet may still be trading.');
}

// ── vitals ──────────────────────────────────────────────────────────────────

// A vital is a number with no context unless you already know the system, which
// is exactly the reader this page exists for. Each tile therefore carries a
// plain-language explanation, reachable three ways so nobody is left out: hover
// (pointer), focus (keyboard, the tile is tabbable), and aria-describedby (screen
// reader, which gets it without any interaction at all).
function vitalTile({ label, value, sub, tone, help }, i) {
	const helpId = `th-vital-help-${i}`;
	return `<div class="th-vital${tone ? ` th-vital-${tone}` : ''}" tabindex="0"${
		help ? ` aria-describedby="${helpId}"` : ''
	}>
		<div class="th-vital-label">${esc(label)}</div>
		<div class="th-vital-value">${esc(value)}</div>
		<div class="th-vital-sub">${esc(sub)}</div>
		${help ? `<span class="th-vital-help" id="${helpId}" role="tooltip">${esc(help)}</span>` : ''}
	</div>`;
}

function renderVitals(status) {
	const el = $('th-vitals');
	if (!el) return;
	el.removeAttribute('aria-busy');
	const d = describeFleet(status);
	const funding = status?.funding || {};
	const tiles = [
		{
			label: 'Mode',
			value: status?.mode === 'live' ? 'Live' : status?.mode === 'simulate' ? 'Simulate' : 'Unknown',
			sub: status?.mode === 'live' ? 'Real funds, real fills' : 'Real quotes, no broadcast',
			tone: status?.mode === 'live' ? 'live' : 'muted',
			help: "Live means the worker signs and broadcasts real transactions from the agents' own wallets. Simulate means it does everything except broadcast: real launches, real quotes, real decisions, no money moved.",
		},
		{
			label: 'Strategies armed',
			value: String(status?.strategies ?? 0),
			sub: 'Independent agents, each with its own rules',
			help: 'How many strategies are currently enabled with their kill switch off. Each one has its own filters, position size and exit rules, and they compete on the same launches.',
		},
		{
			label: 'Open positions',
			value: String(status?.openPositions ?? 0),
			sub: 'Held right now, not yet realized',
			help: 'Coins the fleet is holding right now. An open position is not profit: it is worth whatever it re-quotes at, and that number moves until it closes.',
		},
		{
			label: 'Launch feed',
			value: d.feedLabel,
			sub: d.feedDetail,
			tone: d.feedTone,
			help: 'The live stream of new launches. This is the failure that hides best: the worker can be up, healthy and beating steadily while its feed has gone silent, in which case it sees nothing and takes no trades.',
		},
		{
			label: 'Funded to date',
			value: formatSol(funding.fundedTotalSol, { signed: false }),
			sub: `Last top-up ${formatAgo(funding.lastFundAt)}`,
			help: 'Total SOL moved into agent trading wallets from the treasury. This is capital deployed, not profit or loss. A stale last top-up while strategies are armed usually means the funding wallet is dry.',
		},
		{
			label: 'Uptime',
			value: d.uptimeLabel,
			sub: 'Since the worker last booted',
			help: 'How long the current worker process has been running. A long uptime is not automatically good: it also means the process predates any fix deployed since it booted.',
		},
	];
	el.innerHTML = tiles.map(vitalTile).join('');
}

function renderVitalsError() {
	const el = $('th-vitals');
	if (!el) return;
	el.removeAttribute('aria-busy');
	el.innerHTML = `<div class="th-state th-state-error" role="alert">
		<h3>Fleet vitals are unavailable</h3>
		<p>The status endpoint did not respond. This page reads live data only, so nothing is shown rather than a stale guess. It retries automatically every 30 seconds.</p>
		<p><a href="/play/arena">Open the live arena</a> for the position feed in the meantime.</p>
	</div>`;
}

function renderVitalsLoading() {
	const el = $('th-vitals');
	if (!el) return;
	el.innerHTML = Array.from({ length: 6 })
		.map(() => '<div class="th-vital th-skeleton" aria-hidden="true"></div>')
		.join('');
}

// ── scoreboard ──────────────────────────────────────────────────────────────

function boardRow(row) {
	const pnl = Number(row.realized_pnl_sol ?? 0);
	const tone = pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'flat';
	const series = Array.isArray(row.pnl_series) ? row.pnl_series : [];
	const spark = sparkPath(series, 120, 32);
	const name = row.agent_name || 'Unnamed agent';
	const wins = Number(row.wins ?? 0);
	const closed = Number(row.closed ?? 0);
	const winRate = closed > 0 ? formatPct((wins / closed) * 100, { signed: false }) : 'no trades yet';
	return `<article class="th-row th-row-${tone}">
		<div class="th-row-rank" aria-hidden="true">${esc(String(row.rank ?? '·'))}</div>
		<div class="th-row-main">
			<h3 class="th-row-name">${esc(name)}</h3>
			<p class="th-row-meta">${esc(String(closed))} closed · ${esc(winRate)} win rate</p>
		</div>
		<div class="th-row-spark" aria-hidden="true">
			${spark ? `<svg viewBox="0 0 120 32" preserveAspectRatio="none" focusable="false"><path d="${spark}" /></svg>` : ''}
		</div>
		<div class="th-row-pnl">
			<div class="th-row-pnl-value">${esc(formatSol(pnl))}</div>
			<div class="th-row-pnl-sub">${esc(formatPct(row.roi_pct))} ROI</div>
		</div>
	</article>`;
}

function renderBoard(data) {
	const el = $('th-board');
	if (!el) return;
	el.removeAttribute('aria-busy');
	const rows = Array.isArray(data?.leaderboard) ? data.leaderboard : [];
	const traded = rows.filter((r) => Number(r.closed ?? 0) > 0);
	if (!traded.length) {
		el.innerHTML = `<div class="th-state th-state-empty">
			<h3>No closed trades yet</h3>
			<p>The fleet is armed but has not finished a round trip in this window. Positions only count here once they are closed, so an open trade never shows up as profit.</p>
			<p><a href="/sniper/experiments">See what each strategy is waiting for</a>.</p>
		</div>`;
		return;
	}
	el.innerHTML = traded.slice(0, BOARD_LIMIT).map(boardRow).join('');
}

function renderBoardError() {
	const el = $('th-board');
	if (!el) return;
	el.removeAttribute('aria-busy');
	el.innerHTML = `<div class="th-state th-state-error" role="alert">
		<h3>The scoreboard is unavailable</h3>
		<p>The leaderboard endpoint did not respond. It retries automatically every 30 seconds.</p>
		<p><a href="/leaderboard">Try the full leaderboard</a>.</p>
	</div>`;
}

function renderBoardLoading() {
	const el = $('th-board');
	if (!el) return;
	el.innerHTML = Array.from({ length: 3 })
		.map(() => '<div class="th-row th-skeleton" aria-hidden="true"></div>')
		.join('');
}

// ── static directories ──────────────────────────────────────────────────────

function card(item) {
	return `<a class="th-card" href="${esc(item.href)}">
		<span class="th-card-kicker">${esc(item.kicker)}</span>
		<span class="th-card-title">${esc(item.title)}</span>
		<span class="th-card-body">${esc(item.body)}</span>
	</a>`;
}

function renderDirectories() {
	const s = $('th-surfaces');
	if (s) s.innerHTML = SURFACES.map(card).join('');
	const l = $('th-learn');
	if (l) l.innerHTML = LEARN.map(card).join('');
}

// ── refresh loop ────────────────────────────────────────────────────────────

async function refresh() {
	const [status, board] = await Promise.allSettled([
		getJson('/api/sniper/status'),
		getJson('/api/sniper/leaderboard?window=all&sort=score'),
	]);

	if (status.status === 'fulfilled') {
		renderPill(status.value);
		renderVitals(status.value);
	} else {
		renderPillError();
		renderVitalsError();
	}

	if (board.status === 'fulfilled') renderBoard(board.value);
	else renderBoardError();

	const stamp = $('th-updated');
	if (stamp) {
		stamp.textContent =
			status.status === 'fulfilled' || board.status === 'fulfilled'
				? `Updated ${new Date().toLocaleTimeString()}. Refreshes every 30 seconds.`
				: 'Live data unavailable. Retrying every 30 seconds.';
	}
}

function start() {
	renderDirectories();
	renderVitalsLoading();
	renderBoardLoading();
	refresh();
	if (timer) clearInterval(timer);
	timer = setInterval(() => {
		// Pause polling while the tab is hidden so a backgrounded page does not
		// keep hitting the API for numbers nobody is reading.
		if (document.visibilityState === 'visible') refresh();
	}, REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible') refresh();
});

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
	start();
}
