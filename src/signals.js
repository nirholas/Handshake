/**
 * Signal Marketplace controller.
 *
 * Renders /api/signals/marketplace into a ranked, filterable directory of paid
 * alpha feeds. Feeds are scored by PROVEN realized edge (confidence-regressed),
 * not follower count. State (sort / network) reflects into the URL so any view is
 * shareable; every card deep-links to the feed detail page.
 */

import { escapeHtml, fmtPct, compact, identicon } from './trader-format.js';
import { updateValue, flipReorder, setLiveDot } from './ui-juice.js';

const API = '/api/signals/marketplace';
const SORTS = new Set(['edge', 'roi', 'hitrate', 'subscribers', 'newest']);
const NETWORKS = new Set(['mainnet', 'devnet']);
const REFRESH_MS = 30_000;

const $ = (s, r = document) => r.querySelector(s);
const state = { sort: 'edge', network: 'mainnet' };
let timer = null;
let firstLoad = true;

function readUrl() {
	const p = new URLSearchParams(location.search);
	if (SORTS.has(p.get('sort'))) state.sort = p.get('sort');
	if (NETWORKS.has(p.get('network'))) state.network = p.get('network');
}
function writeUrl() {
	const p = new URLSearchParams();
	if (state.sort !== 'edge') p.set('sort', state.sort);
	if (state.network !== 'mainnet') p.set('network', state.network);
	const qs = p.toString();
	history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function syncControls() {
	for (const btn of document.querySelectorAll('#sm-sort .sm-seg-btn')) {
		const on = btn.dataset.sort === state.sort;
		btn.classList.toggle('is-active', on);
		btn.setAttribute('aria-pressed', on ? 'true' : 'false');
	}
	for (const btn of document.querySelectorAll('#sm-net .sm-seg-btn')) {
		const on = btn.dataset.net === state.network;
		btn.classList.toggle('is-active', on);
		btn.setAttribute('aria-pressed', on ? 'true' : 'false');
	}
}

function setStatus(msg, { error = false, retry = false } = {}) {
	const el = $('#sm-status');
	if (!el) return;
	if (!msg) { el.hidden = true; el.innerHTML = ''; return; }
	el.hidden = false;
	el.classList.toggle('is-error', error);
	el.innerHTML = escapeHtml(msg) + (retry ? ' <button class="sm-retry" type="button">Retry</button>' : '');
	if (retry) $('.sm-retry', el)?.addEventListener('click', () => load());
}

function skeletonGrid() {
	const cards = Array.from({ length: 6 }, () => `
		<div class="sm-card sm-skel" aria-hidden="true">
			<div class="sm-card-head"><div class="sm-avatar"></div><div class="sm-id" style="flex:1">
				<div class="sm-skel-line" style="width:62%"></div>
				<div class="sm-skel-line" style="width:40%;margin-top:8px;height:9px"></div></div></div>
			<div class="sm-skel-line" style="width:34%;height:26px"></div>
			<div class="sm-skel-line"></div>
			<div class="sm-metrics"><div class="sm-skel-line" style="height:38px"></div><div class="sm-skel-line" style="height:38px"></div><div class="sm-skel-line" style="height:38px"></div></div>
		</div>`).join('');
	$('#sm-grid').innerHTML = cards;
}

function priceBlock(p) {
	if (p.per_signal_usdc > 0 && p.per_epoch_usdc > 0) {
		return `<span class="amt">$${p.per_signal_usdc}</span><span class="per">/signal · $${p.per_epoch_usdc}/${epochLabel(p.epoch_seconds)}</span>`;
	}
	if (p.per_signal_usdc > 0) return `<span class="amt">$${p.per_signal_usdc}</span><span class="per">USDC / signal</span>`;
	if (p.per_epoch_usdc > 0) return `<span class="amt">$${p.per_epoch_usdc}</span><span class="per">USDC / ${epochLabel(p.epoch_seconds)}</span>`;
	return `<span class="amt">Free</span><span class="per">no charge</span>`;
}
function epochLabel(sec) {
	if (sec % 86400 === 0) { const d = sec / 86400; return d === 1 ? 'day' : `${d}d`; }
	if (sec % 3600 === 0) { const h = sec / 3600; return h === 1 ? 'hour' : `${h}h`; }
	return `${Math.round(sec / 60)}m`;
}

function metric(label, value, cls = '') {
	return `<div class="sm-metric"><div class="l">${label}</div><div class="v ${cls}">${value}</div></div>`;
}

function card(f) {
	const s = f.stats;
	const avatar = f.publisher.image
		? `<img class="sm-avatar" src="${escapeHtml(f.publisher.image)}" alt="" loading="lazy" />`
		: `<span class="sm-avatar" aria-hidden="true" style="background:${identicon(f.publisher.agent_id)}"></span>`;
	const verified = f.publisher.verified
		? `<span class="sm-verified" title="Verified on-chain track record">✓ Verified</span>`
		: '';
	const hit = s.hit_rate != null ? `${Math.round(s.hit_rate * 100)}%` : '—';
	const roi = s.avg_realized_pct != null ? fmtPct(s.avg_realized_pct, { sign: true }) : '—';
	const roiCls = s.avg_realized_pct == null ? 'muted' : s.avg_realized_pct > 0 ? 'win' : s.avg_realized_pct < 0 ? 'loss' : 'muted';
	const thin = s.closed_signals < 10
		? `<span class="sm-thin" title="Fewer than 10 closed signals — edge is regressed toward neutral until proven">Building track record</span>`
		: '';
	return `
		<a class="sm-card" href="/signals/${encodeURIComponent(f.slug)}" data-key="${escapeHtml(String(f.slug))}" aria-label="${escapeHtml(f.title)} by ${escapeHtml(f.publisher.name)} — edge ${f.edge_score}">
			<span class="sm-rank">#${f.rank}</span>
			<div class="sm-card-head">
				${avatar}
				<div class="sm-id">
					<h3 class="sm-feed-title">${escapeHtml(f.title)}</h3>
					<div class="sm-pub"><span class="sm-pub-name">${escapeHtml(f.publisher.name)}</span>${verified}</div>
				</div>
			</div>
			<div>
				<div class="sm-edge"><span class="sm-edge-score">${f.edge_score}</span><span class="sm-edge-label">Proven<br>edge</span></div>
				<div class="sm-edge-bar" aria-hidden="true"><span class="sm-edge-fill" style="width:${Math.max(4, f.edge_score)}%"></span></div>
			</div>
			<div class="sm-metrics">
				${metric('Hit rate', hit, s.hit_rate != null && s.hit_rate >= 0.5 ? 'win' : '')}
				${metric('Avg ROI', roi, roiCls)}
				${metric('Signals', `${compact(s.closed_signals)}<span style="font-size:11px;color:var(--ink-dim,#889)">/${compact(s.total_entries)}</span>`)}
			</div>
			<div class="sm-card-foot">
				<div class="sm-price">${priceBlock(f.pricing)}</div>
				<div style="display:flex;align-items:center;gap:8px">${thin}<span class="sm-view">${s.subscribers} sub${s.subscribers === 1 ? '' : 's'} · View →</span></div>
			</div>
		</a>`;
}

function emptyState() {
	$('#sm-grid').innerHTML = `
		<div class="sm-empty" style="grid-column:1/-1">
			<h2>No live feeds yet</h2>
			<p>No verified trader has published a feed on ${state.network} yet. Build a verified track record on the
			leaderboard, then publish your signals from your agent's wallet: your followers' agents pay per signal and
			auto-mirror the fill.</p>
			<div class="sm-empty-actions">
				<a class="sm-cta" href="/leaderboard">See the trader leaderboard →</a>
				<a class="sm-cta is-ghost" href="/agent-wallet#signals">Publish your feed</a>
			</div>
		</div>`;
}

// Count a summary tile from its previously-shown real value to the new one and
// flash the direction of change; missing → static dash with the tracker cleared.
function setSummaryNum(el, value, format) {
	if (!el) return;
	if (value == null || !Number.isFinite(value)) { el.textContent = '—'; delete el.dataset.juiceVal; return; }
	updateValue(el, value, format);
}

function renderSummary(feeds) {
	const verified = feeds.filter((f) => f.publisher.verified).length;
	const closed = feeds.reduce((a, f) => a + (f.stats.closed_signals || 0), 0);
	const topEdge = feeds.reduce((a, f) => Math.max(a, f.edge_score || 0), 0);
	setSummaryNum($('#sm-sum-feeds'), feeds.length, compact);
	setSummaryNum($('#sm-sum-verified'), verified, compact);
	setSummaryNum($('#sm-sum-closed'), closed, compact);
	setSummaryNum($('#sm-sum-edge'), feeds.length ? topEdge : null, (n) => String(Math.round(n)));
}

async function load() {
	const grid = $('#sm-grid');
	if (firstLoad) { skeletonGrid(); grid.setAttribute('aria-busy', 'true'); }
	try {
		const res = await fetch(`${API}?network=${state.network}&sort=${state.sort}&limit=60`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		const feeds = Array.isArray(data.feeds) ? data.feeds : [];
		setStatus(null);
		renderSummary(feeds);
		if (!feeds.length) emptyState();
		else {
			// First paint lets cards stagger in; refreshes/re-sorts FLIP cards to
			// their new rank instead of re-flashing the whole grid (the --reflow
			// class suppresses the per-card entrance while ranks settle).
			const flip = firstLoad ? null : flipReorder(grid, (el) => el.dataset.key || '');
			flip?.capture();
			grid.classList.toggle('sm-grid--reflow', !firstLoad);
			grid.innerHTML = feeds.map(card).join('');
			flip?.play();
		}
		grid.setAttribute('aria-busy', 'false');
		firstLoad = false;
		setLiveDot($('#sm-live'), 'live', 'live');
	} catch (err) {
		if (firstLoad) {
			grid.innerHTML = '';
			grid.setAttribute('aria-busy', 'false');
			setStatus('Could not load the marketplace. Check your connection and try again.', { error: true, retry: true });
			setLiveDot($('#sm-live'), 'error', 'offline');
		} else {
			setStatus('Reconnecting — showing the last known board.', { error: false });
			setLiveDot($('#sm-live'), 'connecting', 'reconnecting');
		}
	}
}

function bindControls() {
	$('#sm-sort')?.addEventListener('click', (e) => {
		const btn = e.target.closest('.sm-seg-btn'); if (!btn) return;
		state.sort = btn.dataset.sort; firstLoad = true; syncControls(); writeUrl(); load();
	});
	$('#sm-net')?.addEventListener('click', (e) => {
		const btn = e.target.closest('.sm-seg-btn'); if (!btn) return;
		state.network = btn.dataset.net; firstLoad = true; syncControls(); writeUrl(); load();
	});
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) { clearInterval(timer); timer = null; }
		else if (!timer) { load(); timer = setInterval(load, REFRESH_MS); }
	});
}

function init() {
	readUrl();
	// An unrecognised ?sort= / ?network= falls back to the defaults above, so
	// rewrite the address bar to the view actually rendered: a shared link is
	// only shareable if it names the board the next reader will see.
	writeUrl();
	syncControls();
	bindControls();
	load();
	timer = setInterval(load, REFRESH_MS);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
