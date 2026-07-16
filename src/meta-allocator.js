// Meta-Allocator page, the "ETF of degens" allocation planner UI.
// Fetches /api/meta-allocator (real verified leaders + a diversified plan) and
// renders the basket with every state designed: loading, empty, error, populated.
// Non-custodial: it shows a plan and deep-links each leader to the existing
// copy-subscribe flow. Nothing here signs or moves funds.

const resultEl = document.getElementById('maResult');
const budgetEl = document.getElementById('maBudget');
const segEl = document.getElementById('maSeg');

let risk = 'balanced';
let budget = 5;
let reqSeq = 0;

const GROUP_LABEL = {
	high_winrate: 'high win-rate',
	moonshot: 'moonshot',
	high_roi: 'high ROI',
	steady: 'steady',
	volatile: 'volatile',
};
// The copy-trade / back-an-agent surface is /vaults (segregated custody, spend
// caps, drawdown breaker). The leader's own track record lives at /trader/<id>.
const CTA_HREF = () => `/vaults`;

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initials(name) {
	return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}
function pct(n) { return n == null ? '-' : `${n}%`; }
function groupColor(g) {
	return { high_winrate: '#34d399', moonshot: '#fb7185', high_roi: '#22d3ee', steady: '#7c5cff', volatile: '#fbbf24' }[g] || '#a1a1aa';
}

function skeleton() {
	resultEl.innerHTML = `<div class="ma-skel" aria-hidden="true">${'<div class="ma-skel-card"></div>'.repeat(4)}</div><span class="sr-only">Building your allocation…</span>`;
}

function renderEmpty(plan) {
	resultEl.innerHTML = `
		<div class="ma-empty">
			<h3>No verified leaders qualify yet</h3>
			<p>${esc(plan?.caution || 'The allocator only picks agents with a real, closed on-chain track record. None meet this risk profile right now.')} Try a looser risk profile, or explore the leaderboard while more records settle.</p>
			<a href="/leaderboard">Browse the trader leaderboard</a>
		</div>`;
}

function renderError(msg) {
	resultEl.innerHTML = `
		<div class="ma-error">
			<h3>Could not build an allocation</h3>
			<p>${esc(msg || 'The allocation service is unreachable right now.')}</p>
			<button type="button" id="maRetry">Try again</button>
		</div>`;
	document.getElementById('maRetry')?.addEventListener('click', load);
}

function renderPlan(plan) {
	if (!plan || !Array.isArray(plan.allocations) || plan.allocations.length === 0) {
		return renderEmpty(plan);
	}
	const barSegments = plan.allocations
		.map((a) => `<i style="width:${a.weight_pct}%;background:${groupColor(a.correlation_group)}" title="${esc(a.name)} ${a.weight_pct}%"></i>`)
		.join('');

	const cards = plan.allocations.map((a) => {
		const avatar = a.avatar
			? `<img class="ma-ava" src="${esc(a.avatar)}" alt="" loading="lazy" />`
			: `<span class="ma-ava" aria-hidden="true">${esc(initials(a.name))}</span>`;
		const roiCls = a.roi_pct == null ? '' : a.roi_pct >= 0 ? 'pos' : 'neg';
		const warn = a.over_capacity
			? `<div class="ma-warn">⚠ Suggested size is above this leader's typical fill and may move their price. Consider trimming.</div>`
			: '';
		return `
			<article class="ma-card">
				<div class="ma-card-top">
					${avatar}
					<div>
						<p class="ma-name">${esc(a.name)}</p>
						<div class="ma-chips"><span class="ma-chip grp" style="color:${groupColor(a.correlation_group)}">${esc(GROUP_LABEL[a.correlation_group] || a.correlation_group)}</span><span class="ma-chip">${a.settled} trades</span></div>
					</div>
					<div class="ma-weight"><b>${a.weight_pct}%</b><small>${a.size_quote == null ? '' : `${a.size_quote} SOL`}</small></div>
				</div>
				<div class="ma-stats">
					<span>Win <b>${pct(a.win_rate_pct)}</b></span>
					<span>ROI <b class="${roiCls}">${pct(a.roi_pct)}</b></span>
					<span>Max DD <b>${pct(a.max_drawdown_pct)}</b></span>
					<span>Followers <b>${a.followers}</b></span>
				</div>
				<div class="ma-why">${esc(a.why)}</div>
				${warn}
				<div class="ma-links">
					<a href="/trader/${encodeURIComponent(a.agent_id)}">Track record</a>
					<a class="primary" href="${CTA_HREF()}">Copy this leader</a>
				</div>
			</article>`;
	}).join('');

	const excluded = Array.isArray(plan.excluded) && plan.excluded.length
		? `<details class="ma-excluded"><summary>Considered but excluded (${plan.excluded.length})</summary><ul>${plan.excluded.map((e) => `<li><b>${esc(e.name)}</b>: ${esc(e.reason)}</li>`).join('')}</ul></details>`
		: '';

	const groups = plan.diversification || {};
	const groupCount = Object.keys(groups).length;

	resultEl.innerHTML = `
		<div class="ma-summary">
			<span>Basket of <b>${plan.allocations.length}</b> verified leaders</span>
			<span>across <b>${groupCount}</b> style${groupCount === 1 ? '' : 's'}</span>
			<span>from <b>${plan.leaders_considered}</b> considered</span>
			${plan.source === 'llm' ? '<span>plan by <b>three.ws LLM</b></span>' : '<span>plan by <b>risk-adjusted ranking</b></span>'}
		</div>
		<div class="ma-bar" aria-hidden="true">${barSegments}</div>
		<div class="ma-grid">${cards}</div>
		<div class="ma-note"><b>Rebalance rule.</b> ${esc(plan.rebalance_rule)}</div>
		<div class="ma-note"><b>Risk.</b> ${esc(plan.caution)}</div>
		${excluded}
		<div class="ma-note">This is a non-custodial <b>plan</b>. three.ws never holds your funds. Copying a leader opens a segregated, spend-capped subscription you control and can stop at any time.</div>`;
}

async function load() {
	const seq = ++reqSeq;
	skeleton();
	try {
		const url = `/api/meta-allocator?risk=${encodeURIComponent(risk)}&budget=${encodeURIComponent(budget)}`;
		const res = await fetch(url, { headers: { accept: 'application/json' } });
		if (seq !== reqSeq) return; // a newer request superseded this one
		if (!res.ok) {
			let msg = `Service returned ${res.status}.`;
			try { const j = await res.json(); if (j?.error_description) msg = j.error_description; } catch { /* keep default */ }
			return renderError(msg);
		}
		const data = await res.json();
		if (seq !== reqSeq) return;
		renderPlan(data.plan);
	} catch (err) {
		if (seq !== reqSeq) return;
		renderError('Network error reaching the allocator. Check your connection and try again.');
	}
}

let budgetTimer = null;
budgetEl.addEventListener('input', () => {
	const v = parseFloat(budgetEl.value);
	budget = Number.isFinite(v) && v > 0 ? v : 5;
	clearTimeout(budgetTimer);
	budgetTimer = setTimeout(load, 350);
});
segEl.addEventListener('click', (e) => {
	const btn = e.target.closest('button[data-risk]');
	if (!btn) return;
	risk = btn.dataset.risk;
	for (const b of segEl.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
	load();
});

load();
