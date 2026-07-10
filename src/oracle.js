// Oracle — the fused pump.fun conviction war room.
//
// Reads /api/oracle/* (feed, coin, wallet, stream, watch, trades). Every
// surface degrades gracefully: if the backend isn't reachable yet (it deploys
// with the migration), the page shows an honest "warming up" state instead of
// breaking.
//
// Views: live conviction feed (with SSE), wallet reputation leaderboard,
// conviction-tier edge backtest, the agent action-loop arm panel, and the 3D
// force graph. The coin drawer also streams live trades via oracle-tape.js.

import { proxiedImageURL } from './ipfs.js';

const NETWORK = 'mainnet';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ── watchlist helpers (same key as launch-detail.js and watchlist.js) ────────
const WATCH_KEY = 'ld_watchlist';
function watchedMints() {
	try { return new Set(JSON.parse(localStorage.getItem(WATCH_KEY) || '[]')); } catch { return new Set(); }
}
function toggleOracleWatch(mint) {
	try {
		const list = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
		const idx = list.indexOf(mint);
		if (idx >= 0) list.splice(idx, 1); else list.unshift(mint);
		localStorage.setItem(WATCH_KEY, JSON.stringify(list.slice(0, 200)));
		return idx < 0;
	} catch { return false; }
}

// ── tiny helpers ─────────────────────────────────────────────────────────────
function setMeta(prop, content) {
	let el = document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`);
	if (!el) {
		el = document.createElement('meta');
		document.head.appendChild(el);
	}
	el.setAttribute(prop.startsWith('og:') || prop.startsWith('twitter:') ? 'property' : 'name', prop);
	el.setAttribute('content', content || '');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── token / NFT art proxy ────────────────────────────────────────────────────
// Route every remote image through the same-origin proxy (api/img.js) instead of
// hot-linking public IPFS gateways. Those gateways (ipfs.io, pinata, …) answer
// cross-origin <img> loads with no CORS/content-type headers the browser trusts,
// so it ORB-blocks them (net::ERR_BLOCKED_BY_ORB) and every piece of art on the
// page fails. The proxy fetches server-side across a gateway fallback list and
// ALWAYS returns a valid image — the real art or an on-brand placeholder — so the
// loader never sees a broken-image icon. Same pattern as src/radar.js.
//
// Returns the `src` + fallback attributes for an <img>. `seed` should be a stable
// per-token identifier (mint, symbol) so a given coin's placeholder art is unique
// and identical across loads. On error we drop to the seed-only placeholder (no
// upstream URL), clearing onerror first so a placeholder that itself fails cannot
// spin an error loop.
//
// The placeholder URL is carried in `data-ph` and read back via `this.dataset.ph`
// rather than interpolated into the onerror script. Seeds are attacker-controlled
// (a pump.fun launcher picks the token symbol), so splicing one into a quoted JS
// string literal would be an injection vector. Here the onerror body is a constant
// and both URLs only ever land in esc()'d attribute values.
function proxyImgAttrs(rawUrl, seed) {
	const s = String(seed || 'coin');
	const placeholder = `/api/img?${new URLSearchParams({ seed: s })}`;
	// Only remote art is proxied. Anything else — a javascript:/data: URI reaching
	// us through a creator-controlled feed — degrades to the placeholder instead.
	const src = rawUrl && /^(https?|ipfs|ar):\/\//i.test(String(rawUrl))
		? proxiedImageURL(String(rawUrl), s)
		: placeholder;
	return `src="${esc(src)}" data-ph="${esc(placeholder)}" onerror="this.onerror=null;this.src=this.dataset.ph"`;
}
const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '');
const fmtSol = (n) => (n == null ? '—' : `${Number(n) < 0.01 && Number(n) > 0 ? Number(n).toFixed(4) : Number(n).toFixed(2)}◎`);
const fmtPct = (n) => (n == null ? '—' : `${Math.round(Number(n))}%`);
// Compact USD for market stats: $2.1M, $465K, $1.2B, $0.00.
function fmtUsd(n) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	const abs = Math.abs(v);
	if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
	if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
	if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
	return `$${v.toFixed(2)}`;
}
// Token price: keep 3–4 significant figures for sub-cent memecoins.
function fmtPrice(n) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	if (v === 0) return '$0';
	if (v >= 1) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
	const decimals = Math.min(12, Math.max(4, 3 - Math.floor(Math.log10(v))));
	return `$${v.toFixed(decimals)}`;
}
const fmtInt = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(Number(n)).toLocaleString());
// Signed percent with an up/down class — for price-change chips.
function changeStr(n) {
	if (n == null || !Number.isFinite(Number(n))) return { txt: '—', cls: 'flat' };
	const v = Number(n);
	const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
	const txt = `${v > 0 ? '+' : ''}${v.toFixed(v <= -100 || v >= 100 ? 0 : 2)}%`;
	return { txt, cls };
}
const tierClass = (t) => `t-${t || 'avoid'}`;
const tierPill = (t) => `tp-${t || 'avoid'}`;
function ago(ts) {
	if (!ts) return '—';
	const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
	if (s < 60) return `${Math.floor(s)}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}
function solscan(addr) { return `https://solscan.io/account/${addr}`; }
function pumpUrl(mint) { return `https://pump.fun/coin/${mint}`; }
function winTweet(w) {
	const sym = (w.symbol || w.mint.slice(0, 6)).toUpperCase();
	const ath = w.ath_multiple != null ? `${Number(w.ath_multiple).toFixed(1)}×` : 'graduated';
	const score = w.score != null ? `${w.score}/100 ${w.tier}` : w.tier;
	const shareUrl = coinShareUrl(w.mint);
	const text = `Oracle called $${sym} (${score} conviction) — it went ${ath} 🔮\n\nproof.not.promises @trythreews\n${shareUrl}`;
	return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

function coinShareUrl(mint) {
	return `https://three.ws/oracle/coin/${encodeURIComponent(mint)}`;
}
function tweetConviction(c) {
	const tier = c.tier || 'watch';
	const score = c.score ?? '—';
	const symbol = c.symbol || '—';
	const shareUrl = coinShareUrl(c.mint);
	const text = `$${symbol} — ${score}/100 ${tier} conviction on @trythreews Oracle\n\nWho · How · What · Move all fused into one score.\n${shareUrl}`;
	return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

const CATEGORIES = ['meme', 'tech', 'ai', 'culture', 'community', 'political', 'news', 'animal', 'celebrity', 'utility', 'unknown'];
const TIER_ORDER = ['prime', 'strong', 'lean', 'watch', 'avoid'];
const TIER_COLOR = { prime: '#e8ebf2', strong: '#cdd2e0', lean: '#c4c9d6', watch: '#8a92a8', avoid: '#6c7280' };
const ARCH_TITLE = {
	smart_money: 'Smart Money', kol: 'KOL', top_dev: 'Top Dev', sniper: 'Sniper',
	dumper: 'Dumper', rugger: 'Rugger', fresh: 'Fresh', neutral: 'Neutral', unproven: 'Unproven',
};

async function api(path, opts = {}) {
	const ctrl = new AbortController();
	const to = setTimeout(() => ctrl.abort(), opts.timeout || 12000);
	try {
		const res = await fetch(path, { credentials: 'include', signal: ctrl.signal, ...opts });
		const data = await res.json().catch(() => null);
		return { ok: res.ok, status: res.status, data };
	} catch {
		return { ok: false, status: 0, data: null };
	} finally {
		clearTimeout(to);
	}
}

// ── state ────────────────────────────────────────────────────────────────────
const state = {
	view: 'feed',
	tier: '',
	category: '',
	minScore: 0,
	sort: 'score',         // 'score' | 'hot' | 'new'
	watchOnly: false,      // feed filtered to the local watchlist
	label: '',
	feed: new Map(),       // mint -> item, preserves SSE + initial load
	es: null,
	agents: [],
	agentId: null,
	watch: null,
	tape: null,            // { destroy() } handle from oracle-tape.js
};

// ── boot ─────────────────────────────────────────────────────────────────────
function boot() {
	// populate category filter
	const catSel = $('#catSel');
	for (const c of CATEGORIES) {
		const o = document.createElement('option');
		o.value = c; o.textContent = c[0].toUpperCase() + c.slice(1);
		catSel.appendChild(o);
	}

	// tabs — click + full keyboard support (roving tabindex per ARIA tablist).
	const tabs = $$('.tab');
	tabs.forEach((t, i) => {
		t.setAttribute('aria-selected', String(i === 0));
		t.tabIndex = i === 0 ? 0 : -1;
		t.addEventListener('click', () => switchView(t.dataset.view));
		t.addEventListener('keydown', (e) => {
			const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
				: e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
			if (dir) {
				e.preventDefault();
				const next = tabs[(i + dir + tabs.length) % tabs.length];
				next.focus(); switchView(next.dataset.view);
			} else if (e.key === 'Home') {
				e.preventDefault(); tabs[0].focus(); switchView(tabs[0].dataset.view);
			} else if (e.key === 'End') {
				e.preventDefault(); tabs[tabs.length - 1].focus(); switchView(tabs[tabs.length - 1].dataset.view);
			}
		});
	});
	// filters
	$('#tierSeg').addEventListener('click', (e) => {
		const b = e.target.closest('button'); if (!b) return;
		$$('#tierSeg button').forEach((x) => x.classList.toggle('on', x === b));
		state.tier = b.dataset.tier; syncFilterUrl(); loadFeed();
	});
	$('#catSel').addEventListener('change', (e) => {
		state.category = e.target.value;
		syncFilterUrl();
		loadFeed();
		$$('#hotSectors .hs-card').forEach((c) => c.classList.toggle('active', c.dataset.cat === state.category && !!state.category));
	});
	$('#minSel').addEventListener('change', (e) => { state.minScore = Number(e.target.value) || 0; syncFilterUrl(); loadFeed(); });
	$('#sortSeg').addEventListener('click', (e) => {
		const b = e.target.closest('[data-fsort]'); if (!b) return;
		$$('#sortSeg button').forEach((x) => x.classList.toggle('on', x === b));
		state.sort = b.dataset.fsort; syncFilterUrl(); renderFeed();
	});
	// Watchlist filter — folds the local ★ watchlist into the live feed.
	$('#watchToggle')?.addEventListener('click', () => {
		state.watchOnly = !state.watchOnly;
		syncWatchToggleUi();
		renderFeed();
	});
	// Conviction breadth bar — segments and legend chips filter the feed by tier.
	$('#breadthBar')?.addEventListener('click', (e) => {
		const el = e.target.closest('[data-tier]');
		if (el) applyTierFilter(el.dataset.tier);
	});
	const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
	const searchEl = $('#mintSearch');
	let _searchTimer = null;
	const _searchDrop = document.createElement('div');
	_searchDrop.id = 'mintSearchDrop';
	_searchDrop.className = 'ms-drop';
	_searchDrop.style.display = 'none';
	searchEl.parentNode?.insertBefore(_searchDrop, searchEl.nextSibling);

	function closeSearchDrop() { _searchDrop.style.display = 'none'; _searchDrop.innerHTML = ''; }

	async function doSymbolSearch(q) {
		if (!q || q.length < 2) { closeSearchDrop(); return; }
		const res = await fetch(`/api/oracle/search?q=${encodeURIComponent(q)}&network=${NETWORK}&limit=8`).catch(() => null);
		if (!res?.ok) { closeSearchDrop(); return; }
		const data = await res.json().catch(() => null);
		const items = data?.items || [];
		if (!items.length) { closeSearchDrop(); return; }
		const TCOL = { prime: '#e8ebf2', strong: '#e4e8f2', lean: '#c4c9d6', watch: '#8a92a8', avoid: '#6c7280' };
		_searchDrop.innerHTML = items.map((it) => {
			const col = TCOL[it.tier] || '#8a92a8';
			const label = it.symbol || it.name || it.mint.slice(0, 8);
			return `<button class="ms-item" data-mint="${esc(it.mint)}" type="button" aria-label="View ${esc(label)} conviction">
				<span class="ms-sym">${esc(label)}</span>
				<span class="ms-tier" style="color:${col}">${esc(it.tier || '')}${it.score != null ? ` ${it.score}` : ''}</span>
			</button>`;
		}).join('');
		_searchDrop.style.display = '';
	}

	searchEl.addEventListener('input', () => {
		const v = searchEl.value.trim();
		clearTimeout(_searchTimer);
		if (MINT_RE.test(v)) { closeSearchDrop(); return; }
		_searchTimer = setTimeout(() => doSymbolSearch(v), 280);
	});

	searchEl.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') { closeSearchDrop(); return; }
		if (e.key !== 'Enter') return;
		const v = searchEl.value.trim();
		if (MINT_RE.test(v)) { openCoin(v); searchEl.blur(); closeSearchDrop(); }
	});

	_searchDrop.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-mint]');
		if (!btn) return;
		openCoin(btn.dataset.mint);
		searchEl.value = '';
		closeSearchDrop();
		searchEl.blur();
	});

	document.addEventListener('click', (e) => {
		if (!searchEl.contains(e.target) && !_searchDrop.contains(e.target)) closeSearchDrop();
	});
	// movers filters
	$('#movDirSeg')?.addEventListener('click', (e) => {
		const b = e.target.closest('[data-movdir]'); if (!b) return;
		$$('#movDirSeg button').forEach((x) => x.classList.toggle('on', x === b));
		_moversState.direction = b.dataset.movdir; loadMovers(true);
	});
	$('#movHrSeg')?.addEventListener('click', (e) => {
		const b = e.target.closest('[data-movhr]'); if (!b) return;
		$$('#movHrSeg button').forEach((x) => x.classList.toggle('on', x === b));
		_moversState.hours = Number(b.dataset.movhr); loadMovers(true);
	});

	$('#labelSeg').addEventListener('click', (e) => {
		const b = e.target.closest('button'); if (!b) return;
		$$('#labelSeg button').forEach((x) => x.classList.toggle('on', x === b));
		state.label = b.dataset.label; loadWallets();
	});
	// proof filters
	$('#proofTierSeg')?.addEventListener('click', (e) => {
		const b = e.target.closest('[data-ptier]'); if (!b) return;
		$$('#proofTierSeg button').forEach((x) => x.classList.toggle('on', x === b));
		_proofState.tier = b.dataset.ptier; loadProof(true);
	});
	$('#proofPeriodSeg')?.addEventListener('click', (e) => {
		const b = e.target.closest('[data-pperiod]'); if (!b) return;
		$$('#proofPeriodSeg button').forEach((x) => x.classList.toggle('on', x === b));
		_proofState.period = b.dataset.pperiod; loadProof(true);
	});
	$('#proofLoadMoreBtn')?.addEventListener('click', () => {
		$('#proofLoadMoreBtn').disabled = true; loadProof(false);
	});
	// activity feed filters
	$('#afModeSeg')?.addEventListener('click', (e) => {
		const b = e.target.closest('[data-afmode]'); if (!b) return;
		$$('#afModeSeg button').forEach((x) => x.classList.toggle('on', x === b));
		_afState.mode = b.dataset.afmode; loadActivity(true);
	});
	$('#afTierSeg')?.addEventListener('click', (e) => {
		const b = e.target.closest('[data-aftier]'); if (!b) return;
		$$('#afTierSeg button').forEach((x) => x.classList.toggle('on', x === b));
		_afState.tier = b.dataset.aftier; loadActivity(true);
	});
	$('#afOutcomeSeg')?.addEventListener('click', (e) => {
		const b = e.target.closest('[data-afoutcome]'); if (!b) return;
		$$('#afOutcomeSeg button').forEach((x) => x.classList.toggle('on', x === b));
		_afState.outcome = b.dataset.afoutcome; loadActivity(true);
	});
	$('#afMoreBtn')?.addEventListener('click', () => {
		$('#afMoreBtn').disabled = true; loadActivity(false);
	});
	// follow agent panel — delegated on the leaderboard container
	document.addEventListener('click', (e) => {
		const followBtn = e.target.closest('.lrow-follow');
		if (!followBtn) return;
		const entry = followBtn.closest('.al-entry');
		if (!entry) return;
		const panel = entry.querySelector('.follow-panel');
		if (!panel) return;
		const open = followBtn.getAttribute('aria-expanded') === 'true';
		followBtn.setAttribute('aria-expanded', String(!open));
		panel.hidden = open;
		if (!open && !panel.dataset.loaded) {
			panel.dataset.loaded = '1';
			initFollowPanel(entry.dataset.agentId, panel);
		}
	});

	// drawer close
	$$('#drawer [data-close]').forEach((el) => el.addEventListener('click', closeDrawer));
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

	// Read initial filter state from URL — enables shareable filter links.
	const qs = new URLSearchParams(location.search);
	const VALID_TIERS = new Set(['prime', 'strong', 'lean', 'watch', 'avoid']);
	const VALID_SORTS = new Set(['score', 'hot', 'new']);
	const VALID_CATS = new Set(CATEGORIES);

	const qTier     = qs.get('tier') || '';
	const qCategory = qs.get('category') || '';
	const qMinScore = Math.max(0, Math.min(100, Number(qs.get('min_score')) || 0));
	const qSort     = qs.get('sort') || 'score';

	if (VALID_TIERS.has(qTier))    { state.tier     = qTier;     const b = $(`#tierSeg [data-tier="${qTier}"]`); if (b) { $$('#tierSeg button').forEach((x) => x.classList.toggle('on', x === b)); } }
	if (VALID_CATS.has(qCategory)) { state.category  = qCategory; const s = $('#catSel'); if (s) s.value = qCategory; }
	if (qMinScore)                 { state.minScore  = qMinScore; const s = $('#minSel'); if (s) s.value = String(qMinScore); }
	if (VALID_SORTS.has(qSort) && qSort !== 'score') { state.sort = qSort; const b = $(`#sortSeg [data-fsort="${qSort}"]`); if (b) { $$('#sortSeg button').forEach((x) => x.classList.toggle('on', x === b)); } }

	wireStatActions();
	syncWatchToggleUi();
	setupShortcuts(tabs);

	loadFeed();
	loadHotSectors();
	loadBreadth();
	openStream();

	// Keep the headline numbers honest while the page sits open: re-pull the
	// global stats and the conviction-breadth read on a slow cadence, but only
	// while the tab is visible so a backgrounded page costs nothing.
	setInterval(() => {
		if (document.hidden) return;
		loadGlobalStats();
		loadBreadth();
	}, 60000);

	// Restore the active tab from the URL hash so /oracle#wallets etc. deep-link,
	// and keep the browser back/forward buttons stepping through views.
	const hashView = location.hash.replace(/^#/, '');
	if (VIEWS.includes(hashView) && hashView !== 'feed') switchView(hashView, { updateHash: false });
	window.addEventListener('popstate', () => {
		const v = location.hash.replace(/^#/, '') || 'feed';
		switchView(VIEWS.includes(v) ? v : 'feed', { updateHash: false });
	});

	// If the page was opened with ?mint= (e.g. from a shared link or Telegram alert),
	// open that coin's drawer immediately after the feed loads.
	const MINT_RE2 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
	const initialMint = qs.get('mint');
	if (initialMint && MINT_RE2.test(initialMint)) openCoin(initialMint);
}

// Global keyboard shortcuts: "/" focuses search, 1–9 jump to a tab. Ignored
// while typing in a field or when a modifier is held.
function setupShortcuts(tabs) {
	document.addEventListener('keydown', (e) => {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const el = e.target;
		const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
		if (e.key === '/' && !typing) {
			e.preventDefault();
			const s = $('#mintSearch');
			if (s) { switchView('feed'); s.focus(); s.select(); }
			return;
		}
		if (typing) return;
		if ($('#drawer')?.classList.contains('open')) return;
		if (/^[1-9]$/.test(e.key)) {
			const tab = tabs[Number(e.key) - 1];
			if (tab) { e.preventDefault(); tab.focus(); switchView(tab.dataset.view); }
		}
	});
}

function syncFilterUrl() {
	const url = new URL(location.href);
	if (state.tier)     url.searchParams.set('tier', state.tier); else url.searchParams.delete('tier');
	if (state.category) url.searchParams.set('category', state.category); else url.searchParams.delete('category');
	if (state.minScore) url.searchParams.set('min_score', String(state.minScore)); else url.searchParams.delete('min_score');
	if (state.sort && state.sort !== 'score') url.searchParams.set('sort', state.sort); else url.searchParams.delete('sort');
	history.replaceState(null, '', url.toString());
}

const VIEWS = ['feed', 'movers', 'wallets', 'graph', 'edge', 'proof', 'agents', 'activity', 'agent'];

function switchView(view, { updateHash = true } = {}) {
	if (!VIEWS.includes(view)) view = 'feed';
	state.view = view;
	$$('.tab').forEach((t) => {
		const on = t.dataset.view === view;
		t.classList.toggle('on', on);
		t.setAttribute('aria-selected', String(on));
		t.tabIndex = on ? 0 : -1;
	});
	$$('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${view}`));
	// Keep the tab in the URL hash so views are shareable, bookmarkable, and the
	// browser back button steps through them. 'feed' is the default — no hash.
	if (updateHash) {
		const url = new URL(location.href);
		url.hash = view === 'feed' ? '' : view;
		history.replaceState(null, '', url.toString());
	}
	if (view === 'movers' && !$('#moversGrid').dataset.loaded) loadMovers();
	if (view === 'wallets' && !$('#walletWrap').dataset.loaded) loadWallets();
	if (view === 'edge' && !$('#edgeWrap').dataset.loaded) loadEdge();
	if (view === 'proof' && !$('#proofGrid').dataset.loaded) loadProof();
	if (view === 'agents' && !$('#agentLeadWrap').dataset.loaded) loadAgentLeaderboard();
	if (view === 'activity' && !$('#afTableWrap').dataset.loaded) loadActivity(true);
	if (view === 'agent' && !$('#armBody').dataset.loaded) loadAgentPanel();
	if (view === 'graph') loadGraph();
}

let graphHandle = null;
async function loadGraph() {
	const canvas = $('#og-canvas');
	const labels = $('#og-labels');
	const stateEl = $('#og-state');
	if (!canvas || canvas.dataset.loaded) return;
	canvas.dataset.loaded = '1';
	if (stateEl) stateEl.textContent = 'Loading conviction data…';
	try {
		const { mountOracleGraph } = await import('./oracle-graph.js');
		const q = new URLSearchParams({ network: NETWORK, limit: '80' });
		const { data } = await api(`/api/oracle/feed?${q}`);
		const coins = Array.isArray(data?.items) ? data.items : [];
		if (!coins.length) {
			if (stateEl) stateEl.textContent = 'No scored coins yet — check back once the Oracle has swept.';
			return;
		}
		if (stateEl) stateEl.textContent = '';
		graphHandle = mountOracleGraph(canvas, labels);
		graphHandle.loadCoins(coins);
	} catch (err) {
		if (stateEl) {
			stateEl.innerHTML = `<div class="state" style="padding:0"><b>Graph failed to load</b>${esc(err.message || 'The conviction data could not be reached. This is usually temporary.')}<div style="margin-top:14px"><button class="btn" type="button" id="ogRetry">Retry now</button></div></div>`;
			$('#ogRetry')?.addEventListener('click', () => {
				canvas.dataset.loaded = '';
				stateEl.textContent = '';
				loadGraph();
			});
		}
	}
}

// Open coin drawer from the 3D graph node click.
window.addEventListener('oracle:open-coin', (e) => {
	const mint = e.detail?.mint;
	if (mint) openCoin(mint);
});

// ── feed ─────────────────────────────────────────────────────────────────────
function feedSkeletons() {
	$('#feedGrid').innerHTML = Array.from({ length: 6 }, () => '<div class="skel"></div>').join('');
}

async function loadFeed() {
	feedSkeletons();
	const q = new URLSearchParams({ network: NETWORK, limit: '60' });
	if (state.tier) q.set('tier', state.tier);
	if (state.category) q.set('category', state.category);
	if (state.minScore) q.set('min_score', String(state.minScore));
	const { ok, data } = await api(`/api/oracle/feed?${q}`);

	if (!ok || !data) return renderFeedEmpty('warming');
	state.feed = new Map((data.items || []).map((it) => [it.mint, it]));
	setStats(data);
	renderFeed();
	if (Array.isArray(data.backtest)) cacheBacktest(data.backtest);
}

function syncWatchToggleUi() {
	const btn = $('#watchToggle');
	if (!btn) return;
	const on = state.watchOnly;
	btn.setAttribute('aria-pressed', String(on));
	btn.firstChild.textContent = on ? '★ Watching ' : '☆ Watching ';
	const ct = $('#watchCt');
	if (ct) ct.textContent = watchedMints().size ? watchedMints().size : '';
}

function renderFeed() {
	const sorter = state.sort === 'new'
		? (a, b) => new Date(b.scored_at || 0) - new Date(a.scored_at || 0)
		: state.sort === 'hot'
			? (a, b) => (Number(b.pillars?.momentum) || 0) - (Number(a.pillars?.momentum) || 0)
			: (a, b) => b.score - a.score;
	const watched = watchedMints();
	let items = [...state.feed.values()].sort(sorter);
	if (state.watchOnly) items = items.filter((it) => watched.has(it.mint));
	items = collapseCopycats(items, watched);
	syncWatchToggleUi();
	$('#ctFeed').textContent = items.length ? items.length : '';
	if (!items.length) return renderFeedEmpty(state.watchOnly ? 'watch' : 'empty');
	const grid = $('#feedGrid');
	grid.innerHTML = '';
	items.forEach((it) => grid.appendChild(coinCard(it, watched)));
}

// Copycat & bundle spam floods pump.fun — dozens of distinct mints launched
// with an identical symbol+name (the "deploy 100 more" and "America 250" runs),
// each landing on the same default conviction. Because every mint is its own
// row, the feed would render a wall of near-identical cards that reads like a
// bug. Fold each cluster into its single strongest representative — items arrive
// pre-sorted, so the first one seen (highest score / newest, per the active
// sort) wins — and tag it with the cluster size. A watched ★ mint is never
// folded away: a coin you're tracking always keeps its own card.
function collapseCopycats(items, watched = new Set()) {
	const repByKey = new Map();
	const out = [];
	for (const it of items) {
		const sym = (it.symbol || '').trim().toLowerCase();
		const name = (it.name || '').trim().replace(/\s+/g, ' ').toLowerCase();
		const key = (sym || name) ? `${sym}\u0000${name}` : null;
		if (!key || watched.has(it.mint)) { out.push(it); continue; }
		const rep = repByKey.get(key);
		if (rep) {
			rep._dupes += 1;
			rep._dupeMints.push(it.mint);
		} else {
			// Shallow clone so the dupe tally never mutates the cached feed item
			// (renderFeed runs on every SSE insert — mutation would double-count).
			const clone = { ...it, _dupes: 1, _dupeMints: [it.mint] };
			repByKey.set(key, clone);
			out.push(clone);
		}
	}
	return out;
}

function renderFeedEmpty(kind) {
	const grid = $('#feedGrid');
	$('#ctFeed').textContent = '';

	if (kind === 'warming') {
		grid.innerHTML = `<div class="state" style="grid-column:1/-1"><b>Oracle is warming up</b>The conviction engine ships with its backend — once the ingestion augmentor is live it scores every new pump.fun launch in real time. Check back shortly.</div>`;
		return;
	}

	if (kind === 'watch') {
		const hasWatched = watchedMints().size > 0;
		grid.innerHTML = hasWatched
			? `<div class="state" style="grid-column:1/-1"><b>None of your watched coins are scored right now</b>The coins on your watchlist haven't surfaced in the current conviction window. They'll reappear here the moment Oracle re-scores them.<div style="margin-top:14px"><button class="btn" type="button" id="watchClear">Show all coins</button></div></div>`
			: `<div class="state" style="grid-column:1/-1"><b>Your watchlist is empty</b>Tap the ☆ on any coin to track it — then this filter shows just your watched setups, scored live. It's shared with your launch watchlist across three.ws.<div style="margin-top:14px"><button class="btn" type="button" id="watchClear">Show all coins</button></div></div>`;
		$('#watchClear')?.addEventListener('click', () => {
			state.watchOnly = false;
			syncWatchToggleUi();
			renderFeed();
		});
		return;
	}

	// kind === 'empty' — the feed loaded, but nothing rendered. Distinguish
	// "no scored coins anywhere yet" from "your filters excluded everything".
	const hasFilters = !!(state.tier || state.category || state.minScore);
	if (!hasFilters) {
		grid.innerHTML = `<div class="state" style="grid-column:1/-1"><b>No launches scored yet</b>Oracle hasn't surfaced any conviction-scored coins in this window. New launches are scored the moment they hit pump.fun — they'll appear here automatically, no reload needed.</div>`;
		return;
	}

	grid.innerHTML = `<div class="state" style="grid-column:1/-1"><b>No launches clear your filters</b>There are scored coins, but none pass your current tier, narrative, or minimum-score filters. Loosen them to see more.<div style="margin-top:14px"><button class="btn" type="button" id="feedReset">Reset filters</button></div></div>`;
	$('#feedReset')?.addEventListener('click', resetFeedFilters);
}

function resetFeedFilters() {
	state.tier = '';
	state.category = '';
	state.minScore = 0;
	$$('#tierSeg button').forEach((x) => x.classList.toggle('on', x.dataset.tier === ''));
	const catSel = $('#catSel'); if (catSel) catSel.value = '';
	const minSel = $('#minSel'); if (minSel) minSel.value = '0';
	$$('#hotSectors .hs-card').forEach((c) => c.classList.remove('active'));
	syncFilterUrl();
	loadFeed();
}

// ── hot sectors ───────────────────────────────────────────────────────────────
async function loadHotSectors() {
	const el = $('#hotSectors');
	if (!el || el.dataset.loaded) return;
	el.dataset.loaded = '1';

	const { ok, data } = await api(`/api/oracle/categories?network=${NETWORK}&hours=24`);
	const items = ok && data ? (data.items || []) : [];
	if (!items.length) return;

	el.innerHTML = items.map((c) => {
		const initial = esc((c.best_symbol || c.category || '?')[0].toUpperCase());
		const imgEl = c.best_image_uri
			? `<img class="hs-img" ${proxyImgAttrs(c.best_image_uri, c.best_symbol || c.category)} alt="" loading="lazy"/>`
			: `<div class="hs-img">${initial}</div>`;
		const primeBadge  = c.prime_count  > 0 ? `<span class="hs-badge prime">${c.prime_count} prime</span>`   : '';
		const strongBadge = c.strong_count > 0 ? `<span class="hs-badge strong">${c.strong_count} strong</span>` : '';
		const totalBadge  = `<span class="hs-badge">${c.total} coins</span>`;
		return `<button class="hs-card" type="button" data-cat="${esc(c.category)}">
			<div class="hs-head">${imgEl}<div class="hs-cat">${esc(c.category)}</div></div>
			<div style="display:flex;align-items:baseline;gap:6px">
				<span class="hs-avg">${Math.round(c.avg_score)}</span>
				<span class="hs-avg-label">avg conviction</span>
			</div>
			<div class="hs-badges">${primeBadge}${strongBadge}${totalBadge}</div>
		</button>`;
	}).join('');

	el.style.display = '';

	// Sync active state with any pre-selected category from URL params.
	if (state.category) {
		const activeCard = el.querySelector(`[data-cat="${CSS.escape(state.category)}"]`);
		if (activeCard) activeCard.classList.add('active');
	}

	el.addEventListener('click', (e) => {
		const card = e.target.closest('.hs-card');
		if (!card) return;
		const cat = card.dataset.cat;
		// Toggle: clicking the active category again deselects it.
		state.category = state.category === cat ? '' : cat;
		syncFilterUrl();
		const catSel = $('#catSel');
		if (catSel) catSel.value = state.category;
		loadFeed();
		$$('#hotSectors .hs-card').forEach((c) => c.classList.toggle('active', c === card && !!state.category));
	});
}

// ── conviction breadth ─────────────────────────────────────────────────────────
// A market-breadth read: the live tier distribution across the full scored
// window, independent of the user's active feed filters. Each segment / legend
// chip filters the feed to that tier. Refreshed on its own cadence so it stays
// an honest gauge of "is the board hot or cold right now".
async function loadBreadth() {
	const { ok, data } = await api(`/api/oracle/feed?network=${NETWORK}&limit=200`);
	if (!ok || !Array.isArray(data?.items) || !data.items.length) return;
	renderBreadth(data.items);
}

function renderBreadth(items) {
	const bar = $('#breadthBar');
	if (!bar) return;
	const counts = Object.fromEntries(TIER_ORDER.map((t) => [t, 0]));
	let scoreSum = 0;
	for (const it of items) {
		if (counts[it.tier] != null) counts[it.tier]++;
		scoreSum += Number(it.score) || 0;
	}
	const total = items.length;
	const avg = Math.round(scoreSum / total);
	const hotPct = Math.round(((counts.prime + counts.strong) / total) * 100);

	const sub = $('#breadthSub');
	if (sub) sub.innerHTML = `${total} live · avg <b>${avg}</b> · ${hotPct}% strong+`;

	const track = $('#breadthTrack');
	if (track) {
		track.innerHTML = TIER_ORDER.filter((t) => counts[t] > 0).map((t) => {
			const pct = (counts[t] / total) * 100;
			return `<button class="breadth-seg" type="button" data-tier="${t}" style="width:${pct}%;background:${TIER_COLOR[t]}"
				title="${counts[t]} ${t} (${Math.round(pct)}%)" aria-label="${counts[t]} ${t} coins — filter the feed"></button>`;
		}).join('');
	}

	const legend = $('#breadthLegend');
	if (legend) {
		legend.innerHTML = TIER_ORDER.map((t) =>
			`<button class="breadth-leg ${state.tier === t ? 'on' : ''}" type="button" data-tier="${t}" aria-pressed="${state.tier === t}">
				<i style="background:${TIER_COLOR[t]}"></i>${t} <b>${counts[t]}</b></button>`
		).join('');
	}
	bar.style.display = '';
}

// Reflect the active tier filter on the breadth legend without a refetch.
function syncBreadthActive() {
	$$('#breadthLegend .breadth-leg').forEach((el) => {
		const on = el.dataset.tier === state.tier;
		el.classList.toggle('on', on);
		el.setAttribute('aria-pressed', String(on));
	});
}

// Shared tier-filter mutation used by the breadth bar (toggle semantics).
function applyTierFilter(tier) {
	state.tier = state.tier === tier ? '' : tier;
	$$('#tierSeg button').forEach((x) => x.classList.toggle('on', x.dataset.tier === state.tier));
	state.watchOnly = false;
	syncFilterUrl();
	syncBreadthActive();
	loadFeed();
}

function pillar(kind, label, val) {
	return `<div class="pil ${kind}"><div class="lab">${label}<b>${val ?? '—'}</b></div>
		<div class="track"><div class="fill" style="width:${Math.max(0, Math.min(100, val || 0))}%"></div></div></div>`;
}

// Inline conviction trajectory — a tiny SVG sparkline of the score over the last
// 24h. Trend-colored, with the live point dotted. Renders nothing for <2 points.
function miniSpark(points) {
	const pts = (points || []).map(Number).filter(Number.isFinite);
	if (pts.length < 2) return '';
	const W = 56, H = 18, pad = 2;
	const min = Math.min(...pts), max = Math.max(...pts);
	const span = max - min || 1;
	const n = pts.length;
	const xs = pts.map((_, i) => pad + (i / (n - 1)) * (W - pad * 2));
	const ys = pts.map((v) => pad + (1 - (v - min) / span) * (H - pad * 2));
	const delta = Math.round(pts[n - 1] - pts[0]);
	const col = delta > 2 ? 'var(--up)' : delta < -2 ? 'var(--down)' : 'var(--muted)';
	const poly = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
	const sign = delta > 0 ? '+' : '';
	return `<span class="coin-spark" title="Conviction ${sign}${delta} pts over the last 24h · ${n} readings">
		<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-label="Conviction trend ${sign}${delta} points over 24 hours">
			<polyline points="${poly}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
			<circle cx="${xs[n - 1].toFixed(1)}" cy="${ys[n - 1].toFixed(1)}" r="1.9" fill="${col}"/>
		</svg></span>`;
}

const TAKE_TIER = {
	prime:  'A prime setup',
	strong: 'A strong setup',
	lean:   'A lean call',
	watch:  'One to watch',
	avoid:  'Steer clear',
};
const TAKE_PILLAR = {
	pedigree: { hi: 'sharp wallets are already in', lo: 'no real pedigree behind it' },
	structure:{ hi: 'a clean, distributed launch', lo: 'the launch structure is shaky' },
	narrative:{ hi: 'a narrative with legs', lo: 'a thin story' },
	momentum: { hi: 'real buy pressure building', lo: 'momentum hasn\'t shown up' },
};
const TAKE_LABEL = { pedigree: 'Who', structure: 'How', narrative: 'What', momentum: 'Move' };

// Oracle's take — a deterministic one-line synthesis grounded in the same pillars
// the card already shows. Leads with the tier, names the strongest pillar, and is
// honest about the weakest when conviction isn't high. No LLM, no latency, no spin.
function oracleTake(it) {
	const p = it.pillars || {};
	const entries = ['pedigree', 'structure', 'narrative', 'momentum']
		.map((k) => ({ k, v: Number(p[k]) }))
		.filter((e) => Number.isFinite(e.v));
	if (!entries.length) return '';
	const strong = entries.reduce((a, b) => (b.v > a.v ? b : a));
	const weak = entries.reduce((a, b) => (b.v < a.v ? b : a));
	const tier = it.tier || 'watch';
	const lead = TAKE_TIER[tier] || 'One to watch';

	let body;
	if (tier === 'prime' || tier === 'strong') {
		body = `${TAKE_PILLAR[strong.k].hi}`;
		if (it.smart_wallet_count >= 3 && strong.k !== 'pedigree') body += `, with ${it.smart_wallet_count} smart-money wallets in`;
		if ((it.badges || []).includes('structure-flag')) body += ` — but watch the structure flag`;
		if ((it.badges || []).includes('pedigree-flag')) body += ` — but the creator has a rug history`;
	} else if (tier === 'lean') {
		body = `${TAKE_PILLAR[strong.k].hi}, but ${TAKE_PILLAR[weak.k].lo}`;
	} else {
		body = weak.v < 40 ? `${TAKE_PILLAR[weak.k].lo}` : `nothing here stands out yet`;
		if ((it.badges || []).includes('pedigree-flag')) body = `the creator wallet has a rug history`;
		else if ((it.badges || []).includes('structure-flag')) body = `the launch structure throws a flag`;
	}
	const cat = it.category && it.category !== 'unknown' ? ` Riding a ${esc(it.category)} narrative.` : '';
	return `<div class="coin-take"><span class="ct-q">“</span><span><b>${lead}</b> — ${body}.${cat}</span></div>`;
}

function coinCard(it, watched = new Set()) {
	const p = it.pillars || {};
	const BADGE_META = {
		'smart-money':    { cls: 'sm',   txt: 'smart-money',  title: '3+ proven wallets are already in' },
		'structure-flag': { cls: 'flag', txt: 'structure ⚑', title: 'A structural red flag (bundle, concentration, dumping dev) caps the score' },
		'pedigree-flag':  { cls: 'flag', txt: 'creator ⚑',   title: 'The creator wallet has a rug history — the score is ceilinged regardless of its buyers' },
		'thin-data':      { cls: 'thin', txt: 'thin data',    title: 'Much of this read rests on defaulted inputs — treat as a lead to watch, not a sized call' },
		'news':           { cls: 'news', txt: 'news',         title: 'Riding a live news story — fast but fragile' },
		'momentum':       { cls: 'mom',  txt: 'momentum',     title: 'Strong buy-side momentum' },
		'prime':          { cls: 'prime', txt: 'prime',       title: 'Top-tier conviction (86+)' },
	};
	const badges = (it.badges || []).map((b) => {
		const m = BADGE_META[b] || { cls: '', txt: b, title: '' };
		return `<span class="chip ${m.cls}"${m.title ? ` title="${esc(m.title)}"` : ''}>${esc(m.txt)}</span>`;
	}).join('');

	// A real link to the coin's full page: crawlable, cmd/ctrl/middle-click and
	// "open in new tab" all work. A plain left-click is intercepted to open the
	// in-feed drawer instead, so the fast quick-glance flow is unchanged.
	const btn = document.createElement('a');
	btn.className = `coin ${tierClass(it.tier)}`;
	btn.dataset.mint = it.mint;
	btn.href = `/oracle/coin/${encodeURIComponent(it.mint)}`;
	btn.setAttribute('aria-label', `View ${it.symbol || it.name || it.mint.slice(0, 8)} conviction — score ${it.score}, ${it.tier || 'unrated'} tier${it._dupes > 1 ? `, ${it._dupes} copycat mints share this name` : ''}`);
	btn.innerHTML = `
		<div class="coin-top">
			${it.image_uri
				? `<img class="coin-img" ${proxyImgAttrs(it.image_uri, it.mint)} alt="" loading="lazy">`
				: `<div class="coin-img">${esc((it.symbol || '?')[0])}</div>`}
			<div class="coin-id">
				<div class="coin-sym"><span class="sym-txt">${esc(it.symbol || '—')}</span>${it._dupes > 1
					? `<span class="dupe-badge" title="${it._dupes} distinct mints launched with this exact name — copycat or bundle spam. Showing the highest-conviction one.">×${it._dupes}</span>`
					: ''}</div>
				<div class="coin-name">${esc(it.name || it.mint.slice(0, 8))}</div>
			</div>
			<div class="dial">
				<b>${it.score}</b><span>conviction</span>
				<div class="tierpill ${tierPill(it.tier)}">${esc(it.tier)}</div>
				${miniSpark(it.spark)}
			</div>
		</div>
		${oracleTake(it)}
		<div class="pillars">
			${pillar('ped', 'Who', p.pedigree)}
			${pillar('str', 'How', p.structure)}
			${pillar('nar', 'What', p.narrative)}
			${pillar('mom', 'Move', p.momentum)}
		</div>
		<div class="coin-meta">
			${it.category ? `<span class="chip cat">${esc(it.category)}</span>` : ''}
			${it.smart_wallet_count ? `<span class="chip sm"><b>${it.smart_wallet_count}</b> smart in</span>` : ''}
			${badges}
			${it.coin_first_seen_at ? `<span class="chip" title="Launch age — first seen on pump.fun">age <b>${ago(it.coin_first_seen_at)}</b></span>` : ''}
			<span class="chip" title="When Oracle last scored this launch">scored ${ago(it.scored_at)} ago</span>
		</div>`;
	btn.addEventListener('click', (e) => {
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // let the browser handle new-tab/window opens
		e.preventDefault();
		openCoin(it.mint);
	});

	const isWatched = watched.has(it.mint);
	const watchBtn = document.createElement('button');
	watchBtn.className = `oc-watch${isWatched ? ' oc-watched' : ''}`;
	watchBtn.type = 'button';
	watchBtn.textContent = isWatched ? '★' : '☆';
	watchBtn.setAttribute('aria-label', isWatched ? 'Remove from watchlist' : 'Add to watchlist');
	watchBtn.setAttribute('aria-pressed', String(isWatched));
	watchBtn.title = isWatched ? 'Remove from watchlist' : 'Add to watchlist';
	watchBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		const nowWatched = toggleOracleWatch(it.mint);
		watchBtn.textContent = nowWatched ? '★' : '☆';
		watchBtn.classList.toggle('oc-watched', nowWatched);
		watchBtn.setAttribute('aria-pressed', String(nowWatched));
		watchBtn.setAttribute('aria-label', nowWatched ? 'Remove from watchlist' : 'Add to watchlist');
		watchBtn.title = nowWatched ? 'Remove from watchlist' : 'Add to watchlist';
	});

	const wrap = document.createElement('div');
	wrap.className = 'coin-wrap';
	wrap.appendChild(btn);
	wrap.appendChild(watchBtn);
	return wrap;
}

function setStats(data) {
	const items = data.items || [];
	// Populate from the feed window immediately, then override with the richer
	// global stats once /api/oracle/stats responds.
	$('#stScored').textContent = (data.count ?? items.length).toLocaleString();
	$('#stPrime').textContent  = items.filter((i) => i.tier === 'prime').length || '—';
	$('#stStrong').textContent = items.filter((i) => i.tier === 'strong').length || '—';
	loadGlobalStats();
}

async function loadGlobalStats() {
	try {
		const { ok, data } = await api('/api/oracle/stats');
		if (!ok || !data) return;
		const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };

		set('#stScored', (data.scored_24h ?? 0).toLocaleString());
		if (data.scored_total != null) set('#stScoredSub', `${data.scored_total.toLocaleString()} all-time`);

		set('#stPrime',  data.prime_count != null ? data.prime_count.toLocaleString() : '—');
		set('#stStrong', data.strong_count != null ? data.strong_count.toLocaleString() : '—');

		// Call win rate: Lean/Strong/Prime calls only. Null until real calls
		// resolve — show that honestly instead of substituting the market rate.
		set('#stWin', data.win_rate != null ? data.win_rate + '%' : '—');
		set('#stWinSub', data.total_resolved
			? `${(data.total_wins ?? 0).toLocaleString()} / ${data.total_resolved.toLocaleString()} calls resolved`
			: 'no calls resolved yet');
		const winEl = $('#stWin');
		if (winEl) winEl.classList.toggle('up', data.win_rate != null && data.win_rate >= 50);

		set('#stAth', data.best_ath != null ? Number(data.best_ath).toFixed(1) + '×' : '—');

		set('#stArmed', (data.agents_armed ?? 0).toLocaleString());
		set('#stArmedSub', data.open_actions != null ? `${data.open_actions.toLocaleString()} open positions` : '');
		set('#stOpenTrades', data.open_actions != null ? data.open_actions.toLocaleString() : '—');

		// Market base rate: every scored launch — the baseline the calls must beat.
		set('#stBase', data.market_base_rate != null ? data.market_base_rate + '%' : '—');
		set('#stBaseSub', data.market_resolved
			? `${(data.market_wins ?? 0).toLocaleString()} / ${data.market_resolved.toLocaleString()} launches`
			: '');
	} catch { /* non-fatal — feed-window fallbacks already rendered */ }
}

// Deep-link the hero KPIs: clicking a stat jumps to the surface that proves it.
function wireStatActions() {
	$('#statline')?.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-stat-action]');
		if (!btn) return;
		const action = btn.dataset.statAction;
		if (action === 'prime' || action === 'strong') {
			state.tier = action;
			$$('#tierSeg button').forEach((x) => x.classList.toggle('on', x.dataset.tier === action));
			state.watchOnly = false;
			syncWatchToggleUi();
			syncFilterUrl();
			loadFeed();
			switchView('feed');
			$('.tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		} else if (action === 'edge') {
			switchView('edge');
		} else if (action === 'proof') {
			switchView('proof');
		} else if (action === 'agents') {
			switchView('agents');
		}
	});
}

// ── live stream ──────────────────────────────────────────────────────────────
function openStream() {
	try {
		const es = new EventSource(`/api/oracle/stream?network=${NETWORK}`);
		state.es = es;
		es.addEventListener('hello', () => { setLive(true); });
		es.addEventListener('coin', (e) => {
			let it; try { it = JSON.parse(e.data); } catch { return; }
			onLiveCoin(it);
		});
		es.addEventListener('bye', () => { es.close(); setTimeout(openStream, 1500); });
		es.onerror = () => { setLive(false); es.close(); setTimeout(openStream, 4000); };
	} catch { setLive(false); }
}

function setLive(on) {
	$('#liveDot').classList.toggle('off', !on);
	$('#liveLabel').textContent = on ? 'Live · fused conviction' : 'Reconnecting…';
}

function onLiveCoin(it) {
	// passes active filters?
	if (state.tier && it.tier !== state.tier) return;
	if (state.category && it.category !== state.category) return;
	if (state.minScore && it.score < state.minScore) return;
	const isNew = !state.feed.has(it.mint);
	state.feed.set(it.mint, it);
	// Push fresh coin to the 3D graph if it's mounted.
	if (graphHandle?.addCoin) graphHandle.addCoin(it);
	if (state.view !== 'feed') return;
	renderFeed();
	if (isNew) {
		const el = $(`#feedGrid .coin[data-mint="${CSS.escape(it.mint)}"]`);
		if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 950); }
	}
}

// ── wallets ──────────────────────────────────────────────────────────────────
async function loadWallets() {
	const wrap = $('#walletWrap');
	wrap.innerHTML = '<div class="state">Loading the reputation graph…</div>';
	const q = new URLSearchParams({ leaderboard: '1', network: NETWORK, limit: '60' });
	if (state.label) q.set('label', state.label);
	const { ok, data } = await api(`/api/oracle/wallet?${q}`);
	wrap.dataset.loaded = '1';
	if (!ok) {
		wrap.innerHTML = `<div class="state"><b>Could not reach the reputation graph</b>The wallet leaderboard did not respond — this is usually temporary. The engine or network may be momentarily unavailable.<div style="margin-top:14px"><button class="btn" type="button" id="walletRetry">Retry now</button></div></div>`;
		$('#ctWallets').textContent = '';
		$('#walletRetry')?.addEventListener('click', () => loadWallets());
		return;
	}
	if (!data || !(data.items || []).length) {
		const filtered = !!state.label;
		wrap.innerHTML = filtered
			? `<div class="state"><b>No wallets match this label</b>No wallets carry the <b>${esc(state.label.replace('_', ' '))}</b> label yet. Switch back to <b>All</b> to see every ranked wallet.<div style="margin-top:14px"><button class="btn" type="button" id="walletReset">Show all wallets</button></div></div>`
			: `<div class="state"><b>No wallets ranked yet</b>The reputation graph fills in as coins resolve to outcomes. Once the brain has judged enough launches, the proven money surfaces here.</div>`;
		$('#ctWallets').textContent = '';
		$('#walletReset')?.addEventListener('click', () => {
			state.label = '';
			$$('#labelSeg button').forEach((x) => x.classList.toggle('on', x.dataset.label === ''));
			loadWallets();
		});
		return;
	}
	$('#ctWallets').textContent = data.items.length;
	wrap.innerHTML = `
		<div class="lhead"><span>#</span><span>Wallet</span><span class="colhide">Win rate</span><span>Early win</span><span>Score</span></div>
		${data.items.map((w, i) => walletRow(w, i)).join('')}`;
	$$('#walletWrap .lrow').forEach((r) => r.addEventListener('click', () => openWallet(r.dataset.wallet)));
}

function walletRow(w, i) {
	const a = w.archetype || { label: w.label, title: ARCH_TITLE[w.label] || 'Unproven' };
	return `<div class="lrow-wrap">
		<button class="lrow" data-wallet="${esc(w.wallet)}">
			<span class="lrank ${i < 3 ? 'top' : ''}">${i + 1}</span>
			<span class="lw"><span class="nlabel lb-${esc(w.label)}">${esc(a.title)}</span><span class="lw-addr">${esc(shortAddr(w.wallet))}</span></span>
			<span class="lstat colhide"><b>${fmtPct(w.win_rate)}</b></span>
			<span class="lstat"><b>${fmtPct(w.early_win_rate)}</b></span>
			<span class="lscore">${Math.round(w.score)}</span>
		</button>
		<a class="lrow-copy" href="/trader/${encodeURIComponent(w.wallet)}" title="Trader profile + copy trades">→</a>
	</div>`;
}

// ── oracle agent leaderboard ──────────────────────────────────────────────────
async function loadAgentLeaderboard() {
	const wrap = $('#agentLeadWrap');
	wrap.dataset.loaded = '1';
	wrap.innerHTML = '<div class="state">Loading agent rankings…</div>';
	const { ok, data } = await api(`/api/oracle/leaderboard?network=${NETWORK}&limit=30&min_actions=1`);
	const agents = ok && data ? (data.agents || []) : [];
	if (!agents.length) {
		wrap.innerHTML = `<div class="state"><b>No ranked agents yet</b>Once oracle agents have resolved enough conviction calls, they appear here ranked by win rate. Agents in simulate mode are included — their track records are just as honest.</div>`;
		$('#ctAgents').textContent = '';
		return;
	}
	$('#ctAgents').textContent = agents.length;
	wrap.innerHTML = `
		<div class="alhead"><span>#</span><span>Agent</span><span class="colhide">Actions</span><span>Win rate</span><span>PnL ◎</span></div>
		${agents.map((a, i) => agentLeadRow(a, i)).join('')}`;
	bindFollowHandlers(wrap);
}

function bindFollowHandlers(wrap) {
	wrap.addEventListener('click', (e) => {
		const btn = e.target.closest('.lrow-follow');
		if (!btn) return;
		e.preventDefault();
		const entry = btn.closest('.al-entry');
		const panel = entry?.querySelector('.follow-panel');
		if (!panel) return;
		const opening = panel.hidden;
		panel.hidden = !opening;
		btn.setAttribute('aria-expanded', String(opening));
		if (opening) panel.querySelector('.fp-chat')?.focus();
	});

	wrap.addEventListener('input', (e) => {
		const slider = e.target.closest('.fp-score');
		if (!slider) return;
		const label = slider.closest('.fp-score-field')?.querySelector('.fp-score-val');
		if (label) label.textContent = slider.value;
	});

	wrap.addEventListener('submit', async (e) => {
		const form = e.target.closest('.follow-form');
		if (!form) return;
		e.preventDefault();
		const entry = form.closest('.al-entry');
		const agentId = entry?.dataset.agentId;
		const chatId = form.querySelector('.fp-chat')?.value.trim();
		const minScore = Number(form.querySelector('.fp-score')?.value) || 54;
		const msg = form.querySelector('.fp-msg');
		if (!chatId) { showFpMsg(msg, 'Enter your Telegram chat ID or @handle', 'err'); return; }
		localStorage.setItem('oracle_follow_chat', chatId);
		showFpMsg(msg, 'Subscribing…', '');
		const { ok, data } = await api('/api/oracle/follow', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ agent_id: agentId, chat_id: chatId, min_score: minScore }),
		});
		if (ok) {
			showFpMsg(msg, data?.action === 'updated' ? 'Updated ✓' : 'Subscribed ✓', 'ok');
		} else {
			showFpMsg(msg, data?.message || 'Failed', 'err');
		}
	});

	wrap.addEventListener('click', async (e) => {
		const btn = e.target.closest('.fp-unsub');
		if (!btn) return;
		const form = btn.closest('.follow-form');
		const entry = form?.closest('.al-entry');
		const agentId = entry?.dataset.agentId;
		const chatId = form?.querySelector('.fp-chat')?.value.trim();
		const msg = form?.querySelector('.fp-msg');
		if (!chatId) { showFpMsg(msg, 'Enter your chat ID first', 'err'); return; }
		showFpMsg(msg, 'Unsubscribing…', '');
		const { ok } = await api('/api/oracle/follow', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ agent_id: agentId, chat_id: chatId }),
		});
		showFpMsg(msg, ok ? 'Unsubscribed' : 'Failed', ok ? 'ok' : 'err');
	});
}

function showFpMsg(el, text, cls) {
	if (!el) return;
	el.textContent = text;
	el.className = `fp-msg${cls ? ` fp-msg-${cls}` : ''}`;
}

async function initFollowPanel(agentId, panel) {
	if (!agentId) return;
	const chatInput = panel.querySelector('.fp-chat');
	const savedChat = localStorage.getItem('oracle_follow_chat') || '';
	if (chatInput && savedChat) {
		chatInput.value = savedChat;
		// Also cache for next open
		chatInput.addEventListener('change', () => {
			if (chatInput.value.trim()) localStorage.setItem('oracle_follow_chat', chatInput.value.trim());
		});
	}
	if (!savedChat) return;
	const { ok, data } = await api(
		`/api/oracle/follow?agent_id=${encodeURIComponent(agentId)}&chat_id=${encodeURIComponent(savedChat)}&network=${NETWORK}`
	);
	if (!ok || !data?.following) return;
	const msg = panel.querySelector('.fp-msg');
	if (msg) showFpMsg(msg, 'Already following', 'ok');
	if (data.min_score != null) {
		const slider = panel.querySelector('.fp-score');
		const val    = panel.querySelector('.fp-score-val');
		if (slider) slider.value = String(data.min_score);
		if (val)    val.textContent = String(data.min_score);
	}
}

function agentLeadRow(a, i) {
	const winRate = a.win_rate != null ? `${a.win_rate}%` : '—';
	const wrClass = (a.win_rate || 0) >= 50 ? 'up' : 'dn';
	const pnlVal = a.realized_pnl_sol != null ? Number(a.realized_pnl_sol) : null;
	const pnlStr = pnlVal != null ? `${pnlVal >= 0 ? '+' : ''}${Math.abs(pnlVal) < 0.01 ? pnlVal.toFixed(4) : pnlVal.toFixed(3)}` : '—';
	const pnlClass = pnlVal != null ? (pnlVal >= 0 ? 'up' : 'dn') : '';
	const img = a.image_url
		? `<img class="ag-av" ${proxyImgAttrs(a.image_url, a.agent_id || a.name)} alt="" loading="lazy" />`
		: `<div class="ag-av ag-av-ph">${esc((a.name || '?')[0].toUpperCase())}</div>`;
	const subLine = `${a.wins}W / ${a.losses}L${a.roi_pct != null ? ` · ROI ${a.roi_pct >= 0 ? '+' : ''}${a.roi_pct}%` : ''}`;
	return `<div class="al-entry" data-agent-id="${esc(a.agent_id)}">
		<div class="lrow-wrap">
			<a class="alrow lrow" href="/agents/${encodeURIComponent(a.agent_id)}" target="_blank" rel="noopener">
				<span class="lrank ${i < 3 ? 'top' : ''}">${i + 1}</span>
				<span class="lw">${img}
					<span>
						<div class="ag-name">${esc(a.name || shortAddr(a.agent_id))}</div>
						<div class="ag-wl colhide">${esc(subLine)}</div>
					</span>
				</span>
				<span class="lstat colhide">${a.total}</span>
				<span class="lstat"><b class="${wrClass}">${winRate}</b></span>
				<span class="lstat"><b class="${pnlClass}">${pnlStr}</b></span>
			</a>
			<a class="lrow-copy" href="/trader/${encodeURIComponent(a.agent_id)}#tp-copy-panel" title="Copy this agent" rel="noopener">→</a>
			<button class="lrow-follow" type="button" title="Follow agent signals on Telegram" aria-label="Follow agent on Telegram">+</button>
		</div>
		<div class="follow-panel" hidden>
			<form class="follow-form" autocomplete="off">
				<div class="fp-field">
					<label class="fp-label">Telegram chat ID or @handle</label>
					<input type="text" class="fp-chat" placeholder="@handle or -100…" spellcheck="false" />
				</div>
				<div class="fp-field fp-score-field">
					<label class="fp-label">Min conviction score: <b class="fp-score-val">54</b></label>
					<input type="range" class="fp-score" min="36" max="100" value="54" step="1" />
				</div>
				<div class="fp-actions">
					<button type="submit" class="fp-sub">Subscribe</button>
					<button type="button" class="fp-unsub">Unsubscribe</button>
					<span class="fp-msg"></span>
				</div>
			</form>
		</div>
	</div>`;
}

// ── activity feed ─────────────────────────────────────────────────────────────
const _afState = { mode: '', tier: '', outcome: '', cursor: null, loading: false };

async function loadActivity(reset = false) {
	if (_afState.loading) return;
	_afState.loading = true;
	const wrap = $('#afTableWrap');
	wrap.dataset.loaded = '1';
	if (reset) { _afState.cursor = null; wrap.innerHTML = afSkeletons(8); }

	const params = new URLSearchParams({ network: NETWORK, limit: '40' });
	if (_afState.mode)    params.set('mode',    _afState.mode);
	if (_afState.tier)    params.set('tier',    _afState.tier);
	if (_afState.outcome) params.set('outcome', _afState.outcome);
	if (_afState.cursor)  params.set('before',  _afState.cursor);

	const { ok, data } = await api(`/api/oracle/activity?${params}`);
	_afState.loading = false;

	const items = ok && data ? (data.items || []) : [];
	if (!items.length && reset) {
		wrap.innerHTML = `<div class="state"><b>No actions yet</b>Once Oracle-armed agents make their first call, the floor lights up here — every buy, every outcome, in real time.</div>`;
		$('#ctActivity').textContent = '';
		$('#afMore').style.display = 'none';
		return;
	}

	if (reset) {
		wrap.innerHTML = afTableHtml(items);
	} else {
		const tbody = wrap.querySelector('tbody');
		if (tbody) tbody.insertAdjacentHTML('beforeend', items.map(afRow).join(''));
	}

	_afState.cursor = data?.next_before || null;
	const moreEl = $('#afMore');
	const moreBtn = $('#afMoreBtn');
	moreEl.style.display = _afState.cursor ? '' : 'none';
	if (moreBtn) moreBtn.disabled = false;
	const total = data?.summary?.total ?? data?.total ?? null;
	if (reset && total != null) $('#ctActivity').textContent = total;
}

function afSkeletons(n) {
	return `<div class="af-outer">${Array.from({length: n}, () => '<div class="af-skel" style="height:46px;border-bottom:1px solid rgba(255,255,255,0.04)"></div>').join('')}</div>`;
}

function afTableHtml(items) {
	return `<div class="af-outer"><table class="af-table"><thead><tr>
		<th scope="col">Agent</th><th scope="col">Coin</th><th scope="col">Tier</th><th scope="col">Score</th><th scope="col">Size ◎</th><th scope="col">Mode</th><th scope="col">Outcome</th><th scope="col">PnL ◎</th><th scope="col">When</th>
	</tr></thead><tbody>${items.map(afRow).join('')}</tbody></table></div>`;
}

function afRow(a) {
	const av = a.agent_image
		? `<img class="af-av" ${proxyImgAttrs(a.agent_image, a.agent_id || a.agent_name)} alt="" loading="lazy">`
		: `<div class="af-av" style="display:grid;place-items:center;font:700 11px/1 var(--mono);color:var(--faint)">${esc((a.agent_name || '?')[0].toUpperCase())}</div>`;
	const outcome = a.outcome || 'open';
	const outCls = outcome === 'win' ? 'af-outcome-win' : outcome === 'loss' ? 'af-outcome-loss' : 'af-outcome-open';
	const outLabel = outcome === 'win'
		? `✓ Win${a.peak_multiple ? ` ${Number(a.peak_multiple).toFixed(1)}×` : ''}`
		: outcome === 'loss' ? '✗ Loss' : '—';
	const pnl = a.realized_pnl_sol != null ? Number(a.realized_pnl_sol) : null;
	const pnlStr = pnl != null ? `${pnl >= 0 ? '+' : ''}${Math.abs(pnl) < 0.01 ? pnl.toFixed(4) : pnl.toFixed(3)}` : '—';
	const pnlCls = pnl != null ? (pnl >= 0 ? 'up' : 'dn') : '';
	const modeBadge = a.mode === 'live' ? '<span class="act-live">live</span>' : '<span class="act-sim">sim</span>';
	return `<tr class="af-row">
		<td class="af-agent">${av}<a class="af-name" href="/trader/${encodeURIComponent(a.agent_id)}" target="_blank" rel="noopener">${esc(a.agent_name || 'Agent')}</a></td>
		<td class="af-coin"><a href="${esc(a.pump_url)}" target="_blank" rel="noopener">${esc(a.symbol || a.mint?.slice(0, 6) || '?')}</a></td>
		<td><span class="tierpill ${tierPill(a.tier)}">${esc(a.tier || '—')}</span></td>
		<td class="af-mono">${a.conviction ?? '—'}</td>
		<td class="af-mono">${a.size_sol != null ? Number(a.size_sol).toFixed(3) : '—'}</td>
		<td>${modeBadge}</td>
		<td class="${outCls}">${outLabel}</td>
		<td class="af-mono ${pnlCls}">${pnlStr}</td>
		<td class="af-mono" style="color:var(--faint);font-size:11px">${a.acted_at ? ago(a.acted_at) + ' ago' : '—'}</td>
	</tr>`;
}

// ── edge (backtest) ──────────────────────────────────────────────────────────
let _backtest = null;
function cacheBacktest(bt) {
	// Normalize old { tier, scored, resolved, grad_rate, avg_ath_multiple } rows
	// into the richer format from /api/oracle/backtest if the feed returns both.
	if (!_backtest && Array.isArray(bt)) _backtest = { by_tier: bt, aggregate: null, top_performers: [] };
	if ($('#edgeWrap').dataset.loaded) renderEdge();
}

async function loadEdge() {
	const wrap = $('#edgeWrap');
	wrap.dataset.loaded = '1';
	wrap.innerHTML = '<div class="state">Loading performance data…</div>';
	const { ok, data } = await api(`/api/oracle/backtest?period=30d&network=${NETWORK}`);
	if (ok && data) {
		_backtest = data;
	} else if (!_backtest) {
		// Fallback: try to get the old format from the feed
		const { data: feed } = await api(`/api/oracle/feed?network=${NETWORK}&limit=1`);
		if (feed?.backtest) _backtest = { by_tier: feed.backtest, aggregate: null, top_performers: [] };
	}
	renderEdge();
}

function renderEdge() {
	const wrap = $('#edgeWrap');
	const bt = _backtest;
	const tiers = bt?.by_tier || [];
	const rows = tiers.filter((r) => (r.total || r.scored || 0) > 0);

	if (!rows.length) {
		wrap.innerHTML = `<div class="state"><b>The edge is still proving itself.</b> Win-rate by tier appears once Oracle has scored coins that have since resolved to an outcome. This is intentionally honest — no backfilled numbers.</div>`;
		return;
	}

	const agg = bt?.aggregate;
	const edge = bt?.edge;

	// ── verdict hero: does conviction beat blind buying? ──────────────────────
	let hero = '';
	if (edge && edge.prime_win_rate == null && edge.baseline_win_rate != null) {
		// No Prime calls have resolved yet — say so instead of implying an edge.
		hero = `
			<div class="edge-hero thin">
				<p class="edge-hero-claim">No Prime calls have resolved yet — the edge is unproven, and we say so.</p>
				<p class="edge-hero-sub">Across <b style="color:var(--ink)">${(edge.baseline_n || 0).toLocaleString()}</b> resolved launches, buying everything blind wins <b style="color:var(--ink)">${edge.baseline_win_rate}%</b> of the time (graduated, or ≥2× without rugging). That's the market's base rate, not Oracle's skill. Prime/Strong call win rates appear here the moment real calls resolve — never backfilled, never cherry-picked.</p>
			</div>`;
	}
	if (edge && edge.prime_win_rate != null && edge.baseline_win_rate != null) {
		const lift = edge.prime_lift;
		const mult = edge.edge_multiple;
		const beats = lift != null && lift > 0;
		const mono = edge.monotonic;
		hero = `
			<div class="edge-hero${beats ? '' : ' thin'}">
				<p class="edge-hero-claim">Prime calls win <b class="win">${edge.prime_win_rate}%</b> of the time${beats ? `, vs <b>${edge.baseline_win_rate}%</b> for a coin picked at random` : ''}.</p>
				<p class="edge-hero-sub">${beats
					? `That's a <b style="color:var(--ink)">+${lift} point</b> lift over blind buying${mult ? ` — <b style="color:var(--ink)">${mult}×</b> the base rate` : ''}. ${mono ? 'And the win rate climbs with the score at every band — the ranking is calibrated, not noise.' : 'The ladder isn\'t fully monotonic yet — treat lower bands with caution.'}`
					: `Conviction isn't beating the market over this window yet. We show it anyway — no cherry-picking.`}</p>
				<div class="edge-hero-metrics">
					<span class="edge-chip ${beats ? 'ok' : ''}"><b class="${beats ? 'up' : ''}">${lift != null ? (lift >= 0 ? '+' : '') + lift + 'pt' : '—'}</b><span>edge lift</span></span>
					${mult ? `<span class="edge-chip"><b>${mult}×</b><span>vs base rate</span></span>` : ''}
					${edge.brier != null ? `<span class="edge-chip" title="Mean squared error of the score (as a probability) vs the real outcome. Lower = better calibrated. 0.25 = a coin-flip."><b>${edge.brier.toFixed(3)}</b><span>brier</span></span>` : ''}
					<span class="edge-chip ${mono ? 'ok' : ''}"><b class="${mono ? 'up' : ''}">${mono ? 'monotonic' : 'mixed'}</b><span>ranking</span></span>
					${edge.baseline_n ? `<span class="edge-chip"><b>${edge.baseline_n.toLocaleString()}</b><span>resolved</span></span>` : ''}
				</div>
			</div>`;
	}

	const aggLine = agg && agg.total > 0 ? `
		<div class="edge-agg">
			<div class="edge-kpi"><span>Total scored</span><b>${agg.total.toLocaleString()}</b></div>
			<div class="edge-kpi" title="Across ALL scored tiers, Watch/Avoid included — the market, not the calls"><span>Win rate (all scored)</span><b class="${(agg.win_rate||0) >= 50 ? 'up' : 'dn'}">${agg.win_rate != null ? agg.win_rate + '%' : '—'}</b>${agg.ci ? `<span class="ci">95% CI ${agg.ci.lo}–${agg.ci.hi}</span>` : ''}</div>
			<div class="edge-kpi"><span>Wins</span><b class="up">${agg.wins}</b></div>
			<div class="edge-kpi"><span>Losses</span><b class="dn">${agg.losses}</b></div>
			<div class="edge-kpi"><span>Graduated</span><b>${agg.graduated}</b></div>
			<div class="edge-kpi"><span>Rugged</span><b>${agg.rugged}</b></div>
			<div class="edge-kpi"><span>≥ 5×</span><b>${agg.five_x}</b></div>
			<div class="edge-kpi"><span>≥ 10×</span><b>${agg.ten_x}</b></div>
		</div>` : '';

	// ── calibration ladder: realized win rate by score band ───────────────────
	const cal = (bt?.calibration || []).filter((c) => c.n != null);
	const calHtml = cal.length ? `
		<div class="dr-sec edge-sec">Calibration — realized win rate by score band</div>
		<div class="cal">
			${cal.slice().reverse().map(calRow).join('')}
			<div class="cal-legend">
				<span><i class="li-real"></i>Realized win rate (bar fill)</span>
				<span><i class="li-pred"></i>What the band predicts (midpoint)</span>
				<span style="color:var(--faint)">A calibrated engine keeps the bar near the marker, climbing band over band.</span>
			</div>
		</div>` : '';

	const top = bt?.top_performers?.slice(0, 5) || [];
	const topHtml = top.length ? `
		<div class="dr-sec edge-sec">Top performers (by ATH)</div>
		<div class="edge-top">
			${top.map((t) => `<a class="edge-top-row" href="https://pump.fun/coin/${esc(t.mint)}" target="_blank" rel="noopener">
				<span class="tierpill ${tierPill(t.tier)}">${esc(t.tier)}</span>
				<b>${esc(t.symbol || t.mint.slice(0, 6))}</b>
				<span class="edge-ath">${t.ath_multiple ? Number(t.ath_multiple).toFixed(1) + '×' : t.graduated ? '✓ grad' : '—'}</span>
			</a>`).join('')}
		</div>` : '';

	wrap.innerHTML = `
		${hero}
		${aggLine}
		<div class="dr-sec edge-sec">Win rate by conviction tier</div>
		<div class="edge">
			<div class="ehead"><span>Tier</span><span>Win rate (95% CI)</span><span class="colhide">Wins / Losses</span><span>Avg ATH×</span><span>≥ 5×</span></div>
			${rows.map(edgeRow).join('')}
		</div>
		${calHtml}
		${topHtml}
		<p style="font-size:11px;color:var(--faint);margin-top:18px">Win = graduated, OR ATH ≥ 2× on a coin that did not rug — a 2× wick on the way to zero doesn't count. Loss = rugged OR ATH &lt; 1.2×. Open positions excluded. Confidence intervals are Wilson 95% — wide bands mean a thin sample, not a weak edge. 30-day window.</p>`;
}

function edgeRow(r) {
	// Support both old format (grad_rate, scored) and new format (win_rate, total, wins, losses, ci)
	const winRate = r.win_rate ?? r.grad_rate ?? null;
	const wins = r.wins ?? 0;
	const losses = r.losses ?? 0;
	const resolved = wins + losses;
	const ath = r.avg_ath ? Number(r.avg_ath).toFixed(1) : (r.avg_ath_multiple ? Number(r.avg_ath_multiple).toFixed(1) : null);
	const fiveX = r.five_x ?? 0;
	const thin = resolved > 0 && resolved < 8; // too few to trust — dim it, but show it
	const ci = r.ci && resolved ? `<span class="ci">${r.ci.lo}–${r.ci.hi}${thin ? ' · thin' : ''}</span>` : '';
	return `<div class="erow${thin ? ' thin' : ''}"${thin ? ' title="Small sample — wide confidence band"' : ''}>
		<span><span class="tierpill ${tierPill(r.tier)}">${esc(r.tier)}</span></span>
		<span><div class="gradbar"><i style="width:${winRate ?? 0}%"></i></div><span class="lstat" style="text-align:left"><b>${winRate != null ? winRate + '%' : '—'}</b>${ci}</span></span>
		<span class="lstat colhide">${wins} / ${losses}</span>
		<span class="lstat"><b>${ath ? ath + '×' : '—'}</b></span>
		<span class="lstat">${fiveX}</span>
	</div>`;
}

function calRow(c) {
	const real = c.realized;
	const hasData = real != null && c.n > 0;
	const thin = hasData && c.n < 5;
	return `<div class="cal-row${hasData ? '' : ' empty'}">
		<div class="cal-band">${esc(c.band)}<small>n=${c.n || 0}${thin ? ' · thin' : ''}</small></div>
		<div class="cal-track" role="img" aria-label="band ${esc(c.band)}: realized ${hasData ? real + '%' : 'no data'}, predicted ${c.predicted}%">
			<div class="cal-real" style="width:${hasData ? real : 0}%"></div>
			<div class="cal-pred" style="left:${c.predicted}%"></div>
		</div>
		<div class="cal-val">${hasData ? `${real}%` : '<span style="color:var(--faint)">—</span>'}<small>pred ${c.predicted}%</small></div>
	</div>`;
}

// ── proof / wins gallery ──────────────────────────────────────────────────────

const _proofState = { tier: '', period: '30d', cursor: null, loading: false };

// ── movers ──────────────────────────────────────────────────────────────────
const _moversState = { direction: 'rising', hours: 24 };

function moverCardHtml(m) {
	const tier = m.tier || 'watch';
	const deltaSign = m.delta >= 0 ? '+' : '';
	const deltaCls = m.delta >= 0 ? 'up' : 'dn';
	const imgSrc = m.image_uri
		? `<img class="mv-img" ${proxyImgAttrs(m.image_uri, m.mint)} alt="" loading="lazy">`
		: `<div class="mv-img">${esc((m.symbol || '?')[0])}</div>`;
	const TIER_META = { prime: { color: '#e8ebf2' }, strong: { color: '#e4e8f2' }, lean: { color: '#c4c9d6' }, watch: { color: '#8a92a8' }, avoid: { color: '#6c7280' } };
	const tierColor = (TIER_META[tier] || TIER_META.watch).color;

	const pil = (val, key) => {
		const v = Math.max(0, Math.min(100, Number(val) || 0));
		const labels = { pedigree: 'Who', structure: 'How', narrative: 'What', momentum: 'Move' };
		return `<div class="mv-pil">
			<div class="mv-pil-label">${labels[key] || key}</div>
			<div class="mv-pil-bar"><div class="mv-pil-fill" style="width:${v}%"></div></div>
		</div>`;
	};

	const tierChangedHtml = m.tier_changed
		? `<div class="mv-tier-change">Tier: ${esc(m.first_tier)} → ${esc(m.tier)}</div>`
		: '';

	return `<div class="mv-card mv-${m.delta >= 0 ? 'rising' : 'falling'}" role="button" tabindex="0"
		data-mint="${esc(m.mint)}">
		<div class="mv-head">
			${imgSrc}
			<div class="mv-id">
				<div class="mv-sym">${esc(m.symbol || m.mint.slice(0, 8))}</div>
				<div class="mv-name">${esc(m.name || '')}</div>
			</div>
			<div class="mv-delta">
				<div class="mv-delta-val ${deltaCls}">${deltaSign}${m.delta}</div>
				<div class="mv-delta-label">score Δ</div>
			</div>
		</div>
		<div class="mv-scores">
			<span style="color:var(--muted)">${m.first_score ?? '?'}</span>
			<span class="mv-arrow">→</span>
			<span class="mv-score-cur" style="color:${tierColor}">${m.score ?? '?'}</span>
			<span class="tierpill tp-${tier}" style="margin-left:4px;padding:1px 6px;font-size:10px">${tier}</span>
			${m.category ? `<span style="color:var(--faint);font-size:11px;margin-left:auto">${esc(m.category)}</span>` : ''}
		</div>
		${tierChangedHtml}
		<div class="mv-pillars">
			${pil(m.pillars?.pedigree, 'pedigree')}
			${pil(m.pillars?.structure, 'structure')}
			${pil(m.pillars?.narrative, 'narrative')}
			${pil(m.pillars?.momentum, 'momentum')}
		</div>
	</div>`;
}

async function loadMovers(reset = false) {
	const grid = $('#moversGrid');
	if (!grid) return;
	if (grid.dataset.loaded !== '1') {
		const openFromCard = (el) => {
			const mint = el?.dataset?.mint;
			if (mint) openCoin(mint);
		};
		grid.addEventListener('click', (e) => openFromCard(e.target.closest('.mv-card')));
		grid.addEventListener('keydown', (e) => {
			if (e.key !== 'Enter' && e.key !== ' ') return;
			const card = e.target.closest('.mv-card');
			if (!card) return;
			e.preventDefault();
			openFromCard(card);
		});
	}
	grid.dataset.loaded = '1';

	const skels = Array.from({ length: 6 }, () =>
		'<div class="skel" style="height:160px;border-radius:var(--r)"></div>'
	).join('');
	if (reset || !grid.children.length) grid.innerHTML = skels;

	const { direction, hours } = _moversState;
	const { ok, data } = await api(
		`/api/oracle/movers?network=${NETWORK}&direction=${direction}&hours=${hours}&limit=40`
	);

	if (!ok || !data?.items?.length) {
		grid.innerHTML = `<div class="state" style="grid-column:1/-1">
			<b>No movers yet in this window.</b>
			Conviction deltas appear once Oracle re-scores the same coins in the selected window.
			${direction === 'rising' ? 'Try the 48h window or check back as more coins get re-scored.' : ''}
		</div>`;
		return;
	}

	grid.innerHTML = data.items.map(moverCardHtml).join('');
}

function winCardHtml(w, idx) {
	const tier = w.tier || 'watch';
	const athStr = w.ath_multiple != null ? `${Number(w.ath_multiple).toFixed(1)}×` : w.graduated ? 'Grad ✓' : '—';
	const imgSrc = w.image_uri || '';
	const sym = esc((w.symbol || w.mint.slice(0, 6)).toUpperCase());
	const scoreColor = tier === 'prime' ? 'var(--up)' : tier === 'strong' ? 'var(--up)' : tier === 'lean' ? 'var(--gold)' : 'var(--muted)';
	const pillars = w.pillars || {};
	const pil = (k, cls, lbl) => {
		const v = pillars[k] != null ? Math.round(Number(pillars[k])) : null;
		return `<div class="win-pil ${cls}">
			<label>${lbl}<b>${v != null ? v : '?'}</b></label>
			<div class="win-pil-bar"><div class="win-pil-fill" style="width:${v ?? 0}%"></div></div>
		</div>`;
	};
	const when = w.scored_at ? ago(w.scored_at) : '';
	return `<a class="win-card win-in" href="${esc(w.oracle_url)}" style="animation-delay:${Math.min(idx * 40, 400)}ms">
		<div class="win-card-head">
			<div class="win-img">${imgSrc ? `<img ${proxyImgAttrs(imgSrc, w.mint)} alt="" style="width:42px;height:42px;border-radius:10px;object-fit:cover" loading="lazy" />` : sym.slice(0, 2)}</div>
			<div class="win-id">
				<div class="win-sym">$${sym}</div>
				${w.name ? `<div class="win-name">${esc(w.name)}</div>` : ''}
			</div>
			<div class="win-ath">
				<span class="win-ath-val">${esc(athStr)}</span>
				<span class="win-ath-label">ATH</span>
			</div>
		</div>
		<div class="win-body">
			<div class="win-score-row">
				<span class="win-score-label">Oracle at entry</span>
				<span class="win-score-val" style="color:${scoreColor}">${w.score != null ? w.score : '—'}</span>
				<span class="tierpill tp-${tier}" style="margin-left:6px">${tier}</span>
			</div>
			<div class="win-pillars">
				${pil('pedigree', 'ped', 'Who')}${pil('structure', 'str', 'How')}${pil('narrative', 'nar', 'What')}${pil('momentum', 'mom', 'Move')}
			</div>
			<div class="win-badges">
				${w.graduated ? '<span class="win-grad">Graduated</span>' : ''}
				<span class="win-when">${esc(when)}</span>
			</div>
			<div class="win-links">
				<a class="win-link" href="${esc(w.pump_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">pump.fun ↗</a>
				<a class="win-link" href="${esc(w.oracle_url)}" onclick="event.stopPropagation()">Oracle ↗</a>
				<a class="win-link" style="margin-left:auto;color:var(--muted)" href="${esc(winTweet(w))}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Share on X">Share ↗</a>
			</div>
		</div>
	</a>`;
}

function proofSkeletons(n = 6) {
	return Array.from({ length: n }, () => '<div class="skel" style="height:220px;border-radius:var(--r)"></div>').join('');
}

async function loadProof(reset = false) {
	if (_proofState.loading) return;
	_proofState.loading = true;
	const grid = $('#proofGrid');
	grid.dataset.loaded = '1';
	if (reset) { _proofState.cursor = null; grid.innerHTML = proofSkeletons(); }

	const url = `/api/oracle/wins?network=${NETWORK}&period=${_proofState.period}&limit=24&min_ath=2`;
	const q = url + (_proofState.tier ? `&tier=${_proofState.tier}` : '') + (_proofState.cursor ? `&before=${_proofState.cursor}` : '');

	const { ok, data } = await api(q);
	_proofState.loading = false;

	if (!ok || !data?.items) {
		if (reset) grid.innerHTML = `<div class="state" style="grid-column:1/-1"><b>No proved wins yet.</b><br>Once Oracle-scored coins resolve to a positive outcome, they appear here. The engine is scoring live.</div>`;
		return;
	}

	const items = data.items || [];
	if (reset) {
		grid.innerHTML = items.length ? items.map(winCardHtml).join('') : `<div class="state" style="grid-column:1/-1"><b>No ${_proofState.tier === 'all' ? '' : 'called '}wins resolved yet in this period.</b><br>${_proofState.tier === 'all'
			? 'Try a longer window or check back as more coins resolve.'
			: 'This gallery only counts coins Oracle rated Lean or above — no cherry-picking winners it never called. Try a longer window, or switch to “All scored” to see the whole market.'}</div>`;
	} else {
		items.forEach((w, i) => grid.insertAdjacentHTML('beforeend', winCardHtml(w, i)));
	}

	_proofState.cursor = data.next_before || null;
	const moreWrap = $('#proofLoadMore');
	const moreBtn  = $('#proofLoadMoreBtn');
	moreWrap.style.display = _proofState.cursor ? '' : 'none';
	if (moreBtn) { moreBtn.disabled = false; }

	// Render KPIs on first load
	if (reset && data.summary) {
		const kpis = $('#proofKpis');
		const s = data.summary;
		kpis.style.display = '';
		kpis.innerHTML = [
			['Wins', s.total_wins ?? 0, 'up'],
			['Best ATH', s.best_ath != null ? `${Number(s.best_ath).toFixed(1)}×` : '—', 'up'],
			['5× or more', s.five_x_count ?? 0, ''],
			['10× or more', s.ten_x_count ?? 0, ''],
			['Graduated', s.graduated_count ?? 0, ''],
		].map(([l, v, cls]) => `<div class="proof-kpi"><span>${l}</span><b class="${cls}">${v}</b></div>`).join('');
		const ctProof = $('#ctProof');
		if (ctProof && s.total_wins) ctProof.textContent = s.total_wins;
	}
}

// ── coin drawer ──────────────────────────────────────────────────────────────
async function openCoin(mint) {
	const dr = $('#drawer');
	dr.classList.add('open'); dr.setAttribute('aria-hidden', 'false');
	$('#drTitle').textContent = 'Loading…';
	$('#drBody').innerHTML = '<div class="state">Reading the order book…</div>';
	// Update URL so this conviction view is shareable / bookmarkable.
	const url = new URL(location.href);
	url.searchParams.set('mint', mint);
	history.replaceState(null, '', url.toString());
	const { ok, data } = await api(`/api/oracle/coin?mint=${encodeURIComponent(mint)}&network=${NETWORK}`);
	if (!ok || !data || !data.conviction) {
		$('#drTitle').textContent = 'Not observed yet';
		$('#drBody').innerHTML = `<div class="state"><b>This launch hasn't been scored</b>Oracle scores coins as they surface on pump.fun. If it's brand new, it'll appear here within moments — the full coin page already streams its live market and trade tape.
			<div style="margin-top:14px"><a class="dr-act" href="/oracle/coin/${encodeURIComponent(mint)}">Open full coin page ↗</a></div></div>`;
		return;
	}
	renderDrawer(data);
}

function structurePanel(st) {
	if (!st) return '';
	const pct = (n) => (n == null ? '—' : `${Math.round(Number(n))}%`);
	const bar = (val, color) => `<div class="str-track"><div class="str-fill" style="width:${Math.max(0,Math.min(100,val||0))}%;background:${color}"></div></div>`;
	const organic  = Number(st.organicScore  ?? 0);
	const bundle   = Number(st.bundleScore   ?? 0);
	const top10    = Number(st.top10Pct      ?? 0);
	const connect  = Number(st.bubblemapConnectivity ?? 0);
	const devSold  = Number(st.devSoldPct    ?? 0);
	const devBuy   = st.creatorHoldPct != null ? `${Math.round(Number(st.creatorHoldPct))}%` : '—';
	const buyers   = st.uniqueBuyers   ?? '—';
	const bundleFl = st.bundleFlag;
	if (!st.organicScore && !st.bundleScore && !st.top10Pct && !st.bubblemapConnectivity) return '';
	return `
		<div class="dr-sec">Structure <span style="color:var(--faint);font-weight:400;font-size:10px">wallet graph · buy pattern</span></div>
		<div class="str-grid">
			<div class="str-row">
				<span class="str-lbl">Organic buy</span>
				${bar(organic, 'var(--up)')}
				<span class="str-val" style="color:var(--up)">${pct(organic)}</span>
			</div>
			<div class="str-row">
				<span class="str-lbl">Bundle / coord</span>
				${bar(bundle, bundleFl ? 'var(--down)' : 'var(--amber)')}
				<span class="str-val" style="color:${bundleFl ? 'var(--down)' : 'var(--amber)'}">${pct(bundle)}${bundleFl ? ' ⚑' : ''}</span>
			</div>
			${top10 ? `<div class="str-row">
				<span class="str-lbl">Top 10 hold</span>
				${bar(top10, top10 > 60 ? 'var(--down)' : 'var(--gold)')}
				<span class="str-val" style="color:${top10 > 60 ? 'var(--down)' : 'var(--gold)'}">${pct(top10)}</span>
			</div>` : ''}
			${connect ? `<div class="str-row">
				<span class="str-lbl">Graph density</span>
				${bar(connect, connect > 50 ? 'var(--down)' : 'var(--muted)')}
				<span class="str-val" style="color:${connect > 50 ? 'var(--down)' : 'var(--muted)'}">${pct(connect)}</span>
			</div>` : ''}
		</div>
		<div class="coin-meta" style="margin-top:10px">
			${buyers !== '—' ? `<span class="chip">buyers <b>${buyers}</b></span>` : ''}
			${devBuy !== '—' ? `<span class="chip ${devSold > 50 ? 'flag' : ''}">dev hold <b>${devBuy}</b>${devSold > 20 ? ` · sold ${Math.round(devSold)}%` : ''}</span>` : ''}
		</div>`;
}


// Oracle's take for the drawer — leads with the tier+score, then weaves the two
// highest-contribution reasons the engine actually computed into one sentence.
function drawerTake(d) {
	const c = d.conviction || {};
	const lead = TAKE_TIER[c.tier] || 'One to watch';
	const rs = (d.reasons || []).map((r) => r.text).filter(Boolean);
	if (!rs.length) return '';
	const body = rs.slice(0, 2).map((t) => t.replace(/\.$/, '')).join('; ');
	return `<div class="coin-take" style="font-size:13.5px;margin:10px 0 4px"><span class="ct-q">“</span><span><b>${esc(lead)} at ${c.score}</b> — ${esc(body)}.</span></div>`;
}

function renderDrawer(d) {
	const c = d.conviction; const p = c.pillars || {};
	$('#drTitle').innerHTML = `<a href="/oracle/coin/${encodeURIComponent(c.mint)}" style="color:inherit;text-decoration:none" title="Open the full conviction page">${esc(c.symbol || '—')} <span style="color:var(--muted);font:600 13px var(--mono)">${esc(c.name || '')}</span></a>`;
	const reasons = (d.reasons || []).map((r) => `<div class="reason"><span class="rdot ${esc(r.pillar)}"></span><span>${esc(r.text)}</span></div>`).join('') || '<div class="state">No breakdown available.</div>';
	const narr = d.narrative;
	const whos = (d.whos_in || []).map(whoRow).join('') || '<div class="state">No wallet footprint recorded yet.</div>';
	const out = d.outcome;
	$('#drBody').innerHTML = `
		<div style="display:flex;align-items:center;gap:18px;margin-bottom:6px">
			<div class="dial ${tierClass(c.tier)}" style="text-align:left">
				<b style="font-size:40px">${c.score}</b>
				<div class="tierpill ${tierPill(c.tier)}">${esc(c.tier)} conviction</div>
			</div>
			<div style="flex:1" class="pillars">
				${pillar('ped', 'Who', p.pedigree)}
				${pillar('str', 'How', p.structure)}
				${pillar('nar', 'What', p.narrative)}
				${pillar('mom', 'Move', p.momentum)}
			</div>
		</div>
		${drawerTake(d)}
		<div class="dr-actions">
			<a class="dr-act" href="/oracle/coin/${encodeURIComponent(c.mint)}" title="Open the full conviction page">Full page ↗</a>
			<a class="dr-act" href="${pumpUrl(c.mint)}" target="_blank" rel="noopener">pump.fun ↗</a>
			<a class="dr-act" href="${solscan(c.mint)}" target="_blank" rel="noopener">solscan ↗</a>
			<a class="dr-act" href="/launches/${esc(c.mint)}" target="_blank" rel="noopener">Details ↗</a>
			<a class="dr-act" href="/coin3d?mint=${encodeURIComponent(c.mint)}" target="_blank" rel="noopener" title="Open the full 3D coin profile">View in 3D ↗</a>
			<button class="dr-act dr-watch" id="drWatch" data-mint="${esc(c.mint)}" type="button" aria-pressed="${watchedMints().has(c.mint)}">${watchedMints().has(c.mint) ? '★ Watching' : '☆ Watch'}</button>
			<button class="dr-act" id="drCopyMint" type="button" title="Copy mint address" data-mint="${esc(c.mint)}">Copy mint</button>
			<button class="dr-act" id="drCopyLink" type="button" title="Copy shareable link" data-link="${esc(coinShareUrl(c.mint))}">Copy link</button>
			<a class="dr-act dr-share" href="${tweetConviction(c)}" target="_blank" rel="noopener" title="Share conviction on X">Share ↗</a>
			${c.structure_cap != null && c.structure_cap < 60 ? `<span class="note warn">structural cap ${c.structure_cap}</span>` : ''}
			${d.components?.pedigree_cap != null && d.components.pedigree_cap < 60 ? `<span class="note warn">creator cap ${d.components.pedigree_cap}</span>` : ''}
			${d.components?.confidence != null ? `<span class="note ${d.components.confidence >= 70 ? 'ok' : d.components.confidence >= 45 ? '' : 'warn'}" title="How much of this read rests on real data vs. defaulted inputs">data confidence ${d.components.confidence}% · ${esc(d.components.confidence_label || '')}</span>` : ''}
		</div>
		<div id="scoreHistoryWrap" style="margin-top:12px"></div>
		<div id="marketWrap" class="mkt-loading" aria-busy="true">
			<div class="dr-sec">Market <span style="color:var(--faint);font-weight:400;font-size:10px">live</span></div>
			<div class="mkt-skel"><span></span><span></span><span></span><span></span><span></span><span></span></div>
		</div>
		${narr ? `<div class="dr-sec">Narrative</div><div style="font-size:13.5px;color:var(--ink)">${esc(narr.narrative || '')}</div>
			<div class="coin-meta" style="margin-top:8px"><span class="chip cat">${esc(narr.category)}</span><span class="chip">virality <b>${narr.virality ?? '—'}</b></span><span class="chip">${esc(narr.source || '')}</span></div>` : ''}
		<div class="dr-sec">Why this score</div>${reasons}
		<div id="communityPulseWrap"></div>
		${structurePanel(d.components?.structure)}
		<div class="dr-sec">Who's in <span style="color:var(--faint)">(${(d.whos_in || []).length})</span></div>${whos}
		${out ? `<div class="dr-sec">Outcome</div><div class="coin-meta">
			<span class="chip ${out.graduated ? 'sm' : out.rugged ? 'flag' : ''}">${out.graduated ? 'graduated ✓' : out.rugged ? 'rugged ✕' : 'live'}</span>
			${out.ath_multiple ? `<span class="chip">ATH <b>${Number(out.ath_multiple).toFixed(1)}×</b></span>` : ''}</div>` : ''}
		<div class="dr-sec">Live trades</div>
		<div id="tradeTape" class="trade-tape"></div>
		<div id="drProofTradesWrap"></div>
	`;

	// Fetch and render conviction score history sparkline + community sentiment.
	loadScoreHistory(c.mint);
	loadCoinMarket(c.mint);
	loadSentimentPulse(c.mint);
	loadProofTrades(c.mint);

	// Update OG / Twitter meta so shared links carry the coin's conviction card.
	const ogImg    = `https://three.ws/api/oracle/og?mint=${encodeURIComponent(c.mint)}`;
	const ogTitle  = `$${c.symbol || c.mint.slice(0, 8)} — ${c.score ?? '?'}/100 ${c.tier || ''} conviction · Oracle`;
	const ogDesc   = `Oracle scored this launch ${c.score ?? '?'}/100 (${c.tier || 'unscored'}). Who · How · What · Move — all fused into one signal.`;
	setMeta('og:title',            ogTitle);
	setMeta('og:description',      ogDesc);
	setMeta('og:image',            ogImg);
	setMeta('og:url',              `https://three.ws/oracle/coin/${encodeURIComponent(c.mint)}`);
	setMeta('twitter:card',        'summary_large_image');
	setMeta('twitter:title',       ogTitle);
	setMeta('twitter:description', ogDesc);
	setMeta('twitter:image',       ogImg);

	// Tear down any previous tape, then mount fresh for this coin.
	state.tape?.destroy();
	state.tape = null;
	const tapeEl = $('#tradeTape');
	if (tapeEl) {
		import('./oracle-tape.js').then(({ mountTradeTape }) => {
			// Guard: drawer may have been closed while the import was in flight.
			if (!$('#tradeTape')) return;
			state.tape = mountTradeTape(tapeEl, { mint: c.mint, network: NETWORK });
		}).catch(() => {
			if (tapeEl) tapeEl.innerHTML = '<div class="state" style="padding:16px 0">Trade feed unavailable.</div>';
		});
	}

	// Watch toggle
	const watchBtn = $('#drWatch');
	if (watchBtn) {
		watchBtn.addEventListener('click', () => {
			toggleOracleWatch(c.mint);
			const now = watchedMints().has(c.mint);
			watchBtn.textContent = now ? '★ Watching' : '☆ Watch';
			watchBtn.setAttribute('aria-pressed', String(now));
			// Reflect on the coin card in the feed grid if visible.
			const cardEl = document.querySelector(`#feedGrid .coin[data-mint="${CSS.escape(c.mint)}"]`);
			const cardWatchBtn = cardEl?.querySelector('.oc-watch');
			if (cardWatchBtn) {
				cardWatchBtn.textContent = now ? '★' : '☆';
				cardWatchBtn.classList.toggle('oc-watched', now);
				cardWatchBtn.setAttribute('aria-pressed', String(now));
			}
		});
	}

	// Copy mint address
	const copyMintBtn = $('#drCopyMint');
	if (copyMintBtn) {
		copyMintBtn.addEventListener('click', () => {
			navigator.clipboard.writeText(c.mint).then(() => {
				const orig = copyMintBtn.textContent;
				copyMintBtn.textContent = 'Copied!';
				setTimeout(() => { copyMintBtn.textContent = orig; }, 1800);
			}).catch(() => {});
		});
	}

	const copyLinkBtn = $('#drCopyLink');
	if (copyLinkBtn) {
		copyLinkBtn.addEventListener('click', () => {
			const link = copyLinkBtn.dataset.link || coinShareUrl(c.mint);
			navigator.clipboard.writeText(link).then(() => {
				const orig = copyLinkBtn.textContent;
				copyLinkBtn.textContent = 'Copied!';
				setTimeout(() => { copyLinkBtn.textContent = orig; }, 1800);
			}).catch(() => {});
		});
	}

	// Load related coins in same category (async — does not block drawer)
	if (c.category) loadRelatedCoins(c.mint, c.category);
}

async function loadRelatedCoins(mint, category) {
	const whosSec = $('#drBody')?.querySelector('.dr-sec:last-of-type');
	if (!whosSec || !$('#drBody')) return;

	const { ok, data } = await api(
		`/api/oracle/feed?network=${NETWORK}&category=${encodeURIComponent(category)}&limit=6&min_score=60`
	);
	if (!ok || !data?.items?.length) return;
	if (!$('#drBody')) return; // drawer closed while fetching

	const related = data.items.filter((it) => it.mint !== mint).slice(0, 3);
	if (!related.length) return;

	const TIER_META = { prime: { color: '#e8ebf2' }, strong: { color: '#e4e8f2' }, lean: { color: '#c4c9d6' }, watch: { color: '#8a92a8' }, avoid: { color: '#6c7280' } };

	const html = `<div class="dr-sec" style="margin-top:16px">Related · ${esc(category)}</div>
		<div style="display:flex;flex-direction:column;gap:6px">
			${related.map((r) => {
				const tc = (TIER_META[r.tier] || TIER_META.watch).color;
				const imgEl = r.image_uri
					? `<img ${proxyImgAttrs(r.image_uri, r.mint)} alt="" style="width:28px;height:28px;border-radius:7px;object-fit:cover;flex:none;border:1px solid var(--line)" loading="lazy">`
					: `<div style="width:28px;height:28px;border-radius:7px;background:var(--line);display:grid;place-items:center;font:700 11px/1 var(--mono);color:var(--faint);flex:none">${esc((r.symbol||'?')[0])}</div>`;
				return `<button type="button" class="dr-related" data-related-mint="${esc(r.mint)}"
					style="display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 10px;cursor:pointer;text-align:left;width:100%;transition:background .12s"
					onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='var(--panel)'">
					${imgEl}
					<span style="flex:1;min-width:0">
						<span style="font-weight:700;font-size:13px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.symbol || r.mint.slice(0,8))}</span>
						<span style="font-size:11px;color:var(--muted)">${esc(r.name||'')}</span>
					</span>
					<span style="display:flex;flex-direction:column;align-items:flex-end;flex:none">
						<span style="font:700 14px/1 var(--mono);color:${tc}">${r.score}</span>
						<span class="tierpill tp-${esc(r.tier)}" style="margin-top:3px;padding:1px 5px;font-size:9px">${esc(r.tier)}</span>
					</span>
				</button>`;
			}).join('')}
		</div>`;

	// Insert before the "Who's in" section.
	const body = $('#drBody');
	if (!body) return;
	if (body.dataset.relatedWired !== '1') {
		body.dataset.relatedWired = '1';
		body.addEventListener('click', (e) => {
			const btn = e.target.closest('.dr-related');
			const mint = btn?.dataset?.relatedMint;
			if (mint) openCoin(mint);
		});
	}
	const whosSecEl = Array.from(body.querySelectorAll('.dr-sec')).find((el) => el.textContent.startsWith("Who's in"));
	if (whosSecEl) {
		whosSecEl.insertAdjacentHTML('beforebegin', html);
	} else {
		body.insertAdjacentHTML('beforeend', html);
	}
}

function whoRow(w) {
	const title = ARCH_TITLE[w.label] || 'Unproven';
	const sub = [
		w.is_creator ? 'creator' : null,
		w.tag ? `@${w.tag}` : null,
		w.source === 'gmgn' ? 'gmgn-known' : (w.score != null ? `rep ${Math.round(w.score)}` : null),
		w.win_rate != null ? `${Math.round(w.win_rate)}% win` : null,
	].filter(Boolean).join(' · ');
	return `<div class="nwallet">
		<div class="nw-left">
			<span class="nw-addr"><span class="nlabel lb-${esc(w.label)}">${esc(title)}</span><a class="solscan" href="${solscan(w.wallet)}" target="_blank" rel="noopener">${esc(shortAddr(w.wallet))}</a></span>
			<span class="nw-sub">${esc(sub || '—')}</span>
		</div>
		<span class="nw-buy">${fmtSol(w.buy_sol)}</span>
	</div>`;
}

async function loadScoreHistory(mint) {
	const wrap = $('#scoreHistoryWrap');
	if (!wrap) return;
	const { ok, data } = await api(`/api/oracle/history?mint=${encodeURIComponent(mint)}&network=${NETWORK}&hours=48`);
	if (!ok || !data?.points?.length || data.points.length < 2) { wrap.innerHTML = ''; return; }
	wrap.innerHTML = renderSparkline(data.points, data.trend);
}

// Live market intel — the fully-populated market half of the coin page. Fused
// server-side across DexScreener / pump.fun / GeckoTerminal / GoPlus / Birdeye /
// CoinGecko (/api/oracle/market). Lazy so the conviction verdict paints first.
async function loadCoinMarket(mint) {
	const wrap = $('#marketWrap');
	if (!wrap) return;
	const { ok, status, data } = await api(`/api/oracle/market?mint=${encodeURIComponent(mint)}&network=${NETWORK}`, { timeout: 15000 });
	if (!$('#marketWrap')) return; // drawer closed mid-fetch
	wrap.classList.remove('mkt-loading');
	wrap.removeAttribute('aria-busy');
	if (!ok || !data || data.price?.usd == null) {
		// 404 = no live market yet (brand-new mint); anything else = upstreams down.
		wrap.innerHTML = status === 404
			? `<div class="dr-sec">Market</div><div class="state" style="padding:14px 0">No live market yet — this mint hasn't started trading. Price, liquidity and holders appear the moment it does.</div>`
			: `<div class="dr-sec">Market</div><div class="state" style="padding:14px 0">Live market data is momentarily unavailable. <button type="button" class="dr-act" id="mktRetry" data-mint="${esc(mint)}">Retry</button></div>`;
		const retry = $('#mktRetry');
		if (retry) retry.addEventListener('click', () => { wrap.classList.add('mkt-loading'); wrap.setAttribute('aria-busy', 'true'); loadCoinMarket(mint); });
		return;
	}
	wrap.innerHTML = renderMarket(data);
}

function statTile(label, value, sub = '') {
	return `<div class="mkt-tile"><span class="mkt-tile-lbl">${esc(label)}</span><span class="mkt-tile-val">${value}</span>${sub ? `<span class="mkt-tile-sub">${sub}</span>` : ''}</div>`;
}
function changeChip(label, n) {
	const c = changeStr(n);
	return `<span class="mkt-chg mkt-${c.cls}"><span class="mkt-chg-lbl">${esc(label)}</span><b>${c.txt}</b></span>`;
}
function secChip(ok, label, warnLabel = null) {
	if (ok == null) return `<span class="chip" title="not measured">${esc(label)} <b>?</b></span>`;
	return ok
		? `<span class="chip sm" title="safe">✓ ${esc(label)}</span>`
		: `<span class="chip flag" title="risk">⚠ ${esc(warnLabel || label)}</span>`;
}

function renderMarket(m) {
	const p = m.price || {};
	const ch = p.change || {};
	const changeH24 = changeStr(ch.h24);

	const tiles = [
		statTile('Price', fmtPrice(p.usd), `<span class="mkt-${changeH24.cls}">${changeH24.txt} 24h</span>`),
		statTile('Market cap', fmtUsd(m.market_cap_usd)),
		m.fdv_usd != null && m.fdv_usd !== m.market_cap_usd ? statTile('FDV', fmtUsd(m.fdv_usd)) : '',
		statTile('Liquidity', fmtUsd(m.liquidity_usd)),
		statTile('24h volume', fmtUsd(m.volume?.h24)),
		statTile('Holders', fmtInt(m.holders)),
	].filter(Boolean).join('');

	// Price-change chips across every window we have.
	const changeWins = [['5m', ch.m5], ['1h', ch.h1], ['6h', ch.h6], ['24h', ch.h24], ['7d', ch.d7]]
		.filter(([, v]) => v != null);
	const changeRow = changeWins.length
		? `<div class="mkt-chg-row">${changeWins.map(([l, v]) => changeChip(l, v)).join('')}</div>` : '';

	// Bonding-curve progress (un-graduated pump coins) or a graduated badge.
	const pf = m.pumpfun;
	let curveHtml = '';
	if (pf?.is_pump) {
		if (pf.graduated || pf.complete) {
			curveHtml = `<div class="mkt-row"><span class="chip sm">Graduated to DEX ✓</span>${pf.ath_market_cap_usd ? `<span class="chip">ATH mcap <b>${fmtUsd(pf.ath_market_cap_usd)}</b></span>` : ''}</div>`;
		} else if (pf.bonding_curve_pct != null) {
			const pct = Math.round(pf.bonding_curve_pct);
			curveHtml = `<div class="mkt-curve">
				<div class="mkt-curve-top"><span>Bonding curve</span><b>${pct}% to graduation</b></div>
				<div class="mkt-curve-track"><div class="mkt-curve-fill" style="width:${Math.max(2, Math.min(100, pct))}%"></div></div>
				${pf.real_sol_reserves != null ? `<div class="mkt-curve-sub">${pf.real_sol_reserves.toFixed(1)} ◎ in curve${pf.reply_count ? ` · ${fmtInt(pf.reply_count)} replies` : ''}${pf.is_live ? ' · <span class="mkt-up">live now</span>' : ''}</div>` : ''}
			</div>`;
		}
	}

	// 24h buy/sell activity split.
	const act = m.activity;
	let activityHtml = '';
	if (act && act.txns_24h) {
		const buyPct = Math.round((act.buy_ratio ?? 0.5) * 100);
		activityHtml = `<div class="mkt-act">
			<div class="mkt-act-top"><span>24h activity</span><span class="mkt-faint">${fmtInt(act.txns_24h)} txns</span></div>
			<div class="mkt-act-track"><div class="mkt-act-buy" style="width:${buyPct}%"></div></div>
			<div class="mkt-act-legend"><span class="mkt-up">${fmtInt(act.buys_24h)} buys</span><span class="mkt-down">${fmtInt(act.sells_24h)} sells</span></div>
		</div>`;
	}

	// Supply.
	const sup = m.supply || {};
	const supplyChips = [
		sup.total != null ? `<span class="chip">supply <b>${fmtInt(sup.total)}</b></span>` : '',
		sup.circulating != null && Math.abs((sup.circulating || 0) - (sup.total || 0)) > (sup.total || 0) * 0.01
			? `<span class="chip">circulating <b>${fmtInt(sup.circulating)}</b></span>` : '',
		m.identity?.created_at ? `<span class="chip" title="First trade / launch">age <b>${ago(m.identity.created_at)}</b></span>` : '',
	].filter(Boolean).join('');

	// Security posture.
	const sec = m.security;
	const secHtml = sec
		? `<div class="dr-sec">Security <span style="color:var(--faint);font-weight:400;font-size:10px">GoPlus</span></div>
			<div class="coin-meta">
				${secChip(sec.mint_authority_revoked, 'Mint revoked', 'Mint authority live')}
				${secChip(sec.freeze_authority_revoked, 'Freeze revoked', 'Can freeze')}
				${secChip(sec.metadata_mutable === false ? true : (sec.metadata_mutable === true ? false : null), 'Metadata locked', 'Mutable metadata')}
				${sec.transfer_fee_pct != null ? (sec.transfer_fee_pct > 0 ? `<span class="chip flag" title="transfer tax">⚠ ${sec.transfer_fee_pct}% fee</span>` : `<span class="chip sm">No transfer fee</span>`) : ''}
				${sec.top10_holder_pct != null ? `<span class="chip ${sec.top10_holder_pct > 50 ? 'flag' : ''}" title="Top 10 holder concentration">top 10 <b>${Math.round(sec.top10_holder_pct)}%</b></span>` : ''}
				${sec.trusted_token ? '<span class="chip sm" title="GoPlus verified list">Trusted ✓</span>' : ''}
			</div>` : '';

	// Listing — only for coins CoinGecko tracks (rank / ATH / ATL / categories).
	const lst = m.listing;
	let listingHtml = '';
	if (lst && (lst.market_cap_rank != null || lst.ath_usd != null || (lst.categories && lst.categories.length))) {
		const athChg = changeStr(lst.ath_change_pct);
		listingHtml = `<div class="dr-sec">Listed market <span style="color:var(--faint);font-weight:400;font-size:10px">CoinGecko</span></div>
			<div class="coin-meta">
				${lst.market_cap_rank != null ? `<span class="chip">rank <b>#${lst.market_cap_rank}</b></span>` : ''}
				${lst.ath_usd != null ? `<span class="chip" title="All-time high (${lst.ath_date ? new Date(lst.ath_date).toLocaleDateString() : ''})">ATH <b>${fmtPrice(lst.ath_usd)}</b> <span class="mkt-${athChg.cls}">${athChg.txt}</span></span>` : ''}
				${lst.atl_usd != null ? `<span class="chip" title="All-time low">ATL <b>${fmtPrice(lst.atl_usd)}</b></span>` : ''}
			</div>
			${lst.categories && lst.categories.length ? `<div class="coin-meta" style="margin-top:6px">${lst.categories.slice(0, 5).map((c) => `<span class="chip cat">${esc(c)}</span>`).join('')}</div>` : ''}`;
	}

	// DEX pairs.
	const pairs = Array.isArray(m.pairs) ? m.pairs.filter((pr) => pr.url) : [];
	const pairsHtml = pairs.length
		? `<div class="dr-sec">Markets <span style="color:var(--faint);font-weight:400;font-size:10px">${pairs.length} pair${pairs.length > 1 ? 's' : ''}</span></div>
			<div class="mkt-pairs">${pairs.slice(0, 5).map((pr) => `
				<a class="mkt-pair" href="${esc(pr.url)}" target="_blank" rel="noopener">
					<span class="mkt-pair-dex">${esc(pr.dex || 'dex')}${pr.quote_symbol ? ` <span class="mkt-faint">/${esc(pr.quote_symbol)}</span>` : ''}</span>
					<span class="mkt-pair-liq">${fmtUsd(pr.liquidity_usd)} liq</span>
					<span class="mkt-pair-arrow">↗</span>
				</a>`).join('')}</div>` : '';

	// Chart + explorer + social links.
	const lk = m.links || {};
	const linkBtns = [
		lk.dexscreener ? `<a class="dr-act" href="${esc(lk.dexscreener)}" target="_blank" rel="noopener">DexScreener ↗</a>` : '',
		lk.geckoterminal ? `<a class="dr-act" href="${esc(lk.geckoterminal)}" target="_blank" rel="noopener">GeckoTerminal ↗</a>` : '',
		lk.birdeye ? `<a class="dr-act" href="${esc(lk.birdeye)}" target="_blank" rel="noopener">Birdeye ↗</a>` : '',
		lk.website ? `<a class="dr-act" href="${esc(lk.website)}" target="_blank" rel="noopener">Website ↗</a>` : '',
		lk.twitter ? `<a class="dr-act" href="${esc(lk.twitter)}" target="_blank" rel="noopener">X ↗</a>` : '',
		lk.telegram ? `<a class="dr-act" href="${esc(lk.telegram)}" target="_blank" rel="noopener">Telegram ↗</a>` : '',
	].filter(Boolean).join('');

	const srcNote = Array.isArray(m.sources) && m.sources.length
		? `<div class="mkt-src">Live · ${m.sources.map(esc).join(' · ')}</div>` : '';

	return `<div class="dr-sec">Market <span style="color:var(--faint);font-weight:400;font-size:10px">live${p.native_sol ? ` · ${p.native_sol < 0.0001 ? p.native_sol.toExponential(2) : p.native_sol.toFixed(6)} ◎` : ''}</span></div>
		<div class="mkt-stats">${tiles}</div>
		${changeRow}
		${curveHtml}
		${activityHtml}
		${supplyChips ? `<div class="coin-meta" style="margin-top:10px">${supplyChips}</div>` : ''}
		${secHtml}
		${listingHtml}
		${pairsHtml}
		${linkBtns ? `<div class="dr-actions" style="margin-top:12px">${linkBtns}</div>` : ''}
		${srcNote}`;
}

async function loadSentimentPulse(mint) {
	const wrap = $('#communityPulseWrap');
	if (!wrap) return;
	try {
		const res = await fetch('/api/social/sentiment-pulse', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: mint }),
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) { if ($('#communityPulseWrap')) $('#communityPulseWrap').innerHTML = ''; return; }
		const d = await res.json();
		const el = $('#communityPulseWrap');
		if (!el) return;
		if (!d.ok || !d.overall || d.overall.count < 3) { el.innerHTML = ''; return; }
		const o = d.overall;
		const scoreColor = o.score >= 60 ? 'var(--up)' : o.score <= 40 ? 'var(--down)' : 'var(--muted)';
		const sentLabel = o.score >= 60 ? 'bullish' : o.score <= 40 ? 'bearish' : 'mixed';
		const sentChipCls = o.score >= 60 ? 'sm' : o.score <= 40 ? 'flag' : '';
		const exHtml = (o.examples || []).slice(0, 2).map(
			(ex) => `<div class="reason" style="font-size:11.5px;opacity:.75"><span class="rdot nar"></span><span>${esc(ex)}</span></div>`
		).join('');
		el.innerHTML = `
			<div class="dr-sec">Community pulse <span style="color:var(--faint);font-weight:400;font-size:10px">pump.fun · ${o.count} comments</span></div>
			<div class="coin-meta" style="margin-bottom:8px">
				<span class="chip ${sentChipCls}" style="color:${scoreColor}">${sentLabel} · ${o.score}</span>
			</div>
			<div class="str-grid">
				<div class="str-row">
					<span class="str-lbl">Positive</span>
					<div class="str-track"><div class="str-fill" style="width:${Math.round(o.posPct)}%;background:var(--up)"></div></div>
					<span class="str-val" style="color:var(--up)">${Math.round(o.posPct)}%</span>
				</div>
				<div class="str-row">
					<span class="str-lbl">Negative</span>
					<div class="str-track"><div class="str-fill" style="width:${Math.round(o.negPct)}%;background:var(--down)"></div></div>
					<span class="str-val" style="color:var(--down)">${Math.round(o.negPct)}%</span>
				</div>
				<div class="str-row">
					<span class="str-lbl">Neutral</span>
					<div class="str-track"><div class="str-fill" style="width:${Math.round(o.neuPct)}%;background:var(--muted)"></div></div>
					<span class="str-val" style="color:var(--muted)">${Math.round(o.neuPct)}%</span>
				</div>
			</div>
			${exHtml}`;
	} catch {
		const el = $('#communityPulseWrap');
		if (el) el.innerHTML = '';
	}
}

function renderSparkline(points, trend) {
	const W = 220; const H = 40; const PAD = 4;
	const scores = points.map((p) => Number(p.score));
	const min = Math.max(0, Math.min(...scores) - 5);
	const max = Math.min(100, Math.max(...scores) + 5);
	const range = max - min || 1;
	const n = scores.length;
	const xs = scores.map((_, i) => PAD + (i / (n - 1)) * (W - PAD * 2));
	const ys = scores.map((s) => PAD + (1 - (s - min) / range) * (H - PAD * 2));
	const d = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
	const trendColor = trend === 'rising' ? '#e4e8f2' : trend === 'falling' ? '#6c7280' : '#8a92a8';
	const trendArrow = trend === 'rising' ? '↑' : trend === 'falling' ? '↓' : '→';
	const lastScore = scores[n - 1];
	const firstScore = scores[0];
	const delta = lastScore - firstScore;
	const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
	return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0 4px">
		<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="flex-shrink:0;overflow:visible" aria-label="Conviction history">
			<polyline points="${xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')}" fill="none" stroke="${trendColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
			<circle cx="${xs[n-1].toFixed(1)}" cy="${ys[n-1].toFixed(1)}" r="2.5" fill="${trendColor}"/>
		</svg>
		<div style="font-size:11px;line-height:1.4;flex-shrink:0">
			<div style="color:${trendColor};font-weight:700;letter-spacing:.02em">${trendArrow} ${deltaStr} pts</div>
			<div style="color:var(--muted)">${points.length} readings · 48 h</div>
		</div>
	</div>`;
}

// Load closed proof trades from agent_sniper_positions for this specific coin.
// Surfaces after the live tape so users can see: real exits, P&L, and the agent
// who made it — with a direct link to copy that trader.
async function loadProofTrades(mint) {
	const wrap = $('#drProofTradesWrap');
	if (!wrap) return;
	try {
		const r = await fetch(`/api/trades/feed?mint=${encodeURIComponent(mint)}&min_pnl_pct=0&limit=8`);
		if (!r.ok) return;
		const { items = [] } = await r.json();
		if (!$('#drProofTradesWrap')) return; // drawer closed mid-fetch
		if (!items.length) { wrap.innerHTML = ''; return; }
		const rows = items.map((t) => {
			const sym    = esc((t.symbol || t.mint?.slice(0, 6) || '?').toUpperCase());
			const agent  = esc(t.agent_name || t.agent_id?.slice(0, 8) || 'Agent');
			const mult   = t.multiple    != null ? `${t.multiple.toFixed(2)}×`               : null;
			const pct    = t.realized_pnl_pct != null ? `+${Math.round(t.realized_pnl_pct)}%` : null;
			const pnlSol = t.realized_pnl_sol != null ? `+${t.realized_pnl_sol.toFixed(3)} ◎` : null;
			const isPos  = (t.realized_pnl_sol ?? 0) >= 0;
			const color  = isPos ? 'var(--up, #e4e8f2)' : 'var(--down, #6c7280)';
			return `<div class="dr-ptrade">
				<span class="dr-ptrade-mult" style="color:${color}">${mult || pct || pnlSol || '+?'}</span>
				<div class="dr-ptrade-mid">
					<span class="dr-ptrade-agent">${agent}</span>
					${pnlSol ? `<span style="color:${color};font-size:11px">${pnlSol}</span>` : ''}
				</div>
				<a class="dr-act" href="/trader/${encodeURIComponent(t.agent_id || '')}" style="font-size:11.5px;padding:4px 8px">Copy →</a>
			</div>`;
		}).join('');
		wrap.innerHTML = `<div class="dr-sec" style="margin-top:16px">Agent exits on this coin <span style="color:var(--faint);font-weight:400;font-size:10px">${items.length} found</span></div>
			<div style="display:flex;flex-direction:column;gap:4px">${rows}</div>`;
	} catch { /* non-fatal */ }
}

function closeDrawer() {
	const dr = $('#drawer'); dr.classList.remove('open'); dr.setAttribute('aria-hidden', 'true');
	// Tear down the trade tape so the PumpPortal SSE connection closes.
	state.tape?.destroy();
	state.tape = null;
	// Clear the mint param so the URL reflects the closed state.
	const url = new URL(location.href);
	if (url.searchParams.has('mint')) {
		url.searchParams.delete('mint');
		history.replaceState(null, '', url.toString());
	}
}

async function openWallet(wallet) {
	switchView('feed'); // close any drawer context; wallets open in drawer too
	const dr = $('#drawer');
	dr.classList.add('open'); dr.setAttribute('aria-hidden', 'false');
	$('#drTitle').textContent = shortAddr(wallet);
	$('#drBody').innerHTML = '<div class="state">Pulling track record…</div>';
	const { ok, data } = await api(`/api/oracle/wallet?address=${encodeURIComponent(wallet)}&network=${NETWORK}`);
	if (!ok || !data) { $('#drBody').innerHTML = '<div class="state">Could not load this wallet.</div>'; return; }
	const r = data.reputation; const a = data.archetype || {};
	$('#drTitle').innerHTML = `<span class="nlabel lb-${esc(a.label)}">${esc(a.title || 'Unproven')}</span> ${esc(shortAddr(wallet))}`;
	const recent = (data.recent || []).map((c) => `<div class="nwallet"><div class="nw-left"><span class="nw-addr">${esc(c.symbol || c.mint.slice(0, 6))} ${c.is_creator ? '<span class="nlabel lb-rugger">created</span>' : ''}</span><span class="nw-sub">${esc(c.category || '')}</span></div><span class="nw-buy">${fmtSol(c.buy_sol)}</span></div>`).join('') || '<div class="state">No recent coins recorded.</div>';
	$('#drBody').innerHTML = `
		<div style="font-size:13px;color:var(--muted);margin-bottom:14px">${esc(a.blurb || '')}</div>
		${r ? `<div class="pillars" style="grid-template-columns:repeat(2,1fr);gap:12px">
			${pillar('ped', 'Smart score', Math.round(r.score))}
			${pillar('str', 'Win rate', Math.round(r.win_rate))}
			${pillar('nar', 'Early win', Math.round(r.early_win_rate))}
			${pillar('mom', 'Dump rate', Math.round(r.dump_rate))}
		</div>
		<div class="coin-meta" style="margin-top:14px">
			<span class="chip">coins <b>${r.coins_traded ?? 0}</b></span>
			<span class="chip">early <b>${r.early_entries ?? 0}</b></span>
			<span class="chip sm">wins <b>${r.wins ?? 0}</b></span>
			<span class="chip flag">duds <b>${r.duds ?? 0}</b></span>
			${r.creator_count ? `<span class="chip">created <b>${r.creator_count}</b></span>` : ''}
		</div>` : '<div class="state">This wallet has no judged history yet.</div>'}
		<div class="dr-sec">Recent footprint</div>${recent}
		<div class="dr-actions" style="margin-top:16px">
			<a class="dr-act" href="/trader/${encodeURIComponent(wallet)}" rel="noopener">Trader profile ↗</a>
			<a class="dr-act" href="/trader/${encodeURIComponent(wallet)}#copy" rel="noopener" style="background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.28)">Copy trades →</a>
			<a class="dr-act solscan" href="${solscan(wallet)}" target="_blank" rel="noopener">Solscan ↗</a>
		</div>
	`;
}

// ── agent arm panel ──────────────────────────────────────────────────────────
// Configuration lives on the dedicated /oracle/arm page (the trading-bot setup
// surface). Here we show a compact status summary + the live action ledger, and
// hand off to that page to change anything.
async function loadAgentPanel() {
	const body = $('#armBody');
	body.dataset.loaded = '1';
	body.innerHTML = '<div class="state">Loading your agents…</div>';
	const { ok, data } = await api('/api/agents');
	const agents = ok && data ? (data.agents || data.items || data || []) : [];
	state.agents = Array.isArray(agents) ? agents : [];
	if (!state.agents.length) {
		body.innerHTML = `<div class="state"><b>Sign in and create a 3D agent</b>Your agent needs its own custodial Solana wallet to act on conviction. Create one in the studio, then come back to arm it.
			<div style="margin-top:16px"><a class="btn" href="/create/studio">Create an agent →</a></div></div>`;
		return;
	}
	const opts = state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)}</option>`).join('');
	body.innerHTML = `
		<div class="field"><label>Agent</label><select id="agSel">${opts}</select></div>
		<div id="armSummary"><div class="state" style="padding:18px 0">Loading configuration…</div></div>
		<a class="btn primary" href="/oracle/arm" style="margin-top:14px;text-decoration:none">Open full setup →</a>`;
	$('#agSel').addEventListener('change', () => loadWatch($('#agSel').value));
	state.agentId = state.agents[0].id;
	loadWatch(state.agentId);
}

function armSummaryHtml(w) {
	if (!w) return '<div class="state" style="padding:18px 0">Not configured yet — open the full setup to arm this agent.</div>';
	const min = w.min_score >= 86 ? 'Prime (≥86)' : w.min_score >= 72 ? 'Strong+ (≥72)' : 'Lean+ (≥56)';
	const live = w.mode === 'live';
	const dotCls = !w.armed ? 'off' : live ? 'live' : 'sim';
	const statusLab = !w.armed ? 'Disarmed' : live ? 'Armed · Live' : 'Armed · Simulate';
	const cats = (w.categories && w.categories.length) ? w.categories.map((c) => `<span class="cchip on" style="pointer-events:none">${esc(c)}</span>`).join('') : '<span style="color:var(--faint)">any narrative</span>';
	const row = (k, v) => `<div class="arm-srow"><span>${k}</span><b>${v}</b></div>`;
	return `
		<div class="arm-status arm-${dotCls}"><i></i>${esc(statusLab)}</div>
		<div class="arm-sgrid">
			${row('Min conviction', esc(min))}
			${row('Size / trade', fmtSol(w.per_trade_sol))}
			${row('Max daily', fmtSol(w.max_daily_sol))}
			${row('Max open', w.max_open ?? 5)}
			${row('Smart money', w.require_smart_money !== false ? 'Required' : 'Optional')}
			${row('Size scaling', w.size_scaling ? 'On' : 'Off')}
		</div>
		<div class="arm-cats">${cats}</div>
		${w.telegram_chat_id ? '<div class="arm-tg">✓ Telegram alerts active</div>' : ''}`;
}

async function loadWatch(agentId) {
	state.agentId = agentId;
	const sum = $('#armSummary');
	const { ok, data } = await api(`/api/oracle/watch?agent_id=${encodeURIComponent(agentId)}&network=${NETWORK}`);
	const w = ok && data ? data.watch : null;
	state.watch = w;
	if (sum) sum.innerHTML = armSummaryHtml(w);
	loadActions(agentId);
}

async function loadActions(agentId) {
	const body = $('#actionsBody');
	const { ok, data } = await api(`/api/oracle/watch?agent_id=${encodeURIComponent(agentId)}&network=${NETWORK}`);
	const actions = ok && data ? (data.actions || []) : [];
	const s = (ok && data && data.summary) || null;

	const pnlSign = (v) => v >= 0 ? '+' : '';
	const statline = s && s.total ? `
		<div class="act-kpis">
			<div class="act-kpi"><span>Total</span><b>${s.total}</b></div>
			<div class="act-kpi"><span>Wins</span><b class="${s.wins > 0 ? 'up' : ''}">${s.wins}</b></div>
			<div class="act-kpi"><span>Losses</span><b class="${s.losses > 0 ? 'dn' : ''}">${s.losses}</b></div>
			<div class="act-kpi"><span>Win rate</span><b>${s.win_rate == null ? '—' : s.win_rate + '%'}</b></div>
			<div class="act-kpi"><span>Realized PnL</span><b class="${s.realized_pnl_sol >= 0 ? 'up' : 'dn'}">${pnlSign(s.realized_pnl_sol)}${fmtSol(s.realized_pnl_sol)}</b></div>
			${s.roi_pct != null ? `<div class="act-kpi"><span>ROI</span><b class="${s.roi_pct >= 0 ? 'up' : 'dn'}">${pnlSign(s.roi_pct)}${s.roi_pct}%</b></div>` : ''}
			${s.open > 0 ? `<div class="act-kpi"><span>Open</span><b>${s.open}</b></div>` : ''}
		</div>` : '';

	if (!actions.length) {
		body.innerHTML = `${statline}<div class="state">No actions yet — once armed, every buy lands here and gets graded against the outcome in real time.</div>`;
		return;
	}

	const rows = actions.map(actionRow).join('');
	body.innerHTML = `
		${statline}
		<div class="act-wrap">
			<table class="act-table">
				<thead><tr>
					<th scope="col">Coin</th><th scope="col">Tier</th><th scope="col">Conv.</th>
					<th scope="col">Size</th><th scope="col">Outcome</th><th scope="col">PnL</th><th scope="col">When</th>
				</tr></thead>
				<tbody>${rows}</tbody>
			</table>
		</div>`;
}

function actionRow(a) {
	const outcome = a.outcome || 'open';
	const outCls = outcome === 'win' ? 'up' : outcome === 'loss' ? 'dn' : '';
	let outLabel;
	if (outcome === 'win') outLabel = `✓ Win${a.peak_multiple ? ` · ${Number(a.peak_multiple).toFixed(1)}×` : ''}`;
	else if (outcome === 'loss') outLabel = '✗ Loss';
	else if (a.exit_signal) outLabel = `<span class="act-exit act-exit-${esc(a.exit_signal.urgency || 'normal')}" title="${esc(a.exit_signal.reason)}">⚠ Exit</span>`;
	else outLabel = 'Open';
	const pnl = a.realized_pnl_sol != null ? `${Number(a.realized_pnl_sol) >= 0 ? '+' : ''}${fmtSol(a.realized_pnl_sol)}` : '—';
	const pnlCls = a.realized_pnl_sol != null ? (Number(a.realized_pnl_sol) >= 0 ? 'up' : 'dn') : '';
	const modeBadge = a.mode === 'live' ? '<span class="act-live">live</span>' : '<span class="act-sim">sim</span>';

	// For open positions show current conviction score alongside entry, with delta.
	let convCell;
	if (outcome === 'open' && a.current_score != null) {
		const entry = Number(a.conviction) || 0;
		const cur = Number(a.current_score);
		const delta = cur - entry;
		const deltaCls = delta > 0 ? 'up' : delta < 0 ? 'dn' : '';
		const deltaStr = delta !== 0 ? `<span class="act-delta ${deltaCls}">${delta > 0 ? '+' : ''}${delta}</span>` : '';
		const curCls = tierPill(a.current_tier);
		convCell = `<span class="${curCls}" style="padding:1px 4px;font-size:11px">${cur}</span>${deltaStr}`;
	} else {
		convCell = a.conviction ?? '—';
	}

	return `<tr class="act-row" data-outcome="${esc(outcome)}">
		<td class="act-coin"><a href="https://pump.fun/coin/${esc(a.mint)}" target="_blank" rel="noopener">${esc(a.symbol || a.mint.slice(0, 6))}</a> ${modeBadge}</td>
		<td><span class="tierpill ${tierPill(a.tier)}">${esc(a.tier || '—')}</span></td>
		<td class="act-mono">${convCell}</td>
		<td class="act-mono">${fmtSol(a.size_sol)}</td>
		<td class="act-mono ${outCls}">${outLabel}</td>
		<td class="act-mono ${pnlCls}">${pnl}</td>
		<td class="act-when" title="${esc(a.acted_at || '')}">${ago(a.acted_at)} ago</td>
	</tr>`;
}

document.addEventListener('DOMContentLoaded', boot);
