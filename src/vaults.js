// Back-an-Agent Vaults client.
// Discovery feed → vault detail (live NAV, P&L, positions, backers, audit ledger)
// → back / redeem / (owner) trade-the-pool, pause, set terms, claim fees.
// Every number here traces to a real /api/vaults endpoint; nothing is faked.

import { apiFetch, noteSession } from './api.js';
import { updateValue, flipReorder } from './ui-juice.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
	me: false,
	agents: [], // the signed-in user's agents
	tab: 'all',
	sort: 'perf',
	feed: [],
	feedLoaded: false,
	vault: null, // current detail vault
	pollTimer: null,
};

// ── formatting ───────────────────────────────────────────────────────────────
const ATOMICS = 1_000_000;
const usd = (atomics) => {
	const n = Number(BigInt(atomics ?? 0)) / ATOMICS;
	return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const usdCompact = (atomics) => {
	const n = Number(BigInt(atomics ?? 0)) / ATOMICS;
	if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
	return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};
const shares = (atomics) => (Number(BigInt(atomics ?? 0)) / ATOMICS).toLocaleString('en-US', { maximumFractionDigits: 4 });
const priceE6 = (e6) => '$' + (Number(BigInt(e6 ?? ATOMICS)) / ATOMICS).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const pctBps = (bps) => `${(Number(bps || 0) / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
const roiText = (bps) => `${bps > 0 ? '+' : ''}${(Number(bps || 0) / 100).toFixed(2)}%`;
const signClass = (n) => (n > 0 ? 'is-pos' : n < 0 ? 'is-neg' : 'is-flat');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shortMint = (m) => (m ? `${m.slice(0, 4)}…${m.slice(-4)}` : '');

function toast(msg, kind = 'info') {
	let host = $('#vx-toast');
	if (!host) {
		host = document.createElement('div');
		host.id = 'vx-toast';
		document.body.appendChild(host);
	}
	const el = document.createElement('div');
	el.className = `vx-toast-item vx-toast--${kind}`;
	el.textContent = msg;
	host.appendChild(el);
	requestAnimationFrame(() => el.classList.add('is-in'));
	setTimeout(() => { el.classList.remove('is-in'); setTimeout(() => el.remove(), 300); }, 4200);
}

async function readErr(res, fallback) {
	try { const j = await res.json(); return j.error_description || j.message || fallback; } catch { return fallback; }
}

// ── visual helpers ───────────────────────────────────────────────────────────

// Animated count-up for headline stats. fmt maps a raw number to display text.
// Count a stat tile from its PREVIOUSLY-shown real value to the new one and flash
// the direction of change. Delegates to the shared game-feel library so the whole
// platform shares one count-up — and, unlike a from-zero animation, this never
// fakes activity on a refresh (it counts the real delta or, with no prior value,
// settles instantly).
function countUp(el, to, fmt) {
	if (!el) return;
	updateValue(el, to, fmt);
}

function sumBig(items, key) {
	return items.reduce((acc, it) => acc + (it[key] != null ? BigInt(it[key]) : 0n), 0n);
}

// Inline SVG sparkline from a real series of {p} price points (chronological).
function sparkline(points, { w = 320, h = 64, pad = 4, tone = 'pos' } = {}) {
	if (!points || points.length < 2) return '';
	const ys = points.map((p) => p.p);
	const min = Math.min(...ys), max = Math.max(...ys);
	const span = max - min || 1;
	const stepX = (w - pad * 2) / (points.length - 1);
	const coords = points.map((p, i) => {
		const x = pad + i * stepX;
		const y = pad + (h - pad * 2) * (1 - (p.p - min) / span);
		return [x, y];
	});
	const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
	const area = `${line} L${coords[coords.length - 1][0].toFixed(1)} ${h - pad} L${coords[0][0].toFixed(1)} ${h - pad} Z`;
	const stroke = tone === 'neg' ? 'var(--danger)' : tone === 'flat' ? 'var(--ink-dim)' : 'var(--success)';
	const gid = `vxg-${tone}`;
	const [lx, ly] = coords[coords.length - 1];
	return `<svg class="vx-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Share price history">
		<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color="${stroke}" stop-opacity="0.28"/>
			<stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
		</linearGradient></defs>
		<path d="${area}" fill="url(#${gid})"/>
		<path d="${line}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
		<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3" fill="${stroke}"/>
	</svg>`;
}

// Real drawdown gauge: how much of the drawdown budget is currently used.
function drawdownGauge(peakE6, curE6, stopBps) {
	const peak = Number(BigInt(peakE6 || 1_000_000));
	const cur = Number(BigInt(curE6 || 1_000_000));
	const ddBps = peak > cur ? Math.round(((peak - cur) / peak) * 10000) : 0;
	const stop = Math.max(1, Number(stopBps || 2500));
	const ratio = Math.max(0, Math.min(1, ddBps / stop));
	const tone = ratio < 0.5 ? 'ok' : ratio < 0.85 ? 'warn' : 'crit';
	const used = (ddBps / 100).toFixed(1);
	const cap = (stop / 100).toFixed(0);
	return `<div class="vx-gauge">
		<div class="vx-gauge-head">
			<span class="vx-gauge-l">Drawdown from peak</span>
			<span class="vx-gauge-v ${ddBps > 0 ? (tone === 'crit' ? 'is-neg' : '') : 'is-pos'}">${ddBps > 0 ? `−${used}%` : 'At peak'}</span>
		</div>
		<div class="vx-gauge-track"><div class="vx-gauge-fill is-${tone}" style="width:${(ratio * 100).toFixed(1)}%"></div></div>
		<div class="vx-gauge-cap">Circuit breaker halts trading at −${cap}% · ${(100 - ratio * 100).toFixed(0)}% of buffer left</div>
	</div>`;
}

// Real backer capital distribution from the public roster (stake size only).
function backerDist(backers) {
	const rows = (backers || []).filter((b) => BigInt(b.deposited_atomics || 0) > 0n);
	if (!rows.length) return '';
	const total = rows.reduce((a, b) => a + Number(BigInt(b.deposited_atomics)), 0) || 1;
	const sorted = [...rows].sort((a, b) => Number(BigInt(b.deposited_atomics)) - Number(BigInt(a.deposited_atomics)));
	const palette = ['#8b5cf6', '#a78bfa', '#7c6fe8', '#6d6bd6', '#5b6cc4', '#4a6bb2'];
	let ci = 0;
	const seg = sorted.slice(0, 6).map((b) => {
		const pct = (Number(BigInt(b.deposited_atomics)) / total) * 100;
		const color = b.is_me ? '' : palette[ci++ % palette.length];
		return { pct, me: b.is_me, color };
	});
	const restPct = 100 - seg.reduce((a, s) => a + s.pct, 0);
	const bars = seg.map((s) => `<i class="${s.me ? 'is-me' : ''}" style="width:${s.pct.toFixed(1)}%${s.me ? '' : `;background:${s.color}`}" title="${s.pct.toFixed(1)}%"></i>`).join('') +
		(restPct > 0.5 ? `<i style="width:${restPct.toFixed(1)}%;background:var(--surface-3)"></i>` : '');
	const mine = seg.find((s) => s.me);
	const legend = `${mine ? `<span><span class="vx-dist-dot" style="background:var(--wallet-accent-strong)"></span>You · ${mine.pct.toFixed(1)}%</span>` : ''}<span><span class="vx-dist-dot" style="background:${palette[0]}"></span>${rows.length} backer${rows.length === 1 ? '' : 's'}</span>`;
	return `<div class="vx-distbar">${bars}</div><div class="vx-dist-legend">${legend}</div>`;
}

// ── auth + agents ──────────────────────────────────────────────────────────────
// Resolve the session BEFORE asking for anything owner-scoped. /api/auth/me
// answers 200 with { user: null } when signed out; /api/agents answers 401, which
// the browser prints as a red console error on every anonymous visit to this
// public page. Ask the endpoint that has an answer for both kinds of visitor,
// teach api.js what it learned (so no mutation wastes a CSRF pre-flight), and
// only reach for the owner's agents once we know there is an owner.
async function loadMe() {
	try {
		const res = await fetch('/api/auth/me', { credentials: 'include' });
		const j = res.ok ? await res.json().catch(() => null) : null;
		state.me = !!j?.user;
		noteSession(state.me);
	} catch {
		state.me = false;
	}
	state.agents = [];
	if (state.me) {
		try {
			const res = await apiFetch('/api/agents', { allowAnonymous: true });
			if (res.ok) {
				const j = await res.json();
				state.agents = (j.agents || []).filter(Boolean);
			}
		} catch {
			state.agents = [];
		}
	}
	$$('[data-auth="in"]').forEach((el) => { el.hidden = !state.me; });
	$$('[data-auth="out"]').forEach((el) => { el.hidden = !!state.me; });
	// The empty state is the one render that reads `state.me`, and the feed may
	// have painted before this resolved. Repaint it so a signed-in visitor is
	// offered "Open a vault", not the signed-out path.
	if (state.feedLoaded && !state.feed.length) renderFeed();
}

// ── discovery feed ──────────────────────────────────────────────────────────────
async function loadFeed() {
	const grid = $('#vx-grid');
	grid.setAttribute('aria-busy', 'true');
	if (!state.feed.length) grid.innerHTML = skeletonCards(6);
	try {
		const path = state.tab === 'mine' ? '/api/vaults?mine=1' : '/api/vaults';
		const res = await apiFetch(path, { allowAnonymous: state.tab !== 'mine' });
		if (!res.ok) throw new Error(await readErr(res, 'could not load vaults'));
		const j = await res.json();
		state.feed = j.data?.items || [];
		state.feedLoaded = true;
		renderFeed();
	} catch (e) {
		grid.innerHTML = `<div class="vx-empty"><p class="vx-empty-t">Couldn't load vaults</p><p class="vx-empty-d">${esc(e.message)}</p><button class="vx-btn" id="vx-retry" type="button">Retry</button></div>`;
		$('#vx-retry')?.addEventListener('click', loadFeed);
	} finally {
		grid.removeAttribute('aria-busy');
	}
}

function skeletonCards(n) {
	return Array.from({ length: n }, () => '<div class="vx-card vx-card--skel"><div class="vx-skel-line"></div><div class="vx-skel-line short"></div><div class="vx-skel-stats"></div></div>').join('');
}

const navNum = (v) => (v.last_nav_atomics != null ? Number(BigInt(v.last_nav_atomics)) : 0);

function sortFeed(items) {
	const by = {
		perf: (a, b) => (b.roi_bps || 0) - (a.roi_bps || 0),
		capital: (a, b) => navNum(b) - navNum(a),
		backers: (a, b) => (b.backer_count || 0) - (a.backer_count || 0),
		rep: (a, b) => {
			const av = a.reputation?.verified ? 1 : 0, bv = b.reputation?.verified ? 1 : 0;
			if (av !== bv) return bv - av;
			return (b.reputation?.score ?? 0) - (a.reputation?.score ?? 0);
		},
	};
	return [...items].sort(by[state.sort] || by.perf);
}

function renderStats() {
	const host = $('#vx-stats');
	if (!host) return;
	if (!state.feed.length) { host.hidden = true; return; }
	host.hidden = false;
	if (state.tab === 'mine') {
		const deposited = sumBig(state.feed, 'deposited_atomics');
		const realized = state.feed.reduce((a, v) => a + (v.realized_gain_atomics != null ? BigInt(v.realized_gain_atomics) : 0n), 0n);
		const tiles = [
			{ l: 'Positions', to: state.feed.length, fmt: (n) => Math.round(n).toLocaleString() },
			{ l: 'Total deposited', to: Number(deposited) / ATOMICS, fmt: (n) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 }) },
			{ l: 'Realized P&L', to: Number(realized) / ATOMICS, fmt: (n) => (realized >= 0n ? '+' : '−') + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 }), pos: realized >= 0n },
			{ l: 'Active vaults', to: state.feed.filter((v) => v.status === 'open').length, fmt: (n) => Math.round(n).toLocaleString() },
		];
		paintStats(host, tiles);
		return;
	}
	const capital = sumBig(state.feed, 'last_nav_atomics');
	const backers = state.feed.reduce((a, v) => a + (v.backer_count || 0), 0);
	const best = state.feed.reduce((m, v) => Math.max(m, v.roi_bps || 0), 0);
	const verified = state.feed.filter((v) => v.reputation?.verified).length;
	const tiles = [
		{ l: 'Open vaults', to: state.feed.length, fmt: (n) => Math.round(n).toLocaleString(), sub: `${verified} reputation-verified` },
		{ l: 'Capital backed', to: Number(capital) / ATOMICS, fmt: (n) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 }) },
		{ l: 'Backers', to: backers, fmt: (n) => Math.round(n).toLocaleString() },
		{ l: 'Best return', to: best / 100, fmt: (n) => (best > 0 ? '+' : '') + n.toFixed(1) + '%', pos: best > 0 },
	];
	paintStats(host, tiles);
}

function paintStats(host, tiles) {
	// Reuse the tile DOM across refreshes (keyed by the label set) so countUp can
	// animate from the previously-shown real value. Only rebuild when the tile set
	// changes (e.g. switching the all/mine tab), and render the real value up front
	// — never a placeholder zero that would fake a count on every refresh.
	const sig = tiles.map((t) => t.l).join('|');
	if (host.dataset.sig !== sig) {
		host.innerHTML = tiles.map((t) => `<div class="vx-stat-tile${t.pos ? ' is-pos' : ''}">
			<span class="vx-stat-tile-l">${t.l}</span>
			<span class="vx-stat-tile-v">${esc(t.fmt(t.to))}</span>
			${t.sub ? `<span class="vx-stat-tile-s">${esc(t.sub)}</span>` : ''}
		</div>`).join('');
		host.dataset.sig = sig;
	} else {
		$$('.vx-stat-tile', host).forEach((tile, i) => {
			tile.classList.toggle('is-pos', !!tiles[i].pos);
			const s = $('.vx-stat-tile-s', tile);
			if (s && tiles[i].sub != null) s.textContent = tiles[i].sub;
		});
	}
	$$('.vx-stat-tile-v', host).forEach((el, i) => countUp(el, tiles[i].to, tiles[i].fmt));
}

function renderFeed() {
	const grid = $('#vx-grid');
	renderStats();
	if (state.tab === 'mine') return renderMine();
	if (!state.feed.length) {
		$('#vx-feed-count').textContent = '';
		grid.innerHTML = `<div class="vx-empty">
			<p class="vx-empty-t">No open vaults yet</p>
			<p class="vx-empty-d">Be the first. If your agent has a verified trading track record, open a vault and let backers stake behind it.</p>
			${state.me ? '<button class="vx-btn vx-btn--primary" id="vx-empty-open" type="button">Open a vault</button>' : '<a class="vx-btn vx-btn--primary" href="/leaderboard">Find a trader to verify</a>'}
		</div>`;
		$('#vx-empty-open')?.addEventListener('click', openVaultModal);
		return;
	}
	$('#vx-feed-count').textContent = `${state.feed.length} ${state.feed.length === 1 ? 'vault' : 'vaults'}`;
	const items = sortFeed(state.feed);
	const maxNav = items.reduce((m, v) => Math.max(m, navNum(v)), 0);
	const topIds = [...state.feed].filter((v) => (v.roi_bps || 0) > 0).sort((a, b) => (b.roi_bps || 0) - (a.roi_bps || 0)).slice(0, 3).map((v) => v.id);
	// FLIP cards to their new rank when the sort changes, so the board glides into
	// order instead of snapping (same data-id keys map old → new positions).
	const flip = flipReorder(grid, (el) => el.dataset.id || '');
	flip.capture();
	grid.innerHTML = items.map((v) => cardHtml(v, maxNav, topIds.indexOf(v.id))).join('');
	$$('.vx-card[data-id]', grid).forEach((c) => c.addEventListener('click', () => openDetail(c.dataset.id)));
	flip.play();
}

function renderMine() {
	const grid = $('#vx-grid');
	if (!state.feed.length) {
		$('#vx-feed-count').textContent = '';
		grid.innerHTML = `<div class="vx-empty"><p class="vx-empty-t">You haven't backed any agent</p><p class="vx-empty-d">Browse open vaults and stake behind a verified trader.</p><button class="vx-btn vx-btn--primary" id="vx-go-all" type="button">Browse vaults</button></div>`;
		$('#vx-go-all')?.addEventListener('click', () => setTab('all'));
		return;
	}
	$('#vx-feed-count').textContent = `${state.feed.length} ${state.feed.length === 1 ? 'position' : 'positions'}`;
	grid.innerHTML = state.feed.map(mineCardHtml).join('');
	$$('.vx-card[data-id]', grid).forEach((c) => c.addEventListener('click', () => openDetail(c.dataset.id)));
}

function repBadge(rep) {
	if (!rep) return '<span class="vx-rep vx-rep--none">No track record</span>';
	if (rep.verified) return `<span class="vx-rep vx-rep--ok" title="Verified on-chain track record">✓ Verified · score ${Math.round(rep.score)}</span>`;
	return `<span class="vx-rep vx-rep--warn">Unverified · ${rep.closed_count} trades</span>`;
}

function avatar(src, cls) {
	return src ? `<img class="vx-card-av ${cls || ''}" src="${esc(src)}" alt="" loading="lazy" />` : `<div class="vx-card-av vx-card-av--ph ${cls || ''}" aria-hidden="true"></div>`;
}

function cardHtml(v, maxNav, rank) {
	const roi = v.roi_bps || 0;
	const sc = signClass(roi);
	// A vault with no NAV snapshot has taken no deposits yet, so $0 is the honest
	// reading, and it keeps the "$X backed" meta line below grammatical.
	const navLine = usdCompact(v.last_nav_atomics);
	const ringTone = v.status === 'paused' ? 'is-paused' : v.status === 'open' ? 'is-open' : '';
	const statusChip = v.status === 'paused' ? '<span class="vx-chip vx-chip--warn">Paused</span>' : '';
	const rankBadge = rank >= 0 ? `<span class="vx-card-rank rank-${rank}">${rank + 1}</span>` : '';
	const capPct = maxNav > 0 ? Math.max(3, (navNum(v) / maxNav) * 100) : 0;
	const arrow = roi > 0 ? '▲' : roi < 0 ? '▼' : '•';
	return `<button class="vx-card" data-id="${esc(v.id)}" type="button">
		<span class="vx-card-accent ${sc}" aria-hidden="true"></span>
		<div class="vx-card-head">
			<div class="vx-card-avwrap ${ringTone}">${rankBadge}${avatar(v.agent_image)}</div>
			<div class="vx-card-id">
				<span class="vx-card-name" title="${esc(v.agent_name || 'Agent')}">${esc(v.agent_name || 'Agent')}</span>
				${repBadge(v.reputation)}
			</div>
			${statusChip}
		</div>
		<div class="vx-card-return ${sc}">
			<span class="vx-card-return-arrow" aria-hidden="true">${arrow}</span>
			<span class="vx-card-return-v">${roiText(roi)}</span>
			<span class="vx-card-return-l">return</span>
		</div>
		<div class="vx-card-stats">
			<div class="vx-stat"><span class="vx-stat-l">Vault NAV</span><span class="vx-stat-v">${navLine}</span></div>
			<div class="vx-stat"><span class="vx-stat-l">Share price</span><span class="vx-stat-v">${priceE6(v.share_price_e6)}</span></div>
		</div>
		<div class="vx-card-cap">
			<div class="vx-card-cap-bar"><i style="width:${capPct.toFixed(1)}%"></i></div>
			<div class="vx-card-cap-meta"><span>${navLine} backed</span><span>${v.backer_count} ${v.backer_count === 1 ? 'backer' : 'backers'}</span></div>
		</div>
		<div class="vx-card-foot">
			<span title="Performance fee">${pctBps(v.performance_fee_bps)} fee</span>
			<span title="Drawdown circuit breaker">${pctBps(v.max_drawdown_bps)} stop</span>
			<span class="vx-card-cta">View vault →</span>
		</div>
	</button>`;
}

function mineCardHtml(v) {
	const deposited = BigInt(v.deposited_atomics || 0);
	const realized = BigInt(v.realized_gain_atomics || 0);
	const realizedPos = realized >= 0n;
	const ringTone = v.status === 'paused' ? 'is-paused' : v.status === 'open' ? 'is-open' : '';
	return `<button class="vx-card" data-id="${esc(v.id)}" type="button">
		<span class="vx-card-accent ${signClass(Number(realized))}" aria-hidden="true"></span>
		<div class="vx-card-head">
			<div class="vx-card-avwrap ${ringTone}">${avatar(v.agent_image)}</div>
			<div class="vx-card-id"><span class="vx-card-name" title="${esc(v.agent_name || 'Agent')}">${esc(v.agent_name || 'Agent')}</span><span class="vx-rep vx-rep--muted">${esc(v.status)}</span></div>
		</div>
		<div class="vx-card-return ${signClass(Number(realized))}">
			<span class="vx-card-return-v" style="font-size:var(--text-xl)">${realizedPos ? '+' : '−'}${usdCompact(realizedPos ? realized : -realized)}</span>
			<span class="vx-card-return-l">realized P&amp;L</span>
		</div>
		<div class="vx-card-stats">
			<div class="vx-stat"><span class="vx-stat-l">Your shares</span><span class="vx-stat-v">${shares(v.shares)}</span></div>
			<div class="vx-stat"><span class="vx-stat-l">Deposited</span><span class="vx-stat-v">${usdCompact(deposited)}</span></div>
		</div>
		<div class="vx-card-foot"><span>${pctBps(v.performance_fee_bps)} fee</span><span class="vx-card-cta">Manage →</span></div>
	</button>`;
}

// ── vault detail ─────────────────────────────────────────────────────────────
// `push` is false when the URL already reflects the view we are entering: a
// popstate (the browser moved us) or a first paint on /vaults?v=…. Pushing there
// appended a fresh entry on every Back press, so the visitor could never leave
// the page once they had opened a vault.
async function openDetail(id, { push = true } = {}) {
	stopPoll();
	$('#vx-feed-view').hidden = true;
	const dv = $('#vx-detail-view');
	dv.hidden = false;
	$('#vx-detail').innerHTML = '<div class="vx-detail-skel">Loading vault…</div>';
	window.scrollTo({ top: 0, behavior: 'smooth' });
	if (push) history.pushState({ v: id }, '', `/vaults?v=${id}`);
	await refreshDetail(id);
	state.pollTimer = setInterval(() => refreshDetail(id, true), 12_000);
}

// Every detail failure ends somewhere the visitor can act: a reason and a retry,
// never a spinner that never resolves.
function showDetailError(id, title, message) {
	$('#vx-detail').innerHTML = `<div class="vx-empty">
		<p class="vx-empty-t">${esc(title)}</p>
		<p class="vx-empty-d">${esc(message)}</p>
		<div class="vx-empty-actions">
			<button class="vx-btn vx-btn--primary" id="vx-detail-retry" type="button">Try again</button>
			<button class="vx-btn" id="vx-detail-back" type="button">All vaults</button>
		</div>
	</div>`;
	$('#vx-detail-retry')?.addEventListener('click', () => refreshDetail(id));
	$('#vx-detail-back')?.addEventListener('click', backToFeed);
}

async function refreshDetail(id, quiet = false) {
	let v;
	let ledger;
	try {
		const [vres, lres] = await Promise.all([
			apiFetch(`/api/vaults/${id}`, { allowAnonymous: true }),
			apiFetch(`/api/vaults/ledger?vault_id=${id}&limit=40`, { allowAnonymous: true }),
		]);
		if (!vres.ok) throw new Error(await readErr(vres, 'vault not found'));
		v = (await vres.json()).data;
		ledger = lres.ok ? ((await lres.json()).data?.items || []) : [];
	} catch (e) {
		// A poll that fails transiently must not blow away a good render, so a quiet
		// refresh keeps what is on screen and waits for the next tick.
		if (!quiet) showDetailError(id, "Couldn't load this vault", e.message);
		return;
	}
	state.vault = v;
	// Render failures are a different fault from load failures and must not be
	// reported as "couldn't load", which sends the visitor chasing their network.
	try {
		renderDetail(v, ledger);
	} catch (e) {
		stopPoll();
		showDetailError(id, "This vault couldn't be displayed", e.message);
	}
}

function renderDetail(v, ledger) {
	const nav = v.nav;
	const roi = nav.roi_bps || 0;
	const t = v.terms;
	const agentImg = v.agent?.image ? `<img class="vx-d-av" src="${esc(v.agent.image)}" alt="" loading="lazy" decoding="async" />` : '<div class="vx-d-av vx-d-av--ph" aria-hidden="true"></div>';
	const halted = v.status === 'paused';
	const closed = v.status === 'closing' || v.status === 'closed';

	// Real share-price history straight from the audit ledger (newest-first → chronological).
	const sparkPoints = (ledger || []).filter((e) => e.share_price_e6 != null).map((e) => ({ p: Number(BigInt(e.share_price_e6)) / ATOMICS })).reverse();
	const sparkTone = sparkPoints.length >= 2 ? (sparkPoints[sparkPoints.length - 1].p > sparkPoints[0].p ? 'pos' : sparkPoints[sparkPoints.length - 1].p < sparkPoints[0].p ? 'neg' : 'flat') : 'flat';
	const chartHtml = sparkPoints.length >= 2
		? sparkline(sparkPoints, { tone: sparkTone })
		: '<div class="vx-spark-empty">Share-price history appears once the vault records its first trades.</div>';
	const inPositions = BigInt(nav.nav_atomics) - BigInt(nav.usdc_atomics);
	const gaugeHtml = drawdownGauge(nav.peak_share_price_e6, nav.share_price_e6, t.max_drawdown_bps);
	const distHtml = backerDist(v.backers);
	const navHero = `<div class="vx-navhero">
		<div class="vx-navhero-main">
			<span class="vx-navhero-l">Vault NAV · live</span>
			<span class="vx-navhero-v">${usd(nav.nav_atomics)}</span>
			<span class="vx-navhero-roi ${signClass(roi)}">${roi > 0 ? '▲' : roi < 0 ? '▼' : '•'} ${roiText(roi)} all-time</span>
		</div>
		<div class="vx-navhero-chart">
			<div class="vx-chart-head"><span class="vx-chart-t">Share price</span><span class="vx-chart-now">${priceE6(nav.share_price_e6)}</span></div>
			${chartHtml}
		</div>
	</div>`;

	const statusBanner = halted
		? `<div class="vx-banner vx-banner--warn">⚠ Trading halted${v.halt_reason === 'drawdown' ? ' by the drawdown circuit breaker' : v.halt_reason === 'owner_pause' ? ' by the owner' : ''}. Backers can still redeem.</div>`
		: closed ? '<div class="vx-banner">Vault is winding down, redemptions only.</div>' : '';

	const repLine = v.reputation
		? `${repBadge(v.reputation)} <span class="vx-d-rep-detail">${v.reputation.closed_count} closed · ${(v.reputation.win_rate * 100).toFixed(0)}% win · ${Number(v.reputation.realized_pnl_sol).toFixed(2)} SOL realized · max DD ${Number(v.reputation.max_drawdown_pct).toFixed(0)}%</span>`
		: repBadge(null);

	const myPos = v.my_position;
	const mineBlock = myPos ? `
		<div class="vx-panel vx-panel--mine">
			<h3 class="vx-panel-h">Your position</h3>
			<div class="vx-kv-grid">
				<div><span>Shares</span><b>${shares(myPos.shares)}</b></div>
				<div><span>Current value</span><b>${usd(myPos.current_value_atomics)}</b></div>
				<div><span>Deposited</span><b>${usd(myPos.deposited_atomics)}</b></div>
				<div><span>Unrealized</span><b class="${signClass(Number(BigInt(myPos.unrealized_gain_atomics)))}">${Number(BigInt(myPos.unrealized_gain_atomics)) >= 0 ? '+' : '-'}${usd(BigInt(myPos.unrealized_gain_atomics) < 0n ? -BigInt(myPos.unrealized_gain_atomics) : BigInt(myPos.unrealized_gain_atomics))}</b></div>
			</div>
			<p class="vx-fineprint">Redeem now nets ~${usd(myPos.estimated_net_atomics)} after the ${pctBps(t.performance_fee_bps)} performance fee on gains.</p>
			<button class="vx-btn vx-btn--ghost vx-btn--block" id="vx-redeem-btn" type="button">Redeem</button>
		</div>` : '';

	// Filter BEFORE the empty check: a vault whose rows are all dust-zero has no
	// open positions, and the table must say so rather than render bare headers.
	const openPositions = v.positions.filter((p) => p.amount_raw !== '0');
	const positionsRows = openPositions.length
		? openPositions.map((p) => `<tr><td class="vx-mono">${shortMint(p.mint)}</td><td>${Number(p.amount_raw).toLocaleString()}</td><td>${p.mark_atomics != null ? usd(p.mark_atomics) : '<span class="vx-muted">repricing…</span>'}</td></tr>`).join('')
		: '<tr><td colspan="3" class="vx-muted">All capital is in USDC, no open positions.</td></tr>';

	const ownerBlock = v.is_owner ? ownerPanel(v) : '';

	$('#vx-detail').innerHTML = `
		${statusBanner}
		<div class="vx-d-head">
			${agentImg}
			<div class="vx-d-id">
				<h1 class="vx-d-name">${esc(v.agent?.name || 'Agent')}'s Vault</h1>
				<div class="vx-d-rep">${repLine}</div>
				<div class="vx-d-links">
					<a class="vx-link" href="/agent/${esc(v.agent_id)}">Agent profile →</a>
					<a class="vx-link" href="/agent/${esc(v.agent_id)}#trades">Watch it trade →</a>
				</div>
			</div>
			<div class="vx-d-cta">
				${closed ? '' : `<button class="vx-btn vx-btn--primary" id="vx-back-btn" type="button">Back this agent</button>`}
			</div>
		</div>

		${navHero}

		<div class="vx-d-metrics">
			<div class="vx-metric"><span class="vx-metric-l">Liquid USDC</span><span class="vx-metric-v">${usd(nav.usdc_atomics)}</span></div>
			<div class="vx-metric"><span class="vx-metric-l">In positions</span><span class="vx-metric-v">${usd(inPositions < 0n ? 0n : inPositions)}</span></div>
			<div class="vx-metric"><span class="vx-metric-l">Share price</span><span class="vx-metric-v">${priceE6(nav.share_price_e6)}</span></div>
			<div class="vx-metric"><span class="vx-metric-l">Backers</span><span class="vx-metric-v">${v.backer_count}</span></div>
		</div>

		<div class="vx-d-cols">
			<div class="vx-d-main">
				${mineBlock}
				<div class="vx-panel">
					<h3 class="vx-panel-h">Open positions <span class="vx-panel-sub">${nav.priced ? 'marked to market' : 'partial, repricing'}</span></h3>
					<table class="vx-table"><thead><tr><th>Token</th><th>Amount</th><th>Value</th></tr></thead><tbody>${positionsRows}</tbody></table>
				</div>
				${ownerBlock}
			</div>
			<aside class="vx-d-side">
				<div class="vx-panel">
					<h3 class="vx-panel-h">Terms</h3>
					<div class="vx-terms">
						<div><span>Performance fee</span><b>${pctBps(t.performance_fee_bps)}</b></div>
						<div><span>Drawdown stop</span><b>${pctBps(t.max_drawdown_bps)}</b></div>
						<div><span>Max per trade</span><b>${usd(t.max_per_trade_atomics)}</b></div>
						<div><span>Daily budget</span><b>${usd(t.daily_budget_atomics)}</b></div>
						<div><span>Per-backer cap</span><b>${t.per_backer_cap_atomics ? usd(t.per_backer_cap_atomics) : 'None'}</b></div>
						<div><span>Network</span><b>${esc(v.network)}</b></div>
					</div>
					${gaugeHtml}
					<p class="vx-fineprint">Funds live in a dedicated, segregated wallet. Trading is hard-capped and halts automatically on a ${pctBps(t.max_drawdown_bps)} drawdown. Not investment advice; you can lose principal.</p>
				</div>
				${distHtml ? `<div class="vx-panel"><h3 class="vx-panel-h">Capital distribution <span class="vx-panel-sub">${v.backer_count} backer${v.backer_count === 1 ? '' : 's'}</span></h3>${distHtml}</div>` : ''}
				<div class="vx-panel">
					<h3 class="vx-panel-h">Audit trail</h3>
					<ul class="vx-ledger" id="vx-ledger">${ledger.map(ledgerRow).join('') || '<li class="vx-muted">No activity yet.</li>'}</ul>
				</div>
			</aside>
		</div>`;

	$('#vx-back-btn')?.addEventListener('click', () => backModal(v));
	$('#vx-redeem-btn')?.addEventListener('click', () => redeemModal(v));
	wireOwner(v);
}

function ledgerRow(e) {
	const labels = { open: 'Vault opened', deposit: 'Deposit', redeem: 'Redemption', trade: 'Trade', fee: 'Fee accrued', fee_claim: 'Fee claim', drawdown_halt: 'Drawdown halt', pause: 'Paused', resume: 'Resumed', terms: 'Terms changed', close: 'Closing' };
	const icon = { deposit: '↘', redeem: '↗', trade: '⇄', drawdown_halt: '⚠', fee: '◆', fee_claim: '◆', open: '★', pause: '⏸', resume: '▶', terms: '⚙', close: '⏹' }[e.type] || '·';
	let detail = '';
	if (e.type === 'trade') detail = `${e.meta?.side === 'buy' ? 'Bought' : 'Sold'} ${shortMint(e.meta?.mint)}${e.meta?.usdc_in ? ` · ${usd(e.meta.usdc_in)}` : e.meta?.usdc_out ? ` · ${usd(e.meta.usdc_out)}` : ''}`;
	else if (e.type === 'deposit') detail = `+${shares(e.shares_delta || 0)} shares`;
	else if (e.type === 'redeem') detail = `${usd((e.meta?.net_atomics) || 0)} out`;
	else if (e.type === 'drawdown_halt') detail = 'circuit breaker tripped';
	const ts = new Date(e.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	const link = e.explorer ? `<a class="vx-ledger-x" href="${esc(e.explorer)}" target="_blank" rel="noopener" title="View on-chain">⧉</a>` : '';
	return `<li class="vx-ledger-row vx-ledger--${e.type}"><span class="vx-ledger-i" aria-hidden="true">${icon}</span><span class="vx-ledger-b"><b>${labels[e.type] || e.type}</b><span class="vx-ledger-d">${esc(detail)}</span></span><span class="vx-ledger-t">${ts}${link}</span></li>`;
}

// ── owner controls ─────────────────────────────────────────────────────────────
function ownerPanel(v) {
	const t = v.terms;
	const accrued = v.accrued_fee_atomics || '0';
	return `<div class="vx-panel vx-panel--owner">
		<h3 class="vx-panel-h">Owner controls</h3>
		<div class="vx-owner-row">
			${v.status === 'open' ? '<button class="vx-btn vx-btn--ghost" data-owner="pause" type="button">Pause trading</button>' : v.status === 'paused' ? '<button class="vx-btn" data-owner="resume" type="button">Resume trading</button>' : ''}
			<span class="vx-owner-fee">Accrued fees: <b>${usd(accrued)}</b></span>
			${BigInt(accrued) > 0n ? '<button class="vx-btn vx-btn--ghost" data-owner="claim" type="button">Claim fees</button>' : ''}
		</div>
		<form class="vx-trade-form" id="vx-trade-form">
			<h4 class="vx-trade-h">Deploy the pool</h4>
			<div class="vx-trade-grid">
				<select class="vx-input" id="vx-trade-side">
					<option value="buy">Buy (USDC → token)</option>
					<option value="sell">Sell (token → USDC)</option>
				</select>
				<input class="vx-input vx-mono" id="vx-trade-mint" placeholder="token mint address" />
				<input class="vx-input" id="vx-trade-amount" placeholder="USDC (buy) / amount or max (sell)" />
				<button class="vx-btn vx-btn--primary" id="vx-trade-go" type="submit" ${v.status !== 'open' ? 'disabled' : ''}>Trade</button>
			</div>
			<p class="vx-fineprint">Hard limits: ≤ ${usd(t.max_per_trade_atomics)}/trade, ≤ ${usd(t.daily_budget_atomics)}/day. A ${pctBps(t.max_drawdown_bps)} drawdown auto-halts the vault.</p>
		</form>
	</div>`;
}

function wireOwner(v) {
	$$('[data-owner]').forEach((b) => b.addEventListener('click', async () => {
		const act = b.dataset.owner;
		if (act === 'claim') return claimFees(v);
		b.disabled = true;
		try {
			const res = await apiFetch(`/api/vaults/${v.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: act }) });
			if (!res.ok) throw new Error(await readErr(res, 'action failed'));
			toast(act === 'pause' ? 'Trading paused' : 'Trading resumed', 'ok');
			await refreshDetail(v.id);
		} catch (e) { toast(e.message, 'err'); b.disabled = false; }
	}));

	$('#vx-trade-form')?.addEventListener('submit', async (ev) => {
		ev.preventDefault();
		const side = $('#vx-trade-side').value;
		const mint = $('#vx-trade-mint').value.trim();
		const amountRaw = $('#vx-trade-amount').value.trim();
		if (!mint) return toast('Enter a token mint', 'err');
		const go = $('#vx-trade-go');
		go.disabled = true; go.textContent = 'Trading…';
		const body = { vaultId: v.id, side, mint, slippageBps: 100 };
		if (side === 'buy') { const n = Number(amountRaw); if (!(n > 0)) { go.disabled = false; go.textContent = 'Trade'; return toast('Enter a USDC amount', 'err'); } body.usdc = n; }
		else body.amount = amountRaw || 'max';
		try {
			const res = await apiFetch('/api/vaults/trade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
			const j = await res.json();
			if (!res.ok) throw new Error(j.error_description || 'trade blocked');
			if (j.data?.halted) toast('Trade filled, drawdown breaker tripped, vault halted to protect capital.', 'warn');
			else toast(`Trade filled (${side}). NAV ${usd(j.data.nav_atomics)}`, 'ok');
			await refreshDetail(v.id);
		} catch (e) { toast(e.message, 'err'); }
		finally { go.disabled = false; go.textContent = 'Trade'; }
	});
}

async function claimFees(v) {
	const fundable = state.agents.filter((a) => a.walletReady);
	if (!fundable.length) return toast('Provision a Solana wallet on one of your agents to receive fees', 'err');
	const to = fundable[0];
	try {
		const res = await apiFetch('/api/vaults/claim-fees', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vaultId: v.id, toAgentId: to.id }) });
		const j = await res.json();
		if (!res.ok) throw new Error(j.error_description || 'claim failed');
		toast(`Claimed ${usd(j.data.claimed_atomics)} to ${to.name}`, 'ok');
		await refreshDetail(v.id);
	} catch (e) { toast(e.message, 'err'); }
}

// ── back (deposit) + redeem modals ──────────────────────────────────────────────
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])';
let modalOpener = null;

function focusablesIn(root) {
	return $$(FOCUSABLE, root).filter((el) => el.offsetParent !== null);
}

// A dialog that never takes focus leaves a keyboard user stranded behind the
// backdrop, and one that never gives it back drops them at the top of the page.
function modal(id, show) {
	const m = $(id);
	if (!m) return;
	const wasOpen = !m.hidden;
	if (show === wasOpen) return;
	m.hidden = !show;
	document.body.classList.toggle('vx-modal-open', show);
	if (show) {
		modalOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const target = focusablesIn(m).find((el) => !el.hasAttribute('data-close')) || focusablesIn(m)[0];
		target?.focus();
		return;
	}
	modalOpener?.focus();
	modalOpener = null;
}

function openModal() {
	return $$('.vx-modal').find((m) => !m.hidden) || null;
}

function closeModals() {
	modal('#vx-open-modal', false);
	modal('#vx-back-modal', false);
}

// Keep Tab inside the open dialog: aria-modal is a promise to assistive tech,
// not an enforcement, so the cycle has to be real.
function trapTab(e) {
	if (e.key !== 'Tab') return;
	const m = openModal();
	if (!m) return;
	const f = focusablesIn(m);
	if (!f.length) return;
	const first = f[0];
	const last = f[f.length - 1];
	if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
	else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function backModal(v) {
	if (!state.me) { window.location.href = '/login?next=' + encodeURIComponent(`/vaults?v=${v.id}`); return; }
	const fundable = state.agents.filter((a) => a.walletReady);
	const t = v.terms;
	const body = $('#vx-back-modal-body');
	if (!fundable.length) {
		body.innerHTML = `<h2 id="vx-back-title" class="vx-modal-title">Fund a wallet first</h2><p class="vx-modal-sub">Backing draws USDC from one of your agents' wallets. None of your agents has a funded Solana wallet yet.</p><a class="vx-btn vx-btn--primary vx-btn--block" href="/dashboard">Set up a wallet</a>`;
		modal('#vx-back-modal', true);
		return;
	}
	const capNote = t.per_backer_cap_atomics ? `Per-backer cap: ${usd(t.per_backer_cap_atomics)}.` : '';
	body.innerHTML = `
		<h2 id="vx-back-title" class="vx-modal-title">Back ${esc(v.agent?.name || 'this agent')}</h2>
		<p class="vx-modal-sub">You'll receive shares priced at the live NAV (${priceE6(v.nav.share_price_e6)}/share). P&amp;L is shared pro-rata; the owner earns ${pctBps(t.performance_fee_bps)} on your gains only.</p>
		<form id="vx-deposit-form" class="vx-form">
			<label class="vx-field">
				<span class="vx-label">Fund from</span>
				<select class="vx-input" id="vx-dep-agent">${fundable.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select>
			</label>
			<label class="vx-field">
				<span class="vx-label">Amount (USDC)</span>
				<div class="vx-input-suffix"><span>$</span><input class="vx-input" id="vx-dep-amount" type="number" min="1" step="0.01" placeholder="100.00" required /></div>
				<span class="vx-hint">${esc(capNote)} Real on-chain transfer, spend-limit checked.</span>
			</label>
			<div class="vx-risk">Backing deploys your own funds into a limit-bound, auditable strategy. You can lose principal. Redemptions pay at real NAV and may queue if capital is in open positions.</div>
			<div class="vx-form-err" id="vx-dep-err" hidden></div>
			<button class="vx-btn vx-btn--primary vx-btn--block" id="vx-dep-submit" type="submit">Confirm deposit</button>
		</form>`;
	modal('#vx-back-modal', true);
	$('#vx-deposit-form').addEventListener('submit', async (ev) => {
		ev.preventDefault();
		const backerAgentId = $('#vx-dep-agent').value;
		const amt = Number($('#vx-dep-amount').value);
		const errEl = $('#vx-dep-err');
		errEl.hidden = true;
		if (!(amt > 0)) { errEl.textContent = 'Enter a positive amount'; errEl.hidden = false; return; }
		const sub = $('#vx-dep-submit');
		sub.disabled = true; sub.textContent = 'Depositing…';
		try {
			const res = await apiFetch('/api/vaults/deposit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vaultId: v.id, backerAgentId, usdc: amt }) });
			const j = await res.json();
			if (!res.ok) throw new Error(j.error_description || 'deposit failed');
			// Round to whole atomics: `10.005 * 1_000_000` lands on 10004999.999999998
			// in binary floating point and BigInt() throws on that. The throw landed in
			// the catch below, so a deposit that had already settled on-chain was
			// reported back to the backer as a failure.
			toast(`Deposited ${usd(Math.round(amt * ATOMICS))} for ${shares(j.data.shares_minted)} shares`, 'ok');
			modal('#vx-back-modal', false);
			await refreshDetail(v.id);
		} catch (e) { errEl.textContent = e.message; errEl.hidden = false; }
		finally { sub.disabled = false; sub.textContent = 'Confirm deposit'; }
	});
}

function redeemModal(v) {
	const p = v.my_position;
	if (!p) return;
	const body = $('#vx-back-modal-body');
	body.innerHTML = `
		<h2 id="vx-back-title" class="vx-modal-title">Redeem from ${esc(v.agent?.name || 'this vault')}</h2>
		<p class="vx-modal-sub">You hold ${shares(p.shares)} shares worth ~${usd(p.current_value_atomics)}. Redeeming nets ~${usd(p.estimated_net_atomics)} after the ${pctBps(v.terms.performance_fee_bps)} fee on gains.</p>
		<form id="vx-redeem-form" class="vx-form">
			<label class="vx-field">
				<span class="vx-label">Shares to redeem</span>
				<input class="vx-input" id="vx-red-amount" type="text" value="max" />
				<span class="vx-hint">"max" redeems your full position. Paid to your funding wallet at real NAV.</span>
			</label>
			<div class="vx-form-err" id="vx-red-err" hidden></div>
			<button class="vx-btn vx-btn--primary vx-btn--block" id="vx-red-submit" type="submit">Confirm redemption</button>
		</form>`;
	modal('#vx-back-modal', true);
	$('#vx-redeem-form').addEventListener('submit', async (ev) => {
		ev.preventDefault();
		const raw = $('#vx-red-amount').value.trim();
		const shares_ = raw === 'max' || raw === '' ? 'max' : String(Math.floor(Number(raw) * ATOMICS));
		const errEl = $('#vx-red-err'); errEl.hidden = true;
		const sub = $('#vx-red-submit'); sub.disabled = true; sub.textContent = 'Redeeming…';
		try {
			const res = await apiFetch('/api/vaults/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vaultId: v.id, shares: shares_ }) });
			const j = await res.json();
			if (!res.ok && res.status !== 202) throw new Error(j.error_description || 'redeem failed');
			if (j.data?.status === 'queued') toast('No liquid USDC right now, your redemption is queued.', 'warn');
			else if (j.data?.status === 'partial') toast(`Partial: ${usd(j.data.net_atomics)} paid, rest queued.`, 'warn');
			else toast(`Redeemed, ${usd(j.data.net_atomics)} paid out`, 'ok');
			modal('#vx-back-modal', false);
			await refreshDetail(v.id);
		} catch (e) { errEl.textContent = e.message; errEl.hidden = false; }
		finally { sub.disabled = false; sub.textContent = 'Confirm redemption'; }
	});
}

// ── open a vault ────────────────────────────────────────────────────────────────
function openVaultModal() {
	if (!state.me) { window.location.href = '/login?next=' + encodeURIComponent('/vaults'); return; }
	const sel = $('#vx-open-agent');
	const submit = $('#vx-open-submit');
	const hint = $('#vx-open-agent-hint');
	if (!state.agents.length) {
		// No agents means nothing to open a vault behind. Say so and hand the visitor
		// the next step instead of letting them submit a form that can only 400.
		hint.innerHTML = 'You have no agents yet. <a class="vx-link" href="/create">Create one</a> and build a track record first.';
		sel.innerHTML = '<option value="">No agents yet</option>';
		sel.disabled = true;
		submit.disabled = true;
	} else {
		sel.disabled = false;
		submit.disabled = false;
		sel.innerHTML = state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
		hint.textContent = 'Only an agent with a verified on-chain track record can open a vault.';
	}
	modal('#vx-open-modal', true);
}

async function submitOpen(ev) {
	ev.preventDefault();
	const err = $('#vx-open-err'); err.hidden = true;
	const body = {
		agentId: $('#vx-open-agent').value,
		performanceFeeBps: Math.round(Number($('#vx-open-fee').value) * 100),
		maxDrawdownBps: Math.round(Number($('#vx-open-dd').value) * 100),
		maxPerTradeUsdc: Number($('#vx-open-pertrade').value),
		dailyBudgetUsdc: Number($('#vx-open-daily').value),
		perBackerCapUsdc: $('#vx-open-cap').value ? Number($('#vx-open-cap').value) : null,
	};
	const sub = $('#vx-open-submit'); sub.disabled = true; sub.textContent = 'Opening…';
	try {
		const res = await apiFetch('/api/vaults', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const j = await res.json();
		if (!res.ok) throw new Error(j.error_description || 'could not open vault');
		toast('Vault opened, share it so backers can stake.', 'ok');
		modal('#vx-open-modal', false);
		await openDetail(j.data.vault.id);
	} catch (e) { err.textContent = e.message; err.hidden = false; }
	finally { sub.disabled = false; sub.textContent = 'Open vault'; }
}

// ── navigation ───────────────────────────────────────────────────────────────
function setTab(tab) {
	state.tab = tab;
	state.feed = [];
	state.feedLoaded = false;
	$$('.vx-tab').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
	const sortEl = $('.vx-sort');
	if (sortEl) sortEl.style.display = tab === 'mine' ? 'none' : '';
	loadFeed();
}

function backToFeed({ push = true } = {}) {
	stopPoll();
	$('#vx-detail-view').hidden = true;
	$('#vx-feed-view').hidden = false;
	state.vault = null;
	if (push) history.pushState({}, '', '/vaults');
}

function stopPoll() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }

function wireGlobal() {
	$('#vx-open-cta')?.addEventListener('click', openVaultModal);
	$('#vx-sort')?.addEventListener('change', (e) => { state.sort = e.target.value; if (state.feed.length) renderFeed(); });
	$('#vx-back')?.addEventListener('click', backToFeed);
	$('#vx-open-form')?.addEventListener('submit', submitOpen);
	$$('.vx-tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
	$$('.vx-modal [data-close]').forEach((el) => el.addEventListener('click', closeModals));
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') closeModals();
		else trapTab(e);
	});
	window.addEventListener('popstate', () => {
		const id = new URL(location.href).searchParams.get('v');
		if (id) openDetail(id, { push: false }); else backToFeed({ push: false });
	});
}

async function init() {
	wireGlobal();
	// The public read does not need a session, so it goes out WITH the session
	// probe rather than behind it. Serialising the two put a full round trip
	// between first paint and the first vault on screen.
	const id = new URL(location.href).searchParams.get('v');
	await Promise.all([loadMe(), id ? openDetail(id, { push: false }) : loadFeed()]);
}

document.addEventListener('DOMContentLoaded', init);
