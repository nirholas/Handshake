/**
 * Signal feed detail controller.
 *
 * Renders /api/signals/feed?slug= : the publisher's verified track record, the
 * feed's proven accuracy (hit-rate, avg realized ROI, follower ROI, emit→fill
 * latency), and the emission log — every signal with its realized outcome and a
 * link to the on-chain tx that proves it. A signed-in viewer can subscribe one of
 * their agents inline (simulate or live), which auto-mirrors paid emissions.
 */

import { apiFetch } from './api.js';
import { escapeHtml, fmtPct, compact, identicon } from './trader-format.js';

const $ = (s, r = document) => r.querySelector(s);

function slugFromUrl() {
	const m = location.pathname.match(/\/signals\/([^/]+)/);
	if (m) return decodeURIComponent(m[1]);
	return new URLSearchParams(location.search).get('slug') || '';
}
function networkFromUrl() {
	const n = new URLSearchParams(location.search).get('network');
	return n === 'devnet' ? 'devnet' : 'mainnet';
}

const slug = slugFromUrl();
const network = networkFromUrl();
let feed = null;
let myAgents = [];

function epochLabel(sec) {
	if (sec % 86400 === 0) { const d = sec / 86400; return d === 1 ? 'day' : `${d}d`; }
	if (sec % 3600 === 0) { const h = sec / 3600; return h === 1 ? 'hour' : `${h}h`; }
	return `${Math.round(sec / 60)}m`;
}
function latency(ms) {
	if (ms == null) return '—';
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms / 60000)}m`;
}

function statBlock(label, value, { cls = '', sub = '' } = {}) {
	return `<div class="sd-stat"><div class="l">${label}</div><div class="v ${cls}">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
}

function heroHtml(f) {
	const p = f.publisher;
	const avatar = p.image
		? `<img loading="lazy" decoding="async" class="sm-avatar" src="${escapeHtml(p.image)}" alt="" />`
		: `<span class="sm-avatar" aria-hidden="true" style="background:${identicon(p.agent_id)}"></span>`;
	const verified = p.verified ? `<span class="sm-verified">✓ Verified track record</span>` : `<span class="sm-thin">Unverified</span>`;
	return `
		<div class="sd-hero">
			<div class="sd-hero-id">
				${avatar}
				<div>
					<h1 id="sd-title">${escapeHtml(f.title)}</h1>
					<div class="sd-hero-pub">
						by <a href="/trader/${encodeURIComponent(p.agent_id)}">${escapeHtml(p.name)}</a>
						${verified}
					</div>
				</div>
			</div>
			<div class="sd-edge-big"><div class="n">${f.edge_score}</div><div class="l">Proven edge</div></div>
		</div>`;
}

function statsHtml(f) {
	const s = f.stats;
	const hit = s.hit_rate != null ? `${Math.round(s.hit_rate * 100)}%` : '—';
	const roi = s.avg_realized_pct != null ? fmtPct(s.avg_realized_pct, { sign: true }) : '—';
	const roiCls = s.avg_realized_pct == null ? 'muted' : s.avg_realized_pct > 0 ? 'win' : s.avg_realized_pct < 0 ? 'loss' : 'muted';
	const froi = s.avg_follower_roi_pct != null ? fmtPct(s.avg_follower_roi_pct, { sign: true }) : '—';
	const froiCls = s.avg_follower_roi_pct == null ? 'muted' : s.avg_follower_roi_pct > 0 ? 'win' : 'loss';
	return `
		<div class="sd-stats">
			${statBlock('Hit rate', hit, { cls: s.hit_rate != null && s.hit_rate >= 0.5 ? 'win' : '', sub: `${s.winning_signals}/${s.closed_signals} won` })}
			${statBlock('Avg realized', roi, { cls: roiCls, sub: 'per closed signal' })}
			${statBlock('Follower ROI', froi, { cls: froiCls, sub: `${s.executed_fills} fills` })}
			${statBlock('Signals', compact(s.total_entries), { sub: `${s.closed_signals} closed` })}
			${statBlock('Avg latency', latency(s.avg_latency_ms), { sub: 'emit → fill' })}
			${statBlock('Subscribers', compact(s.subscribers), { sub: f.publisher.closed_trades != null ? `${f.publisher.closed_trades} trades` : '' })}
		</div>`;
}

function outcomeCell(e) {
	if (e.status !== 'closed') return `<div class="pct flat">live</div><div class="badge open">open</div>`;
	const cls = e.outcome === 'win' ? 'win' : e.outcome === 'loss' ? 'loss' : 'flat';
	const pct = e.realized_pnl_pct != null ? fmtPct(e.realized_pnl_pct, { sign: true }) : '—';
	return `<div class="pct ${cls}">${pct}</div><div class="badge">${escapeHtml(e.outcome || 'flat')}</div>`;
}

function emitRow(e) {
	// A paid feed's open positions come back redacted for anyone who has not
	// subscribed. Render that as the deliberate state it is (locked, with the
	// conviction and side still shown so the row still says something) rather
	// than as a row with missing data.
	if (e.locked) {
		const conv = e.conviction != null ? `conv ${Math.round(e.conviction * 100)}%` : '';
		const meta = [conv, 'subscribe to see the coin'].filter(Boolean).join('<span aria-hidden="true">·</span>');
		return `
		<div class="sd-emit is-locked">
			<span class="sd-emit-side ${e.side}">${e.side}</span>
			<div class="sd-emit-coin"><div class="sym" aria-label="Locked signal">🔒 Live signal</div><div class="meta">${meta}</div></div>
			<div class="sd-emit-out">${outcomeCell(e)}</div>
		</div>`;
	}
	const sym = e.symbol ? `$${escapeHtml(e.symbol)}` : `${escapeHtml((e.mint || '').slice(0, 6))}…`;
	const conv = e.conviction != null ? `conv ${Math.round(e.conviction * 100)}%` : '';
	const size = e.size_multiple != null ? `${e.size_multiple.toFixed(2)}× size` : '';
	const proof = e.buy_url ? `<a href="${escapeHtml(e.buy_url)}" target="_blank" rel="noopener">buy ↗</a>` : '';
	const proofS = e.sell_url ? `<a href="${escapeHtml(e.sell_url)}" target="_blank" rel="noopener">sell ↗</a>` : '';
	const meta = [conv, size, proof, proofS].filter(Boolean).join('<span aria-hidden="true">·</span>');
	return `
		<div class="sd-emit">
			<span class="sd-emit-side ${e.side}">${e.side}</span>
			<div class="sd-emit-coin"><div class="sym">${sym}</div><div class="meta">${meta || '<span style="opacity:.6">no on-chain proof yet</span>'}</div></div>
			<div class="sd-emit-out">${outcomeCell(e)}</div>
		</div>`;
}

function logHtml(f) {
	const rows = (f.emissions || []).map(emitRow).join('');
	const lockedCount = (f.emissions || []).filter((e) => e.locked).length;
	const note = lockedCount
		? `<p class="sd-note">${lockedCount} live ${lockedCount === 1 ? 'position is' : 'positions are'} open right now. Closed signals below are shown in full with their on-chain proof; subscribe to see the open ones as they are called.</p>`
		: '';
	return `
		<div class="sd-panel">
			<h2>Signal log <span class="sd-count">${f.emissions?.length || 0} recent · realized outcomes</span></h2>
			${note}
			<div class="sd-log">${rows || '<p class="sd-note">No signals emitted yet. The moment this trader opens or closes a real position, it appears here.</p>'}</div>
		</div>`;
}

function subscribeHtml(f) {
	const p = f.pricing;
	let price;
	if (p.per_signal_usdc > 0 && p.per_epoch_usdc > 0) price = `<span class="amt">$${p.per_signal_usdc}</span><span class="per">/ signal · $${p.per_epoch_usdc}/${epochLabel(p.epoch_seconds)} option</span>`;
	else if (p.per_signal_usdc > 0) price = `<span class="amt">$${p.per_signal_usdc}</span><span class="per">USDC / signal</span>`;
	else if (p.per_epoch_usdc > 0) price = `<span class="amt">$${p.per_epoch_usdc}</span><span class="per">USDC / ${epochLabel(p.epoch_seconds)}</span>`;
	else price = `<span class="amt">Free</span><span class="per">no charge</span>`;

	const agentOpts = myAgents.length
		? myAgents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || a.id)}</option>`).join('')
		: '';
	const billingOpts = [
		p.per_signal_usdc > 0 ? `<option value="per_signal">Per signal ($${p.per_signal_usdc})</option>` : '',
		p.per_epoch_usdc > 0 ? `<option value="per_epoch">Per ${epochLabel(p.epoch_seconds)} ($${p.per_epoch_usdc})</option>` : '',
	].filter(Boolean).join('');

	const form = `
		<div class="sd-modes" role="radiogroup" aria-label="Mode">
			<div class="sd-mode is-active" data-mode="simulate" role="radio" aria-checked="true" tabindex="0">Simulate<small>track, no spend</small></div>
			<div class="sd-mode" data-mode="live" role="radio" aria-checked="false" tabindex="0">Live<small>pay + auto-mirror</small></div>
		</div>
		<div class="sd-field"><label for="sd-agent">Subscriber agent</label>
			<select id="sd-agent">${agentOpts}</select></div>
		<div class="sd-field"><label for="sd-billing">Billing</label>
			<select id="sd-billing">${billingOpts}</select></div>
		<div class="sd-row2">
			<div class="sd-field"><label for="sd-base">Base order (SOL)</label><input id="sd-base" type="number" min="0.001" step="0.01" value="0.05" /></div>
			<div class="sd-field"><label for="sd-scale">Size scaling</label><input id="sd-scale" type="number" min="0.05" step="0.25" value="1" /></div>
		</div>
		<div class="sd-row2">
			<div class="sd-field"><label for="sd-max">Max / trade (SOL)</label><input id="sd-max" type="number" min="0.001" step="0.05" value="0.25" /></div>
			<div class="sd-field"><label for="sd-slip">Slippage (bps)</label><input id="sd-slip" type="number" min="0" max="5000" step="50" value="300" /></div>
		</div>
		<div class="sd-field"><label for="sd-fw">Firewall</label>
			<select id="sd-fw"><option value="block">Block unsafe trades (recommended)</option><option value="warn">Warn only</option></select></div>
		<button class="sd-btn" id="sd-subscribe" type="button">Subscribe &amp; auto-mirror</button>
		<p class="sd-note" id="sd-note">Simulate mode mirrors every signal without paying or trading — proof before you commit real funds. Switch to Live to pay USDC from your agent's wallet and mirror real trades, fully spend-guarded. Halt instantly anytime from your wallet hub.</p>`;

	const gate = `<div class="sd-gate"><p style="margin:0 0 8px;color:var(--ink-dim,#9aa)">Sign in and pick one of your agents to subscribe — its wallet pays the USDC and signs the mirror.</p><a href="/login?next=${encodeURIComponent(location.pathname)}">Sign in →</a></div>`;
	const noAgents = `<div class="sd-gate"><p style="margin:0 0 8px;color:var(--ink-dim,#9aa)">You don't have an agent with a wallet yet.</p><a href="/create-agent">Create your first agent →</a></div>`;

	const body = myAgents === null ? gate : (myAgents.length ? form : noAgents);
	return `
		<div class="sd-panel">
			<h2>Subscribe</h2>
			<div class="sd-price-row">${price}</div>
			${body}
		</div>`;
}

function render() {
	const root = $('#sd-root');
	root.setAttribute('aria-busy', 'false');
	root.innerHTML = `
		${heroHtml(feed)}
		${statsHtml(feed)}
		<div class="sd-cols">
			${logHtml(feed)}
			${subscribeHtml(feed)}
		</div>`;
	document.title = `${feed.title} · Signals · three.ws`;
	wireSubscribe();
}

function wireSubscribe() {
	let mode = 'simulate';
	for (const m of document.querySelectorAll('.sd-mode')) {
		const pick = () => {
			mode = m.dataset.mode;
			for (const el of document.querySelectorAll('.sd-mode')) {
				const on = el === m;
				el.classList.toggle('is-active', on);
				el.setAttribute('aria-checked', on ? 'true' : 'false');
			}
		};
		m.addEventListener('click', pick);
		m.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
	}

	const btn = $('#sd-subscribe');
	if (!btn) return;
	btn.addEventListener('click', async () => {
		const note = $('#sd-note');
		note.className = 'sd-note';
		const agentId = $('#sd-agent')?.value;
		if (!agentId) { note.textContent = 'Pick a subscriber agent first.'; note.classList.add('is-error'); return; }
		btn.disabled = true;
		const prev = btn.textContent;
		btn.textContent = 'Subscribing…';
		try {
			const res = await apiFetch('/api/signals/subscribe', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					agent_id: agentId,
					feed_id: feed.id,
					mode,
					billing: $('#sd-billing')?.value || 'per_signal',
					base_sol: Number($('#sd-base')?.value) || 0.05,
					size_scaling: Number($('#sd-scale')?.value) || 1,
					max_per_trade_sol: Number($('#sd-max')?.value) || 0.25,
					slippage_bps: Number($('#sd-slip')?.value) || 300,
					firewall_level: $('#sd-fw')?.value || 'block',
				}),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
			note.textContent = mode === 'live'
				? '✓ Subscribed. Your agent will pay per signal and auto-mirror new trades. Manage or kill it anytime from your wallet hub → Signals.'
				: '✓ Subscribed in simulate mode. New signals will be tracked without spending. Switch to Live from your wallet hub when ready.';
			note.classList.add('is-ok');
			btn.textContent = 'Subscribed ✓';
			setTimeout(() => { btn.disabled = false; btn.textContent = prev; }, 2500);
		} catch (err) {
			note.textContent = `Could not subscribe: ${err.message}`;
			note.classList.add('is-error');
			btn.disabled = false;
			btn.textContent = prev;
		}
	});
}

function errorState(msg) {
	const root = $('#sd-root');
	root.setAttribute('aria-busy', 'false');
	root.innerHTML = `<div class="sm-empty"><h1 id="sd-title" class="sd-error-title">${escapeHtml(msg)}</h1><p>This feed may have been paused, made unlisted, or never existed.</p><div class="sm-empty-actions"><a class="sm-cta" href="/signals">Browse all feeds →</a></div></div>`;
}

async function loadAgents() {
	try {
		const res = await apiFetch('/api/agents', { allowAnonymous: true });
		if (res.status === 401) { myAgents = null; return; }
		const j = await res.json().catch(() => ({}));
		const list = j.agents || j.data?.agents || j.data || [];
		myAgents = list.filter((a) => a && a.id);
	} catch { myAgents = []; }
}

async function init() {
	if (!slug) { errorState('No feed specified'); return; }
	const [detailRes] = await Promise.all([
		apiFetch(`/api/signals/feed?slug=${encodeURIComponent(slug)}&network=${network}`, { allowAnonymous: true }).catch(() => null),
		loadAgents(),
	]);
	if (!detailRes || !detailRes.ok) { errorState('Feed not found'); return; }
	const data = await detailRes.json().catch(() => null);
	if (!data?.feed) { errorState('Feed not found'); return; }
	feed = data.feed;
	render();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
