// Shared Strategy Object UI primitives: the config editor, the equip picker, the
// human-readable rule summary, plus the styles every strategy surface uses. Reused
// by the /strategies library page and the agent-detail equip panel so the editor
// and the design stay in one place.
//
// 100% real: the editor POSTs/PATCHes to /api/strategies (server-validated against
// the same schema the runtime uses); the equip picker POSTs to
// /api/agents/:id/strategies. No mock state, no fake preview numbers.

import { apiFetch } from '../api.js';

export const VIOLET = 'var(--wallet-accent, #c4b5fd)';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const shortAddr = (a, h = 4, t = 4) => (a && a.length > h + t + 1 ? `${a.slice(0, h)}…${a.slice(-t)}` : a || '');
export function fmtSol(n) {
	if (n == null || !Number.isFinite(Number(n))) return '-';
	const v = Number(n);
	if (v === 0) return '0';
	if (Math.abs(v) < 0.001) return v.toExponential(1);
	return `${v.toFixed(v < 1 ? 4 : 2).replace(/\.?0+$/, '')}`;
}
export function timeAgo(t) {
	if (!t) return '';
	const d = (Date.now() - new Date(t).getTime()) / 1000;
	if (d < 0) return 'just now';
	if (d < 60) return 'just now';
	if (d < 3600) return `${Math.floor(d / 60)}m ago`;
	if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
	return `${Math.floor(d / 86400)}d ago`;
}

// ── toast ──────────────────────────────────────────────────────────────────────
let _toastEl = null;
let _toastTimer = null;
export function toast(msg, ms = 2800) {
	if (typeof document === 'undefined') return;
	if (!_toastEl) {
		_toastEl = document.createElement('div');
		_toastEl.className = 'so-toast';
		_toastEl.setAttribute('role', 'status');
		_toastEl.setAttribute('aria-live', 'polite');
		document.body.appendChild(_toastEl);
	}
	_toastEl.textContent = msg;
	_toastEl.dataset.show = 'true';
	clearTimeout(_toastTimer);
	_toastTimer = setTimeout(() => { if (_toastEl) _toastEl.dataset.show = 'false'; }, ms);
}

// ── rule summary: a one-line, honest plain-language read of a config ──────────
export function configSummary(config) {
	const c = config || {};
	const e = c.entry || {}, s = c.sizing || {}, x = c.exits || {}, k = c.risk || {};
	const parts = [];
	if (e.max_age_minutes != null) parts.push(`launches &lt;${e.max_age_minutes}m old`);
	if (e.min_liquidity_sol != null) parts.push(`liq ≥◎${fmtSol(e.min_liquidity_sol)}`);
	if (e.min_market_cap_usd != null || e.max_market_cap_usd != null) {
		const lo = e.min_market_cap_usd != null ? `$${fmtUsdShort(e.min_market_cap_usd)}` : '';
		const hi = e.max_market_cap_usd != null ? `$${fmtUsdShort(e.max_market_cap_usd)}` : '';
		parts.push(`MC ${lo}${lo && hi ? ' to ' : ''}${hi}`);
	}
	if (e.require_socials) parts.push('has socials');
	parts.push(`size ◎${fmtSol(s.amount_sol)}`);
	if (x.take_profit_pct != null) parts.push(`TP +${x.take_profit_pct}%`);
	if (x.stop_loss_pct != null) parts.push(`SL −${x.stop_loss_pct}%`);
	if (x.trailing_stop_pct != null) parts.push(`trail ${x.trailing_stop_pct}%`);
	if (x.max_hold_minutes != null) parts.push(`≤${formatMinutes(x.max_hold_minutes)}`);
	if (k.max_concurrent_positions != null) parts.push(`max ${k.max_concurrent_positions} open`);
	return parts.join(' · ');
}
function fmtUsdShort(v) {
	const n = Number(v);
	if (!Number.isFinite(n)) return '-';
	if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
	return `${n}`;
}
function formatMinutes(m) {
	const n = Number(m);
	if (!Number.isFinite(n)) return '-';
	if (n >= 1440) return `${Math.round(n / 1440)}d`;
	if (n >= 60) return `${Math.round(n / 60)}h`;
	return `${n}m`;
}

// ── styles (injected once) ─────────────────────────────────────────────────────
const STYLE_ID = 'so-shared-styles';
export function ensureStrategyStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const s = document.createElement('style');
	s.id = STYLE_ID;
	s.textContent = `
.so-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(10px); background: var(--bg-1, #1a1a1a); color: var(--ink-bright, #fff); border: 1px solid var(--wallet-stroke-strong, rgba(139,92,246,.5)); border-radius: var(--radius-md, 10px); padding: 11px 18px; font-size: var(--text-sm, .82rem); opacity: 0; pointer-events: none; transition: opacity .22s, transform .22s; z-index: 10000; max-width: 90vw; box-shadow: var(--shadow-2, 0 12px 32px rgba(0,0,0,.5)); }
.so-toast[data-show="true"] { opacity: 1; transform: translateX(-50%) translateY(0); }
.so-modal-back { position: fixed; inset: 0; background: rgba(0,0,0,.66); backdrop-filter: blur(var(--blur-sm, 4px)); z-index: 9998; display: flex; align-items: center; justify-content: center; padding: 16px; }
.so-modal { width: min(540px, 96vw); max-height: 92vh; overflow: auto; background: var(--bg-1, #141414); border: 1px solid var(--wallet-stroke, rgba(139,92,246,.3)); border-radius: var(--radius-lg, 14px); padding: var(--space-lg, 22px); box-shadow: var(--shadow-3, 0 24px 64px rgba(0,0,0,.6)); }
.so-modal h3 { margin: 0 0 4px; font-family: var(--font-display, inherit); font-size: var(--text-lg, 1.1rem); color: var(--ink-bright, #fff); }
.so-modal .so-sub { font-size: var(--text-xs, .72rem); color: var(--ink-dim, #9a9a9a); margin: 0 0 var(--space-md, 16px); line-height: 1.5; }
.so-group { border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md, 10px); padding: var(--space-sm, 12px); margin-bottom: var(--space-sm, 12px); }
.so-group > legend, .so-glabel { font-size: var(--text-2xs, .64rem); text-transform: uppercase; letter-spacing: .07em; color: ${VIOLET}; font-weight: 700; padding: 0 4px; margin-bottom: 8px; display: block; }
.so-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 460px) { .so-grid { grid-template-columns: 1fr; } }
.so-field { margin-bottom: 2px; }
.so-field label { display: block; font-size: var(--text-2xs, .66rem); color: var(--ink-dim, #9a9a9a); margin-bottom: 5px; }
.so-field input, .so-field select { width: 100%; box-sizing: border-box; font: inherit; font-size: var(--text-sm, .82rem); padding: 8px 10px; border-radius: var(--radius-sm, 6px); border: 1px solid var(--stroke-strong, rgba(255,255,255,.14)); background: var(--surface-1, rgba(255,255,255,.03)); color: var(--ink-bright, #fff); }
.so-field input:focus, .so-field select:focus { outline: none; border-color: var(--wallet-stroke-strong, rgba(139,92,246,.5)); }
.so-field .so-hint { font-size: var(--text-2xs, .6rem); color: var(--ink-faint, #777); margin-top: 3px; }
.so-checkrow { display: flex; align-items: center; gap: 8px; font-size: var(--text-sm, .8rem); color: var(--ink, #ddd); cursor: pointer; margin-top: 4px; }
.so-preview { font-size: var(--text-xs, .72rem); color: var(--ink-dim, #b8b8b8); line-height: 1.6; padding: var(--space-sm, 10px); border-radius: var(--radius-md, 10px); background: var(--wallet-accent-soft, rgba(139,92,246,.08)); border: 1px solid var(--wallet-stroke, rgba(139,92,246,.25)); margin: var(--space-sm, 10px) 0; }
.so-preview b { color: ${VIOLET}; font-family: var(--font-mono, monospace); }
.so-err { color: var(--danger, #f87171); font-size: var(--text-xs, .72rem); margin: 6px 0; }
.so-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: var(--space-md, 16px); }
.so-btn { font: inherit; font-size: var(--text-sm, .8rem); padding: 9px 16px; border-radius: var(--radius-sm, 6px); border: 1px solid var(--stroke-strong, rgba(255,255,255,.14)); background: var(--surface-2, rgba(255,255,255,.05)); color: var(--ink, #e8e8e8); cursor: pointer; transition: all var(--duration-fast, .16s); white-space: nowrap; }
.so-btn:hover { border-color: var(--wallet-stroke-strong, rgba(139,92,246,.5)); color: #fff; }
.so-btn:focus-visible { outline: 2px solid var(--wallet-focus, rgba(139,92,246,.7)); outline-offset: 2px; }
.so-btn-primary { background: ${VIOLET}; color: #1a1340; border-color: transparent; font-weight: 700; }
.so-btn-primary:hover { background: var(--wallet-accent-strong, #a78bfa); color: #1a1340; }
.so-btn-primary:disabled { opacity: .6; cursor: progress; }
.so-pick { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 9px; border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md, 10px); background: var(--surface-1, rgba(255,255,255,.03)); color: var(--ink, #e8e8e8); cursor: pointer; margin-bottom: 6px; transition: border-color .16s; }
.so-pick:hover { border-color: var(--wallet-stroke, rgba(139,92,246,.35)); }
.so-pick img, .so-pick .so-av { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: var(--surface-2, rgba(255,255,255,.06)); flex: 0 0 auto; }
.so-pick .so-pname { font-size: var(--text-sm, .82rem); font-weight: 600; color: var(--ink-bright, #fff); }
.so-compose { max-width: 1040px; margin: 0 auto; }
.so-compose-head { margin-bottom: var(--space-lg, 22px); }
.so-compose-back { background: none; border: none; color: var(--ink-dim, #9a9a9a); font: inherit; font-size: var(--text-sm, .82rem); cursor: pointer; padding: 4px 0; display: inline-flex; align-items: center; gap: 6px; transition: color .16s; }
.so-compose-back:hover { color: var(--ink-bright, #fff); }
.so-compose-back:focus-visible { outline: 2px solid var(--wallet-focus, rgba(139,92,246,.7)); outline-offset: 3px; border-radius: 4px; }
.so-compose-title { font-family: var(--font-display, inherit); font-size: clamp(1.5rem, 4vw, 2.1rem); color: var(--ink-bright, #fff); letter-spacing: -.02em; margin: 10px 0 8px; }
.so-compose-lead { max-width: 620px; color: var(--ink-dim, #9a9a9a); font-size: var(--text-sm, .84rem); line-height: 1.6; margin: 0; }
.so-compose-grid { display: grid; grid-template-columns: 1fr; gap: var(--space-lg, 20px); }
@media (min-width: 880px) { .so-compose-grid { grid-template-columns: minmax(0, 1fr) 296px; align-items: start; } }
@media (min-width: 880px) { .so-compose-side { position: sticky; top: 84px; } }
.so-side-card { border: 1px solid var(--wallet-stroke, rgba(139,92,246,.3)); border-radius: var(--radius-lg, 14px); background: var(--bg-1, #141414); padding: var(--space-lg, 18px); box-shadow: var(--shadow-2, 0 12px 32px rgba(0,0,0,.4)); }
.so-side-h { font-size: var(--text-2xs, .64rem); text-transform: uppercase; letter-spacing: .08em; color: var(--ink-dim, #9a9a9a); font-weight: 700; margin-bottom: 8px; }
.so-side-card .so-preview { margin-top: 0; }
.so-side-points { list-style: none; padding: 0; margin: 12px 0 4px; display: flex; flex-direction: column; gap: 7px; }
.so-side-points li { font-size: var(--text-2xs, .66rem); color: var(--ink-dim, #999); padding-left: 15px; position: relative; line-height: 1.45; }
.so-side-points li::before { content: ''; position: absolute; left: 0; top: 6px; width: 6px; height: 6px; border-radius: 50%; background: ${VIOLET}; }
.so-side-points b { color: var(--ink, #ccc); font-weight: 600; }
.so-side-save { width: 100%; justify-content: center; margin-top: 14px; }
.so-side-cancel { width: 100%; justify-content: center; margin-top: 7px; background: transparent; border-color: transparent; }
.so-side-cancel:hover { background: var(--surface-2, rgba(255,255,255,.05)); }
`;
	document.head.appendChild(s);
}

const DEFAULTS = {
	network: 'mainnet',
	entry: { trigger: 'new_launch', max_age_minutes: 60, min_market_cap_usd: null, max_market_cap_usd: null, min_liquidity_sol: null, require_socials: false, max_creator_launches: null, min_creator_graduated: null, require_sol_quote: true },
	sizing: { amount_sol: 0.1, max_slippage_bps: 500 },
	exits: { take_profit_pct: 100, stop_loss_pct: 40, trailing_stop_pct: null, max_hold_minutes: null },
	risk: { max_concurrent_positions: 3, cooldown_minutes: 0 },
};

const numOrNull = (v) => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };

// ── shared editor internals ────────────────────────────────────────────────────
// One source of truth for the strategy form, used by both the modal editor
// (openStrategyEditor: in-context editing on an agent profile) and the full-page
// builder (mountStrategyComposer: the /strategies "New strategy" flow). The field
// markup, parsing, live preview, and save all live here so the two surfaces can
// never drift apart.
function makeState(existing) {
	const cfg = existing?.config ? structuredCloneSafe(existing.config) : structuredCloneSafe(DEFAULTS);
	return {
		name: existing?.name || '',
		description: existing?.description || '',
		network: cfg.network || 'mainnet',
		entry: { ...DEFAULTS.entry, ...(cfg.entry || {}) },
		sizing: { ...DEFAULTS.sizing, ...(cfg.sizing || {}) },
		exits: { ...DEFAULTS.exits, ...(cfg.exits || {}) },
		risk: { ...DEFAULTS.risk, ...(cfg.risk || {}) },
	};
}

const numVal = (v) => (v == null ? '' : v);

function previewText(state) {
	const c = { entry: state.entry, sizing: state.sizing, exits: state.exits, risk: state.risk };
	return configSummary(c) || 'Define your rules above.';
}

// The form fields, without any chrome. `preview` controls whether the inline
// preview/error block is emitted here (the modal wants it inline; the page hosts
// them in its sticky side panel instead).
function strategyFieldsHTML(state, { preview = true } = {}) {
	return `<div class="so-field"><label>Name</label><input id="so-name" maxlength="80" placeholder="e.g. Fresh-launch sniper" value="${esc(state.name)}"></div>
		<div class="so-field"><label>Description <span style="color:var(--ink-faint,#777)">(optional)</span></label><input id="so-desc" maxlength="2000" placeholder="What edge does this capture?" value="${esc(state.description)}"></div>

		<fieldset class="so-group"><legend>Entry: when to buy</legend>
			<div class="so-grid">
				<div class="so-field"><label>Max launch age (min)</label><input type="number" min="1" max="10080" id="so-age" value="${numVal(state.entry.max_age_minutes)}"><div class="so-hint">only act on launches newer than this</div></div>
				<div class="so-field"><label>Min liquidity (◎ SOL)</label><input type="number" min="0" step="0.1" id="so-liq" value="${numVal(state.entry.min_liquidity_sol)}"></div>
				<div class="so-field"><label>Min market cap (USD)</label><input type="number" min="0" id="so-mcmin" value="${numVal(state.entry.min_market_cap_usd)}"></div>
				<div class="so-field"><label>Max market cap (USD)</label><input type="number" min="0" id="so-mcmax" value="${numVal(state.entry.max_market_cap_usd)}"></div>
				<div class="so-field"><label>Max creator launches</label><input type="number" min="0" id="so-claunch" value="${numVal(state.entry.max_creator_launches)}"><div class="so-hint">skip serial deployers</div></div>
				<div class="so-field"><label>Min creator graduations</label><input type="number" min="0" id="so-cgrad" value="${numVal(state.entry.min_creator_graduated)}"></div>
			</div>
			<label class="so-checkrow"><input type="checkbox" id="so-socials" ${state.entry.require_socials ? 'checked' : ''}> Require socials (X / Telegram / site)</label>
		</fieldset>

		<fieldset class="so-group"><legend>Sizing</legend>
			<div class="so-grid">
				<div class="so-field"><label>Per-trade size (◎ SOL)</label><input type="number" min="0.0001" step="0.01" id="so-size" value="${numVal(state.sizing.amount_sol)}"><div class="so-hint">still capped by your agent's spend policy</div></div>
				<div class="so-field"><label>Max slippage (bps)</label><input type="number" min="0" max="10000" id="so-slip" value="${numVal(state.sizing.max_slippage_bps)}"><div class="so-hint">500 = 5%</div></div>
			</div>
		</fieldset>

		<fieldset class="so-group"><legend>Exits: at least one upside exit + a stop-loss</legend>
			<div class="so-grid">
				<div class="so-field"><label>Take-profit (%)</label><input type="number" min="1" id="so-tp" value="${numVal(state.exits.take_profit_pct)}"><div class="so-hint">100 = sell at 2×</div></div>
				<div class="so-field"><label>Stop-loss (%), required</label><input type="number" min="1" max="99" id="so-sl" value="${numVal(state.exits.stop_loss_pct)}"></div>
				<div class="so-field"><label>Trailing stop (%)</label><input type="number" min="1" max="99" id="so-trail" value="${numVal(state.exits.trailing_stop_pct)}"><div class="so-hint">% drop from peak</div></div>
				<div class="so-field"><label>Max hold (min)</label><input type="number" min="1" id="so-hold" value="${numVal(state.exits.max_hold_minutes)}"></div>
			</div>
		</fieldset>

		<fieldset class="so-group"><legend>Risk</legend>
			<div class="so-grid">
				<div class="so-field"><label>Max concurrent positions</label><input type="number" min="1" max="50" id="so-conc" value="${numVal(state.risk.max_concurrent_positions)}"></div>
				<div class="so-field"><label>Cooldown between entries (min)</label><input type="number" min="0" id="so-cool" value="${numVal(state.risk.cooldown_minutes)}"></div>
				<div class="so-field"><label>Network</label><select id="so-net"><option value="mainnet" ${state.network === 'mainnet' ? 'selected' : ''}>Mainnet</option><option value="devnet" ${state.network === 'devnet' ? 'selected' : ''}>Devnet</option></select></div>
			</div>
		</fieldset>${preview ? `

		<div class="so-preview" id="so-preview">${previewText(state)}</div>
		<div class="so-err" id="so-err" hidden></div>` : ''}`;
}

// Read every field in `root` back into `state` (root is the modal or composer).
function readInputs(root, state) {
	const q = (id) => root.querySelector(id);
	state.name = q('#so-name')?.value || '';
	state.description = q('#so-desc')?.value || '';
	state.network = q('#so-net')?.value || 'mainnet';
	state.entry.max_age_minutes = numOrNull(q('#so-age')?.value);
	state.entry.min_liquidity_sol = numOrNull(q('#so-liq')?.value);
	state.entry.min_market_cap_usd = numOrNull(q('#so-mcmin')?.value);
	state.entry.max_market_cap_usd = numOrNull(q('#so-mcmax')?.value);
	state.entry.max_creator_launches = numOrNull(q('#so-claunch')?.value);
	state.entry.min_creator_graduated = numOrNull(q('#so-cgrad')?.value);
	state.entry.require_socials = !!q('#so-socials')?.checked;
	state.sizing.amount_sol = numOrNull(q('#so-size')?.value);
	state.sizing.max_slippage_bps = numOrNull(q('#so-slip')?.value);
	state.exits.take_profit_pct = numOrNull(q('#so-tp')?.value);
	state.exits.stop_loss_pct = numOrNull(q('#so-sl')?.value);
	state.exits.trailing_stop_pct = numOrNull(q('#so-trail')?.value);
	state.exits.max_hold_minutes = numOrNull(q('#so-hold')?.value);
	state.risk.max_concurrent_positions = numOrNull(q('#so-conc')?.value);
	state.risk.cooldown_minutes = numOrNull(q('#so-cool')?.value);
}

// Live-update the preview as any field changes.
function wireFormFields(root, state) {
	root.querySelectorAll('input,select').forEach((el) => el.addEventListener('input', () => {
		readInputs(root, state);
		const p = root.querySelector('#so-preview'); if (p) p.innerHTML = previewText(state);
	}));
}

function buildConfig(state) {
	return {
		network: state.network,
		entry: { trigger: 'new_launch', ...state.entry },
		sizing: state.sizing,
		exits: state.exits,
		risk: state.risk,
	};
}

function showFieldErr(root, m) { const e = root.querySelector('#so-err'); if (e) { e.textContent = m; e.hidden = false; } }

// POST (create) or PATCH (edit). Returns the saved strategy, or throws.
async function submitStrategy(state, existing) {
	const payload = { name: state.name.trim(), description: state.description.trim() || null, config: buildConfig(state) };
	const res = await apiFetch(existing ? `/api/strategies/${existing.id}` : '/api/strategies', {
		method: existing ? 'PATCH' : 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	});
	const j = await res.json().catch(() => ({}));
	if (!res.ok) {
		const fieldErrs = j?.error?.errors || j?.errors;
		if (Array.isArray(fieldErrs) && fieldErrs.length) throw new Error(fieldErrs.map((e) => e.message).join(' '));
		throw new Error(j?.error?.message || j?.message || 'Could not save');
	}
	return j.data;
}

// ── the strategy editor (modal) ────────────────────────────────────────────────
// In-context editing on an agent profile, where navigating to a full page would
// lose the surrounding context. The /strategies library uses the full-page
// builder below instead. existing: a strategy to edit (PATCH); null → create
// (POST). Resolves the saved strategy object, or null if cancelled.
export function openStrategyEditor({ existing = null } = {}) {
	ensureStrategyStyles();
	const state = makeState(existing);
	return new Promise((resolve) => {
		const back = document.createElement('div');
		back.className = 'so-modal-back';
		back.innerHTML = `<div class="so-modal" role="dialog" aria-modal="true" aria-label="${existing ? 'Edit' : 'New'} strategy">
			<h3>${existing ? 'Edit strategy' : 'New strategy'}</h3>
			<p class="so-sub">A strategy is a real, rule-based plan. When equipped, your agent evaluates real launches and executes on-chain, always inside your spend policy.</p>
			${strategyFieldsHTML(state)}
			<div class="so-actions">
				<button type="button" class="so-btn" id="so-cancel">Cancel</button>
				<button type="button" class="so-btn so-btn-primary" id="so-save">${existing ? 'Save changes' : 'Create strategy'}</button>
			</div>
		</div>`;
		const modal = back.firstElementChild;
		wireFormFields(modal, state);
		modal.querySelector('#so-cancel').addEventListener('click', () => close(null));
		const btn = modal.querySelector('#so-save');
		btn.addEventListener('click', async () => {
			readInputs(modal, state);
			if (!state.name.trim()) { showFieldErr(modal, 'Give your strategy a name.'); return; }
			btn.disabled = true; btn.textContent = 'Saving…';
			try {
				const saved = await submitStrategy(state, existing);
				toast(existing ? 'Strategy updated' : 'Strategy created');
				close(saved);
			} catch (e) {
				if (e?.redirected) return;
				btn.disabled = false; btn.textContent = existing ? 'Save changes' : 'Create strategy';
				showFieldErr(modal, e.message || 'Could not save');
			}
		});
		function close(result) { document.removeEventListener('keydown', onKey); back.remove(); resolve(result); }
		function onKey(e) { if (e.key === 'Escape') close(null); }
		back.addEventListener('click', (e) => { if (e.target === back) close(null); });
		document.addEventListener('keydown', onKey);
		document.body.appendChild(back);
		modal.querySelector('#so-name')?.focus();
	});
}

// ── the strategy builder (full page) ───────────────────────────────────────────
// Renders the whole builder into `host` as a page: a two-column workspace with
// the rules on the left and a sticky live summary + Create button on the right.
// This is the /strategies "New strategy" surface: a complex, multi-section form
// deserves room to breathe, not a cramped modal. onSaved(saved) fires after a
// successful create/edit; onCancel() fires on the back link.
export function mountStrategyComposer(host, { existing = null, onSaved, onCancel } = {}) {
	ensureStrategyStyles();
	const state = makeState(existing);
	host.innerHTML = `<div class="so-compose">
		<div class="so-compose-head">
			<button type="button" class="so-compose-back" id="so-back">← Strategies</button>
			<h1 class="so-compose-title">${existing ? 'Edit strategy' : 'New strategy'}</h1>
			<p class="so-compose-lead">A strategy is a real, rule-based plan. When equipped, your agent evaluates real launches and executes on-chain, always inside your spend policy.</p>
		</div>
		<div class="so-compose-grid">
			<div class="so-compose-main">${strategyFieldsHTML(state, { preview: false })}</div>
			<aside class="so-compose-side">
				<div class="so-side-card">
					<div class="so-side-h">Your strategy</div>
					<div class="so-preview" id="so-preview">${previewText(state)}</div>
					<ul class="so-side-points">
						<li><b>Spend-policy gated</b>: every trade is capped by your agent</li>
						<li><b>Real on-chain</b>: no backtested fiction</li>
						<li><b>Kill switch</b>: halt everything at once</li>
					</ul>
					<div class="so-err" id="so-err" hidden></div>
					<button type="button" class="so-btn so-btn-primary so-side-save" id="so-save">${existing ? 'Save changes' : 'Create strategy'}</button>
					<button type="button" class="so-btn so-side-cancel" id="so-cancel">Cancel</button>
				</div>
			</aside>
		</div>
	</div>`;
	const root = host.firstElementChild;
	wireFormFields(root, state);
	root.querySelector('#so-back').addEventListener('click', () => onCancel?.());
	root.querySelector('#so-cancel').addEventListener('click', () => onCancel?.());
	const btn = root.querySelector('#so-save');
	btn.addEventListener('click', async () => {
		readInputs(root, state);
		if (!state.name.trim()) { showFieldErr(root, 'Give your strategy a name.'); root.querySelector('#so-name')?.focus(); return; }
		btn.disabled = true; btn.textContent = 'Saving…';
		try {
			const saved = await submitStrategy(state, existing);
			toast(existing ? 'Strategy updated' : 'Strategy created');
			onSaved?.(saved);
		} catch (e) {
			if (e?.redirected) return;
			btn.disabled = false; btn.textContent = existing ? 'Save changes' : 'Create strategy';
			showFieldErr(root, e.message || 'Could not save');
		}
	});
	root.querySelector('#so-name')?.focus();
}

function structuredCloneSafe(o) {
	try { return structuredClone(o); } catch { return JSON.parse(JSON.stringify(o)); }
}

// ── equip picker: choose which of MY agents equips this strategy ──────────────
// Resolves true if an equip was created.
export async function openEquipPicker({ strategy }) {
	ensureStrategyStyles();
	let mine = [];
	try {
		const res = await apiFetch('/api/agents', { allowAnonymous: true });
		if (res.ok) {
			const j = await res.json();
			mine = (j.agents || j.data?.agents || j.data || []).filter((a) => a && a.id);
		}
	} catch { /* handled below */ }
	if (!mine.length) { toast('You need your own agent first. Create or fork one'); return false; }

	if (mine.length === 1) return equipOn(mine[0], strategy);

	return new Promise((resolve) => {
		const back = document.createElement('div');
		back.className = 'so-modal-back';
		back.innerHTML = `<div class="so-modal" role="dialog" aria-modal="true" aria-label="Pick an agent to equip">
			<h3>Equip “${esc(strategy.name)}”</h3>
			<p class="so-sub">Pick the agent that will run these rules. It trades on-chain within <b style="color:var(--ink-bright,#fff)">its own</b> spend policy. No wallet access is shared.</p>
			<div>${mine.map((a) => `<button type="button" class="so-pick" data-id="${esc(a.id)}">${a.avatar_url || a.profile_image_url ? `<img loading="lazy" decoding="async" src="${esc(a.avatar_url || a.profile_image_url)}" alt="">` : '<div class="so-av"></div>'}<span class="so-pname">${esc(a.name || shortAddr(a.id))}</span></button>`).join('')}</div>
			<div class="so-actions"><button type="button" class="so-btn" id="so-pick-cancel">Cancel</button></div>
		</div>`;
		const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
		const onKey = (e) => { if (e.key === 'Escape') close(false); };
		back.addEventListener('click', (e) => { if (e.target === back) close(false); });
		document.addEventListener('keydown', onKey);
		back.querySelector('#so-pick-cancel').addEventListener('click', () => close(false));
		back.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', async () => {
			const agent = mine.find((a) => a.id === b.dataset.id);
			close(await equipOn(agent, strategy));
		}));
		document.body.appendChild(back);
	});
}

async function equipOn(agent, strategy) {
	try {
		const res = await apiFetch(`/api/agents/${agent.id}/strategies`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ strategy_id: strategy.id, network: strategy.config?.network || 'mainnet' }),
		});
		const j = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(j?.error?.message || 'Could not equip');
		toast(`Equipped on ${agent.name || 'your agent'}, running within its limits`);
		return true;
	} catch (e) {
		if (e?.redirected) return false;
		toast(e.message || 'Could not equip');
		return false;
	}
}
