// Bounties list — three.ws/bounties
//
// Mirrors pump.fun GO's public bounty board via our cached proxy
// (/api/pump-bounties). Cursor-paginated; sort + search run client-side over the
// loaded set. When a search is active we progressively scan the rest of the
// board (cheap server cache makes this cheap) so search covers every open
// bounty, not just the first page. Sort + query are reflected in the URL so a
// view is shareable and survives refresh. Read-only.

import { safeUrl } from './safe-url.js';

const API = '/api/pump-bounties';
const PAGE = 30;
const MAX_SCAN_PAGES = 24; // safety ceiling on the full-board search scan

const SORTS = {
	reward: (a, b) => (b.reward.totalUsd || 0) - (a.reward.totalUsd || 0),
	newest: (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
	submissions: (a, b) => (b.counts.submissions || 0) - (a.counts.submissions || 0),
	likes: (a, b) => (b.likeCount || 0) - (a.likeCount || 0),
};

let items = [];
let nextCursor = null;
let pagesLoaded = 0;
let inflight = null;
let scanning = false;
let sortKey = 'reward';
let query = '';

const grid = () => document.getElementById('grid');

// ── Boot ──────────────────────────────────────────────────────────────────────

function init() {
	readUrl();
	reflectControls();
	bindControls();
	load(true);
	loadStats();
}

// ── URL state ─────────────────────────────────────────────────────────────────

function readUrl() {
	const p = new URLSearchParams(location.search);
	const s = p.get('sort');
	if (s && SORTS[s]) sortKey = s;
	query = (p.get('q') || '').trim();
}

function writeUrl() {
	const p = new URLSearchParams();
	if (sortKey !== 'reward') p.set('sort', sortKey);
	if (query) p.set('q', query);
	const qs = p.toString();
	history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname);
}

function reflectControls() {
	document.querySelectorAll('#sort-seg button').forEach((b) => {
		b.classList.toggle('active', b.dataset.sort === sortKey);
	});
	const input = document.getElementById('q');
	input.value = query;
	document.getElementById('q-clear').hidden = !query;
}

// ── Board stats strip ─────────────────────────────────────────────────────────

async function loadStats() {
	try {
		const r = await fetch(`${API}/stats`);
		if (!r.ok) throw new Error(String(r.status));
		const s = await r.json();
		setStat('s-count', fmtCompact(s.count) + (s.truncated ? '+' : ''));
		setStat('s-usd', '$' + fmtCompact(s.totalRewardUsd));
		setStat('s-subs', fmtCompact(s.totalSubmissions));
	} catch {
		// Non-critical — hide the strip rather than show broken numbers.
		const el = document.getElementById('stats');
		if (el) el.style.display = 'none';
	}
}

function setStat(id, text) {
	const el = document.getElementById(id);
	if (!el) return;
	el.textContent = text;
	el.classList.remove('skeleton');
}

// ── Controls ──────────────────────────────────────────────────────────────────

function bindControls() {
	document.getElementById('sort-seg').addEventListener('click', (e) => {
		const btn = e.target.closest('button[data-sort]');
		if (!btn || btn.dataset.sort === sortKey) return;
		sortKey = btn.dataset.sort;
		reflectControls();
		writeUrl();
		renderGrid();
	});

	document.getElementById('refresh-btn').addEventListener('click', () => load(true));

	const input = document.getElementById('q');
	let debounce;
	input.addEventListener('input', () => {
		clearTimeout(debounce);
		debounce = setTimeout(() => onSearch(input.value), 180);
	});
	input.addEventListener('search', () => onSearch(input.value)); // native clear (×)

	document.getElementById('q-clear').addEventListener('click', () => {
		input.value = '';
		onSearch('');
		input.focus();
	});

	grid().addEventListener('click', (e) => {
		const card = e.target.closest('.card[data-id]');
		if (card) location.href = `/bounty/${card.dataset.id}`;
	});
}

function onSearch(value) {
	const next = value.trim();
	if (next === query) return;
	query = next;
	document.getElementById('q-clear').hidden = !query;
	writeUrl();
	renderGrid();
	renderMeta();
	if (query && nextCursor && !scanning) scanForSearch();
}

// ── Data ──────────────────────────────────────────────────────────────────────

// Single-flight page fetch. `reset` starts the board over from the first page.
async function fetchNext(reset) {
	if (inflight) return inflight;
	inflight = (async () => {
		const url = new URL(API, location.origin);
		url.searchParams.set('limit', String(PAGE));
		if (!reset && nextCursor) url.searchParams.set('cursor', nextCursor);
		const r = await fetch(url);
		const data = await r.json();
		if (!r.ok) throw new Error(data.error_description || data.error || `HTTP ${r.status}`);
		const batch = data.items || [];
		items = reset ? batch : items.concat(batch);
		nextCursor = data.nextCursor || null;
		pagesLoaded = reset ? 1 : pagesLoaded + 1;
		return batch.length;
	})();
	try {
		return await inflight;
	} finally {
		inflight = null;
	}
}

async function load(reset = false) {
	if (reset) {
		items = [];
		nextCursor = null;
		pagesLoaded = 0;
		grid().innerHTML = skeletons(8);
	} else {
		setLoadMore('Loading…', true);
	}
	try {
		await fetchNext(reset);
		renderGrid();
		renderMeta();
		if (query && nextCursor && !scanning) scanForSearch();
	} catch (err) {
		if (reset) grid().innerHTML = errorState(err.message);
		else setLoadMore('Couldn’t load more, tap to retry', false);
	}
}

// Walk the remaining pages so a search covers the whole open board. The proxy
// caches each page, so repeated searches stay cheap. Re-renders as it goes.
async function scanForSearch() {
	if (scanning) return;
	scanning = true;
	renderMeta();
	try {
		while (query && nextCursor && pagesLoaded < MAX_SCAN_PAGES) {
			await fetchNext(false);
			renderGrid();
			renderMeta();
		}
	} catch {
		// Keep whatever we already scanned; meta reflects partial coverage.
	} finally {
		scanning = false;
		renderMeta();
	}
}

// ── Render ────────────────────────────────────────────────────────────────────

function matches(b) {
	if (!query) return true;
	const q = query.toLowerCase();
	return (
		(b.title || '').toLowerCase().includes(q) ||
		(b.bodyMarkdown || '').toLowerCase().includes(q) ||
		(b.creator?.address || '').toLowerCase().includes(q) ||
		(b.taskId || '').toLowerCase().includes(q)
	);
}

function visible() {
	return items.filter(matches).sort(SORTS[sortKey]);
}

function renderGrid() {
	const el = grid();
	if (!items.length) {
		el.innerHTML = emptyState();
		return;
	}
	const list = visible();
	if (!list.length) {
		el.innerHTML = query && scanning ? scanningState() : noMatchState();
		return;
	}
	el.innerHTML = list.map(card).join('');
	// "Load more" only in browse mode — search auto-scans the whole board.
	if (!query && nextCursor) {
		const btn = document.createElement('button');
		btn.className = 'load-more';
		btn.id = 'load-more';
		btn.textContent = 'Load more';
		btn.addEventListener('click', () => load(false));
		el.appendChild(btn);
	}
}

function renderMeta() {
	const el = document.getElementById('result-meta');
	if (!el) return;
	if (!query) {
		el.hidden = true;
		el.innerHTML = '';
		return;
	}
	const n = items.filter(matches).length;
	const scanned = items.length;
	const safeQ = esc(query);
	let tail;
	if (scanning) {
		tail = `scanning the board… <strong>${n}</strong> match${n === 1 ? '' : 'es'} so far`;
	} else if (nextCursor && pagesLoaded >= MAX_SCAN_PAGES) {
		tail = `<strong>${n}</strong> match${n === 1 ? '' : 'es'} in the first ${scanned} bounties (board is larger)`;
	} else {
		tail = `<strong>${n}</strong> bount${n === 1 ? 'y' : 'ies'} match “${safeQ}” · searched all ${scanned} open`;
	}
	el.hidden = false;
	el.innerHTML = `${scanning ? '<span class="scan-dot"></span>' : ''}${tail}`;
}

function card(b) {
	const img = b.attachments.find(
		(a) => a.kind === 'image' || /^image\//.test(a.contentType || ''),
	);
	const thumb = img
		? `<div class="card-thumb" style="background-image:url('${esc(safeUrl(img.url, ''))}')">${statusBadge(b.status, true)}</div>`
		: `<div class="card-thumb empty">🎯${statusBadge(b.status, true)}</div>`;
	const usd = b.reward.totalUsd != null ? `$${fmtNum(b.reward.totalUsd)}` : '—';
	const token = b.reward.sol != null ? `◎ ${fmtNum(b.reward.sol)} SOL` : tokenLabel(b);
	const left = timeLeft(b.expiresAt);

	return `
	<article class="card" data-id="${esc(b.taskId)}">
		${thumb}
		<div class="card-body">
			<div class="card-title">${esc(b.title) || 'Untitled bounty'}</div>
			<div class="card-reward">
				<span class="reward-usd">${usd}</span>
				${token ? `<span class="reward-token">${esc(token)}</span>` : ''}
			</div>
			<div class="card-meta">
				<span class="m">${iconUser()} ${shortAddr(b.creator.address)}${b.creator.xVerified ? ` <span class="verified" title="X verified">✔</span>` : ''}</span>
				<span class="m">${iconSubs()} ${b.counts.submissions} subs</span>
				<span class="m">♥ ${b.likeCount}</span>
				${left ? `<span class="m">⏳ ${esc(left)}</span>` : ''}
			</div>
		</div>
	</article>`;
}

function statusBadge(status, float = false) {
	const s = String(status || '').toUpperCase();
	let cls = 'badge-pending',
		label = s.replace(/_/g, ' ');
	if (s === 'OPEN' || s === 'ACTIVE' || s === 'PUBLISHED') {
		cls = 'badge-open';
		label = 'Open';
	} else if (s.includes('PENDING')) {
		cls = 'badge-pending';
		label = 'Resolving';
	} else if (
		s.includes('CLOSED') ||
		s.includes('AWARD') ||
		s.includes('RESOLVED') ||
		s.includes('REFUND')
	) {
		cls = 'badge-closed';
		label = label.charAt(0) + label.slice(1).toLowerCase();
	}
	if (!label) label = 'Bounty';
	return `<span class="badge ${cls}${float ? ' badge-float' : ''}">${esc(label)}</span>`;
}

function tokenLabel(b) {
	const leg = b.reward.legs && b.reward.legs[0];
	if (!leg || leg.amount == null) return '';
	return `${fmtNum(leg.amount)} tokens`;
}

// ── States ────────────────────────────────────────────────────────────────────

function skeletons(n) {
	return Array.from({ length: n }, () => `<div class="skeleton skel-card"></div>`).join('');
}
function emptyState() {
	return `<div class="empty"><div class="ico">🎯</div><h3>No open bounties right now</h3><p>The pump.fun GO board is quiet at the moment. Check back shortly.</p></div>`;
}
function noMatchState() {
	return `<div class="empty"><div class="ico">🔍</div><h3>No bounties match “${esc(query)}”</h3><p>Try a different keyword, a creator address, or clear the search to browse the full board.</p></div>`;
}
function scanningState() {
	return `<div class="empty"><div class="ico">🔍</div><h3>Searching the board…</h3><p>Scanning every open bounty for “${esc(query)}”.</p></div>`;
}
function errorState(msg) {
	return `<div class="errbox"><div class="ico">⚠️</div><h3>Couldn't load bounties</h3><p>${esc(msg)}</p><button class="btn btn-ghost btn-sm" data-action="reload">Try again</button></div>`;
}
function setLoadMore(text, disabled) {
	const b = document.getElementById('load-more');
	if (b) {
		b.textContent = text;
		b.disabled = disabled;
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
	if (str == null) return '';
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
function fmtNum(n) {
	const x = Number(n) || 0;
	if (x >= 1000) return x.toLocaleString('en-US', { maximumFractionDigits: 0 });
	if (x >= 1) return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
	return x.toLocaleString('en-US', { maximumFractionDigits: 4 });
}
function fmtCompact(n) {
	const x = Number(n) || 0;
	if (x >= 1_000_000) return (x / 1_000_000).toFixed(x % 1_000_000 === 0 ? 0 : 1) + 'M';
	if (x >= 1000) return (x / 1000).toFixed(x % 1000 === 0 ? 0 : 1) + 'K';
	return x.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function timeLeft(iso) {
	if (!iso) return '';
	const ms = new Date(iso) - Date.now();
	if (ms <= 0) return 'expired';
	const d = Math.floor(ms / 86400000);
	const h = Math.floor((ms % 86400000) / 3600000);
	if (d > 0) return `${d}d ${h}h`;
	const m = Math.floor((ms % 3600000) / 60000);
	return `${h}h ${m}m`;
}
function shortAddr(a) {
	if (!a) return 'anon';
	return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}
function iconUser() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5"/></svg>`;
}
function iconSubs() {
	return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 9H7m10 0l-4-4m4 4l-4 4M3 4v12"/></svg>`;
}

init();
