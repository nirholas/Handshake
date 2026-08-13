// The Reasoning Ledger — frontend surface.
//
// A readable, filterable timeline of an agent's decisions with the rationale,
// prediction, and resolved outcome (right/wrong, by how much), plus the headline
// reputation with a "how is this computed" drill-down, a calibration chart, and a
// verification badge that re-checks the on-chain anchor on demand. Being wrong is
// made visible — honesty is the trust signal.

import { apiFetch } from './api.js';
import { countUp, enterStagger, sparkline, reducedMotion } from './ui-juice.js';

const root = document.getElementById('rl-root');

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortId(id) { return id ? `${id.slice(0, 8)}…${id.slice(-4)}` : ''; }
function shortHash(h) { return h ? `${h.slice(0, 10)}…` : ''; }
function fmtSol(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(4) + ' SOL'; }
function fmtPct(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '%'; }
function timeAgo(iso) {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, (Date.now() - t) / 1000);
	if (s < 60) return `${Math.floor(s)}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

// The kind filter's options, defined once so the <select>, the deep-link
// parser, and any future consumer cannot drift apart.
const KIND_FILTERS = [
	{ value: 'snipe', label: 'Snipe' },
	{ value: 'exit', label: 'Exit' },
	{ value: 'bounty_award', label: 'Bounty award' },
	{ value: 'moderation', label: 'Moderation' },
];

function readAgentId() {
	const m = location.pathname.match(/\/ledger\/([^/?#]+)/);
	if (m) return decodeURIComponent(m[1]);
	const qs = new URLSearchParams(location.search);
	return qs.get('agent') || qs.get('id') || null;
}

// `?kind=snipe` is how the sniper fleet, the blog, and the API's `ledger_url`
// all link into a pre-filtered timeline. Anything not in KIND_FILTERS falls
// back to "All kinds" rather than querying the API for a kind it cannot serve.
function readKindFilter() {
	const kind = new URLSearchParams(location.search).get('kind') || '';
	return KIND_FILTERS.some((k) => k.value === kind) ? kind : '';
}

const state = {
	agentId: readAgentId(),
	data: null,
	verify: null,
	filters: { kind: readKindFilter(), q: '' },
	beforeSeq: null,
	entries: [],
	loadingMore: false,
	revealedCount: 0, // entries already animated-in, so only freshly-appended ones stagger
};

// After a render: sweep the reputation ring, count the score up, and stagger only
// the timeline rows that haven't entered yet (the freshly-appended page on
// "load older", or every row on a fresh load / filter change).
function playLedgerMotion() {
	playScoreRing();
	const rows = Array.from(document.querySelectorAll('.rl-timeline .rl-entry'));
	enterStagger(rows.slice(state.revealedCount));
	state.revealedCount = rows.length;
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchLedger({ append = false } = {}) {
	const params = new URLSearchParams();
	params.set('limit', '40');
	if (state.filters.kind) params.set('kind', state.filters.kind);
	if (state.filters.q) params.set('q', state.filters.q);
	if (append && state.beforeSeq != null) params.set('before', String(state.beforeSeq));
	const res = await apiFetch(`/api/ledger/${encodeURIComponent(state.agentId)}?${params}`);
	if (!res.ok) throw new Error(`ledger ${res.status}`);
	const json = await res.json();
	if (append) {
		state.entries = state.entries.concat(json.decisions);
	} else {
		state.data = json;
		state.entries = json.decisions;
	}
	state.beforeSeq = json.paging?.next_before_seq ?? null;
	return json;
}

async function fetchVerify() {
	try {
		const res = await apiFetch(`/api/ledger/verify/${encodeURIComponent(state.agentId)}`);
		if (!res.ok) throw new Error(`verify ${res.status}`);
		state.verify = await res.json();
	} catch {
		state.verify = { status: 'error' };
	}
}

// ── Render: score ring + calibration chart ────────────────────────────────────

function scoreColor(score) {
	return score >= 70 ? 'var(--rl-green)' : score >= 45 ? 'var(--rl-amber)' : 'var(--rl-red)';
}

function scoreRing(score) {
	const r = 56, c = 2 * Math.PI * r;
	const pct = Math.max(0, Math.min(100, score)) / 100;
	const off = (c * (1 - pct)).toFixed(1);
	const hue = scoreColor(score);
	// The arc starts empty (offset = full circumference) and `playScoreRing` sweeps
	// it to its real offset after paint; the number counts up in step. Reduced
	// motion lands on the final frame instantly (see playScoreRing / countUp).
	return `
		<div class="rl-score-ring">
			<svg viewBox="0 0 132 132" role="img" aria-label="Reputation score ${score} of 100">
				<circle cx="66" cy="66" r="${r}" fill="none" stroke="var(--rl-line)" stroke-width="10" />
				<circle class="rl-score-arc" cx="66" cy="66" r="${r}" fill="none" stroke="${hue}" stroke-width="10"
					stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}"
					stroke-dashoffset="${c.toFixed(1)}" data-target="${off}" />
			</svg>
			<div class="rl-score-num">
				<span class="rl-score-val" data-score="${score}" style="color:${hue}">${score}</span>
				<span class="rl-score-cap">/ 100</span>
			</div>
		</div>`;
}

// Sweep the reputation arc from empty to its real offset and count the number up
// in lockstep. Reduced motion → jump straight to the final state.
function playScoreRing() {
	const arc = document.querySelector('.rl-score-arc');
	const num = document.querySelector('.rl-score-val');
	if (arc) {
		const target = arc.getAttribute('data-target');
		if (reducedMotion()) arc.style.strokeDashoffset = target;
		else requestAnimationFrame(() => requestAnimationFrame(() => { arc.style.strokeDashoffset = target; }));
	}
	if (num) {
		const score = Number(num.dataset.score) || 0;
		countUp(num, 0, score, { format: (n) => String(Math.round(n)) });
	}
}

// Cumulative realized P&L across the reconciled decisions in view, oldest→newest —
// a real "is this agent's judgment paying off" trend. Returns null when there
// aren't yet two settled, P&L-bearing calls to draw a line between.
function qualityTrend(entries) {
	const settled = [...entries]
		.reverse()
		.filter((d) => d.outcome?.status === 'reconciled' && d.outcome.pnl_sol != null);
	if (settled.length < 2) return null;
	let running = 0;
	return settled.map((d) => { running += Number(d.outcome.pnl_sol) || 0; return running; });
}

function calibrationChart(rep) {
	const buckets = (rep.calibration || []).filter((b) => b.count > 0 && b.predicted != null && b.actual != null);
	const S = 300, pad = 34;
	const x = (v) => pad + v * (S - 2 * pad);
	const y = (v) => S - pad - v * (S - 2 * pad);
	const maxN = Math.max(1, ...buckets.map((b) => b.count));
	const grid = [0, 0.25, 0.5, 0.75, 1].map((g) =>
		`<line x1="${x(g)}" y1="${y(0)}" x2="${x(g)}" y2="${y(1)}" stroke="var(--rl-line-2)" stroke-width="1"/>
		 <line x1="${x(0)}" y1="${y(g)}" x2="${x(1)}" y2="${y(g)}" stroke="var(--rl-line-2)" stroke-width="1"/>`).join('');
	const dots = buckets.map((b) => {
		const rr = 4 + 7 * (b.count / maxN);
		const off = Math.abs(b.predicted - b.actual);
		const col = off < 0.1 ? '#4ade80' : off < 0.25 ? '#fbbf24' : '#f87171';
		return `<circle cx="${x(b.predicted).toFixed(1)}" cy="${y(b.actual).toFixed(1)}" r="${rr.toFixed(1)}"
			fill="${col}" fill-opacity="0.7" stroke="${col}" stroke-width="1.5">
			<title>${b.label}: predicted ${(b.predicted * 100).toFixed(0)}%, actual ${(b.actual * 100).toFixed(0)}% (n=${b.count})</title>
		</circle>`;
	}).join('');
	return `
		<svg class="rl-cal-chart" viewBox="0 0 ${S} ${S}" role="img" aria-label="Calibration: predicted confidence vs actual hit rate">
			${grid}
			<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="var(--rl-cyan)" stroke-width="1.5" stroke-dasharray="5 4"/>
			${dots}
			<text x="${S / 2}" y="${S - 6}" text-anchor="middle" fill="var(--rl-dim)" font-size="11" font-family="var(--rl-mono)">predicted confidence →</text>
			<text x="12" y="${S / 2}" text-anchor="middle" fill="var(--rl-dim)" font-size="11" font-family="var(--rl-mono)" transform="rotate(-90 12 ${S / 2})">actual hit rate →</text>
		</svg>`;
}

// ── Render: reputation card ───────────────────────────────────────────────────

function repCard(rep) {
	const ece = rep.calibration_error;
	const compRows = rep.components.map((c) => `
		<div class="rl-comp">
			<span class="rl-comp-label">${esc(c.label)}</span>
			<span class="rl-comp-bar"><i style="width:${Math.round(c.value * 100)}%"></i></span>
			<span class="rl-comp-val">${(c.value * 100).toFixed(0)}% ×${c.weight}</span>
		</div>
		<div class="rl-comp-desc">${esc(c.description)} → +${(c.contribution * 100).toFixed(1)} pts</div>`).join('');

	return `
	<section class="rl-card">
		<div class="rl-card-head"><h2>Reputation</h2></div>
		<div class="rl-rep-grid">
			${scoreRing(rep.score)}
			<dl class="rl-rep-stats">
				<div class="rl-stat"><dt>Hit rate</dt><dd>${rep.sample_size ? (rep.hit_rate * 100).toFixed(0) + '%' : '—'} <small>${rep.wins}W / ${rep.losses}L</small></dd></div>
				<div class="rl-stat"><dt>Reconciled</dt><dd>${rep.sample_size} <small>of ${rep.decisions_total}</small></dd></div>
				<div class="rl-stat"><dt>Calibration err</dt><dd>${ece != null ? (ece * 100).toFixed(1) + '%' : '—'}</dd></div>
				<div class="rl-stat"><dt>Net realized</dt><dd class="${rep.net_pnl_sol > 0 ? 'pos' : rep.net_pnl_sol < 0 ? 'neg' : ''}">${rep.net_pnl_sol ? fmtSol(rep.net_pnl_sol) : '—'}</dd></div>
				<div class="rl-stat"><dt>Pending</dt><dd>${rep.pending_count}</dd></div>
				<div class="rl-stat"><dt>Confidence</dt><dd>${(rep.confidence * 100).toFixed(0)}%</dd></div>
			</dl>
		</div>
		${(() => {
			const trend = qualityTrend(state.entries);
			if (!trend) return '';
			const net = trend[trend.length - 1];
			const cls = net > 0 ? 'pos' : net < 0 ? 'neg' : '';
			return `<div class="rl-trend">
				<span class="rl-trend-k">Realized P&amp;L · settled calls in view</span>
				<span class="rl-trend-spark">${sparkline(trend, { width: 160, height: 32, fill: true, animate: true })}</span>
				<span class="rl-trend-v ${cls}">${fmtSol(net)}</span>
			</div>`;
		})()}
		<div class="rl-verify-row" id="rl-verify-row"></div>
		<details class="rl-drill">
			<summary>How is this score computed?</summary>
			<div class="rl-formula">${esc(rep.formula)}</div>
			${compRows}
		</details>
	</section>

	<section class="rl-card">
		<div class="rl-card-head"><h2>Calibration</h2></div>
		${rep.sample_size > 0 ? `
		<div class="rl-cal-wrap">
			${calibrationChart(rep)}
			<div class="rl-cal-legend">
				<p>Does an ${'80%'}-confidence call actually hit 80% of the time? Each dot is a confidence band — on the dashed line means perfectly calibrated.</p>
				<p><span class="rl-cal-swatch" style="background:#4ade80"></span><b>Well calibrated</b> (&lt;10% off)<br>
				<span class="rl-cal-swatch" style="background:#fbbf24"></span>Slightly off<br>
				<span class="rl-cal-swatch" style="background:#f87171"></span>Poorly calibrated</p>
				<p>Dot size = number of calls in that band.</p>
			</div>
		</div>` : `<p class="rl-state" style="padding:20px">No reconciled calls yet — calibration appears once outcomes are resolved.</p>`}
	</section>`;
}

function verifyBadge() {
	const v = state.verify;
	if (!v) return `<button class="rl-verify is-checking" id="rl-verify-btn"><span class="rl-vdot"></span>Verifying chain…</button>`;
	let cls = 'rl-verify', label = 'Re-verify chain';
	if (v.status === 'verified') { cls += ' is-verified'; label = 'Verified · on-chain anchored'; }
	else if (v.status === 'verified_unanchored') { cls += ' is-unanchored'; label = 'Chain intact · anchor pending'; }
	else if (v.status === 'verification_failed') { cls += ' is-failed'; label = `Tamper detected${v.chain?.broken_at ? ` at #${v.chain.broken_at}` : ''}`; }
	else if (v.status === 'empty') { label = 'No decisions yet'; }
	else { cls += ' is-failed'; label = 'Verification unavailable'; }
	const anchor = v.anchor && v.anchor.explorer_url
		? `<a class="rl-anchor-link" href="${esc(v.anchor.explorer_url)}" target="_blank" rel="noopener">anchor tx ↗</a>`
		: '';
	const head = v.chain?.head_hash ? `<span class="rl-hash" title="${esc(v.chain.head_hash)}">head ${shortHash(v.chain.head_hash)}</span>` : '';
	return `<button class="${cls}" id="rl-verify-btn"><span class="rl-vdot"></span>${esc(label)}</button>${anchor}${head}`;
}

// ── Render: timeline ──────────────────────────────────────────────────────────

function entryCard(d) {
	const o = d.outcome || { status: 'pending' };
	let cls = 'pending', chip = '<span class="rl-chip pending">Pending outcome</span>';
	if (o.status === 'reconciled') {
		const win = o.was_correct;
		cls = win ? 'win' : 'loss';
		const pnl = o.pnl_sol != null ? ` · ${fmtSol(o.pnl_sol)}` : '';
		chip = `<span class="rl-chip ${cls}">${win ? '✓ Right' : '✗ Wrong'}${pnl}</span>`;
		if (o.proof_url) chip += ` <a class="rl-proof" href="${esc(o.proof_url)}" target="_blank" rel="noopener">on-chain proof ↗</a>`;
	}
	const pred = d.prediction?.basis ? `<span class="rl-chip">predicted: ${esc(d.prediction.basis)}</span>` : '';
	const subj = d.subject_ref ? `<span class="rl-chip">${esc(String(d.subject_ref).slice(0, 12))}…</span>` : '';
	return `
		<article class="rl-entry ${cls}">
			<div class="rl-entry-top">
				<span class="rl-kind">${esc(d.kind)}</span>
				<span class="rl-seq">#${d.seq}</span>
				<span class="rl-conf">${d.confidence != null ? (d.confidence * 100).toFixed(0) + '% conf' : ''}</span>
				<span class="rl-when">${esc(timeAgo(d.decided_at))}</span>
			</div>
			<p class="rl-rationale">${esc(d.rationale)}</p>
			<div class="rl-entry-foot">
				${chip} ${pred} ${subj}
				<span class="rl-hash" title="${esc(d.entry_hash)}">${shortHash(d.entry_hash)}</span>
			</div>
		</article>`;
}

function timelineSection() {
	if (!state.entries.length) {
		return `<section class="rl-card"><div class="rl-state"><h3>No decisions match</h3><p>Try clearing the filters, or this agent hasn't logged a decision of this kind yet.</p></div></section>`;
	}
	const rows = state.entries.map(entryCard).join('');
	const more = state.beforeSeq != null
		? `<button class="rl-more" id="rl-more-btn">Load older decisions</button>`
		: '';
	return `
		<section>
			<div class="rl-filters">
				<div class="rl-search"><input id="rl-q" type="search" placeholder="Search rationale or token…" value="${esc(state.filters.q)}" aria-label="Search decisions" /></div>
				<select class="rl-select" id="rl-kind" aria-label="Filter by kind">
					<option value="">All kinds</option>
					${KIND_FILTERS.map((k) => `<option value="${k.value}"${state.filters.kind === k.value ? ' selected' : ''}>${k.label}</option>`).join('')}
				</select>
			</div>
			<div class="rl-timeline">${rows}</div>
			${more}
		</section>`;
}

// ── Render: shells ────────────────────────────────────────────────────────────

function hero(agent) {
	const img = agent?.image
		? `<img class="rl-agent-avatar" src="${esc(agent.image)}" alt="" loading="lazy" decoding="async" />`
		: `<div class="rl-agent-avatar"></div>`;
	const name = agent?.name ? esc(agent.name) : 'Agent';
	return `
		<p class="rl-kicker"><span class="rl-dot"></span>Auditable track record · tamper-evident</p>
		<h1 class="rl-title" id="rl-title">Reasoning Ledger</h1>
		<p class="rl-sub">Every consequential call this agent made — what it decided, why, what it predicted, and what actually happened. Anchored on-chain and independently verifiable. Being wrong is shown, not hidden.</p>
		<div class="rl-agent-head">
			${img}
			<div>
				<p class="rl-agent-name">${name}</p>
				<p class="rl-agent-id"><a href="/agents/${esc(state.agentId)}">${shortId(state.agentId)} ↗</a></p>
			</div>
		</div>`;
}

function renderLoading() {
	root.innerHTML = `
		${hero(null)}
		<section class="rl-card"><div class="rl-skel rl-skel-card"></div></section>
		<section class="rl-card"><div class="rl-skel rl-skel-line" style="width:40%"></div><div class="rl-skel rl-skel-card"></div></section>`;
}

function renderEmptyPrompt() {
	root.innerHTML = `
		${hero(null).replace(/<div class="rl-agent-head">[\s\S]*$/, '')}
		<section class="rl-card"><div class="rl-state">
			<h3>Pick an agent to audit</h3>
			<p>The Reasoning Ledger is per-agent. Open any trader from the leaderboard to interrogate its decisions and verify its track record, or start with a live example: the platform agent's first autonomous snipe, a real +42% trade with its full reasoning recorded.</p>
			<a class="rl-btn" href="/ledger/4c0e4d18-0544-4c95-a0db-a16896b029be">See a live ledger →</a>
			<a class="rl-btn rl-btn-ghost" href="/leaderboard">Open the leaderboard →</a>
		</div></section>`;
}

function renderError(err) {
	root.innerHTML = `
		${hero(state.data?.agent)}
		<section class="rl-card"><div class="rl-state">
			<h3>Couldn't load this ledger</h3>
			<p>${esc(err?.message || 'Something went wrong.')}</p>
			<button class="rl-btn" id="rl-retry">Try again</button>
		</div></section>`;
	document.getElementById('rl-retry')?.addEventListener('click', boot);
}

function renderNoDecisions() {
	root.innerHTML = `
		${hero(state.data?.agent)}
		${repCard(state.data.reputation)}
		<section class="rl-card"><div class="rl-state">
			<h3>No decisions recorded yet</h3>
			<p>Once this agent makes a consequential, on-chain call — a snipe, an exit, an award — it lands here with its reasoning and, after settlement, its real outcome.</p>
			<a class="rl-btn" href="/agents/${esc(state.agentId)}">View agent profile →</a>
		</div></section>`;
	mountVerify();
	playLedgerMotion();
}

function renderAll() {
	if (!state.entries.length && state.data.reputation.decisions_total === 0) {
		return renderNoDecisions();
	}
	root.innerHTML = `
		${hero(state.data.agent)}
		${repCard(state.data.reputation)}
		${timelineSection()}`;
	mountVerify();
	wireFilters();
	playLedgerMotion();
}

// ── Wiring ────────────────────────────────────────────────────────────────────

function mountVerify() {
	const row = document.getElementById('rl-verify-row');
	if (row) row.innerHTML = verifyBadge();
	document.getElementById('rl-verify-btn')?.addEventListener('click', async () => {
		state.verify = null;
		mountVerify();
		await fetchVerify();
		mountVerify();
	});
}

// Mirror the chosen kind back into the URL so the filtered view is the thing
// the reader can copy out of the address bar, matching the links that arrive
// here pre-filtered.
function syncKindInUrl() {
	const url = new URL(location.href);
	if (state.filters.kind) url.searchParams.set('kind', state.filters.kind);
	else url.searchParams.delete('kind');
	history.replaceState(null, '', url);
}

let qTimer = null;
function wireFilters() {
	document.getElementById('rl-kind')?.addEventListener('change', (e) => {
		state.filters.kind = e.target.value;
		syncKindInUrl();
		reloadTimeline();
	});
	document.getElementById('rl-q')?.addEventListener('input', (e) => {
		clearTimeout(qTimer);
		const v = e.target.value;
		qTimer = setTimeout(() => { state.filters.q = v.trim(); reloadTimeline(); }, 300);
	});
	document.getElementById('rl-more-btn')?.addEventListener('click', loadMore);
}

async function reloadTimeline() {
	state.beforeSeq = null;
	state.revealedCount = 0; // a filter/search change re-renders the whole list — stagger all of it
	try {
		await fetchLedger({ append: false });
		renderAll();
		// keep focus on the search box across re-render
		const q = document.getElementById('rl-q');
		if (q && state.filters.q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
	} catch (e) { renderError(e); }
}

async function loadMore() {
	if (state.loadingMore || state.beforeSeq == null) return;
	state.loadingMore = true;
	const btn = document.getElementById('rl-more-btn');
	if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
	try {
		await fetchLedger({ append: true });
		renderAll();
	} catch (e) { renderError(e); }
	finally { state.loadingMore = false; }
}

async function boot() {
	if (!state.agentId) return renderEmptyPrompt();
	renderLoading();
	try {
		await fetchLedger({ append: false });
		renderAll();
		fetchVerify().then(mountVerify); // verify in the background, then upgrade the badge
	} catch (e) {
		renderError(e);
	}
}

boot();
