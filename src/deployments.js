/**
 * /deployments — the on-chain agent deployment feed. Every row is a real
 * agent registered on the ERC-8004 Identity Registry, served by GET
 * /api/deployments. No synthetic entries — if a network is quiet, the feed is
 * honestly empty.
 *
 * Data flow:
 *   GET /api/deployments?view=stats&network=   headline counters + top chains + 7d series
 *   GET /api/deployments?network=&kind=&cursor= keyset-paginated live feed
 */

import { createLogger } from './shared/log.js';
import { updateValue, enterRow, liveDot, setLiveDot } from './ui-juice.js';
import { proxiedImageURL } from './ipfs.js';

const log = createLogger('deployments');

const state = {
	network: 'mainnet',
	kind: 'all',
	cursor: null,
	items: [],
	hasMore: false,
	loading: false,
	paged: false, // true once the user loads older pages — pauses live top-refresh
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtNum(n) {
	const v = Number(n) || 0;
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
	return String(v);
}

function shortAddr(a) {
	if (!a) return '';
	const s = String(a);
	return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function timeAgo(iso) {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, Math.round((Date.now() - t) / 1000));
	if (s < 60) return 'just now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.round(h / 24);
	if (d < 30) return `${d}d ago`;
	const mo = Math.round(d / 30);
	if (mo < 12) return `${mo}mo ago`;
	return `${Math.round(mo / 12)}y ago`;
}

function truncate(s, max) {
	const str = String(s || '').trim();
	if (!str) return '';
	if (str.length <= max) return str;
	return str.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

function absDate(iso) {
	const t = new Date(iso);
	return Number.isFinite(t.getTime()) ? t.toLocaleString() : '';
}

// ── stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
	try {
		const res = await fetch(`/api/deployments?view=stats&network=${state.network}`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`stats ${res.status}`);
		const { data } = await res.json();
		renderStats(data);
	} catch (e) {
		log.warn('stats failed', e?.message);
	}
}

function renderStats(d) {
	// Count the headline registry counters between real poll values — the total and
	// 24h tallies tick up as fresh agents deploy on-chain.
	updateValue($('dp-c-total'), Number(d.total_agents ?? 0), fmtNum, { flash: false });
	updateValue($('dp-c-chains'), Number(d.active_chains ?? 0), (n) => String(Math.round(n)), { flash: false });
	updateValue($('dp-c-d24'), Number(d.deployed_24h ?? 0), fmtNum);
	updateValue($('dp-c-d7'), Number(d.deployed_7d ?? 0), fmtNum, { flash: false });
	updateValue($('dp-c-3d'), Number(d.with_3d_pct ?? 0), (n) => `${Math.round(n)}%`, { flash: false });
	$('dp-c-3d-sub').textContent = `${fmtNum(d.with_3d ?? 0)} rigged agents`;
	updateValue($('dp-c-x402'), Number(d.x402_pct ?? 0), (n) => `${Math.round(n)}%`, { flash: false });
	$('dp-c-x402-sub').textContent = `${fmtNum(d.x402 ?? 0)} accept payments`;

	const todayEl = $('dp-today');
	if (todayEl) {
		const n = d.deployed_24h || 0;
		todayEl.textContent = n > 0 ? ` · ${n} today` : '';
	}
	renderSparkline(d.series_7d);
	renderTopChains(d.top_chains);
}

// 7-day registration sparkline. Bars scale to the busiest day; today highlighted.
function renderSparkline(series) {
	const host = $('dp-spark-bars');
	const totalEl = $('dp-spark-total');
	if (!host) return;
	const days = Array.isArray(series) ? series : [];
	const total = days.reduce((s, d) => s + (d.registrations || 0), 0);
	if (totalEl) totalEl.textContent = `${fmtNum(total)} registration${total === 1 ? '' : 's'}`;
	if (!days.length) { host.innerHTML = `<p class="dp-lb-empty">No registrations yet.</p>`; return; }
	const peak = Math.max(1, ...days.map((d) => d.registrations || 0));
	host.innerHTML = days
		.map((d, i) => {
			const n = d.registrations || 0;
			const h = Math.max(4, Math.round((n / peak) * 100));
			const today = i === days.length - 1;
			return (
				`<div class="dp-spark-col${today ? ' dp-spark-col--now' : ''}" title="${esc(d.day)}: ${n} registration${n === 1 ? '' : 's'}">` +
				`<div class="dp-spark-bar" style="height:${h}%"></div>` +
				`<span class="dp-spark-lbl">${esc(d.label)}</span>` +
				`</div>`
			);
		})
		.join('');
}

function renderTopChains(chains) {
	const host = $('dp-chains');
	if (!host) return;
	if (!chains?.length) {
		host.innerHTML = `<p class="dp-lb-empty">No registrations on this network yet.</p>`;
		return;
	}
	const peak = Math.max(1, ...chains.map((c) => c.count || 0));
	host.innerHTML = chains
		.map((c) => {
			const pct = Math.max(3, Math.round(((c.count || 0) / peak) * 100));
			return (
				`<div class="dp-chain-row">` +
				`<span class="dp-chain-name">${esc(c.chain)}</span>` +
				`<span class="dp-chain-bar"><span style="width:${pct}%"></span></span>` +
				`<span class="dp-chain-n">${fmtNum(c.count)}</span>` +
				`</div>`
			);
		})
		.join('');
}

// ── feed ───────────────────────────────────────────────────────────────────────
async function loadFeed(reset) {
	if (state.loading) return;
	state.loading = true;
	if (reset) { state.cursor = null; state.items = []; state.paged = false; }
	const more = $('dp-more');
	if (more) more.disabled = true;

	const host = $('dp-feed');
	if (reset && host && !host.children.length) host.innerHTML = skeleton();

	try {
		const params = new URLSearchParams({ network: state.network });
		if (state.kind !== 'all') params.set('kind', state.kind);
		if (state.cursor) params.set('cursor', state.cursor);
		const res = await fetch(`/api/deployments?${params}`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`feed ${res.status}`);
		const { data } = await res.json();
		state.items = reset ? data.deployments : state.items.concat(data.deployments);
		state.cursor = data.next_cursor;
		state.hasMore = !!data.has_more;
		renderFeed();
		setFeedLive(state.items.length ? 'live' : 'idle');
	} catch (e) {
		log.warn('feed failed', e?.message);
		setFeedLive('error');
		if (reset && host) {
			host.innerHTML = `<div class="dp-error"><div class="dp-empty-title">Couldn’t reach the registry</div><p>The deployment feed is reconnecting. <button type="button" class="dp-retry" id="dp-retry">Retry</button></p></div>`;
			$('dp-retry')?.addEventListener('click', () => loadFeed(true));
		}
	} finally {
		state.loading = false;
		const m = $('dp-more');
		if (m) { m.disabled = false; m.hidden = !state.hasMore; }
	}
}

function skeleton() {
	return Array.from({ length: 6 }).map(() => `<div class="dp-skeleton"></div>`).join('');
}

function rowHTML(r) {
	const dpId = `${r.chain_id}:${esc(r.agent_id)}`;
	// Registry image URLs are third-party data (ERC-8004 metadata) hosted on
	// arbitrary domains and IPFS gateways that routinely fail ORB/CORS checks or
	// serve non-image bodies. Route every remote URL through the same-origin
	// /api/img proxy: it resolves IPFS across gateways, follows metadata docs to
	// the real art, and always answers 200 with a valid image (deterministic
	// placeholder on failure), so the row never fires a failed request. Anything
	// that is not a remote http(s)/ipfs/ar URL degrades to the monogram tile.
	const mono = `<span class="dp-av dp-av--mono" aria-hidden="true">${esc((r.name || '#').charAt(0).toUpperCase())}</span>`;
	const remote = r.image && /^(https?|ipfs|ar):\/\//i.test(String(r.image));
	const av = remote
		? `<img class="dp-av" src="${esc(proxiedImageURL(String(r.image), dpId))}" alt="" loading="lazy" onerror="this.onerror=null;this.style.visibility='hidden'" />`
		: mono;
	const title = r.name || `Agent #${esc(r.agent_id)}`;
	const nameEl = r.agent_explorer
		? `<a class="dp-row-name" href="${esc(r.agent_explorer)}" target="_blank" rel="noopener">${esc(title)}</a>`
		: `<span class="dp-row-name">${esc(title)}</span>`;
	const tags =
		(r.has_3d ? `<span class="dp-tag dp-tag--3d" title="Ships a 3D avatar">3D</span>` : '') +
		(r.x402_support ? `<span class="dp-tag dp-tag--x402" title="Accepts x402 payments">x402</span>` : '');
	const desc = r.description ? `<span class="dp-row-desc">${esc(truncate(r.description, 110))}</span>` : '';
	const tx = r.tx_explorer ? `<a class="dp-tx" href="${esc(r.tx_explorer)}" target="_blank" rel="noopener" title="Registration transaction">tx ↗</a>` : '';
	const owner = r.owner
		? `<a class="dp-owner" href="${esc(r.owner_explorer)}" target="_blank" rel="noopener" title="Owner address">${esc(shortAddr(r.owner))}</a>`
		: '';
	const timeLabel = timeAgo(r.registered_at);
	const timeTitle = absDate(r.registered_at);
	return (
		`<div class="dp-row" data-dp-id="${dpId}">` +
		av +
		`<span class="dp-row-body">` +
		`<span class="dp-row-top">${nameEl}${tags}</span>` +
		desc +
		`<span class="dp-row-meta"><span class="dp-chip">${esc(r.chain)}</span>${owner}</span>` +
		`</span>` +
		`<span class="dp-row-side"><span class="dp-time" title="${esc(timeTitle)}">${esc(timeLabel)}</span>${tx}</span>` +
		`</div>`
	);
}

function renderFeed() {
	const host = $('dp-feed');
	if (!host) return;
	if (!state.items.length) {
		const what = state.kind === '3d' ? 'agents with a 3D avatar' : state.kind === 'x402' ? 'x402-enabled agents' : 'on-chain agents';
		host.innerHTML =
			`<div class="dp-empty"><div class="dp-empty-title">No ${esc(what)} yet</div>` +
			`<p class="dp-empty-sub">Nothing registered on ${esc(state.network)} for this filter. <a href="/app">Deploy the first one.</a></p></div>`;
		return;
	}

	// Diff against what's already rendered — prepend only genuinely new rows with
	// the dp-land animation so the live 45s refresh feels like a stream, not a flash.
	const renderedIds = new Set([...host.querySelectorAll('[data-dp-id]')].map(el => el.dataset.dpId));
	const newItems = renderedIds.size > 0
		? state.items.filter(r => !renderedIds.has(`${r.chain_id}:${r.agent_id}`))
		: null;

	if (newItems?.length) {
		// Prepend newest-first (items are already sorted desc, so prepend in reverse
		// to keep the display order: newest at top)
		[...newItems].reverse().forEach(r => {
			const wrap = document.createElement('div');
			wrap.innerHTML = rowHTML(r);
			const row = wrap.firstElementChild;
			host.prepend(row);
			enterRow(row); // shared slide-in so the live refresh reads as a stream
		});
	} else if (!renderedIds.size) {
		// Initial render or after full reset
		host.innerHTML = state.items.map(rowHTML).join('');
	}
}

// ── controls ────────────────────────────────────────────────────────────────────
function wireNetworkToggle() {
	for (const btn of document.querySelectorAll('[data-network]')) {
		btn.addEventListener('click', () => {
			const net = btn.dataset.network === 'testnet' ? 'testnet' : 'mainnet';
			if (net === state.network) return;
			state.network = net;
			for (const b of document.querySelectorAll('[data-network]')) {
				const on = b.dataset.network === net;
				b.classList.toggle('active', on);
				b.setAttribute('aria-selected', String(on));
			}
			$('dp-net-label').textContent = net;
			loadStats();
			loadFeed(true);
		});
	}
}

function wireFilters() {
	for (const btn of document.querySelectorAll('[data-kind]')) {
		btn.addEventListener('click', () => {
			const kind = btn.dataset.kind;
			if (kind === state.kind) return;
			state.kind = kind;
			for (const b of document.querySelectorAll('[data-kind]')) {
				const on = b.dataset.kind === kind;
				b.classList.toggle('active', on);
				b.setAttribute('aria-pressed', String(on));
			}
			loadFeed(true);
		});
	}
}

function wireLoadMore() {
	const more = $('dp-more');
	if (!more) return;
	more.addEventListener('click', () => { state.paged = true; loadFeed(false); });
	// Trigger load-more automatically when the button scrolls into view, removing
	// the need to click. Once paged, live refresh is paused (user is browsing history).
	if ('IntersectionObserver' in window) {
		new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting && !more.hidden && !state.loading) {
					state.paged = true;
					loadFeed(false);
				}
			},
			{ rootMargin: '0px 0px 160px 0px' },
		).observe(more);
	}
}

// Live-state dot on the "Live feed" head — driven by the real 45s registry poll
// lifecycle, mirroring the SSE vocabulary used across launch surfaces.
function setFeedLive(stateName) {
	setLiveDot(document.querySelector('.dp-feed-head'), stateName);
}

function init() {
	const feedHead = document.querySelector('.dp-feed-head .dp-section-h');
	if (feedHead) feedHead.insertAdjacentHTML('afterend', liveDot('connecting'));
	wireNetworkToggle();
	wireFilters();
	wireLoadMore();
	loadStats();
	loadFeed(true);
	// Live cadence: refresh stats, and reload the top of the feed only while the
	// user is still on the first page (never yank them back after loading older).
	setInterval(() => {
		if (document.hidden) return;
		loadStats();
		if (!state.paged) loadFeed(true);
	}, 45_000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
