// ════════════════════════════════════════════════════════════════════════════
// /watchlist — the coins a trader is tracking, with a live portfolio readout.
//
// Closes the loop opened by the "Watch" button on every coin profile
// (/launches/<mint>): that button writes a mint into localStorage under
// `ld_watchlist`; this page reads it back and renders each as a live status
// card (shared coin-status widget → one /api/pump/coin fetch per coin), linking
// straight back to the Oracle conviction breakdown. The list is device-local
// and private — no account required — and stays in sync across tabs via the
// storage event.
//
// Beyond the raw list, this page treats the watchlist as a portfolio:
//   · a summary bar aggregates combined market cap, 24h volume, graduated
//     count, average Oracle conviction, and the tier distribution;
//   · a toolbar sorts (added/conviction/mcap/volume/graduation/movers/name),
//     filters by tier, searches by symbol/name/mint, and toggles grid/list;
//   · conviction movers (/api/oracle/movers) surface 24h score swings per coin;
//   · the empty state suggests trending coins to add in one click;
//   · "Share list" copies a self-contained link that recreates the watchlist
//     on any device, and `?add=` links are imported on load.
// ════════════════════════════════════════════════════════════════════════════

import { mountCoinStatus, formatMcap, NO_VALUE } from './pump/coin-status-card.js';
import { updateValue, flipReorder } from './ui-juice.js';

const WATCH_KEY        = 'ld_watchlist'; // shared with src/launch-detail.js
const LAST_TIERS_KEY   = 'wl_last_tiers'; // mint → tier, for upgrade detection
const ALERTS_KEY       = 'wl_alerts_on';
const PREFS_KEY        = 'wl_prefs';      // { sort, view, tier }
const TIER_COLOR       = { prime: '#c084fc', strong: '#34d399', lean: '#fbbf24', watch: '#94a3b8', avoid: '#f87171' };
const TIER_LABEL       = { prime: 'Prime', strong: 'Strong', lean: 'Lean', watch: 'Watch', avoid: 'Avoid' };
const TIER_ORDER       = ['prime', 'strong', 'lean', 'watch', 'avoid'];
const TIER_RANK        = { avoid: 0, watch: 1, lean: 2, strong: 3, prime: 4 };
const MINT_RE          = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const REDUCED_MOTION   = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const REFRESH_MS       = 90_000;
const MAX_WATCH        = 200;

const feedEl    = document.getElementById('wl-feed');
const stateEl   = document.getElementById('wl-state');
const countEl   = document.getElementById('wl-count');
const clearBtn  = document.getElementById('wl-clear');
const alertsBtn = document.getElementById('wl-alerts');
const shareBtn  = document.getElementById('wl-share');
const summaryEl = document.getElementById('wl-summary');
const toolbarEl = document.getElementById('wl-toolbar');
const searchInp = document.getElementById('wl-search');
const sortSel   = document.getElementById('wl-sort');
const filtersEl = document.getElementById('wl-filters');
const viewGrid  = document.getElementById('wl-view-grid');
const viewList  = document.getElementById('wl-view-list');

// ── live state ─────────────────────────────────────────────────────────────
// Central stores keyed by mint. Cards mount async, so the summary, sort, and
// filter all read from these maps as data streams in rather than re-fetching.
const handles    = new Set();             // coin-status destroy handles
const cardEls    = new Map();             // mint → <article>
const coinData   = new Map();             // mint → normalized coin (from widget onData)
const convData   = new Map();             // mint → { score, tier, pillars }
const moverData  = new Map();             // mint → { delta, tierChanged, firstTier }
let refreshTimer = null;
let sortRaf      = 0;
let oracleReachable = true;         // last /api/oracle/batch sweep answered at all

const prefs = readPrefs();

// ── DOM helpers ──────────────────────────────────────────────────────────────

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k === 'html') node.innerHTML = v;
		else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v);
	}
	for (const c of [].concat(children || [])) {
		if (c == null || c === false) continue;
		node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
	const node = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
	return node;
}

// Deterministic orbital glyph seeded from the mint — the placeholder behind the
// real pump.fun logo (matches the /launches feed identicon language).
function hashString(str) {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}
function mulberry32(seed) {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function mintIdenticon(mint) {
	const rand = mulberry32(hashString(String(mint)));
	const svg = svgEl('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true' });
	svg.style.color = 'var(--ink-dim)';
	const cx = 32;
	const cy = 32;
	const rings = 3 + Math.floor(rand() * 2);
	for (let i = 0; i < rings; i++) {
		const r = 8 + i * (20 / rings) + rand() * 4;
		const circumference = 2 * Math.PI * r;
		const dashOn = circumference * (0.18 + rand() * 0.55);
		svg.appendChild(
			svgEl('circle', {
				cx, cy, r: r.toFixed(1), fill: 'none', stroke: 'currentColor',
				'stroke-width': (0.7 + rand() * 0.9).toFixed(2),
				'stroke-dasharray': `${dashOn.toFixed(1)} ${(circumference - dashOn).toFixed(1)}`,
				'stroke-linecap': 'round', opacity: (0.3 + rand() * 0.45).toFixed(2),
				transform: `rotate(${Math.floor(rand() * 360)} ${cx} ${cy})`,
			}),
		);
		if (rand() > 0.35) {
			const theta = rand() * Math.PI * 2;
			svg.appendChild(
				svgEl('circle', {
					cx: (cx + Math.cos(theta) * r).toFixed(1),
					cy: (cy + Math.sin(theta) * r).toFixed(1),
					r: (1 + rand() * 1.8).toFixed(1), fill: 'currentColor',
					opacity: (0.5 + rand() * 0.5).toFixed(2),
				}),
			);
		}
	}
	svg.appendChild(svgEl('circle', { cx, cy, r: '3.2', fill: 'currentColor', opacity: '0.9', style: 'color: var(--ink-bright)' }));
	return svg;
}

// ── storage ──────────────────────────────────────────────────────────────────

function readList() {
	try {
		const arr = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
		return Array.isArray(arr) ? arr.filter((m) => MINT_RE.test(m)) : [];
	} catch {
		return [];
	}
}

function writeList(list) {
	try {
		localStorage.setItem(WATCH_KEY, JSON.stringify(list.slice(0, MAX_WATCH)));
	} catch {
		/* storage blocked — non-fatal */
	}
}

function remove(mint) {
	writeList(readList().filter((m) => m !== mint));
	coinData.delete(mint);
	convData.delete(mint);
	moverData.delete(mint);
	render();
}

function readPrefs() {
	const fallback = { sort: 'added', view: 'grid', tier: 'all' };
	try {
		const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
		return {
			sort: typeof p.sort === 'string' ? p.sort : fallback.sort,
			view: p.view === 'list' ? 'list' : 'grid',
			tier: typeof p.tier === 'string' ? p.tier : fallback.tier,
		};
	} catch {
		return fallback;
	}
}

function savePrefs() {
	try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* non-fatal */ }
}

// ── tier memory + alerts ────────────────────────────────────────────────────

function readLastTiers() {
	try { return JSON.parse(localStorage.getItem(LAST_TIERS_KEY) || '{}'); } catch { return {}; }
}

function saveLastTiers(map) {
	try { localStorage.setItem(LAST_TIERS_KEY, JSON.stringify(map)); } catch { /* non-fatal */ }
}

function alertsEnabled() {
	return localStorage.getItem(ALERTS_KEY) === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

function updateAlertsBtn() {
	if (!alertsBtn) return;
	const on = alertsEnabled();
	alertsBtn.setAttribute('aria-pressed', String(on));
	alertsBtn.textContent = on ? '🔔 Alerts on' : '🔔 Alerts';
	alertsBtn.style.color = on ? '#c084fc' : '';
	alertsBtn.style.borderColor = on ? 'rgba(192,132,252,.4)' : '';
}

async function toggleAlerts() {
	if (typeof Notification === 'undefined') {
		alertsBtn.textContent = '🔕 Unsupported';
		setTimeout(() => updateAlertsBtn(), 2400);
		return;
	}
	if (alertsEnabled()) {
		localStorage.setItem(ALERTS_KEY, '0');
		updateAlertsBtn();
		return;
	}
	if (Notification.permission === 'denied') {
		alertsBtn.textContent = '🔕 Blocked by browser';
		setTimeout(() => updateAlertsBtn(), 2400);
		return;
	}
	const perm = await Notification.requestPermission().catch(() => 'denied');
	if (perm === 'granted') localStorage.setItem(ALERTS_KEY, '1');
	updateAlertsBtn();
}

function maybeFire(mint, newTier, oldTier) {
	if (!alertsEnabled()) return;
	const oldRank = TIER_RANK[oldTier] ?? -1;
	const newRank = TIER_RANK[newTier] ?? -1;
	if (newRank <= oldRank) return;
	if (newRank < TIER_RANK.strong) return; // only strong+ upgrades
	const symbol = coinData.get(mint)?.symbol || mint.slice(0, 8);
	const title = `${symbol} → ${TIER_LABEL[newTier] || newTier} conviction`;
	const body  = `Oracle upgraded this coin to ${newTier} on three.ws`;
	try {
		const n = new Notification(title, { body, icon: '/favicon-32x32.png', tag: mint });
		// Navigate the watchlist tab itself rather than spawning an orphaned new
		// tab — keeps the browser Back button as a reliable return path.
		n.onclick = () => { window.focus(); location.href = `/oracle/coin/${encodeURIComponent(mint)}`; n.close(); };
	} catch { /* Notification blocked mid-flight */ }
}

// ── teardown ─────────────────────────────────────────────────────────────────

function teardown() {
	for (const h of handles) {
		try { h.destroy(); } catch { /* ignore */ }
	}
	handles.clear();
	cardEls.clear();
}

// ── cards ────────────────────────────────────────────────────────────────────

function watchCard(mint, index) {
	// Primary card link opens the coin's full page (conviction + market + trades).
	const link = el('a', {
		class: 'wl-card-link',
		href: `/oracle/coin/${mint}`,
		'aria-label': 'Open the full coin page',
	});
	const market = el('div', { class: 'wl-market' });
	const removeBtn = el('button', {
		class: 'wl-remove',
		type: 'button',
		'aria-label': 'Remove from watchlist',
		title: 'Remove from watchlist',
		text: '✕',
		onclick: (e) => {
			e.preventDefault();
			e.stopPropagation();
			remove(mint);
		},
	});
	const delta = el('div', { class: 'wl-delta', 'data-delta': mint, hidden: true });
	const oracleBadge = el('div', { class: 'wl-oracle-badge', 'data-oracle': mint });
	const card = el('article', { class: 'wl-card', 'data-mint': mint }, [link, delta, oracleBadge, removeBtn, market]);
	if (!REDUCED_MOTION) {
		card.style.animationDelay = `${Math.min(index, 12) * 40}ms`;
		card.classList.add('wl-in');
	}
	handles.add(
		mountCoinStatus(market, mint, {
			variant: 'card',
			placeholder: mintIdenticon(mint),
			showBuy: true,
			oracle: false, // conviction is batch-fetched here; skip the per-card round trip
			onData: (coin) => {
				coinData.set(mint, coin);
				updateSummary();
				scheduleSortFilter();
			},
		}),
	);
	cardEls.set(mint, card);
	return card;
}

// ── empty state (with trending suggestions) ─────────────────────────────────

function renderEmpty() {
	const suggestWrap = el('div', { class: 'wl-suggest', id: 'wl-suggest', hidden: true });
	stateEl.replaceChildren(
		el('div', { class: 'wl-empty' }, [
			el('div', { class: 'wl-empty-glyph', 'aria-hidden': 'true' }, [mintIdenticon('three.ws-watchlist-empty')]),
			el('h2', { text: 'Nothing on your watchlist yet' }),
			el('p', { text: 'Paste a mint address or pump.fun URL above to add any coin instantly. Or tap ☆ Watch on any coin profile to pin it here.' }),
			el('div', { class: 'wl-empty-ctas' }, [
				el('a', { class: 'wl-btn wl-btn-primary', href: '/launches', text: 'Explore launches' }),
				el('a', { class: 'wl-btn', href: '/oracle', text: 'Open Oracle' }),
			]),
			suggestWrap,
		]),
	);
	loadSuggestions(suggestWrap);
}

// Pull live trending coins so the empty state offers a real first action.
async function loadSuggestions(wrap) {
	let coins = [];
	try {
		const r = await fetch('/api/pump/trending?limit=8');
		if (r.ok) {
			const data = await r.json();
			coins = (data?.data || []).filter((c) => MINT_RE.test(c?.mint || '')).slice(0, 6);
		}
	} catch { /* trending is best-effort garnish on the empty state */ }
	if (!coins.length || !wrap.isConnected) return;

	const chips = coins.map((c) => {
		const label = c.symbol ? `$${c.symbol}` : `${c.mint.slice(0, 4)}…`;
		return el('button', {
			class: 'wl-suggest-chip',
			type: 'button',
			title: `Add ${c.name || label} to your watchlist`,
			onclick: () => {
				if (addMint(c.mint) !== 'already') showAddMsg(`Added ${label} — building your list.`, 'ok');
			},
		}, [
			c.logo ? el('img', { class: 'wl-suggest-img', src: c.logo, alt: '', loading: 'lazy' }) : null,
			el('span', { text: label }),
			el('span', { class: 'wl-suggest-plus', text: '+', 'aria-hidden': 'true' }),
		]);
	});

	wrap.replaceChildren(
		el('p', { class: 'wl-suggest-head', text: 'Trending right now — tap to add' }),
		el('div', { class: 'wl-suggest-row' }, chips),
	);
	wrap.hidden = false;
}

// ── render ───────────────────────────────────────────────────────────────────

function render() {
	teardown();
	feedEl.replaceChildren();
	stateEl.replaceChildren();

	const list = readList();
	const n = list.length;
	countEl.textContent = n ? `${n} coin${n === 1 ? '' : 's'} watched` : '';
	clearBtn.hidden = n === 0;
	if (shareBtn) shareBtn.hidden = n === 0;
	toolbarEl.hidden = n < 2;        // controls only earn their space past one coin
	summaryEl.hidden = n === 0;

	// Drop cached data for mints no longer watched.
	for (const m of [...coinData.keys()]) if (!list.includes(m)) coinData.delete(m);
	for (const m of [...convData.keys()]) if (!list.includes(m)) convData.delete(m);
	// Movers too: a coin unwatched in another tab and re-added later would
	// otherwise flash its previous 24h delta before the fresh sweep lands.
	for (const m of [...moverData.keys()]) if (!list.includes(m)) moverData.delete(m);

	if (n === 0) {
		feedEl.setAttribute('aria-busy', 'false');
		renderEmpty();
		updateSummary();
		return;
	}

	list.forEach((mint, i) => feedEl.appendChild(watchCard(mint, i)));
	feedEl.setAttribute('aria-busy', 'false');
	applyView();
	updateSummary();
	enrichWithOracleConviction(list);
	fetchMovers(list);
}

// ── summary bar ──────────────────────────────────────────────────────────────

function updateSummary() {
	if (summaryEl.hidden) return;
	const list = readList();
	const coins = list.map((m) => coinData.get(m)).filter(Boolean);
	const convs = list.map((m) => convData.get(m)).filter((c) => c && c.score != null);

	// Aggregate only over the coins that actually report each figure. Treating a
	// missing number as zero fabricates data: the pump feed omits 24h volume for
	// graduated coins, and summing `|| 0` across four of them rendered a
	// confident "$0" where the honest answer is "not reported".
	const sumMcap = sumReported(coins, 'mcap');
	const sumVol  = sumReported(coins, 'volume24h');
	const gradCnt = coins.filter((c) => c.graduated).length;
	const avgConv = convs.length ? Math.round(convs.reduce((a, c) => a + Number(c.score), 0) / convs.length) : null;

	// Count the aggregate tiles from their previously-shown real values, flashing
	// the direction as watched-coin data refreshes (the #wl-sum-* nodes persist).
	setNum('wl-sum-mcap', sumMcap, formatMcap);
	setNum('wl-sum-vol',  sumVol,  formatMcap);
	setStat('wl-sum-grad', coins.length ? `${gradCnt}/${list.length}` : null);
	setNum('wl-sum-conv', avgConv, (n) => String(Math.round(n)));

	setTileNote('wl-sum-mcap', sumMcap == null
		? 'Market caps are still loading for the coins you watch.'
		: `Combined across ${countReported(coins, 'mcap')} of ${list.length} watched coins.`);
	setTileNote('wl-sum-vol', sumVol == null
		? 'The pump.fun feed reports no 24h volume for these coins.'
		: `Combined across ${countReported(coins, 'volume24h')} of ${list.length} watched coins.`);
	setTileNote('wl-sum-conv', convs.length
		? `Average of the ${convs.length} of ${list.length} watched coins the Oracle has scored.`
		: oracleReachable
			? 'The Oracle has not scored any watched coin yet.'
			: 'The Oracle is unreachable right now, so no conviction is available.');

	const convEl = document.getElementById('wl-sum-conv');
	if (convEl && avgConv != null) convEl.style.color = TIER_COLOR[tierForScore(avgConv)] || '';

	renderTierBar(convs, list.length);
}

function countReported(coins, key) {
	return coins.filter((c) => Number.isFinite(c[key])).length;
}

// Sum a field over the coins that report it; null when nobody does, so the tile
// falls back to its "no value yet" dash instead of asserting a zero.
function sumReported(coins, key) {
	const vals = coins.map((c) => c[key]).filter((v) => Number.isFinite(v));
	return vals.length ? vals.reduce((a, v) => a + v, 0) : null;
}

// Explain each aggregate's coverage on hover and to screen readers, so a partial
// figure never reads as a total.
function setTileNote(id, note) {
	const node = document.getElementById(id);
	if (!node) return;
	node.title = note;
	node.setAttribute('aria-description', note);
}

// A non-numeric summary tile (the graduated ratio); null renders the same
// "no value yet" dash the numeric tiles use.
function setStat(id, text) {
	const node = document.getElementById(id);
	if (node) node.textContent = text == null ? NO_VALUE : text;
}

// Count a summary tile from its previously-shown real value to the new one and
// flash the direction; missing value renders a static dash with the count
// tracker cleared.
function setNum(id, value, format) {
	const node = document.getElementById(id);
	if (!node) return;
	if (value == null || !Number.isFinite(value)) { node.textContent = NO_VALUE; delete node.dataset.juiceVal; return; }
	updateValue(node, value, format);
}

function tierForScore(s) {
	if (s >= 75) return 'prime';
	if (s >= 60) return 'strong';
	if (s >= 45) return 'lean';
	if (s >= 30) return 'watch';
	return 'avoid';
}

// The bar spans every watched coin, not just the scored ones: an unscored
// remainder gets its own muted segment so the distribution can never imply the
// Oracle has an opinion on coins it has not rated.
function renderTierBar(convs, watched = convs.length) {
	const bar = document.getElementById('wl-sum-tiers');
	if (!bar) return;
	if (!convs.length) {
		const why = !watched
			? 'Nothing watched yet'
			: oracleReachable
				? 'Awaiting Oracle scores'
				: 'Oracle unreachable';
		bar.replaceChildren(el('span', { class: 'wl-tierbar-empty', text: why }));
		bar.removeAttribute('aria-label');
		return;
	}
	const counts = {};
	for (const c of convs) counts[c.tier] = (counts[c.tier] || 0) + 1;
	const unscored = Math.max(0, watched - convs.length);
	const total = Math.max(convs.length, watched);
	const segs = [];
	const labelParts = [];
	for (const tier of TIER_ORDER) {
		const cnt = counts[tier] || 0;
		if (!cnt) continue;
		labelParts.push(`${cnt} ${tier}`);
		segs.push(el('span', {
			class: 'wl-tierseg',
			style: `flex:${cnt};background:${TIER_COLOR[tier]}`,
			title: `${cnt} ${TIER_LABEL[tier]}`,
		}, cnt / total > 0.14 ? [el('span', { class: 'wl-tierseg-n', text: String(cnt) })] : []));
	}
	if (unscored) {
		labelParts.push(`${unscored} not scored yet`);
		segs.push(el('span', {
			class: 'wl-tierseg wl-tierseg--unscored',
			style: `flex:${unscored}`,
			title: `${unscored} not scored by the Oracle yet`,
		}, unscored / total > 0.14 ? [el('span', { class: 'wl-tierseg-n', text: String(unscored) })] : []));
	}
	bar.replaceChildren(...segs);
	bar.setAttribute('aria-label', `Tier distribution: ${labelParts.join(', ')}`);
}

// ── conviction (batch) ──────────────────────────────────────────────────────

async function enrichWithOracleConviction(mints) {
	if (!mints.length) return;
	const chunks = [];
	for (let i = 0; i < mints.length; i += 20) chunks.push(mints.slice(i, i + 20));
	const results = {};
	const answered = new Set(); // mints covered by a chunk request that succeeded
	try {
		const responses = await Promise.all(
			chunks.map((chunk) =>
				fetch(`/api/oracle/batch?mints=${chunk.map(encodeURIComponent).join(',')}&network=mainnet`)
					.then((r) => (r.ok ? r.json() : null))
					.then((json) => (json ? { chunk, json } : null))
					.catch(() => null),
			),
		);
		for (const resp of responses) {
			if (!resp) continue;
			// Only a chunk that actually answered can tell us a mint is unscored; a
			// chunk that failed says nothing about its mints, so it stays out of
			// `answered` and its cards keep their existing badge.
			for (const mint of resp.chunk) answered.add(mint);
			if (resp.json.results) Object.assign(results, resp.json.results);
		}
		oracleReachable = answered.size > 0;
	} catch {
		oracleReachable = false;
		updateSummary();
		return;
	}

	const lastTiers = readLastTiers();
	const nextTiers = { ...lastTiers };

	for (const mint of mints) {
		const data = results[mint];
		if (!data || data.score == null) {
			if (!answered.has(mint)) continue; // the Oracle never answered for this one
			// The Oracle has no score for this mint yet. Leaving the badge slot empty
			// reads as "no opinion rendered" rather than "not rated", so say it and
			// keep the route to the coin's Oracle page open.
			convData.delete(mint);
			paintUnscoredBadge(mint);
			continue;
		}
		convData.set(mint, data);
		paintOracleBadge(mint, data);

		const oldTier = lastTiers[mint];
		const newTier = data.tier;
		const card = cardEls.get(mint);
		if (oldTier && newTier && (TIER_RANK[newTier] ?? -1) > (TIER_RANK[oldTier] ?? -1)) {
			maybeFire(mint, newTier, oldTier);
			if (card) card.classList.add('wl-card--upgraded');
		}
		if (newTier) nextTiers[mint] = newTier;
	}

	saveLastTiers(nextTiers);
	updateSummary();
	scheduleSortFilter();
}

function paintUnscoredBadge(mint) {
	const card = cardEls.get(mint);
	const badge = card?.querySelector('.wl-oracle-badge');
	if (!badge) return;
	badge.replaceChildren(
		el('a', {
			class: 'wl-ob-link wl-ob-link--unscored',
			href: `/oracle/coin/${encodeURIComponent(mint)}`,
			title: 'The Oracle has not scored this coin yet. Open its page to run a fresh read.',
			'aria-label': 'Oracle conviction: not scored yet. Open the coin page to run a read.',
		}, [
			el('span', { class: 'wl-ob-score', text: NO_VALUE }),
			el('span', { class: 'wl-ob-tier', text: 'unrated' }),
		]),
	);
}

function paintOracleBadge(mint, data) {
	const card = cardEls.get(mint);
	if (!card) return;
	const badge = card.querySelector('.wl-oracle-badge');
	if (!badge) return;
	const tier = data.tier || 'watch';
	const color = TIER_COLOR[tier] || '#94a3b8';
	const p = data.pillars || {};
	const bars = [
		['P', p.pedigree], ['S', p.structure], ['N', p.narrative], ['M', p.momentum],
	].filter(([, v]) => v != null);
	const pillarBars = bars.length
		? `<span class="wl-ob-pillars" aria-hidden="true">${bars.map(([k, v]) =>
				`<span class="wl-ob-pbar" title="${k} ${Math.round(v)}"><span style="height:${Math.max(8, Math.min(100, v))}%;background:${color}"></span></span>`,
			).join('')}</span>`
		: '';
	badge.innerHTML = `<a class="wl-ob-link" href="/oracle/coin/${encodeURIComponent(mint)}" aria-label="Oracle conviction: ${data.score} ${tier}">
		<span class="wl-ob-top">
			<span class="wl-ob-score" style="color:${color}">${data.score}</span>
			<span class="wl-ob-tier" style="color:${color}">${tier}</span>
		</span>${pillarBars}
	</a>`;
}

// ── conviction movers (24h delta) ───────────────────────────────────────────

async function fetchMovers(mints) {
	if (!mints.length) return;
	const watched = new Set(mints);
	try {
		const r = await fetch('/api/oracle/movers?direction=all&hours=24&limit=60&network=mainnet');
		if (!r.ok) return;
		const data = await r.json();
		const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data?.movers) ? data.movers : []);
		for (const it of items) {
			const mint = it?.mint;
			if (!mint || !watched.has(mint)) continue;
			const delta = Number(it.delta);
			if (!Number.isFinite(delta)) continue;
			moverData.set(mint, { delta, tierChanged: !!it.tier_changed, firstTier: it.first_tier || null });
			paintDelta(mint);
		}
	} catch { /* movers are an enhancement, not load-bearing */ }
	scheduleSortFilter();
}

function paintDelta(mint) {
	const card = cardEls.get(mint);
	if (!card) return;
	const node = card.querySelector('.wl-delta');
	if (!node) return;
	const m = moverData.get(mint);
	if (!m || !m.delta) { node.hidden = true; return; }
	const up = m.delta > 0;
	node.className = `wl-delta ${up ? 'wl-delta--up' : 'wl-delta--down'}`;
	node.title = `Oracle conviction ${up ? 'rose' : 'fell'} ${Math.abs(Math.round(m.delta))} pts in 24h${m.tierChanged ? ` (tier changed from ${m.firstTier})` : ''}`;
	node.textContent = `${up ? '▲' : '▼'} ${Math.abs(Math.round(m.delta))}`;
	node.hidden = false;
}

// ── sort / filter / search ──────────────────────────────────────────────────

function scheduleSortFilter() {
	if (sortRaf) return;
	sortRaf = requestAnimationFrame(() => { sortRaf = 0; applySortFilter(); });
}

function sortValue(mint, mode) {
	const c = coinData.get(mint);
	const cv = convData.get(mint);
	switch (mode) {
		case 'conviction': return cv?.score ?? -1;
		case 'mcap':       return c?.mcap ?? -1;
		case 'volume':     return c?.volume24h ?? -1;
		case 'graduation': return c?.graduationPct ?? -1;
		case 'movers':     return moverData.get(mint)?.delta ?? -Infinity;
		case 'name':       return (c?.name || c?.symbol || mint).toLowerCase();
		default:           return 0; // 'added' — keep list order
	}
}

function applySortFilter() {
	const list = readList();
	if (!list.length) return;
	const mode = prefs.sort;
	const q = (searchInp?.value || '').trim().toLowerCase();
	const tierFilter = prefs.tier;

	// Sort a copy of the list. 'added' preserves list order (newest first).
	let ordered = list.slice();
	if (mode !== 'added') {
		ordered.sort((a, b) => {
			const va = sortValue(a, mode);
			const vb = sortValue(b, mode);
			if (mode === 'name') return String(va).localeCompare(String(vb));
			return Number(vb) - Number(va); // numeric: descending
		});
	}

	// FLIP the cards to their new order: capture current positions, move the same
	// nodes into rank order, then animate the deltas — so live data re-sorts glide
	// instead of snapping. Same nodes are reused, so this is a true FLIP.
	const flip = flipReorder(feedEl, (cardEl) => cardEl.dataset.mint || '');
	flip.capture();
	let visible = 0;
	for (const mint of ordered) {
		const card = cardEls.get(mint);
		if (!card) continue;
		feedEl.appendChild(card); // reorder in place

		const c = coinData.get(mint);
		const cv = convData.get(mint);
		const matchQ = !q || mint.toLowerCase().includes(q)
			|| (c?.symbol || '').toLowerCase().includes(q)
			|| (c?.name || '').toLowerCase().includes(q);
		const matchTier = tierFilter === 'all' || cv?.tier === tierFilter;
		const show = matchQ && matchTier;
		card.classList.toggle('wl-hidden', !show);
		if (show) visible++;
	}
	flip.play();

	renderNoMatch(visible === 0, q, tierFilter);
}

function renderNoMatch(empty, q, tier) {
	let node = document.getElementById('wl-nomatch');
	if (!empty) {
		if (node) node.remove();
		return;
	}
	const reason = q
		? `No watched coin matches “${q}”.`
		: `No watched coin is rated ${TIER_LABEL[tier] || tier} yet.`;
	const content = [
		el('p', { class: 'wl-nomatch-msg', text: reason }),
		el('button', { class: 'wl-btn wl-btn-ghost', type: 'button', text: 'Clear filters', onclick: clearFilters }),
	];
	if (node) {
		node.replaceChildren(...content);
	} else {
		node = el('div', { class: 'wl-nomatch', id: 'wl-nomatch' }, content);
		stateEl.replaceChildren(node);
	}
}

function clearFilters() {
	if (searchInp) searchInp.value = '';
	setSort('added');
	setTierFilter('all');
}

function setSort(mode) {
	prefs.sort = mode;
	savePrefs();
	if (sortSel && sortSel.value !== mode) sortSel.value = mode;
	applySortFilter();
}

function setTierFilter(tier) {
	prefs.tier = tier;
	savePrefs();
	if (filtersEl) {
		for (const btn of filtersEl.querySelectorAll('.wl-chip')) {
			const on = btn.dataset.tier === tier;
			btn.classList.toggle('is-active', on);
			btn.setAttribute('aria-pressed', String(on));
		}
	}
	applySortFilter();
}

function applyView() {
	const list = prefs.view === 'list';
	feedEl.classList.toggle('wl-grid--list', list);
	if (viewGrid) { viewGrid.classList.toggle('is-active', !list); viewGrid.setAttribute('aria-pressed', String(!list)); }
	if (viewList) { viewList.classList.toggle('is-active', list); viewList.setAttribute('aria-pressed', String(list)); }
}

function setView(view) {
	prefs.view = view;
	savePrefs();
	applyView();
}

// ── share / import ──────────────────────────────────────────────────────────

async function shareList() {
	const list = readList();
	if (!list.length) return;
	const url = `${location.origin}/watchlist?add=${list.join(',')}`;
	try {
		await navigator.clipboard.writeText(url);
		showAddMsg(`Link copied — opens this ${list.length}-coin watchlist anywhere.`, 'ok');
	} catch {
		// Clipboard blocked (insecure context / permission) — fall back to share sheet or prompt.
		if (navigator.share) {
			navigator.share({ title: 'My three.ws watchlist', url }).catch(() => {});
		} else {
			window.prompt('Copy your watchlist link:', url);
		}
	}
}

// Seed the watchlist from a `?add=mint,mint` link, then strip the param so a
// refresh doesn't re-import. Returns the count of newly added mints.
function importFromUrl() {
	const params = new URLSearchParams(location.search);
	const raw = params.get('add');
	if (!raw) return 0;
	const incoming = raw.split(',').map((m) => m.trim()).filter((m) => MINT_RE.test(m));
	let added = 0;
	if (incoming.length) {
		const list = readList();
		const have = new Set(list);
		const fresh = incoming.filter((m) => !have.has(m));
		if (fresh.length) {
			writeList([...fresh, ...list]);
			added = fresh.length;
		}
	}
	params.delete('add');
	const qs = params.toString();
	history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
	return added;
}

// ── ambient field (shared visual language) ──────────────────────────────────

function startParticleField() {
	const canvas = document.getElementById('wl-field');
	if (!canvas) return;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	let width = 0;
	let height = 0;
	let particles = [];
	let inkRGB = '232,232,232';
	let raf = 0;
	const readInk = () => {
		const scheme = getComputedStyle(document.documentElement).getPropertyValue('color-scheme');
		inkRGB = scheme.includes('light') ? '20,24,34' : '232,232,232';
	};
	const resize = () => {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		width = window.innerWidth;
		height = window.innerHeight;
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		const target = Math.min(60, Math.floor((width * height) / 32000));
		particles = Array.from({ length: target }, () => ({
			x: Math.random() * width,
			y: Math.random() * height,
			vx: (Math.random() - 0.5) * 0.1,
			vy: (Math.random() - 0.5) * 0.1,
			r: 0.6 + Math.random() * 1,
		}));
	};
	const draw = () => {
		ctx.clearRect(0, 0, width, height);
		for (const p of particles) {
			p.x += p.vx;
			p.y += p.vy;
			if (p.x < -10) p.x = width + 10;
			if (p.x > width + 10) p.x = -10;
			if (p.y < -10) p.y = height + 10;
			if (p.y > height + 10) p.y = -10;
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(${inkRGB},0.13)`;
			ctx.fill();
		}
		for (let i = 0; i < particles.length; i++) {
			for (let j = i + 1; j < particles.length; j++) {
				const a = particles[i];
				const b = particles[j];
				const dx = a.x - b.x;
				const dy = a.y - b.y;
				const d2 = dx * dx + dy * dy;
				if (d2 < 12100) {
					const alpha = 0.04 * (1 - Math.sqrt(d2) / 110);
					ctx.beginPath();
					ctx.moveTo(a.x, a.y);
					ctx.lineTo(b.x, b.y);
					ctx.strokeStyle = `rgba(${inkRGB},${alpha.toFixed(3)})`;
					ctx.lineWidth = 0.6;
					ctx.stroke();
				}
			}
		}
	};
	const loop = () => {
		draw();
		raf = requestAnimationFrame(loop);
	};
	readInk();
	resize();
	window.addEventListener('resize', resize, { passive: true });
	new MutationObserver(readInk).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
	if (REDUCED_MOTION) {
		draw();
		return;
	}
	loop();
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) cancelAnimationFrame(raf);
		else loop();
	});
}

// ── add by mint / URL ────────────────────────────────────────────────────────

function parseMintFromInput(raw) {
	const s = raw.trim();
	const urlMatch = s.match(/pump\.fun\/(?:coin|token)\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
	if (urlMatch) return urlMatch[1];
	if (MINT_RE.test(s)) return s;
	return null;
}

function addMint(mint) {
	const list = readList();
	if (list.includes(mint)) return 'already';
	writeList([mint, ...list]);
	render();
	return 'added';
}

function showAddMsg(msg, tone = 'ok') {
	const node = document.getElementById('wl-add-msg');
	if (!node) return;
	node.textContent = msg;
	node.className = `wl-add-msg wl-add-msg-${tone}`;
	node.hidden = false;
	clearTimeout(node._t);
	node._t = setTimeout(() => { node.hidden = true; }, 3500);
}

// ── wiring ───────────────────────────────────────────────────────────────────

const addForm  = document.getElementById('wl-add-form');
const addInput = document.getElementById('wl-add-input');

if (addForm && addInput) {
	addForm.addEventListener('submit', (e) => {
		e.preventDefault();
		const mint = parseMintFromInput(addInput.value);
		if (!mint) {
			showAddMsg('Paste a valid Solana mint address or pump.fun URL.', 'err');
			addInput.focus();
			return;
		}
		const result = addMint(mint);
		if (result === 'already') {
			showAddMsg('Already on your watchlist.', 'warn');
		} else {
			showAddMsg('Added — scroll down to see it.', 'ok');
			addInput.value = '';
		}
	});

	addInput.addEventListener('paste', (e) => {
		const pasted = (e.clipboardData || window.clipboardData)?.getData('text') || '';
		const mint = parseMintFromInput(pasted);
		if (mint) {
			e.preventDefault();
			const result = addMint(mint);
			showAddMsg(result === 'already' ? 'Already on your watchlist.' : 'Added — scroll down to see it.', result === 'already' ? 'warn' : 'ok');
		}
	});
}

clearBtn.addEventListener('click', () => {
	if (!readList().length) return;
	writeList([]);
	render();
});

if (alertsBtn) {
	updateAlertsBtn();
	alertsBtn.addEventListener('click', () => toggleAlerts());
}

if (shareBtn) shareBtn.addEventListener('click', shareList);

if (searchInp) {
	let t = 0;
	searchInp.addEventListener('input', () => {
		clearTimeout(t);
		t = setTimeout(() => applySortFilter(), 120);
	});
}
if (sortSel) {
	sortSel.value = prefs.sort;
	sortSel.addEventListener('change', () => setSort(sortSel.value));
}
if (filtersEl) {
	filtersEl.addEventListener('click', (e) => {
		const btn = e.target.closest('.wl-chip');
		if (btn) setTierFilter(btn.dataset.tier);
	});
}
if (viewGrid) viewGrid.addEventListener('click', () => setView('grid'));
if (viewList) viewList.addEventListener('click', () => setView('list'));

// Keep in sync if the user watches/unwatches a coin in another tab.
window.addEventListener('storage', (e) => {
	if (e.key === WATCH_KEY) render();
	if (e.key === ALERTS_KEY) updateAlertsBtn();
});

function scheduleRefresh() {
	clearTimeout(refreshTimer);
	refreshTimer = setTimeout(async () => {
		const list = readList();
		if (list.length) {
			await enrichWithOracleConviction(list);
			fetchMovers(list);
		}
		scheduleRefresh();
	}, REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
	if (document.hidden) clearTimeout(refreshTimer);
	else scheduleRefresh();
});

// ── boot ─────────────────────────────────────────────────────────────────────

const imported = importFromUrl();
// Reflect persisted prefs in the controls before first paint.
setTierFilter(prefs.tier);
applyView();
startParticleField();
render();
if (imported) showAddMsg(`Imported ${imported} coin${imported === 1 ? '' : 's'} from a shared link.`, 'ok');
scheduleRefresh();
