/**
 * Trade Terminal — controller.
 *
 * A two-pane pump.fun analytics workstation:
 *
 *   • Left rail — a live feed of three.ws's own on-chain activity: platform
 *     launches (/api/pump/launches over pump_agent_mints) and notable agent
 *     exits (/api/trades/feed). $THREE is pinned at the top. Selecting any row,
 *     or pasting a mint into the search box, drives the deep-dive.
 *
 *   • Centre — the deep-dive (./trades-detail.js): for the selected mint it
 *     pulls every real signal the platform holds — candlestick chart, bonding
 *     curve, intel signals, holders & cohorts, a funder bubblemap, smart money,
 *     the wallet footprint, a live trade tape, outcome, and agent economics.
 *
 * The header carries a real live pulse from /api/pump/helius-stats (network
 * mint rate, graduations/hour, SOL price). Everything is real data; the only
 * pinned mint is $THREE — the platform's one coin.
 */

import { mountDetail } from './trades-detail.js';
import { escapeHtml, compact, shortAddr, relTime } from './trader-format.js';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NETWORK_KEY = 'tf_network';
const FEED_REFRESH_MS = 30_000;
const PULSE_REFRESH_MS = 20_000;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
	tab: 'launches', // 'launches' | 'exits'
	network: localStorage.getItem(NETWORK_KEY) || 'mainnet',
	selected: null,
	rows: [],
};

let detail = null;
let feedTimer = null;
let pulseTimer = null;

document.addEventListener('DOMContentLoaded', init);

function init() {
	readUrl();
	wireControls();
	loadFeed(true);
	loadPulse();
	// Open the deep-dive immediately so the terminal is never an empty void —
	// the URL mint if present, otherwise the platform coin.
	select(state.selected || THREE_MINT, state.selected ? null : threeSeed(), { push: false });
	feedTimer = setInterval(() => loadFeed(false), FEED_REFRESH_MS);
	pulseTimer = setInterval(loadPulse, PULSE_REFRESH_MS);
	window.addEventListener('beforeunload', teardown);
}

function teardown() {
	clearInterval(feedTimer);
	clearInterval(pulseTimer);
	try { detail?.destroy?.(); } catch { /* gone */ }
}

function threeSeed() {
	return { symbol: 'THREE', name: 'three.ws', image_uri: '' };
}

// ── URL ───────────────────────────────────────────────────────────────────────
function readUrl() {
	const p = new URL(location.href).searchParams;
	const m = p.get('mint') || p.get('coin');
	if (m && MINT_RE.test(m)) state.selected = m;
	if (p.get('network') === 'devnet') state.network = 'devnet';
	if (p.get('tab') === 'exits') state.tab = 'exits';
}
function writeUrl() {
	const p = new URLSearchParams();
	if (state.selected) p.set('mint', state.selected);
	if (state.tab !== 'launches') p.set('tab', state.tab);
	if (state.network !== 'mainnet') p.set('network', state.network);
	history.replaceState(null, '', `${location.pathname}${p.toString() ? '?' + p : ''}`);
}

// ── controls ────────────────────────────────────────────────────────────────────
function wireControls() {
	$$('#ttTabs [data-tab]').forEach((b) => {
		b.classList.toggle('on', b.dataset.tab === state.tab);
		b.addEventListener('click', () => {
			if (state.tab === b.dataset.tab) return;
			state.tab = b.dataset.tab;
			$$('#ttTabs [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
			writeUrl();
			loadFeed(true);
		});
	});

	const net = $('#ttNetwork');
	if (net) {
		net.value = state.network;
		net.addEventListener('change', () => {
			state.network = net.value;
			localStorage.setItem(NETWORK_KEY, state.network);
			writeUrl();
			loadFeed(true);
		});
	}

	const search = $('#ttSearch');
	if (search) {
		search.addEventListener('keydown', (e) => {
			if (e.key !== 'Enter') return;
			const v = search.value.trim();
			if (MINT_RE.test(v)) { select(v, null, { push: true }); search.blur(); }
			else if (v) { search.classList.add('shake'); setTimeout(() => search.classList.remove('shake'), 400); }
		});
		$('#ttSearchGo')?.addEventListener('click', () => {
			const v = search.value.trim();
			if (MINT_RE.test(v)) select(v, null, { push: true });
		});
	}

	// Event delegation for feed row selection.
	$('#ttFeed').addEventListener('click', (e) => {
		const row = e.target.closest('[data-mint]');
		if (!row) return;
		let seed = null;
		try { seed = row.dataset.seed ? JSON.parse(row.dataset.seed) : null; } catch { /* ignore */ }
		select(row.dataset.mint, seed, { push: true });
	});
}

// ── selection ─────────────────────────────────────────────────────────────────
function select(mint, seed, { push = true } = {}) {
	if (!MINT_RE.test(mint)) return;
	// Re-selecting the mounted coin is a no-op: a full remount would re-fire
	// every detail fetch (5 endpoints) for data already on screen.
	if (detail && state.selected === mint) {
		highlightRow(mint);
		if (push) writeUrl();
		return;
	}
	state.selected = mint;
	highlightRow(mint);
	if (push) writeUrl();
	try { detail?.destroy?.(); } catch { /* gone */ }
	const host = $('#ttDetail');
	host.scrollTop = 0;
	detail = mountDetail(host, { mint, network: state.network, seed: seed || seedFromRows(mint) || threeSeedIf(mint) });
}

function threeSeedIf(mint) { return mint === THREE_MINT ? threeSeed() : null; }
function seedFromRows(mint) {
	const r = state.rows.find((x) => x.mint === mint);
	return r ? { symbol: r.symbol, name: r.name, image_uri: r.image_uri } : null;
}
function highlightRow(mint) {
	$$('#ttFeed [data-mint]').forEach((el) => el.classList.toggle('on', el.dataset.mint === mint));
}

// ── live pulse ──────────────────────────────────────────────────────────────────
async function loadPulse() {
	try {
		const r = await fetch('/api/pump/helius-stats', { headers: { accept: 'application/json' } });
		if (!r.ok) return;
		const d = await r.json();
		const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
		set('ttPulseMints', d.feed?.mints_per_min != null ? `${d.feed.mints_per_min}/min` : '—');
		set('ttPulseGrad', d.feed?.graduations_per_hour != null ? `${d.feed.graduations_per_hour}/hr` : '—');
		set('ttPulseSol', d.sol_price != null ? `$${Number(d.sol_price).toFixed(2)}` : '—');
		const chgEl = document.getElementById('ttPulseSolChg');
		if (chgEl && d.sol_change_24h != null) {
			const c = Number(d.sol_change_24h);
			chgEl.textContent = `${c >= 0 ? '+' : ''}${c.toFixed(1)}%`;
			chgEl.className = `tt-pulse-chg ${c >= 0 ? 'up' : 'down'}`;
		}
	} catch { /* pulse is decorative — silent */ }
}

// ── feed ─────────────────────────────────────────────────────────────────────────
async function loadFeed(reset) {
	const feed = $('#ttFeed');
	if (reset) feed.innerHTML = skeletonRows(7);
	try {
		const rows = state.tab === 'exits' ? await fetchExits() : await fetchLaunches();
		state.rows = rows;
		renderFeed(rows);
	} catch {
		if (reset) {
			const pinned = state.tab === 'launches'
				? rowHtml({ kind: 'launch', mint: THREE_MINT, symbol: 'THREE', name: 'three.ws · platform coin', image_uri: '', agent_name: 'The only coin', oracle_tier: null }, { pinned: true })
				: '';
			feed.innerHTML = pinned + feedState('Could not load other launches.', 'Retry', () => loadFeed(true));
		}
	}
}

async function fetchLaunches() {
	const q = new URLSearchParams({ network: state.network, limit: '40' });
	const r = await fetch(`/api/pump/launches?${q}`, { headers: { accept: 'application/json' } });
	if (!r.ok) throw new Error(String(r.status));
	const body = await r.json();
	const list = body?.data?.launches || body?.launches || [];
	return list.map((l) => ({
		kind: 'launch',
		mint: l.mint,
		symbol: (l.symbol || l.mint?.slice(0, 4) || '?').toUpperCase(),
		name: l.name || '',
		image_uri: l.image_uri || '',
		agent_name: l.agent_name || '',
		oracle_tier: l.oracle_tier || l.oracle?.tier || null,
		oracle_score: l.oracle_score ?? l.oracle?.score ?? null,
		ts: l.created_at || null,
	}));
}

async function fetchExits() {
	const q = new URLSearchParams({ network: state.network, window: '7d', min_pnl_pct: '10', limit: '40' });
	const r = await fetch(`/api/trades/feed?${q}`, { headers: { accept: 'application/json' } });
	if (!r.ok) throw new Error(String(r.status));
	const body = await r.json();
	return (body?.items || []).map((t) => ({
		kind: 'exit',
		mint: t.mint,
		symbol: (t.symbol || t.mint?.slice(0, 4) || '?').toUpperCase(),
		name: t.name || '',
		image_uri: t.image_uri || '',
		agent_name: t.agent_name || '',
		oracle_tier: t.oracle_tier || null,
		pnl_pct: t.realized_pnl_pct,
		multiple: t.multiple,
		ts: t.closed_at || null,
	}));
}

const TIER_CLASS = { prime: 'prime', strong: 'strong', lean: 'lean', watch: 'watch', avoid: 'avoid' };

function rowHtml(r, { pinned = false } = {}) {
	const seed = escapeHtml(JSON.stringify({ symbol: r.symbol, name: r.name, image_uri: r.image_uri }));
	const initials = escapeHtml(r.symbol.slice(0, 2));
	const imgHtml = r.image_uri
		? `<img src="${escapeHtml(r.image_uri)}" alt="" class="tt-row-img" loading="lazy" onerror="this.outerHTML='<span class=tt-row-ini>${initials}</span>'" />`
		: `<span class="tt-row-ini">${initials}</span>`;
	const tier = r.oracle_tier && r.oracle_tier !== 'avoid'
		? `<span class="tt-tier ${TIER_CLASS[r.oracle_tier] || ''}">${escapeHtml(r.oracle_tier)}</span>` : '';
	let right = '';
	if (r.kind === 'exit') {
		const up = Number(r.pnl_pct) >= 0;
		right = `<span class="tt-row-pnl ${up ? 'up' : 'down'}">${r.multiple != null ? `${Number(r.multiple).toFixed(2)}×` : ''}${r.pnl_pct != null ? ` +${Math.round(r.pnl_pct)}%` : ''}</span>`;
	} else if (pinned) {
		right = '<span class="tt-row-pin">★</span>';
	} else if (r.oracle_score != null) {
		right = `<span class="tt-row-score">${Math.round(r.oracle_score)}</span>`;
	}
	return `<button type="button" class="tt-row${pinned ? ' tt-row--pin' : ''}${state.selected === r.mint ? ' on' : ''}" data-mint="${escapeHtml(r.mint)}" data-seed="${seed}">
		${imgHtml}
		<span class="tt-row-main">
			<span class="tt-row-top"><b>$${escapeHtml(r.symbol)}</b>${r.name ? `<span class="tt-row-name">${escapeHtml(r.name)}</span>` : ''}${tier}</span>
			<span class="tt-row-sub">${r.agent_name ? escapeHtml(r.agent_name) : shortAddr(r.mint, 4, 4)}${r.ts ? ` · ${escapeHtml(relTime(r.ts))}` : ''}</span>
		</span>
		${right}
	</button>`;
}

function renderFeed(rows) {
	const feed = $('#ttFeed');
	// $THREE is always pinned at the top of the launches view (and never duplicated).
	const pinned = state.tab === 'launches'
		? rowHtml({ kind: 'launch', mint: THREE_MINT, symbol: 'THREE', name: 'three.ws · platform coin', image_uri: '', agent_name: 'The only coin', oracle_tier: null }, { pinned: true })
		: '';
	const body = rows.filter((r) => !(state.tab === 'launches' && r.mint === THREE_MINT))
		.map((r) => rowHtml(r)).join('');
	if (!rows.length && !pinned) {
		feed.innerHTML = feedState(
			state.tab === 'exits' ? 'No profitable agent exits in this window yet.' : 'No launches on this network yet.',
			'', null,
		);
		return;
	}
	feed.innerHTML = pinned + body;
	highlightRow(state.selected);
}

// ── feed states ───────────────────────────────────────────────────────────────
function skeletonRows(n) {
	return Array.from({ length: n }, () => '<div class="tt-row tt-row--skel"><span class="tt-row-ini sk"></span><span class="tt-row-main"><span class="sk sk-l"></span><span class="sk sk-s"></span></span></div>').join('');
}
function feedState(msg, action, fn) {
	const id = action ? `tt-fs-${Math.random().toString(36).slice(2, 8)}` : '';
	if (action && fn) setTimeout(() => { const b = document.getElementById(id); if (b) b.addEventListener('click', fn); }, 0);
	return `<div class="tt-feed-state"><p>${escapeHtml(msg)}</p>${action ? `<button id="${id}" class="tt-mini-btn">${escapeHtml(action)}</button>` : ''}</div>`;
}
