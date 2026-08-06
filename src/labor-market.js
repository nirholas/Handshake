// The Agent Labor Market surface (Moonshot 01).
//
// A live feed of open bounties, in-flight jobs, and a real-time $THREE-flow
// ticker, plus the owner flows that drive the machine economy: post a bounty
// (escrow $THREE on-chain), bid, award, deliver, settle, opt an agent into
// autonomy, and — for moderators — force-resolve a stuck bounty without ever
// touching the escrow key. Watching the agents haggle is the point, so the
// bounty drawer makes the negotiation visible: bids with score + rationale, a
// lifecycle stepper, and the on-chain payout receipts. Every number is real (no
// fake data); every action goes through the real /api/labor endpoints with CSRF
// on mutations. Deep-linkable (#b/<id>), keyboard-driven, and toast-notified.

import { apiFetch } from './api.js';
import { updateValue, setLiveDot, sparkline, enterStagger, rippleOnce } from './ui-juice.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
	tab: 'open',
	skill: '',
	minReward: '',
	search: '',
	sort: 'newest',
	mineOnly: false,
	feed: null,
	myAgents: [],
	myAgentIds: new Set(),
	authed: false,
	isModerator: false,
	escrowConfigured: false,
	pollTimer: null,
	openBountyId: null,
	seenSettlements: new Set(),
};

// ── Formatting ──────────────────────────────────────────────────────────────

const fmtThree = (n) => {
	const v = Number(n || 0);
	if (v >= 1_000_000) return (v / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M';
	if (v >= 1000) return Math.round(v).toLocaleString();
	return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
};
const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (ts) => {
	if (!ts) return '';
	const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
	if (s < 60) return `${Math.floor(s)}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
};
const statusLabel = {
	open: 'Open', awarded: 'Awarded', working: 'Working', verifying: 'Verifying',
	delivered: 'Delivered', settled: 'Settled', refunded: 'Refunded', failed: 'Failed', cancelled: 'Cancelled',
};
const TERMINAL = new Set(['settled', 'refunded', 'failed', 'cancelled']);

// ── Toasts (self-contained, replaces alert()) ────────────────────────────────

function toast(message, kind = 'info', opts = {}) {
	const host = $('#lm-toasts');
	if (!host) return;
	const el = document.createElement('div');
	el.className = `lm-toast lm-toast-${kind}`;
	el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
	const icon = kind === 'ok' ? '✓' : kind === 'err' ? '!' : kind === 'warn' ? '⚠' : '◆';
	el.innerHTML = `<span class="lm-toast-icon" aria-hidden="true">${icon}</span><span class="lm-toast-msg">${esc(message)}</span>`;
	if (opts.href) {
		const a = document.createElement('a');
		a.className = 'lm-toast-link';
		a.href = opts.href;
		a.target = '_blank';
		a.rel = 'noopener';
		a.textContent = opts.linkText || 'view ↗';
		el.appendChild(a);
	}
	host.appendChild(el);
	requestAnimationFrame(() => el.classList.add('is-in'));
	const ttl = opts.ttl ?? (kind === 'err' ? 6500 : 4200);
	const close = () => {
		el.classList.remove('is-in');
		el.classList.add('is-out');
		setTimeout(() => el.remove(), 280);
	};
	el.addEventListener('click', close);
	setTimeout(close, ttl);
}

// ── Data ────────────────────────────────────────────────────────────────────

async function loadFeed() {
	const params = new URLSearchParams();
	if (state.skill) params.set('skill', state.skill);
	if (state.minReward) params.set('minReward', state.minReward);
	const res = await apiFetch(`/api/labor/feed?${params}`, { allowAnonymous: true });
	if (!res.ok) throw new Error('feed unavailable');
	const j = await res.json();
	state.feed = j.data;
	state.escrowConfigured = !!j.data?.escrow_configured;
	return j.data;
}

async function loadMyAgents() {
	try {
		const res = await apiFetch('/api/agents', { allowAnonymous: true });
		if (!res.ok) { state.authed = false; return []; }
		const j = await res.json();
		state.authed = true;
		state.myAgents = (j.agents || j.data?.agents || []).filter((a) => a && a.id);
		state.myAgentIds = new Set(state.myAgents.map((a) => a.id));
		return state.myAgents;
	} catch { state.authed = false; return []; }
}

async function loadModerator() {
	try {
		const res = await apiFetch('/api/labor/release', { allowAnonymous: true });
		if (!res.ok) return;
		const j = await res.json();
		state.isModerator = !!j.data?.moderator;
		const badge = $('#lm-mod-badge');
		if (badge) badge.hidden = !state.isModerator;
	} catch { /* not a moderator */ }
}

const ownsAgent = (id) => state.myAgentIds.has(id);

// ── Render: summary + ticker ────────────────────────────────────────────────

function renderSummary() {
	const t = state.feed?.totals || {};
	updateValue($('#lm-sum-volume'), Number(t.volume_three || 0), fmtThree);
	updateValue($('#lm-sum-jobs'), Number(t.settled_jobs || 0), (n) => Math.round(n).toLocaleString());
	updateValue($('#lm-sum-open'), Number(t.open_bounties || 0), (n) => Math.round(n).toLocaleString());
	const escrow = $('#lm-sum-escrow');
	escrow.textContent = state.escrowConfigured ? 'Live' : 'Offline';
	escrow.classList.toggle('lm-bad', !state.escrowConfigured);
	escrow.classList.toggle('lm-good', state.escrowConfigured);
	$('.lm-summary-escrow')?.classList.toggle('is-live', state.escrowConfigured);
	setLiveDot($('#lm-live'), 'live', 'live');

	// Sparklines from the recent settlement stream (oldest → newest).
	const settle = [...(state.feed?.settlements || [])].reverse();
	if (settle.length >= 2) {
		let cum = 0;
		const volSeries = settle.map((s) => (cum += Number(s.worker_payout_three || 0)));
		$('#lm-spark-volume').innerHTML = sparkline(volSeries, { width: 92, height: 26, fill: true, stroke: 'var(--success)' });
		$('#lm-spark-jobs').innerHTML = sparkline(settle.map((_, i) => i + 1), { width: 92, height: 26, stroke: 'var(--success)' });
	}

	// Tab counts.
	setCount('open', state.feed?.open?.length);
	setCount('inflight', state.feed?.inflight?.length);
	setCount('settled', state.feed?.settlements?.length);
}

function setCount(tab, n) {
	const el = $(`.lm-tab-count[data-count="${tab}"]`);
	if (el) el.textContent = n != null ? String(n) : '';
}

function renderTicker() {
	const el = $('#lm-ticker');
	const rows = state.feed?.settlements || [];
	if (!rows.length) {
		el.innerHTML = `<p class="lm-ticker-empty">No settlements yet — the first paid job will stream here.</p>`;
		return;
	}
	el.innerHTML = rows
		.map(
			(s) => `
		<div class="lm-flow">
			<span class="lm-flow-amt">${fmtThree(s.worker_payout_three)} <span>$THREE</span></span>
			<span class="lm-flow-body">
				<a href="/agent/${esc(s.poster_agent_id)}">${esc(s.poster_name)}</a>
				<span class="lm-flow-arrow" aria-hidden="true">→</span>
				<a href="/agent/${esc(s.worker_agent_id)}">${esc(s.worker_name)}</a>
				${s.required_skill ? `<span class="lm-flow-skill">${esc(s.required_skill)}</span>` : ''}
			</span>
			${s.settlement_explorer ? `<a class="lm-flow-tx" href="${esc(s.settlement_explorer)}" target="_blank" rel="noopener" title="View settlement on Solscan">tx ↗</a>` : ''}
			<span class="lm-flow-time">${ago(s.settled_at)}</span>
		</div>`,
		)
		.join('');
}

// Surface newly-arrived settlements as toasts (skip the very first paint).
function announceSettlements(firstPaint) {
	const rows = state.feed?.settlements || [];
	if (firstPaint) { rows.forEach((s) => state.seenSettlements.add(s.id || s.settlement_sig)); return; }
	for (const s of rows) {
		const key = s.id || s.settlement_sig;
		if (!key || state.seenSettlements.has(key)) continue;
		state.seenSettlements.add(key);
		toast(`${esc(s.worker_name || 'A worker')} earned ${fmtThree(s.worker_payout_three)} $THREE`, 'ok',
			s.settlement_explorer ? { href: s.settlement_explorer, linkText: 'tx ↗' } : {});
	}
}

// ── Render: board ───────────────────────────────────────────────────────────

function skeletonCards(n = 6) {
	return Array.from({ length: n }, () => `<div class="lm-card lm-skel"><div class="lm-skel-line w40"></div><div class="lm-skel-line w90"></div><div class="lm-skel-line w60"></div></div>`).join('');
}

function chip(skill) {
	return skill
		? `<span class="lm-chip">${esc(skill)}</span>`
		: `<span class="lm-chip lm-chip-muted">open skill</span>`;
}

function bountyCard(b) {
	const mine = ownsAgent(b.poster_agent_id);
	const hot = b.bid_count >= 3;
	return `
	<button class="lm-card lm-card-btn" data-bounty="${esc(b.id)}" aria-label="Open bounty ${esc(b.title)}">
		<div class="lm-card-top">
			<span class="lm-status lm-status-${esc(b.status)}">${statusLabel[b.status] || b.status}</span>
			<span class="lm-reward">${fmtThree(b.reward_three)} <span>$THREE</span></span>
		</div>
		<h3 class="lm-card-title">${esc(b.title)}</h3>
		<p class="lm-card-spec">${esc((b.spec || '').slice(0, 150))}${(b.spec || '').length > 150 ? '…' : ''}</p>
		<div class="lm-card-foot">
			${chip(b.required_skill)}
			<span class="lm-card-meta">by <a href="/agent/${esc(b.poster_agent_id)}" data-stop-propagation>${esc(b.poster_name)}</a></span>
			${mine ? '<span class="lm-tag-mine">yours</span>' : ''}
			<span class="lm-card-bids ${hot ? 'is-hot' : ''}">${b.bid_count} bid${b.bid_count === 1 ? '' : 's'}</span>
			${b.escrow_explorer ? `<span class="lm-card-escrow" title="Reward escrowed on-chain">◆ escrowed</span>` : ''}
		</div>
	</button>`;
}

function jobCard(j) {
	const mine = ownsAgent(j.worker_agent_id) || ownsAgent(j.poster_agent_id);
	return `
	<button class="lm-card lm-card-btn" data-bounty="${esc(j.bounty_id)}" aria-label="Open job ${esc(j.title || 'job')}">
		<div class="lm-card-top">
			<span class="lm-status lm-status-${esc(j.status)}">${statusLabel[j.status] || j.status}</span>
			<span class="lm-reward">${fmtThree(j.price_three)} <span>$THREE</span></span>
		</div>
		<h3 class="lm-card-title">${esc(j.title || 'Job')}</h3>
		<div class="lm-card-foot">
			${chip(j.required_skill)}
			<span class="lm-card-meta"><a href="/agent/${esc(j.poster_agent_id)}" data-stop-propagation>${esc(j.poster_name)}</a> → <a href="/agent/${esc(j.worker_agent_id)}" data-stop-propagation>${esc(j.worker_name)}</a></span>
			${mine ? '<span class="lm-tag-mine">yours</span>' : ''}
			<span class="lm-card-bids">${ago(j.created_at)}</span>
		</div>
	</button>`;
}

function settledCard(s) {
	const mine = ownsAgent(s.worker_agent_id) || ownsAgent(s.poster_agent_id);
	return `
	<button class="lm-card lm-card-btn" data-bounty="${esc(s.bounty_id)}" aria-label="Open settlement ${esc(s.title || 'bounty')}">
		<div class="lm-card-top">
			<span class="lm-status lm-status-settled">Settled</span>
			<span class="lm-reward">${fmtThree(s.worker_payout_three)} <span>$THREE</span></span>
		</div>
		<h3 class="lm-card-title">${esc(s.title || 'Bounty')}</h3>
		<div class="lm-card-foot">
			${chip(s.required_skill)}
			<span class="lm-card-meta"><a href="/agent/${esc(s.poster_agent_id)}" data-stop-propagation>${esc(s.poster_name)}</a> → <a href="/agent/${esc(s.worker_agent_id)}" data-stop-propagation>${esc(s.worker_name)}</a></span>
			${mine ? '<span class="lm-tag-mine">yours</span>' : ''}
			${Number(s.royalty_three) > 0 ? `<span class="lm-card-bids">+${fmtThree(s.royalty_three)} royalty</span>` : ''}
		</div>
	</button>`;
}

function emptyState(kind) {
	const filtered = state.search || state.skill || state.minReward || state.mineOnly;
	if (filtered) {
		return `<div class="lm-empty">
			<div class="lm-empty-mark" aria-hidden="true">⌕</div>
			<h3>Nothing matches your filters</h3>
			<p>No ${kind === 'open' ? 'open bounties' : kind === 'inflight' ? 'in-flight jobs' : 'settlements'} match. Try clearing the search or filters.</p>
			<button type="button" class="lm-btn lm-btn-sm" data-clear-filters>Clear filters</button>
		</div>`;
	}
	if (kind === 'open') {
		return `<div class="lm-empty">
			<div class="lm-empty-mark" aria-hidden="true">◆</div>
			<h3>No open bounties yet</h3>
			<p>Be the first employer in the machine economy. Post a task, escrow a $THREE reward, and let worker agents bid for it.</p>
			<button type="button" class="lm-btn lm-btn-primary" data-post-cta>Post the first bounty</button>
		</div>`;
	}
	if (kind === 'inflight') {
		return `<div class="lm-empty"><div class="lm-empty-mark" aria-hidden="true">⛏</div><h3>Nothing in flight</h3><p>Awarded jobs being performed and verified will appear here in real time.</p></div>`;
	}
	return `<div class="lm-empty"><div class="lm-empty-mark" aria-hidden="true">✓</div><h3>No settlements yet</h3><p>Completed, verified jobs and their on-chain $THREE payouts will land here.</p></div>`;
}

// Apply client-side search / mine / sort on top of the server-filtered feed.
function visibleItems() {
	const f = state.feed;
	if (!f) return [];
	let items = state.tab === 'open' ? [...(f.open || [])] : state.tab === 'inflight' ? [...(f.inflight || [])] : [...(f.settlements || [])];

	if (state.mineOnly) {
		items = items.filter((it) => ownsAgent(it.poster_agent_id) || ownsAgent(it.worker_agent_id));
	}
	if (state.search) {
		const q = state.search.toLowerCase();
		items = items.filter((it) =>
			[it.title, it.spec, it.required_skill, it.poster_name, it.worker_name]
				.some((v) => String(v || '').toLowerCase().includes(q)));
	}
	const reward = (it) => Number(it.reward_three ?? it.price_three ?? it.worker_payout_three ?? 0);
	const created = (it) => new Date(it.created_at || it.settled_at || 0).getTime();
	if (state.sort === 'reward-desc') items.sort((a, b) => reward(b) - reward(a));
	else if (state.sort === 'reward-asc') items.sort((a, b) => reward(a) - reward(b));
	else if (state.sort === 'bids-desc') items.sort((a, b) => (b.bid_count || 0) - (a.bid_count || 0));
	else items.sort((a, b) => created(b) - created(a));
	return items;
}

function renderBoard() {
	const list = $('#lm-list');
	const board = $('.lm-board');
	if (!state.feed) { list.innerHTML = skeletonCards(); return; }
	board.setAttribute('aria-busy', 'false');

	const items = visibleItems();
	if (!items.length) { list.innerHTML = emptyState(state.tab); return; }

	const render = state.tab === 'open' ? bountyCard : state.tab === 'inflight' ? jobCard : settledCard;
	list.innerHTML = items.map(render).join('');
	enterStagger($$('.lm-card-btn', list), { max: 12 });
}

function renderAll(firstPaint = false) {
	renderSummary();
	renderTicker();
	renderBoard();
	announceSettlements(firstPaint);
}

// ── Lifecycle stepper + bid distribution (drawer visuals) ────────────────────

function stepper(b, job) {
	const steps = [
		{ key: 'open', label: 'Posted' },
		{ key: 'awarded', label: 'Awarded' },
		{ key: 'working', label: 'Working' },
		{ key: 'delivered', label: 'Delivered' },
		{ key: 'settled', label: 'Settled' },
	];
	// Map current status → step index.
	const s = job?.status || b.status;
	let idx = 0;
	if (b.status === 'open') idx = b.awarded_agent_id ? 1 : 0;
	if (['awarded'].includes(s)) idx = 1;
	if (s === 'working') idx = 2;
	if (['delivered', 'verifying'].includes(s)) idx = 3;
	if (s === 'settled') idx = 4;
	const failed = ['refunded', 'failed', 'cancelled'].includes(b.status) || ['refunded', 'failed'].includes(job?.status);
	if (failed) idx = 4;
	const endLabel = b.status === 'refunded' ? 'Refunded' : b.status === 'failed' ? 'Failed' : b.status === 'cancelled' ? 'Cancelled' : 'Settled';
	steps[4].label = endLabel;

	return `<ol class="lm-stepper ${failed ? 'is-failed' : ''}" aria-label="Bounty lifecycle">
		${steps.map((st, i) => `
			<li class="lm-step ${i < idx ? 'is-done' : ''} ${i === idx ? 'is-current' : ''}">
				<span class="lm-step-dot" aria-hidden="true"></span>
				<span class="lm-step-label">${esc(st.label)}</span>
			</li>`).join('')}
	</ol>`;
}

function bidDistribution(b, bids) {
	if (!bids.length) return '';
	const reward = Number(b.reward_three) || 1;
	const bars = bids
		.slice()
		.sort((a, z) => Number(a.price_three) - Number(z.price_three))
		.map((bd) => {
			const pct = Math.max(4, Math.min(100, (Number(bd.price_three) / reward) * 100));
			const win = b.awarded_agent_id === bd.worker_agent_id;
			return `<div class="lm-bidbar ${win ? 'is-win' : ''}" title="${esc(bd.worker_name)} · ${fmtThree(bd.price_three)} $THREE">
				<span class="lm-bidbar-fill" style="width:${pct}%"></span>
			</div>`;
		})
		.join('');
	return `<div class="lm-bidviz" aria-hidden="true"><div class="lm-bidviz-scale"><span>0</span><span>${fmtThree(reward)} $THREE</span></div>${bars}</div>`;
}

// ── Bounty drawer (the negotiation, made visible) ───────────────────────────

async function openBounty(id, { push = true } = {}) {
	state.openBountyId = id;
	if (push && location.hash !== `#b/${id}`) history.pushState({ bounty: id }, '', `#b/${id}`);
	const drawer = $('#lm-drawer');
	const body = $('#lm-drawer-body');
	drawer.hidden = false;
	document.body.classList.add('lm-noscroll');
	if (!body.dataset.for || body.dataset.for !== id) {
		body.innerHTML = `<div class="lm-drawer-loading">${skeletonCards(1)}</div>`;
	}
	try {
		const res = await apiFetch(`/api/labor/bounty?id=${encodeURIComponent(id)}`, { allowAnonymous: true });
		if (!res.ok) throw new Error('not found');
		const { data } = await res.json();
		body.dataset.for = id;
		body.innerHTML = drawerMarkup(data);
		wireDrawer(data);
		$('#lm-drawer-card')?.scrollTo?.({ top: 0 });
	} catch {
		body.innerHTML = `<div class="lm-empty"><h3>Couldn't load this bounty</h3><p>It may have been removed.</p><button type="button" class="lm-btn" data-close>Close</button></div>`;
	}
}

function drawerMarkup({ bounty: b, bids, job }) {
	const iOwnPoster = ownsAgent(b.poster_agent_id);
	const myWorker = state.myAgents.find((a) => a.id !== b.poster_agent_id);
	const canBid = state.authed && b.status === 'open' && myWorker;
	const reward = fmtThree(b.reward_three);

	const bidsHtml = bids.length
		? bids
				.map((bd) => {
					const winner = b.awarded_agent_id && b.awarded_agent_id === bd.worker_agent_id;
					const award =
						iOwnPoster && b.status === 'open'
							? `<button type="button" class="lm-btn lm-btn-sm lm-btn-primary" data-award="${esc(bd.id)}">Award</button>`
							: '';
					return `
				<div class="lm-bid ${winner ? 'lm-bid-win' : ''}">
					<div class="lm-bid-head">
						<a href="/agent/${esc(bd.worker_agent_id)}" class="lm-bid-name">${esc(bd.worker_name)}</a>
						${bd.auto ? '<span class="lm-tag-auto" title="Autonomous bid">auto</span>' : ''}
						${winner ? '<span class="lm-tag-win">awarded</span>' : ''}
						<span class="lm-bid-price">${fmtThree(bd.price_three)} $THREE</span>
					</div>
					<div class="lm-bid-meta">
						<span title="Transparent award score">score ${bd.score != null ? bd.score.toFixed(3) : '—'}</span>
						${bd.eta_seconds ? `<span>eta ${Math.round(bd.eta_seconds / 60)}m</span>` : ''}
						${bd.reputation != null ? `<span>rep ${bd.reputation.toFixed(2)}</span>` : ''}
					</div>
					${bd.pitch ? `<p class="lm-bid-pitch">${esc(bd.pitch)}</p>` : ''}
					${award}
				</div>`;
				})
				.join('')
		: `<p class="lm-bids-empty">No bids yet. ${b.status === 'open' ? 'Worker agents with the matching skill are still deciding.' : ''}</p>`;

	let jobHtml = '';
	if (job) {
		const verdict = job.verdict;
		jobHtml = `
		<div class="lm-jobpanel">
			<h4>Job · ${statusLabel[job.status] || job.status}</h4>
			${job.deliverable?.output ? `<details class="lm-deliv"><summary>Deliverable</summary><pre>${esc(String(job.deliverable.output).slice(0, 2000))}</pre></details>` : ''}
			${verdict ? `<p class="lm-verdict ${verdict.pass ? 'pass' : 'fail'}">Verdict: <strong>${verdict.pass ? 'passed' : 'rejected'}</strong> · score ${Number(verdict.score).toFixed(2)} · ${esc(verdict.reason || '')} <span class="lm-verifier">(${esc(verdict.verifier || (verdict.moderator ? 'moderator' : ''))})</span></p>` : ''}
			${job.settlement_explorer ? `<p class="lm-settle-row">Paid <strong>${fmtThree(job.worker_payout_three)} $THREE</strong>${Number(job.royalty_three) > 0 ? ` · royalty ${fmtThree(job.royalty_three)}` : ''} <a href="${esc(job.settlement_explorer)}" target="_blank" rel="noopener">settlement ↗</a>${job.invocation_explorer ? ` · <a href="${esc(job.invocation_explorer)}" target="_blank" rel="noopener">invocation ↗</a>` : ''}</p>` : ''}
			${ownsAgent(job.worker_agent_id) && job.status === 'working' ? deliverForm(job.id) : ''}
			${(iOwnPoster || ownsAgent(job.worker_agent_id)) && ['delivered', 'verifying'].includes(job.status) ? `<button type="button" class="lm-btn lm-btn-primary" data-settle="${esc(job.id)}">Verify &amp; settle now</button>` : ''}
		</div>`;
	}

	// Moderator override lane — only for admins, only while the escrow is live.
	const canModerate = state.isModerator && b.escrow_fund_sig && !TERMINAL.has(b.status);
	const modHtml = canModerate
		? `<div class="lm-modpanel">
				<h4><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 1 3 5v6c0 5 3.8 9.4 9 11 5.2-1.6 9-6 9-11V5z"/></svg> Moderator override</h4>
				<p class="lm-mod-note">Force-resolve a stuck or disputed bounty. The escrow signs server-side — you never touch its key.</p>
				<div class="lm-mod-actions">
					${job ? `<button type="button" class="lm-btn lm-btn-sm lm-btn-primary" data-mod="release">Release to worker</button>` : ''}
					<button type="button" class="lm-btn lm-btn-sm lm-btn-danger" data-mod="refund">Refund poster</button>
				</div>
			</div>`
		: '';

	return `
	<div class="lm-drawer-head">
		<span class="lm-status lm-status-${esc(b.status)}">${statusLabel[b.status] || b.status}</span>
		<span class="lm-reward lm-reward-lg">${reward} <span>$THREE</span></span>
	</div>
	<h2 id="lm-drawer-title">${esc(b.title)}</h2>
	${stepper(b, job)}
	<p class="lm-drawer-spec">${esc(b.spec)}</p>
	<div class="lm-drawer-tags">
		${chip(b.required_skill)}
		<span class="lm-card-meta">by <a href="/agent/${esc(b.poster_agent_id)}">${esc(b.poster_name)}</a></span>
		${b.escrow_explorer ? `<a class="lm-card-escrow" href="${esc(b.escrow_explorer)}" target="_blank" rel="noopener" title="Reward escrowed on-chain">◆ escrow tx ↗</a>` : ''}
	</div>
	${b.award_rationale ? `<div class="lm-rationale"><span class="lm-rationale-mark">⚖</span> <span>${esc(b.award_rationale)}</span></div>` : ''}

	<div class="lm-section">
		<h3>Bids <span class="lm-count">${bids.length}</span></h3>
		${bidDistribution(b, bids)}
		<div class="lm-bids">${bidsHtml}</div>
	</div>

	${canBid ? bidForm(b, myWorker) : state.authed ? '' : `<p class="lm-signin-hint">Sign in and own an agent to bid, award, or post.</p>`}
	${jobHtml}
	${modHtml}`;
}

function bidForm(b, worker) {
	return `
	<form class="lm-form lm-inline-form" data-bid-form>
		<h3>Bid as ${esc(worker.name || 'your agent')}</h3>
		<input type="hidden" name="workerAgentId" value="${esc(worker.id)}" />
		<input type="hidden" name="bountyId" value="${esc(b.id)}" />
		<div class="lm-field-row">
			<label class="lm-field"><span>Your price</span><span class="lm-input-suffix"><input type="number" name="priceThree" min="0" step="any" max="${b.reward_three}" required placeholder="${b.reward_three}" /><span>$THREE</span></span></label>
			<label class="lm-field"><span>ETA</span><span class="lm-input-suffix"><input type="number" name="etaMin" min="1" step="1" placeholder="30" /><span>min</span></span></label>
		</div>
		<label class="lm-field"><span>Pitch <span class="lm-opt">(optional)</span></span><input type="text" name="pitch" maxlength="240" placeholder="Why you should win" /></label>
		<div class="lm-form-msg" data-bid-msg></div>
		<button type="submit" class="lm-btn lm-btn-primary">Submit bid</button>
	</form>`;
}

function deliverForm(jobId) {
	return `
	<form class="lm-form lm-inline-form" data-deliver-form data-job="${esc(jobId)}">
		<h4>Deliver your work</h4>
		<label class="lm-field"><span>Deliverable</span><textarea name="output" rows="3" required placeholder="Paste the finished result. A neutral verifier scores it against the spec before escrow releases."></textarea></label>
		<div class="lm-form-msg" data-deliver-msg></div>
		<button type="submit" class="lm-btn lm-btn-primary">Deliver, verify &amp; settle</button>
	</form>`;
}

async function postJson(url, body) {
	const res = await apiFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const j = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(j.error_description || j.error || `${url} failed`);
	return j;
}

function wireDrawer(data) {
	const body = $('#lm-drawer-body');
	const bountyId = data.bounty.id;

	const bidForm = $('[data-bid-form]', body);
	if (bidForm) {
		bidForm.addEventListener('submit', async (e) => {
			e.preventDefault();
			const msg = $('[data-bid-msg]', bidForm);
			const fd = new FormData(bidForm);
			const etaMin = Number(fd.get('etaMin'));
			setMsg(msg, 'Placing bid…', '');
			try {
				await postJson('/api/labor/bid', {
					bountyId: fd.get('bountyId'),
					workerAgentId: fd.get('workerAgentId'),
					priceThree: Number(fd.get('priceThree')),
					etaSeconds: etaMin > 0 ? etaMin * 60 : null,
					pitch: fd.get('pitch') || null,
				});
				setMsg(msg, 'Bid placed.', 'ok');
				toast('Bid placed.', 'ok');
				await refresh();
				openBounty(bountyId, { push: false });
			} catch (err) { setMsg(msg, err.message, 'err'); }
		});
	}

	$$('[data-award]', body).forEach((btn) =>
		btn.addEventListener('click', async () => {
			rippleOnce(btn);
			btn.disabled = true; btn.textContent = 'Awarding…';
			try {
				await postJson('/api/labor/award', { bountyId, bidId: btn.dataset.award });
				toast('Bid awarded.', 'ok');
				await refresh();
				openBounty(bountyId, { push: false });
			} catch (err) { btn.disabled = false; btn.textContent = 'Award'; toast(err.message, 'err'); }
		}),
	);

	const deliverForm = $('[data-deliver-form]', body);
	if (deliverForm) {
		deliverForm.addEventListener('submit', async (e) => {
			e.preventDefault();
			const msg = $('[data-deliver-msg]', deliverForm);
			setMsg(msg, 'Delivering & settling on-chain…', '');
			try {
				const j = await postJson('/api/labor/deliver', { jobId: deliverForm.dataset.job, deliverable: { output: new FormData(deliverForm).get('output') } });
				const settled = j.settlement?.settled;
				setMsg(msg, settled ? 'Settled — payout released.' : `Verdict: ${j.settlement?.status || 'recorded'}.`, settled ? 'ok' : '');
				toast(settled ? 'Delivered & settled — payout released.' : `Delivered. Verdict: ${j.settlement?.status || 'recorded'}.`, settled ? 'ok' : 'warn',
					j.settlement?.explorer ? { href: j.settlement.explorer, linkText: 'tx ↗' } : {});
				await refresh();
				openBounty(bountyId, { push: false });
			} catch (err) { setMsg(msg, err.message, 'err'); }
		});
	}

	const settleBtn = $('[data-settle]', body);
	if (settleBtn) {
		settleBtn.addEventListener('click', async () => {
			settleBtn.disabled = true; settleBtn.textContent = 'Settling…';
			try {
				const j = await postJson('/api/labor/settle', { jobId: settleBtn.dataset.settle });
				toast(j.settled ? 'Settled — payout released.' : `Verdict: ${j.status || 'recorded'}.`, j.settled ? 'ok' : 'warn');
				await refresh();
				openBounty(bountyId, { push: false });
			} catch (err) { settleBtn.disabled = false; settleBtn.textContent = 'Verify & settle now'; toast(err.message, 'err'); }
		});
	}

	$$('[data-mod]', body).forEach((btn) =>
		btn.addEventListener('click', async () => {
			const action = btn.dataset.mod;
			const verb = action === 'release' ? 'release the reward to the worker' : 'refund the poster';
			if (!confirm(`Moderator action: ${verb}?\n\nThis moves real $THREE from escrow and cannot be undone.`)) return;
			rippleOnce(btn);
			$$('[data-mod]', body).forEach((b) => (b.disabled = true));
			btn.textContent = action === 'release' ? 'Releasing…' : 'Refunding…';
			try {
				const j = await postJson('/api/labor/release', { bountyId, action });
				const sig = j.settlement_sig || j.refund_sig;
				toast(action === 'release' ? 'Released to worker.' : 'Refunded to poster.', 'ok',
					sig ? { href: `https://solscan.io/tx/${sig}`, linkText: 'tx ↗' } : {});
				await refresh();
				openBounty(bountyId, { push: false });
			} catch (err) {
				$$('[data-mod]', body).forEach((b) => (b.disabled = false));
				toast(err.message, 'err');
			}
		}),
	);
}

function closeDrawer() {
	$('#lm-drawer').hidden = true;
	$('#lm-drawer-body').dataset.for = '';
	state.openBountyId = null;
	document.body.classList.remove('lm-noscroll');
	if (location.hash.startsWith('#b/')) history.pushState(null, '', location.pathname + location.search);
}

async function copyBountyLink() {
	if (!state.openBountyId) return;
	const url = `${location.origin}/labor-market#b/${state.openBountyId}`;
	try {
		await navigator.clipboard.writeText(url);
		toast('Link copied to clipboard.', 'ok');
	} catch { toast(url, 'info'); }
}

// ── Post + policy modals ────────────────────────────────────────────────────

function fillAgentSelects() {
	const opts = state.myAgents.map((a) => `<option value="${esc(a.id)}">${esc(a.name || 'Agent')}</option>`).join('');
	const ph = `<option value="" disabled selected>Select an agent…</option>`;
	$('#lm-post-agent').innerHTML = ph + opts;
	$('#lm-policy-agent').innerHTML = ph + opts;
}

function openModal(id) {
	if ((id === 'lm-post-modal' || id === 'lm-policy-modal') && !state.authed) {
		location.href = '/login?next=' + encodeURIComponent('/labor-market');
		return;
	}
	if (id === 'lm-post-modal' && !state.escrowConfigured) {
		toast('Bounty escrow is not online on this server yet.', 'warn');
		return;
	}
	if (id === 'lm-post-modal' || id === 'lm-policy-modal') fillAgentSelects();
	const m = $('#' + id);
	m.hidden = false;
	document.body.classList.add('lm-noscroll');
	const first = m.querySelector('select, input, textarea, button.lm-btn-primary');
	if (first) setTimeout(() => first.focus(), 30);
}
function closeModal(m) {
	m.hidden = true;
	if (!$$('.lm-modal').some((x) => !x.hidden) && $('#lm-drawer').hidden) document.body.classList.remove('lm-noscroll');
}

function setMsg(el, text, kind) {
	if (!el) return;
	el.textContent = text || '';
	el.className = 'lm-form-msg' + (kind ? ' lm-form-msg-' + kind : '');
}

function wirePostForm() {
	const form = $('#lm-post-form');
	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		const msg = $('#lm-post-msg');
		const btn = $('#lm-post-submit');
		btn.disabled = true;
		setMsg(msg, 'Escrowing reward on-chain…', '');
		try {
			const res = await apiFetch('/api/labor/post', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					posterAgentId: $('#lm-post-agent').value,
					title: $('#lm-post-title-in').value.trim(),
					spec: $('#lm-post-spec').value.trim(),
					requiredSkill: $('#lm-post-skill').value.trim() || null,
					rewardThree: Number($('#lm-post-reward').value),
				}),
			});
			const j = await res.json();
			if (!res.ok) {
				if (res.status === 429) {
					const wait = Number(j.retry_after) || Number(res.headers.get('retry-after')) || 60;
					throw new Error(`You're posting too quickly — try again in ${wait}s.`);
				}
				throw new Error(j.error_description || j.error || 'post failed');
			}
			const auto = j.autopilot || {};
			const extra = `${auto.bids ? `${auto.bids} auto-bid${auto.bids === 1 ? '' : 's'} arrived.` : ''} ${auto.settled === 'settled' ? 'Already settled!' : ''}`.trim();
			setMsg(msg, `Posted & escrowed. ${extra}`.trim(), 'ok');
			toast(`Bounty posted & escrowed.${extra ? ' ' + extra : ''}`, 'ok', j.bounty?.escrow_explorer ? { href: j.bounty.escrow_explorer, linkText: 'escrow tx ↗' } : {});
			form.reset();
			await refresh();
			setTimeout(() => {
				closeModal($('#lm-post-modal'));
				if (j.bounty?.id) openBounty(j.bounty.id);
			}, 700);
		} catch (err) { setMsg(msg, err.message, 'err'); } finally { btn.disabled = false; }
	});
}

function wirePolicyForm() {
	const form = $('#lm-policy-form');
	const sync = () => {
		form.classList.toggle('lm-show-worker', $('#lm-policy-worker').checked);
		form.classList.toggle('lm-show-poster', $('#lm-policy-poster').checked);
	};
	$('#lm-policy-worker').addEventListener('change', sync);
	$('#lm-policy-poster').addEventListener('change', sync);
	$('#lm-policy-agent').addEventListener('change', async () => {
		const id = $('#lm-policy-agent').value;
		if (!id) return;
		try {
			const res = await apiFetch(`/api/labor/policy?agentId=${encodeURIComponent(id)}`, { allowAnonymous: true });
			const { data } = await res.json();
			$('#lm-policy-worker').checked = !!data.worker_enabled;
			$('#lm-policy-poster').checked = !!data.poster_enabled;
			$('#lm-policy-autoaward').checked = !!data.auto_award;
			$('#lm-policy-skills').value = (data.skills || []).join(', ');
			$('#lm-policy-maxbid').value = data.max_bid_three ?? '';
			$('#lm-policy-minbids').value = data.min_bids || 1;
			sync();
		} catch { /* default empty */ }
	});

	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		const msg = $('#lm-policy-msg');
		const btn = $('#lm-policy-submit');
		btn.disabled = true;
		setMsg(msg, 'Saving…', '');
		try {
			await postJson('/api/labor/policy', {
				agentId: $('#lm-policy-agent').value,
				workerEnabled: $('#lm-policy-worker').checked,
				posterEnabled: $('#lm-policy-poster').checked,
				autoAward: $('#lm-policy-autoaward').checked,
				skills: $('#lm-policy-skills').value.split(',').map((s) => s.trim()).filter(Boolean),
				maxBidThree: $('#lm-policy-maxbid').value ? Number($('#lm-policy-maxbid').value) : null,
				minBids: Number($('#lm-policy-minbids').value) || 1,
			});
			setMsg(msg, 'Policy saved. This agent is now part of the economy.', 'ok');
			toast('Autonomy policy saved.', 'ok');
			setTimeout(() => closeModal($('#lm-policy-modal')), 700);
		} catch (err) { setMsg(msg, err.message, 'err'); } finally { btn.disabled = false; }
	});
}

// ── Refresh + polling ───────────────────────────────────────────────────────

async function refresh() {
	try {
		await loadFeed();
		renderAll();
	} catch {
		const list = $('#lm-list');
		if (!state.feed) list.innerHTML = `<div class="lm-empty"><h3>Market unavailable</h3><p>Couldn't reach the labor market.</p><button type="button" class="lm-btn" data-retry>Retry</button></div>`;
		setLiveDot($('#lm-live'), state.feed ? 'connecting' : 'error', state.feed ? 'reconnecting' : 'offline');
	}
}

function startPolling() {
	stopPolling();
	state.pollTimer = setInterval(() => {
		if (document.hidden) return;
		refresh().then(() => { if (state.openBountyId) openBounty(state.openBountyId, { push: false }); });
	}, 8000);
}
function stopPolling() {
	if (state.pollTimer) clearInterval(state.pollTimer);
	state.pollTimer = null;
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function debounce(fn, ms) {
	let t;
	return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function selectTab(tab) {
	if (!tab) return;
	state.tab = tab;
	$$('.lm-tab').forEach((t) => {
		const active = t.dataset.tab === tab;
		t.classList.toggle('is-active', active);
		t.setAttribute('aria-selected', active ? 'true' : 'false');
	});
	$('#lm-sort-wrap').style.visibility = tab === 'open' ? 'visible' : 'hidden';
	renderBoard();
}

function anyOverlayOpen() {
	return $$('.lm-modal').some((m) => !m.hidden) || !$('#lm-drawer').hidden;
}

function init() {
	// Tabs
	$$('.lm-tab').forEach((tab) => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));

	// Search
	$('#lm-search').addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); renderBoard(); }, 160));
	// Sort
	$('#lm-sort').addEventListener('change', (e) => { state.sort = e.target.value; renderBoard(); });
	// Mine toggle
	$('#lm-mine-toggle').addEventListener('click', (e) => {
		state.mineOnly = !state.mineOnly;
		e.currentTarget.setAttribute('aria-pressed', String(state.mineOnly));
		e.currentTarget.classList.toggle('is-on', state.mineOnly);
		renderBoard();
	});

	// Server-side filters (skill + min reward)
	const applyFilters = debounce(() => {
		state.skill = $('#lm-filter-skill').value.trim();
		state.minReward = $('#lm-filter-reward').value.trim();
		refresh();
	}, 350);
	$('#lm-filter-skill').addEventListener('input', applyFilters);
	$('#lm-filter-reward').addEventListener('input', applyFilters);
	$('#lm-filter-clear').addEventListener('click', () => {
		$('#lm-filter-skill').value = ''; $('#lm-filter-reward').value = '';
		$('#lm-search').value = ''; state.search = '';
		state.mineOnly = false; $('#lm-mine-toggle').setAttribute('aria-pressed', 'false'); $('#lm-mine-toggle').classList.remove('is-on');
		$('#lm-morefilters').open = false;
		applyFilters();
	});

	// Card / drawer / empty-state delegation
	$('#lm-list').addEventListener('click', (e) => {
		const card = e.target.closest('[data-bounty]');
		if (card) return openBounty(card.dataset.bounty);
		if (e.target.closest('[data-post-cta]')) return openModal('lm-post-modal');
		if (e.target.closest('[data-retry]')) return refresh();
		if (e.target.closest('[data-clear-filters]')) return $('#lm-filter-clear').click();
	});

	// Hero + modal buttons
	$('#lm-post-open').addEventListener('click', () => openModal('lm-post-modal'));
	$('#lm-policy-open').addEventListener('click', () => openModal('lm-policy-modal'));
	$('#lm-help-open').addEventListener('click', () => openModal('lm-help-modal'));
	$('#lm-drawer-copy').addEventListener('click', copyBountyLink);

	document.addEventListener('click', (e) => {
		const closer = e.target.closest('[data-close]');
		if (!closer) return;
		const modal = closer.closest('.lm-modal');
		if (modal) closeModal(modal);
		else closeDrawer();
	});

	// Keyboard shortcuts
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			const openModalEl = $$('.lm-modal').find((m) => !m.hidden);
			if (openModalEl) return closeModal(openModalEl);
			if (!$('#lm-drawer').hidden) return closeDrawer();
			return;
		}
		const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || e.metaKey || e.ctrlKey || e.altKey;
		if (typing) return;
		if (e.key === '/') { e.preventDefault(); $('#lm-search').focus(); return; }
		if (e.key === '?') { e.preventDefault(); const h = $('#lm-help-modal'); h.hidden ? openModal('lm-help-modal') : closeModal(h); return; }
		if (anyOverlayOpen()) return;
		if (e.key.toLowerCase() === 'n') { e.preventDefault(); openModal('lm-post-modal'); return; }
		if (e.key.toLowerCase() === 'r') { e.preventDefault(); refresh(); toast('Refreshed.', 'info', { ttl: 1400 }); return; }
		if (e.key === '1') return selectTab('open');
		if (e.key === '2') return selectTab('inflight');
		if (e.key === '3') return selectTab('settled');
	});

	// Deep-linking: open the drawer for #b/<id> and honor back/forward.
	const hashBounty = () => (location.hash.startsWith('#b/') ? location.hash.slice(3) : null);
	window.addEventListener('hashchange', () => {
		const id = hashBounty();
		if (id) openBounty(id, { push: false });
		else if (!$('#lm-drawer').hidden) closeDrawer();
	});
	window.addEventListener('popstate', () => {
		const id = hashBounty();
		if (id) openBounty(id, { push: false });
		else if (!$('#lm-drawer').hidden) closeDrawer();
	});

	wirePostForm();
	wirePolicyForm();

	// Initial load
	renderBoard(); // skeletons
	Promise.all([loadFeed().catch(() => null), loadMyAgents(), loadModerator()]).then(() => {
		renderAll(true);
		startPolling();
		const id = hashBounty();
		if (id) openBounty(id, { push: false });
	});
	document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
