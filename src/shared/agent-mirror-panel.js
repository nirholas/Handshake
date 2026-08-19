// Shared Copy-Trading (mirror) panel — the avatar↔wallet↔identity weld made into
// a leashed, autonomous fund manager. Mounted on the agent detail page; renders
// the right view for the viewer's role:
//
//   • Owner of the viewed agent → manage who THIS agent mirrors: the prominent
//     leash (kill switch + per-follow caps), the live "mirrored from @leader"
//     fill feed, enable/pause/unfollow, and "Sync now".
//   • Visitor (the viewed agent is a potential LEADER) → its honest, on-chain
//     track record + "Mirror this agent" with one of your own agents.
//   • Logged-out → track record + sign-in prompt.
//
// 100% real: every number is from /api/agents/:id/mirror* (real fills, real
// signatures, real spend-policy caps). No mock leaders, no fake fills.

import { apiFetch } from '../api.js';

const VIOLET = 'var(--wallet-accent, #c4b5fd)';

// ── tiny shared toast (no global toast in src/shared) ─────────────────────────
let _toastEl = null;
let _toastTimer = null;
function toast(msg, ms = 2600) {
	if (typeof document === 'undefined') return;
	if (!_toastEl) {
		_toastEl = document.createElement('div');
		_toastEl.className = 'mir-toast';
		_toastEl.setAttribute('role', 'status');
		_toastEl.setAttribute('aria-live', 'polite');
		document.body.appendChild(_toastEl);
	}
	_toastEl.textContent = msg;
	_toastEl.dataset.show = 'true';
	clearTimeout(_toastTimer);
	_toastTimer = setTimeout(() => { if (_toastEl) _toastEl.dataset.show = 'false'; }, ms);
}

// ── helpers ───────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortAddr = (a, h = 4, t = 4) => (a && a.length > h + t + 1 ? `${a.slice(0, h)}…${a.slice(-t)}` : a || '');
function fmtSol(n) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	if (v === 0) return '0';
	if (Math.abs(v) < 0.001) return v.toExponential(1);
	return `${v.toFixed(v < 1 ? 4 : 2).replace(/\.?0+$/, '')}`;
}
function fmtUsd(n) {
	if (n == null || !Number.isFinite(Number(n))) return '';
	const v = Number(n);
	if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
	if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
	return `$${v.toFixed(2)}`;
}
function timeAgo(t) {
	if (!t) return '';
	const d = (Date.now() - new Date(t).getTime()) / 1000;
	if (d < 60) return 'just now';
	if (d < 3600) return `${Math.floor(d / 60)}m ago`;
	if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
	return `${Math.floor(d / 86400)}d ago`;
}
function sizingSummary(f) {
	if (f.sizing_mode === 'fixed') return `${fmtSol(f.fixed_sol)} SOL per trade`;
	if (f.sizing_mode === 'pct_balance') return `${f.pct_balance}% of balance`;
	return `${f.proportion_pct}% of leader's size`;
}
function leashSummary(f) {
	const parts = [];
	if (f.max_per_trade_sol != null) parts.push(`max ◎${fmtSol(f.max_per_trade_sol)}/trade`);
	if (f.daily_budget_sol != null) parts.push(`◎${fmtSol(f.daily_budget_sol)}/day`);
	if (!f.copy_sells) parts.push('buys only');
	return parts.join(' · ');
}

// ── styles ────────────────────────────────────────────────────────────────────
const STYLE_ID = 'mir-panel-styles';
function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const s = document.createElement('style');
	s.id = STYLE_ID;
	s.textContent = `
.mir { font-family: var(--font-body, system-ui); color: var(--ink, #e8e8e8); display: flex; flex-direction: column; gap: var(--space-sm, 10px); }
.mir-sk { height: 56px; border-radius: var(--radius-md, 10px); background: linear-gradient(90deg, var(--surface-1, rgba(255,255,255,.03)) 25%, var(--surface-2, rgba(255,255,255,.05)) 50%, var(--surface-1, rgba(255,255,255,.03)) 75%); background-size: 200% 100%; animation: mir-sh 1.3s infinite; }
@keyframes mir-sh { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.mir-empty { text-align: center; padding: var(--space-lg, 22px) var(--space-md, 16px); color: var(--ink-dim, #9a9a9a); font-size: var(--text-sm, .8rem); line-height: 1.5; }
.mir-empty strong { color: var(--ink-bright, #fff); display: block; margin-bottom: 4px; font-family: var(--font-display, inherit); }
.mir-err { color: var(--danger, #f87171); font-size: var(--text-sm, .8rem); padding: var(--space-sm, 10px); }

.mir-leash { display: flex; align-items: center; gap: var(--space-sm, 10px); padding: var(--space-sm, 10px) var(--space-md, 14px);
  border: 1px solid var(--wallet-stroke, rgba(139,92,246,.3)); border-radius: var(--radius-md, 10px);
  background: var(--wallet-accent-soft, rgba(139,92,246,.08)); }
.mir-leash-ico { width: 26px; height: 26px; flex: 0 0 auto; color: ${VIOLET}; }
.mir-leash-txt { flex: 1 1 auto; font-size: var(--text-xs, .72rem); color: var(--ink-dim, #b8b8b8); line-height: 1.4; }
.mir-leash-txt b { color: ${VIOLET}; font-family: var(--font-mono, monospace); }
.mir-kill { flex: 0 0 auto; }

.mir-toggle { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; font-size: var(--text-xs, .72rem); color: var(--ink-dim, #b8b8b8); }
.mir-switch { width: 38px; height: 22px; border-radius: 999px; background: var(--surface-3, rgba(255,255,255,.1)); position: relative; transition: background var(--duration-fast, .18s) var(--ease-standard, ease); flex: 0 0 auto; }
.mir-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform var(--duration-fast, .18s) var(--ease-standard, ease); }
.mir-switch[data-on="true"] { background: var(--danger, #f87171); }
.mir-switch[data-on="true"]::after { transform: translateX(16px); }
.mir-switch.mir-switch-go[data-on="true"] { background: var(--success, #4ade80); }

.mir-follow { display: flex; align-items: center; gap: var(--space-sm, 10px); padding: var(--space-sm, 10px); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md, 10px); background: var(--surface-1, rgba(255,255,255,.03)); transition: border-color var(--duration-fast, .18s); }
.mir-follow:hover { border-color: var(--wallet-stroke, rgba(139,92,246,.3)); }
.mir-follow[data-paused="true"] { opacity: .58; }
.mir-av { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; background: var(--surface-2, rgba(255,255,255,.05)); flex: 0 0 auto; }
.mir-fl-body { flex: 1 1 auto; min-width: 0; }
.mir-fl-name { font-size: var(--text-sm, .82rem); font-weight: 600; color: var(--ink-bright, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mir-fl-sub { font-size: var(--text-2xs, .66rem); color: var(--ink-dim, #9a9a9a); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mir-fl-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }

.mir-btn { font: inherit; font-size: var(--text-2xs, .68rem); padding: 5px 10px; border-radius: var(--radius-sm, 6px); border: 1px solid var(--stroke-strong, rgba(255,255,255,.14)); background: var(--surface-2, rgba(255,255,255,.05)); color: var(--ink, #e8e8e8); cursor: pointer; transition: all var(--duration-fast, .18s); white-space: nowrap; }
.mir-btn:hover { border-color: var(--wallet-stroke-strong, rgba(139,92,246,.5)); color: #fff; }
.mir-btn:focus-visible { outline: 2px solid var(--wallet-focus, rgba(139,92,246,.7)); outline-offset: 2px; }
.mir-btn-primary { background: ${VIOLET}; color: #1a1340; border-color: transparent; font-weight: 700; }
.mir-btn-primary:hover { background: var(--wallet-accent-strong, #a78bfa); color: #1a1340; }
.mir-btn-danger { color: var(--danger, #f87171); border-color: var(--danger, #f87171); background: transparent; }
.mir-btn-ico { padding: 5px 8px; line-height: 1; }

.mir-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(80px, 1fr)); gap: var(--space-xs, 8px); }
.mir-stat { padding: var(--space-sm, 10px); border-radius: var(--radius-md, 10px); background: var(--surface-1, rgba(255,255,255,.03)); border: 1px solid var(--stroke, rgba(255,255,255,.06)); text-align: center; }
.mir-stat-v { font-family: var(--font-mono, monospace); font-size: var(--text-md, .9rem); font-weight: 700; color: var(--ink-bright, #fff); }
.mir-stat-v.pos { color: var(--success, #4ade80); }
.mir-stat-v.neg { color: var(--danger, #f87171); }
.mir-stat-l { font-size: var(--text-2xs, .62rem); color: var(--ink-dim, #9a9a9a); text-transform: uppercase; letter-spacing: .04em; margin-top: 3px; }

.mir-feed { display: flex; flex-direction: column; gap: 6px; }
.mir-fill { display: flex; align-items: center; gap: 8px; font-size: var(--text-xs, .72rem); padding: 7px 9px; border-radius: var(--radius-sm, 6px); background: var(--surface-1, rgba(255,255,255,.025)); }
.mir-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--ink-dim, #888); }
.mir-dot.ok { background: var(--success, #4ade80); }
.mir-dot.skip { background: var(--warn, #fbbf24); }
.mir-dot.fail { background: var(--danger, #f87171); }
.mir-fill-main { flex: 1 1 auto; min-width: 0; color: var(--ink, #ddd); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mir-fill-main b { color: ${VIOLET}; }
.mir-fill-side { font-family: var(--font-mono, monospace); text-transform: uppercase; font-size: var(--text-2xs, .62rem); letter-spacing: .05em; }
.mir-fill-side.buy { color: var(--success, #4ade80); }
.mir-fill-side.sell { color: var(--danger, #f87171); }
.mir-fill-time { flex: 0 0 auto; color: var(--ink-faint, #777); font-size: var(--text-2xs, .62rem); }
.mir-fill a { color: ${VIOLET}; text-decoration: none; }
.mir-fill a:hover { text-decoration: underline; }

.mir-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm, 10px); }
.mir-h { font-size: var(--text-2xs, .64rem); text-transform: uppercase; letter-spacing: .07em; color: var(--ink-dim, #9a9a9a); margin: var(--space-xs, 8px) 0 2px; }

/* Follower graph — the avatars of who mirrors this leader (the social weld). */
.mir-graph { display: flex; align-items: center; gap: var(--space-sm, 10px); padding: var(--space-sm, 9px) var(--space-md, 12px); border: 1px solid var(--stroke, rgba(255,255,255,.07)); border-radius: var(--radius-md, 10px); background: var(--surface-1, rgba(255,255,255,.025)); }
.mir-pile { display: flex; flex: 0 0 auto; }
.mir-pile a, .mir-pile span { display: block; width: 26px; height: 26px; border-radius: 50%; border: 2px solid var(--bg-1, #141414); margin-left: -8px; background: var(--surface-2, rgba(255,255,255,.06)); overflow: hidden; transition: transform var(--duration-fast, .18s) var(--ease-standard, ease); }
.mir-pile > :first-child { margin-left: 0; }
.mir-pile a:hover { transform: translateY(-3px); z-index: 2; }
.mir-pile img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mir-pile .mir-more { display: flex; align-items: center; justify-content: center; font-family: var(--font-mono, monospace); font-size: var(--text-2xs, .6rem); color: var(--ink-dim, #b8b8b8); background: var(--surface-3, rgba(255,255,255,.1)); }
.mir-graph-txt { flex: 1 1 auto; min-width: 0; font-size: var(--text-xs, .72rem); color: var(--ink-dim, #b8b8b8); line-height: 1.35; }
.mir-graph-txt b { color: var(--ink-bright, #fff); }
.mir-graph-txt small { display: block; color: var(--ink-faint, #777); font-size: var(--text-2xs, .62rem); margin-top: 1px; }

.mir-modal-back { position: fixed; inset: 0; background: rgba(0,0,0,.66); backdrop-filter: blur(var(--blur-sm, 4px)); z-index: 9998; display: flex; align-items: center; justify-content: center; padding: 16px; }
.mir-modal { width: min(440px, 96vw); max-height: 90vh; overflow: auto; background: var(--bg-1, #141414); border: 1px solid var(--wallet-stroke, rgba(139,92,246,.3)); border-radius: var(--radius-lg, 14px); padding: var(--space-lg, 22px); box-shadow: var(--shadow-3, 0 24px 64px rgba(0,0,0,.6)); }
.mir-modal h3 { margin: 0 0 4px; font-family: var(--font-display, inherit); font-size: var(--text-lg, 1.05rem); color: var(--ink-bright, #fff); }
.mir-modal .mir-sub { font-size: var(--text-xs, .72rem); color: var(--ink-dim, #9a9a9a); margin: 0 0 var(--space-md, 16px); line-height: 1.5; }
.mir-field { margin-bottom: var(--space-sm, 12px); }
.mir-field label { display: block; font-size: var(--text-2xs, .66rem); text-transform: uppercase; letter-spacing: .05em; color: var(--ink-dim, #9a9a9a); margin-bottom: 5px; }
.mir-field input, .mir-field select { width: 100%; box-sizing: border-box; font: inherit; font-size: var(--text-sm, .82rem); padding: 8px 10px; border-radius: var(--radius-sm, 6px); border: 1px solid var(--stroke-strong, rgba(255,255,255,.14)); background: var(--surface-1, rgba(255,255,255,.03)); color: var(--ink-bright, #fff); }
.mir-field input:focus, .mir-field select:focus { outline: none; border-color: var(--wallet-stroke-strong, rgba(139,92,246,.5)); }
.mir-seg { display: flex; gap: 6px; }
.mir-seg button { flex: 1; font: inherit; font-size: var(--text-2xs, .68rem); padding: 7px 4px; border-radius: var(--radius-sm, 6px); border: 1px solid var(--stroke, rgba(255,255,255,.1)); background: var(--surface-1, rgba(255,255,255,.03)); color: var(--ink-dim, #b8b8b8); cursor: pointer; }
.mir-seg button[aria-pressed="true"] { border-color: ${VIOLET}; color: ${VIOLET}; background: var(--wallet-accent-soft, rgba(139,92,246,.1)); }
.mir-leash-preview { font-size: var(--text-xs, .72rem); color: var(--ink-dim, #b8b8b8); line-height: 1.6; padding: var(--space-sm, 10px); border-radius: var(--radius-md, 10px); background: var(--wallet-accent-soft, rgba(139,92,246,.08)); border: 1px solid var(--wallet-stroke, rgba(139,92,246,.25)); margin: var(--space-sm, 10px) 0; }
.mir-leash-preview b { color: ${VIOLET}; font-family: var(--font-mono, monospace); }
.mir-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: var(--space-md, 16px); }
.mir-modal-actions .mir-btn { padding: 8px 16px; font-size: var(--text-sm, .8rem); }
.mir-checkrow { display: flex; align-items: center; gap: 8px; font-size: var(--text-sm, .8rem); color: var(--ink, #ddd); cursor: pointer; }

.mir-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(10px); background: var(--bg-1, #1a1a1a); color: var(--ink-bright, #fff); border: 1px solid var(--wallet-stroke-strong, rgba(139,92,246,.5)); border-radius: var(--radius-md, 10px); padding: 11px 18px; font-size: var(--text-sm, .82rem); opacity: 0; pointer-events: none; transition: opacity .22s, transform .22s; z-index: 10000; max-width: 90vw; box-shadow: var(--shadow-2, 0 12px 32px rgba(0,0,0,.5)); }
.mir-toast[data-show="true"] { opacity: 1; transform: translateX(-50%) translateY(0); }
`;
	document.head.appendChild(s);
}

const LEASH_SVG = '<svg class="mir-leash-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

// ── follow setup modal ────────────────────────────────────────────────────────
// followerId mirrors leader. Returns a promise resolving true if a follow was saved.
function openFollowModal({ followerId, followerName, leader, existing = null }) {
	ensureStyles();
	return new Promise((resolve) => {
		const back = document.createElement('div');
		back.className = 'mir-modal-back';
		const state = {
			sizing_mode: existing?.sizing_mode || 'proportional',
			proportion_pct: existing?.proportion_pct ?? 100,
			fixed_sol: existing?.fixed_sol ?? 0.1,
			pct_balance: existing?.pct_balance ?? 10,
			max_per_trade_sol: existing?.max_per_trade_sol ?? 0.5,
			daily_budget_sol: existing?.daily_budget_sol ?? 2,
			copy_sells: existing ? existing.copy_sells : true,
			network: existing?.network || 'mainnet',
		};

		function sizingField() {
			if (state.sizing_mode === 'fixed') return `<div class="mir-field"><label>Fixed SOL per trade</label><input type="number" step="0.01" min="0" id="mir-fixed" value="${state.fixed_sol}"></div>`;
			if (state.sizing_mode === 'pct_balance') return `<div class="mir-field"><label>% of your wallet balance</label><input type="number" step="1" min="1" max="100" id="mir-pct" value="${state.pct_balance}"></div>`;
			return `<div class="mir-field"><label>% of leader's trade size</label><input type="number" step="5" min="1" id="mir-prop" value="${state.proportion_pct}"></div>`;
		}
		function previewText() {
			let line;
			if (state.sizing_mode === 'fixed') line = `buy <b>◎${fmtSol(state.fixed_sol)}</b> on every leader buy`;
			else if (state.sizing_mode === 'pct_balance') line = `spend <b>${state.pct_balance}%</b> of your balance per leader buy`;
			else line = `match <b>${state.proportion_pct}%</b> of the leader's size`;
			return `<strong>${esc(followerName || 'Your agent')}</strong> will ${line}, capped at <b>◎${fmtSol(state.max_per_trade_sol)}</b>/trade and <b>◎${fmtSol(state.daily_budget_sol)}</b>/day. ${state.copy_sells ? 'It exits when the leader exits.' : 'Buys only.'} You can pause or stop anytime.`;
		}
		function render() {
			back.innerHTML = `<div class="mir-modal" role="dialog" aria-modal="true" aria-label="Set up mirroring">
				<h3>${existing ? 'Edit' : 'Mirror'} ${esc(leader.name || 'agent')}</h3>
				<p class="mir-sub">Your agent <b style="color:var(--ink-bright,#fff)">${esc(followerName || followerId.slice(0, 8))}</b> will auto-copy <b style="color:var(--ink-bright,#fff)">${esc(leader.name || shortAddr(leader.agent_id))}</b>'s real trades — within your spend policy, fully on-chain.</p>
				<div class="mir-field"><label>Sizing</label>
					<div class="mir-seg" id="mir-seg">
						<button type="button" data-m="proportional" aria-pressed="${state.sizing_mode === 'proportional'}">Proportional</button>
						<button type="button" data-m="fixed" aria-pressed="${state.sizing_mode === 'fixed'}">Fixed</button>
						<button type="button" data-m="pct_balance" aria-pressed="${state.sizing_mode === 'pct_balance'}">% balance</button>
					</div>
				</div>
				${sizingField()}
				<div class="mir-row" style="gap:10px">
					<div class="mir-field" style="flex:1"><label>Max ◎ / trade</label><input type="number" step="0.05" min="0" id="mir-cap" value="${state.max_per_trade_sol}"></div>
					<div class="mir-field" style="flex:1"><label>Max ◎ / day</label><input type="number" step="0.1" min="0" id="mir-daily" value="${state.daily_budget_sol}"></div>
				</div>
				<div class="mir-field"><label>Network</label>
					<select id="mir-net"><option value="mainnet" ${state.network === 'mainnet' ? 'selected' : ''}>Mainnet</option><option value="devnet" ${state.network === 'devnet' ? 'selected' : ''}>Devnet</option></select>
				</div>
				<label class="mir-checkrow"><input type="checkbox" id="mir-sells" ${state.copy_sells ? 'checked' : ''}> Mirror exits (sell when the leader sells)</label>
				<div class="mir-leash-preview">${LEASH_SVG.replace('mir-leash-ico', 'mir-leash-ico" style="width:16px;height:16px;vertical-align:-3px')} ${previewText()}</div>
				<div class="mir-modal-actions">
					<button type="button" class="mir-btn" id="mir-cancel">Cancel</button>
					<button type="button" class="mir-btn mir-btn-primary" id="mir-save">${existing ? 'Save' : 'Start mirroring'}</button>
				</div>
			</div>`;
			wire();
		}
		function readInputs() {
			const q = (id) => back.querySelector(id);
			if (state.sizing_mode === 'fixed') state.fixed_sol = Number(q('#mir-fixed')?.value) || 0;
			else if (state.sizing_mode === 'pct_balance') state.pct_balance = Number(q('#mir-pct')?.value) || 0;
			else state.proportion_pct = Number(q('#mir-prop')?.value) || 0;
			state.max_per_trade_sol = Number(q('#mir-cap')?.value) || 0;
			state.daily_budget_sol = Number(q('#mir-daily')?.value) || 0;
			state.network = q('#mir-net')?.value || 'mainnet';
			state.copy_sells = !!q('#mir-sells')?.checked;
		}
		function wire() {
			back.querySelectorAll('#mir-seg button').forEach((b) => {
				b.addEventListener('click', () => { readInputs(); state.sizing_mode = b.dataset.m; render(); });
			});
			['#mir-fixed', '#mir-pct', '#mir-prop', '#mir-cap', '#mir-daily', '#mir-sells'].forEach((sel) => {
				back.querySelector(sel)?.addEventListener('input', () => { readInputs(); const p = back.querySelector('.mir-leash-preview'); if (p) p.innerHTML = `${LEASH_SVG.replace('mir-leash-ico', 'mir-leash-ico" style="width:16px;height:16px;vertical-align:-3px')} ${previewText()}`; });
			});
			back.querySelector('#mir-cancel').addEventListener('click', close);
			back.querySelector('#mir-save').addEventListener('click', save);
		}
		async function save() {
			readInputs();
			const btn = back.querySelector('#mir-save');
			btn.disabled = true; btn.textContent = 'Saving…';
			try {
				const res = await apiFetch(`/api/agents/${followerId}/mirror`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						leader_agent_id: leader.agent_id,
						network: state.network,
						sizing_mode: state.sizing_mode,
						fixed_sol: state.fixed_sol,
						proportion_pct: state.proportion_pct,
						pct_balance: state.pct_balance,
						max_per_trade_sol: state.max_per_trade_sol,
						daily_budget_sol: state.daily_budget_sol,
						copy_sells: state.copy_sells,
						enabled: true,
					}),
				});
				if (!res.ok) {
					const j = await res.json().catch(() => ({}));
					throw new Error(j?.error?.message || j?.message || 'Could not save');
				}
				toast(`Mirroring ${leader.name || 'agent'} — within your limits`);
				close(true);
			} catch (e) {
				if (e?.redirected) return;
				btn.disabled = false; btn.textContent = existing ? 'Save' : 'Start mirroring';
				toast(e.message || 'Could not save mirroring');
			}
		}
		function close(saved) {
			document.removeEventListener('keydown', onKey);
			back.remove();
			resolve(!!saved);
		}
		function onKey(e) { if (e.key === 'Escape') close(false); }
		back.addEventListener('click', (e) => { if (e.target === back) close(false); });
		document.addEventListener('keydown', onKey);
		render();
		document.body.appendChild(back);
		back.querySelector('#mir-save')?.focus();
	});
}

export { openFollowModal };

// ── the panel ─────────────────────────────────────────────────────────────────
export function mountMirrorPanel({ mount, agent, isOwner = false }) {
	if (!mount) return { destroy() {} };
	ensureStyles();
	const card = mount.closest('#ad-mirror-card') || mount.parentElement;
	const agentId = agent.id;
	let alive = true;
	// The page resolves login async via /api/auth/me → window.__authed (undefined
	// while pending). Optimistic until the probe says guest, then we re-render.
	const isLoggedIn = () => window.__authed !== false;
	const root = document.createElement('div');
	root.className = 'mir';
	mount.replaceChildren(root);
	root.innerHTML = '<div class="mir-sk"></div><div class="mir-sk"></div>';

	const show = () => { if (card) card.hidden = false; };
	const hide = () => { if (card) card.hidden = true; };

	function statEl(v, label, cls = '') {
		return `<div class="mir-stat"><div class="mir-stat-v ${cls}">${v}</div><div class="mir-stat-l">${label}</div></div>`;
	}

	// The follower graph — render the real avatars of who mirrors this agent into
	// `container`. The faces ARE the social-financial graph (spec #5): each links to
	// that follower's own profile, so the network is walkable avatar→avatar.
	// `verb` toggles copy for the owner ("you") vs visitor ("this agent").
	async function loadFollowerGraph(container, verb) {
		if (!container) return;
		let data;
		try {
			const res = await apiFetch(`/api/agents/${agentId}/mirror/followers`, { allowAnonymous: true });
			if (!res.ok) { container.remove(); return; }
			data = (await res.json()).data;
		} catch { container.remove(); return; }
		if (!alive) { return; }
		const followers = data?.followers || [];
		if (!followers.length) { container.remove(); return; }
		const shown = followers.slice(0, 7);
		const overflow = data.count - shown.length;
		const pile = shown.map((fl) => {
			const inner = fl.avatar ? `<img loading="lazy" decoding="async" src="${esc(fl.avatar)}" alt="">` : '';
			return `<a href="/agents/${esc(fl.agent_id)}" title="${esc(fl.name || shortAddr(fl.agent_id))}${fl.enabled ? '' : ' (paused)'}" style="${fl.enabled ? '' : 'opacity:.5'}">${inner}</a>`;
		}).join('');
		const more = overflow > 0 ? `<span class="mir-more">+${overflow}</span>` : '';
		const names = shown.map((f) => f.name || shortAddr(f.agent_id)).filter(Boolean);
		const lead = names.slice(0, 2).join(', ');
		const rest = data.count - Math.min(2, names.length);
		container.className = 'mir-graph';
		container.innerHTML = `<div class="mir-pile">${pile}${more}</div>
			<div class="mir-graph-txt"><b>${data.count}</b> ${data.count === 1 ? 'agent mirrors' : 'agents mirror'} ${verb}${lead ? `<small>${esc(lead)}${rest > 0 ? ` +${rest} more` : ''}${data.active < data.count ? ` · ${data.active} active` : ''}</small>` : ''}</div>`;
	}

	// Render the owner management view from /mirror.
	function renderOwner(d) {
		const followsHtml = d.following.length
			? d.following.map((f) => `
				<div class="mir-follow" data-paused="${!f.enabled}" data-leader="${esc(f.leader_agent_id)}">
					${f.leader_avatar ? `<img loading="lazy" decoding="async" class="mir-av" src="${esc(f.leader_avatar)}" alt="">` : '<div class="mir-av"></div>'}
					<div class="mir-fl-body">
						<div class="mir-fl-name"><a href="/agents/${esc(f.leader_agent_id)}" style="color:inherit;text-decoration:none">${esc(f.leader_name || shortAddr(f.leader_agent_id))}</a></div>
						<div class="mir-fl-sub">${esc(sizingSummary(f))}${leashSummary(f) ? ' · ' + esc(leashSummary(f)) : ''}</div>
					</div>
					<div class="mir-fl-actions">
						<label class="mir-toggle" title="${f.enabled ? 'Pause' : 'Resume'} this follow"><span class="mir-switch mir-switch-go" data-on="${f.enabled}" data-act="toggle"></span></label>
						<button class="mir-btn mir-btn-ico" data-act="edit" title="Edit leash">✎</button>
						<button class="mir-btn mir-btn-ico mir-btn-danger" data-act="unfollow" title="Stop following">✕</button>
					</div>
				</div>`).join('')
			: `<div class="mir-empty"><strong>Not mirroring anyone yet</strong>Follow a high-performing agent and this wallet copies its real trades — within your spend policy. <br><a href="/mirror" style="color:${VIOLET}">Discover leaders →</a></div>`;

		const recentHtml = d.recent.length
			? `<div class="mir-h">Recent mirror activity</div><div class="mir-feed">${d.recent.map(fillRow).join('')}</div>`
			: '';

		root.innerHTML = `
			<div class="mir-leash">
				${LEASH_SVG}
				<div class="mir-leash-txt">${d.killed
					? 'Mirroring is <b>halted</b> by the kill switch. No trades will copy until you turn it back on.'
					: `Leashed autonomy: this wallet mirrors <b>${d.following_count}</b> ${d.following_count === 1 ? 'leader' : 'leaders'}, strictly inside your spend policy. Stop anytime.`}</div>
				<label class="mir-toggle mir-kill" title="${d.killed ? 'Resume all mirroring' : 'Halt ALL mirroring instantly'}">${d.killed ? 'Killed' : 'Kill'} <span class="mir-switch" data-on="${d.killed}" data-act="kill"></span></label>
			</div>
			<div class="mir-row">
				<div style="font-size:var(--text-2xs,.64rem);color:var(--ink-dim,#9a9a9a)">${d.followers_count ? `${d.followers_count} ${d.followers_count === 1 ? 'agent mirrors' : 'agents mirror'} you · ` : ''}following ${d.following_count}</div>
				<button class="mir-btn" data-act="sync" ${d.killed ? 'disabled' : ''} title="Check leaders for new trades now">↻ Sync now</button>
			</div>
			<div id="mir-follows">${followsHtml}</div>
			<div style="text-align:center"><button class="mir-btn mir-btn-primary" data-act="add" style="margin-top:4px">+ Mirror an agent</button></div>
			${d.followers_count ? '<div id="mir-fgraph"></div>' : ''}
			${recentHtml}`;
		wireOwner(d);
		if (d.followers_count) loadFollowerGraph(root.querySelector('#mir-fgraph'), 'you');
	}

	function fillRow(f) {
		const dot = f.status === 'executed' ? 'ok' : f.status === 'skipped' ? 'skip' : f.status === 'unconfirmed' ? 'skip' : 'fail';
		const sideCls = f.side === 'sell' ? 'sell' : 'buy';
		let detail;
		if (f.status === 'executed') detail = `${f.side === 'buy' ? 'bought' : 'sold'} ${f.planned_sol != null ? `◎${fmtSol(f.planned_sol)} of ` : ''}${shortAddr(f.mint)}${f.usd != null ? ` (${fmtUsd(f.usd)})` : ''}`;
		else if (f.status === 'unconfirmed') detail = `submitted ${shortAddr(f.mint)} — confirming`;
		else if (f.status === 'skipped') detail = `skipped ${shortAddr(f.mint)} — ${esc(f.skip_label || f.skip_reason || 'no reason')}`;
		else detail = `failed ${shortAddr(f.mint)}${f.skip_label ? ` — ${esc(f.skip_label)}` : ''}`;
		const sig = f.signature ? ` <a href="https://solscan.io/tx/${esc(f.signature)}" target="_blank" rel="noopener" title="View on Solscan">↗</a>` : '';
		return `<div class="mir-fill"><span class="mir-dot ${dot}"></span><span class="mir-fill-side ${sideCls}">${f.side}</span><span class="mir-fill-main">mirrored from <b>${esc(f.leader_name || shortAddr(f.leader_agent_id))}</b> · ${detail}${sig}</span><span class="mir-fill-time">${timeAgo(f.at)}</span></div>`;
	}

	function wireOwner(d) {
		root.querySelector('[data-act="kill"]')?.parentElement?.addEventListener('click', async (e) => {
			e.preventDefault();
			const next = !d.killed;
			await postAction('kill', { killed: next }, next ? 'All mirroring halted' : 'Mirroring resumed');
			load();
		});
		root.querySelector('[data-act="sync"]')?.addEventListener('click', async (e) => {
			const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Syncing…';
			try {
				const res = await apiFetch(`/api/agents/${agentId}/mirror/sync`, { method: 'POST' });
				const j = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(j?.error?.message || 'Sync failed');
				const all = (j.data?.synced || []).flatMap((s) => s.results || []);
				const exec = all.filter((r) => r.status === 'executed').length;
				const skip = all.filter((r) => r.status === 'skipped').length;
				toast(all.length ? `Mirror sync: ${exec} executed, ${skip} skipped` : 'No new leader trades to mirror');
			} catch (err) { if (!err?.redirected) toast(err.message || 'Sync failed'); }
			load();
		});
		root.querySelector('[data-act="add"]')?.addEventListener('click', () => openLeaderPicker());
		root.querySelectorAll('.mir-follow').forEach((row) => {
			const leaderId = row.dataset.leader;
			const f = d.following.find((x) => x.leader_agent_id === leaderId);
			row.querySelector('[data-act="toggle"]')?.parentElement?.addEventListener('click', async (e) => {
				e.preventDefault();
				await saveFollowPatch(f, { enabled: !f.enabled });
				load();
			});
			row.querySelector('[data-act="edit"]')?.addEventListener('click', async () => {
				const saved = await openFollowModal({ followerId: agentId, followerName: agent.name, leader: { agent_id: leaderId, name: f.leader_name }, existing: f });
				if (saved) load();
			});
			row.querySelector('[data-act="unfollow"]')?.addEventListener('click', async () => {
				if (!confirm(`Stop mirroring ${f.leader_name || 'this agent'}? In-flight trades complete; no new ones start.`)) return;
				await postAction('unfollow', { leader_agent_id: leaderId }, 'Stopped mirroring');
				load();
			});
		});
	}

	async function saveFollowPatch(f, patch) {
		try {
			const res = await apiFetch(`/api/agents/${agentId}/mirror`, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					leader_agent_id: f.leader_agent_id, network: f.network,
					sizing_mode: f.sizing_mode, fixed_sol: f.fixed_sol, proportion_pct: f.proportion_pct,
					pct_balance: f.pct_balance, max_per_trade_sol: f.max_per_trade_sol,
					daily_budget_sol: f.daily_budget_sol, min_leader_sol: f.min_leader_sol,
					copy_sells: f.copy_sells, ...patch,
				}),
			});
			if (!res.ok) throw new Error('Could not update');
			toast(patch.enabled === false ? 'Follow paused' : 'Follow resumed');
		} catch (e) { if (!e?.redirected) toast(e.message || 'Update failed'); }
	}

	async function postAction(action, body, okMsg) {
		try {
			const res = await apiFetch(`/api/agents/${agentId}/mirror/${action}`, {
				method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
			});
			if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error?.message || 'Action failed'); }
			if (okMsg) toast(okMsg);
		} catch (e) { if (!e?.redirected) toast(e.message || 'Action failed'); }
	}

	// Pick a leader to mirror (from the discovery leaderboard or a pasted id).
	async function openLeaderPicker() {
		let leaders = [];
		try {
			const res = await apiFetch('/api/mirror/leaderboard?sort=score&limit=12', { allowAnonymous: true });
			if (res.ok) leaders = (await res.json()).data?.leaders || [];
		} catch { /* fall back to manual entry */ }
		leaders = leaders.filter((l) => l.agent_id !== agentId);
		const back = document.createElement('div');
		back.className = 'mir-modal-back';
		back.innerHTML = `<div class="mir-modal" role="dialog" aria-modal="true" aria-label="Pick a leader">
			<h3>Mirror a leader</h3>
			<p class="mir-sub">Pick an agent to copy by its real track record, or paste an agent ID. Your agent executes its trades within your limits.</p>
			<div class="mir-field"><label>Agent ID</label><input id="mir-leader-id" placeholder="uuid of the agent to mirror"></div>
			${leaders.length ? '<div class="mir-h">Top performers</div><div class="mir-feed" id="mir-leaders">' + leaders.map((l) => `<button type="button" class="mir-follow" data-id="${esc(l.agent_id)}" data-name="${esc(l.name || '')}" style="width:100%;text-align:left;cursor:pointer;border:1px solid var(--stroke,rgba(255,255,255,.08))">${l.avatar ? `<img loading="lazy" decoding="async" class="mir-av" src="${esc(l.avatar)}" alt="">` : '<div class="mir-av"></div>'}<div class="mir-fl-body"><div class="mir-fl-name">#${l.rank} ${esc(l.name || shortAddr(l.agent_id))}</div><div class="mir-fl-sub">${l.roi_pct != null ? `${l.roi_pct > 0 ? '+' : ''}${l.roi_pct}% ROI · ` : ''}${l.win_rate != null ? `${l.win_rate}% win · ` : ''}${l.followers} followers</div></div></button>`).join('') + '</div>' : ''}
			<div class="mir-modal-actions"><button type="button" class="mir-btn" id="mir-pick-cancel">Cancel</button></div>
		</div>`;
		const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
		const onKey = (e) => { if (e.key === 'Escape') close(); };
		back.addEventListener('click', (e) => { if (e.target === back) close(); });
		document.addEventListener('keydown', onKey);
		back.querySelector('#mir-pick-cancel').addEventListener('click', close);
		const choose = async (leaderId, name) => {
			leaderId = (leaderId || '').trim();
			if (!/^[0-9a-f-]{36}$/i.test(leaderId)) { toast('Enter a valid agent ID'); return; }
			if (leaderId === agentId) { toast('An agent cannot mirror itself'); return; }
			close();
			const saved = await openFollowModal({ followerId: agentId, followerName: agent.name, leader: { agent_id: leaderId, name } });
			if (saved) load();
		};
		back.querySelectorAll('#mir-leaders [data-id]').forEach((b) => b.addEventListener('click', () => choose(b.dataset.id, b.dataset.name)));
		back.querySelector('#mir-leader-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') choose(e.target.value); });
		document.body.appendChild(back);
		back.querySelector('#mir-leader-id').focus();
	}

	// Render the visitor / logged-out view: this agent is a potential LEADER.
	function renderLeader(record, agentMeta) {
		const r = record.record;
		const hasHistory = r.total > 0;
		const pnlCls = r.realized.pnl_sol > 0 ? 'pos' : r.realized.pnl_sol < 0 ? 'neg' : '';
		const statsHtml = hasHistory ? `
			<div class="mir-stats">
				${statEl(`${r.realized.pnl_sol > 0 ? '+' : ''}${fmtSol(r.realized.pnl_sol)}`, 'P&L ◎', pnlCls)}
				${statEl(r.realized.win_rate != null ? `${r.realized.win_rate}%` : '—', 'Win rate')}
				${statEl(r.realized.roi_pct != null ? `${r.realized.roi_pct}%` : '—', 'ROI', r.realized.roi_pct > 0 ? 'pos' : r.realized.roi_pct < 0 ? 'neg' : '')}
				${statEl(`◎${fmtSol(r.realized.max_drawdown_sol)}`, 'Max DD')}
				${statEl(r.total, 'Trades')}
				${statEl(r.followers.total, 'Followers')}
			</div>
			<div style="font-size:var(--text-2xs,.62rem);color:var(--ink-faint,#777);text-align:center">Real on-chain track record · ${r.realized.settled} settled (${r.realized.wins}W / ${r.realized.losses}L)${r.last_trade_at ? ' · last trade ' + timeAgo(r.last_trade_at) : ''}</div>
		` : `<div class="mir-empty"><strong>No track record yet</strong>This agent hasn't made any trades. Its stats appear here the moment it does — every number on-chain-verified.</div>`;

		const cta = isLoggedIn()
			? `<button class="mir-btn mir-btn-primary" data-act="mirror-this" style="width:100%">⚡ Mirror this agent with your agent</button>`
			: `<a class="mir-btn mir-btn-primary" href="/login?next=${encodeURIComponent(location.pathname)}" style="width:100%;display:block;text-align:center;text-decoration:none">Sign in to mirror this agent</a>`;

		root.innerHTML = `${statsHtml}<div id="mir-fgraph"></div><div style="margin-top:var(--space-sm,10px)">${cta}</div>
			<div style="font-size:var(--text-2xs,.62rem);color:var(--ink-dim,#9a9a9a);text-align:center;margin-top:6px">Your agent copies its trades inside <b style="color:${VIOLET}">your</b> spend limits. Stop anytime.</div>`;

		root.querySelector('[data-act="mirror-this"]')?.addEventListener('click', () => pickFollowerForLeader(agentMeta));
		loadFollowerGraph(root.querySelector('#mir-fgraph'), 'this agent');
	}

	// Visitor flow: choose which of MY agents should mirror the viewed leader.
	async function pickFollowerForLeader(leaderAgent) {
		let mine = [];
		try {
			const res = await apiFetch('/api/agents', { allowAnonymous: true });
			if (res.ok) {
				const j = await res.json();
				mine = (j.agents || j.data?.agents || j.data || []).filter((a) => a && a.id && a.id !== agentId);
			}
		} catch { /* handled below */ }
		if (!mine.length) { toast('You need your own agent first — create or fork one'); return; }

		const leader = { agent_id: agentId, name: leaderAgent.name };
		if (mine.length === 1) {
			const saved = await openFollowModal({ followerId: mine[0].id, followerName: mine[0].name, leader });
			if (saved) load();
			return;
		}
		const back = document.createElement('div');
		back.className = 'mir-modal-back';
		back.innerHTML = `<div class="mir-modal" role="dialog" aria-modal="true" aria-label="Pick your agent">
			<h3>Which agent should mirror?</h3>
			<p class="mir-sub">Pick the agent whose wallet will copy ${esc(leaderAgent.name || 'this leader')}'s trades.</p>
			<div class="mir-feed">${mine.map((a) => `<button type="button" class="mir-follow" data-id="${esc(a.id)}" data-name="${esc(a.name || '')}" style="width:100%;text-align:left;cursor:pointer">${a.avatar_url || a.profile_image_url ? `<img loading="lazy" decoding="async" class="mir-av" src="${esc(a.avatar_url || a.profile_image_url)}" alt="">` : '<div class="mir-av"></div>'}<div class="mir-fl-body"><div class="mir-fl-name">${esc(a.name || shortAddr(a.id))}</div></div></button>`).join('')}</div>
			<div class="mir-modal-actions"><button type="button" class="mir-btn" id="mir-fp-cancel">Cancel</button></div>
		</div>`;
		const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
		const onKey = (e) => { if (e.key === 'Escape') close(); };
		back.addEventListener('click', (e) => { if (e.target === back) close(); });
		document.addEventListener('keydown', onKey);
		back.querySelector('#mir-fp-cancel').addEventListener('click', close);
		back.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', async () => {
			close();
			const saved = await openFollowModal({ followerId: b.dataset.id, followerName: b.dataset.name, leader });
			if (saved) load();
		}));
		document.body.appendChild(back);
	}

	async function load() {
		if (!alive) return;
		try {
			if (isOwner) {
				const res = await apiFetch(`/api/agents/${agentId}/mirror`, { allowAnonymous: true });
				if (res.status === 403 || res.status === 401) { renderLeaderFallback(); return; }
				if (!res.ok) throw new Error('load failed');
				const d = (await res.json()).data;
				show();
				renderOwner(d);
			} else {
				renderLeaderFallback();
			}
		} catch (e) {
			if (e?.redirected) return;
			root.innerHTML = `<div class="mir-err">Couldn't load copy-trading. <button class="mir-btn" id="mir-retry">Retry</button></div>`;
			root.querySelector('#mir-retry')?.addEventListener('click', load);
			show();
		}
	}

	let _authListener = null;
	async function renderLeaderFallback() {
		try {
			const res = await apiFetch(`/api/agents/${agentId}/mirror/track-record`, { allowAnonymous: true });
			if (!res.ok) { hide(); return; }
			const d = (await res.json()).data;
			// A copy-trading card for an agent that has never traded is hollow —
			// no record to judge, nothing to mirror yet. Keep the section collapsed
			// until there's a real track record (mirrors how actions/memory hide
			// when empty). The moment it trades, the card appears with live stats.
			if (!d?.record?.total) { hide(); return; }
			show();
			renderLeader(d, { name: agent.name });
			// Re-render the CTA once the auth probe resolves (guest ↔ member).
			if (!_authListener) {
				_authListener = () => { if (alive) renderLeader(d, { name: agent.name }); };
				window.addEventListener('auth:resolved', _authListener, { once: true });
			}
		} catch { hide(); }
	}

	load();
	return {
		destroy() {
			alive = false;
			if (_authListener) window.removeEventListener('auth:resolved', _authListener);
			mount.replaceChildren();
		},
	};
}
