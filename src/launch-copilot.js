// Launch Copilot — the autonomous fair-launch market-maker control panel.
//
// A self-contained, reusable panel mounted on the create-agent success screen
// and the coin detail page. It configures the market-maker policy with plain-
// language presets, shows the live action log (SSE) + realized PnL / inventory /
// budget, and gives the owner pause / kill / withdraw controls. Every state is
// designed: loading, empty, configured, live, error, and the not-owner (public,
// read-only) transparency view.
//
// All trades happen server-side through the audited firewall + spend-guard path;
// this UI only edits the published policy and reads its honest action ledger.

import { apiFetch } from './api.js';
import { enterRow, flashValue, rippleOnce, liveDot, setLiveDot } from './ui-juice.js';
import './launch-copilot.css';

const NETWORK_DEFAULT = 'mainnet';

const KIND_LABELS = {
	seed: 'Seed',
	defend_buy: 'Floor defense',
	recycle_sell: 'Profit recycle',
	rebalance_trim: 'Rebalance',
	graduation_lp: 'Provided LP',
	graduation_distribute: 'Distributed',
	graduation_hold: 'Held at graduation',
	skip: 'Held',
};

const STATUS_LABELS = {
	idle: 'Idle', active: 'Active', paused: 'Paused',
	killed: 'Killed', graduated: 'Graduated', error: 'Error',
};

// ── small helpers ─────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function el(tag, attrs = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'html') node.innerHTML = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v === true ? '' : v);
	}
	for (const c of [].concat(children)) {
		if (c == null) continue;
		node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return node;
}
const fmtSol = (n, dp = 4) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: dp }));
function fmtPrice(p) {
	if (p == null || !Number.isFinite(Number(p))) return '—';
	const n = Number(p);
	if (n === 0) return '0';
	if (n < 1e-4) return n.toExponential(2);
	return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
}
function timeAgo(iso) {
	if (!iso) return '';
	const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

/**
 * Mount the Launch Copilot into `host`.
 * @param {HTMLElement} host
 * @param {object} opts
 * @param {string} opts.mint
 * @param {string} [opts.network]
 * @param {string} [opts.symbol]
 * @param {string} [opts.coinName]
 * @param {number} [opts.livePriceSol]  current SOL/token price to prefill the floor
 * @returns {{ destroy: () => void }}
 */
export function mountLaunchCopilot(host, opts = {}) {
	const state = {
		mint: opts.mint,
		network: opts.network || NETWORK_DEFAULT,
		symbol: opts.symbol || '',
		coinName: opts.coinName || '',
		livePriceSol: Number(opts.livePriceSol) || null,
		data: null,
		owned: false,
		editing: false,
		busy: false,
		error: null,
		es: null,
		destroyed: false,
	};

	host.classList.add('lc');
	host.setAttribute('aria-label', 'Launch Copilot — autonomous market-maker');

	async function load() {
		state.error = null;
		render();
		try {
			const res = await apiFetch(`/api/launch/mm/${encodeURIComponent(state.mint)}?network=${state.network}&state=1`, { allowAnonymous: true });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.error_description || body?.error || `error ${res.status}`);
			state.data = body.data || {};
			state.owned = !!state.data.owned;
			if (state.data.policy && !state.es) connectStream();
		} catch (e) {
			state.error = e?.message || 'could not load the market-maker';
		}
		render();
	}

	function connectStream() {
		try { state.es?.close(); } catch {}
		const es = new EventSource(`/api/launch/mm/${encodeURIComponent(state.mint)}?network=${state.network}&stream=1`);
		state.es = es;
		es.addEventListener('open', () => setLogLive('live'));
		es.addEventListener('action', (ev) => {
			try {
				const a = JSON.parse(ev.data);
				if (!state.data) return;
				setLogLive('live');
				state.data.actions = [a, ...(state.data.actions || [])].slice(0, 60);
				renderActions();
				// The freshest action slides in and tints in the direction money moved
				// (a sell returns SOL → success, a buy spends it → danger).
				const first = host.querySelector('#lc-actions .lc-act');
				if (first) { enterRow(first); flashValue(first, a.side === 'sell' ? 'up' : 'down'); }
			} catch { /* ignore frame */ }
		});
		es.addEventListener('state', (ev) => {
			try {
				const p = JSON.parse(ev.data);
				if (state.data?.policy) { state.data.policy = p; renderStats(); renderHeader(); }
			} catch { /* ignore */ }
		});
		es.addEventListener('close', () => { es.close(); state.es = null; setLogLive('connecting'); if (!state.destroyed) setTimeout(() => { if (state.data?.policy) connectStream(); }, 800); });
		es.onerror = () => { es.close(); state.es = null; setLogLive('connecting'); if (!state.destroyed) setTimeout(() => { if (state.data?.policy) connectStream(); }, 2500); };
	}

	// Drive the shared live-state dot in the action-log head (survives re-renders;
	// no-ops when the log isn't mounted, e.g. the form/empty states).
	function setLogLive(stateName) {
		setLiveDot(host.querySelector('#lc-log-live'), stateName);
	}

	// ── owner actions ───────────────────────────────────────────────────────────
	async function post(action, payload) {
		state.busy = true; state.error = null; render();
		try {
			const qs = action ? `?action=${action}` : '';
			const res = await apiFetch(`/api/launch/mm${qs}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mint: state.mint, network: state.network, ...(payload || {}) }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.error_description || body?.error || `error ${res.status}`);
			state.busy = false;
			state.editing = false;
			if (body.data?.withdraw_url && action === 'withdraw') window.location.href = body.data.withdraw_url;
			await load();
			// Configuring the maker (action === null) is the "it shipped" moment — one
			// restrained ripple on the freshly-rendered panel marks the maker going live.
			if (!action) rippleOnce(host.firstElementChild);
			return body.data;
		} catch (e) {
			state.busy = false;
			state.error = e?.message || 'action failed';
			render();
			return null;
		}
	}

	// ── render ───────────────────────────────────────────────────────────────────
	function render() {
		host.innerHTML = '';
		host.appendChild(buildShell());
	}

	function buildShell() {
		const wrap = el('div', { class: 'lc-card' });
		wrap.appendChild(buildHeader());

		if (state.error && !state.data) {
			wrap.appendChild(el('div', { class: 'lc-state lc-state--error', role: 'alert' }, [
				el('p', { text: state.error }),
				el('button', { class: 'lc-btn lc-btn--ghost', onclick: load }, 'Retry'),
			]));
			return wrap;
		}
		if (!state.data) { wrap.appendChild(buildLoading()); return wrap; }

		const body = el('div', { class: 'lc-body', id: 'lc-body' });
		if (state.editing || (!state.data.policy && state.owned)) {
			body.appendChild(buildForm());
		} else if (state.data.policy) {
			body.appendChild(buildDashboard());
		} else {
			body.appendChild(buildPublicEmpty());
		}
		wrap.appendChild(body);
		return wrap;
	}

	function buildHeader() {
		const p = state.data?.policy;
		const head = el('div', { class: 'lc-head', id: 'lc-head' });
		const title = el('div', { class: 'lc-head__title' }, [
			el('span', { class: 'lc-spark', 'aria-hidden': 'true' }),
			el('div', {}, [
				el('h3', { text: 'Launch Copilot' }),
				el('p', { class: 'lc-sub', text: 'Autonomous fair-launch market-maker' }),
			]),
		]);
		head.appendChild(title);
		if (p) {
			const pill = el('span', { class: `lc-pill lc-pill--${p.status}` }, STATUS_LABELS[p.status] || p.status);
			const modePill = el('span', { class: `lc-pill lc-pill--mode ${p.mode === 'live' ? 'lc-pill--live' : ''}` }, p.mode === 'live' ? 'Live' : 'Simulate');
			head.appendChild(el('div', { class: 'lc-head__pills' }, [pill, modePill]));
		}
		return head;
	}
	function renderHeader() {
		const old = host.querySelector('#lc-head');
		if (old) old.replaceWith(buildHeader());
	}

	function buildLoading() {
		const s = el('div', { class: 'lc-state', 'aria-busy': 'true' });
		for (let i = 0; i < 3; i++) s.appendChild(el('div', { class: 'lc-skel' }));
		return s;
	}

	// ── public (not-owner) transparency view ─────────────────────────────────────
	function buildPublicEmpty() {
		const wrap = el('div', { class: 'lc-state' });
		wrap.appendChild(el('div', { class: 'lc-empty-icon', 'aria-hidden': 'true', text: '◎' }));
		wrap.appendChild(el('p', { class: 'lc-empty-title', text: 'No market-maker attached' }));
		wrap.appendChild(el('p', { class: 'lc-muted', text: 'The launcher hasn’t armed a Launch Copilot for this coin yet. When they do, every action it takes shows up here in real time.' }));
		wrap.appendChild(buildDisclosure());
		return wrap;
	}

	// ── config form ──────────────────────────────────────────────────────────────
	function buildForm() {
		const p = state.data.policy;
		const presets = state.data.presets || [];
		const guards = state.data.guards || {};
		const f = {
			preset: p?.preset || 'balanced',
			mode: p?.mode || 'simulate',
			floor: p?.floor_price_sol ?? state.livePriceSol ?? '',
			dip: p?.budgets?.dip_buy_sol ?? 0.5,
			daily: p?.budgets?.daily_sol ?? 1,
			seed: p?.budgets?.seed_sol ?? 0,
			grad: p?.graduation_action || 'provide_lp',
			floorBand: p?.floor_band_pct ?? 5,
			takeBand: p?.take_profit_band_pct ?? 25,
			recycle: p?.recycle_pct ?? 20,
			maxInv: p?.max_inventory_tokens ?? 0,
			slippage: p?.slippage_bps ?? 500,
			impact: p?.max_price_impact_pct ?? 8,
			interval: p?.min_action_interval_seconds ?? 60,
			volume: p?.max_volume_pct ?? 15,
		};

		const form = el('form', { class: 'lc-form', novalidate: true });
		form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

		form.appendChild(el('p', { class: 'lc-muted lc-form__intro', text: 'Pick a style, set a floor and a budget, and your launching agent runs the book — defending the floor and recycling profit from its own wallet, transparently.' }));

		// preset chips
		const chips = el('div', { class: 'lc-presets', role: 'radiogroup', 'aria-label': 'Market-maker style' });
		presets.filter((x) => x.key !== 'custom').forEach((preset) => {
			const chip = el('button', {
				type: 'button',
				class: `lc-chip ${f.preset === preset.key ? 'is-active' : ''}`,
				role: 'radio', 'aria-checked': f.preset === preset.key ? 'true' : 'false',
				onclick: () => applyPreset(preset),
			}, [
				el('span', { class: 'lc-chip__label', text: preset.label }),
				el('span', { class: 'lc-chip__desc', text: preset.description }),
			]);
			chips.appendChild(chip);
		});
		form.appendChild(chips);

		function applyPreset(preset) {
			f.preset = preset.key;
			f.floorBand = preset.floor_band_pct; f.takeBand = preset.take_profit_band_pct;
			f.recycle = preset.recycle_pct; f.slippage = preset.slippage_bps;
			f.impact = preset.max_price_impact_pct; f.interval = preset.min_action_interval_seconds;
			f.volume = preset.max_volume_pct; f.grad = preset.graduation_action;
			rebuild();
		}
		function rebuild() {
			const fresh = buildForm();
			form.replaceWith(fresh);
		}

		// core fields
		const grid = el('div', { class: 'lc-grid' });
		grid.appendChild(field('Floor price (SOL per token)', numInput('floor', f.floor, { step: 'any', min: '0', required: true, placeholder: state.livePriceSol ? `current ≈ ${fmtPrice(state.livePriceSol)}` : '0.0' }), 'The price the maker defends. Below it, it buys; well above it, it recycles profit.'));
		grid.appendChild(field('Dip-buy budget (SOL / 24h)', numInput('dip', f.dip, { step: 'any', min: '0' }), 'Rolling daily SOL the maker can spend defending the floor.'));
		grid.appendChild(field('Daily budget (SOL / 24h)', numInput('daily', f.daily, { step: 'any', min: '0' }), 'Hard ceiling on all SOL the maker spends per day.'));
		grid.appendChild(field('Seed buy (SOL, optional)', numInput('seed', f.seed, { step: 'any', min: '0' }), 'A one-time initial buy to seed the book when armed.'));
		form.appendChild(grid);

		// mode
		const modeRow = el('div', { class: 'lc-mode' });
		['simulate', 'live'].forEach((m) => {
			modeRow.appendChild(el('label', { class: `lc-mode__opt ${f.mode === m ? 'is-active' : ''}` }, [
				el('input', { type: 'radio', name: 'lc-mode', value: m, checked: f.mode === m, onchange: () => { f.mode = m; rebuild(); } }),
				el('span', { class: 'lc-mode__title', text: m === 'simulate' ? 'Simulate' : 'Live' }),
				el('span', { class: 'lc-mode__desc', text: m === 'simulate' ? 'Runs the full logic on real quotes — never spends. Watch it work first.' : 'Real trades from the agent wallet. Needs a budget.' }),
			]));
		});
		form.appendChild(el('div', { class: 'lc-field' }, [el('span', { class: 'lc-label', text: 'Mode' }), modeRow]));

		// graduation
		const gradWrap = el('div', { class: 'lc-field' }, [el('span', { class: 'lc-label', text: 'At graduation (curve → AMM)' })]);
		const gradRow = el('div', { class: 'lc-radios' });
		const gradOpts = [
			['provide_lp', 'Provide LP', 'Deposit inventory + paired SOL into the AMM pool as real liquidity.'],
			['hold', 'Hold', 'Keep inventory and keep market-making on the AMM.'],
			['distribute', 'Distribute', 'Liquidate inventory to SOL in the wallet for you to withdraw.'],
		];
		gradOpts.forEach(([val, label, desc]) => {
			gradRow.appendChild(el('label', { class: `lc-radio ${f.grad === val ? 'is-active' : ''}` }, [
				el('input', { type: 'radio', name: 'lc-grad', value: val, checked: f.grad === val, onchange: () => { f.grad = val; rebuild(); } }),
				el('span', { class: 'lc-radio__title', text: label }),
				el('span', { class: 'lc-radio__desc', text: desc }),
			]));
		});
		gradWrap.appendChild(gradRow);
		form.appendChild(gradWrap);

		// advanced
		const adv = el('details', { class: 'lc-adv' });
		adv.appendChild(el('summary', { text: 'Advanced tuning & anti-manipulation caps' }));
		const advGrid = el('div', { class: 'lc-grid' });
		advGrid.appendChild(field('Floor band %', numInput('floorBand', f.floorBand, { step: 'any', min: '0', max: '90' }), 'Buy when price falls this far below the floor.'));
		advGrid.appendChild(field('Take-profit band %', numInput('takeBand', f.takeBand, { step: 'any', min: '0' }), 'Recycle when price rises this far above the floor.'));
		advGrid.appendChild(field('Recycle %', numInput('recycle', f.recycle, { step: 'any', min: '0.1', max: String(guards.max_recycle_pct || 90) }), `Share of inventory sold per recycle (max ${guards.max_recycle_pct || 90}%).`));
		advGrid.appendChild(field('Max inventory (tokens, 0 = none)', numInput('maxInv', f.maxInv, { step: 'any', min: '0' }), 'Trim back toward this ceiling.'));
		advGrid.appendChild(field('Slippage (bps)', numInput('slippage', f.slippage, { step: '1', min: '0', max: '5000' }), 'Max slippage per fill.'));
		advGrid.appendChild(field('Max price impact %', numInput('impact', f.impact, { step: 'any', min: '0' }), 'Skip a fill that would move price more than this.'));
		advGrid.appendChild(field(`Min action interval (s, ≥ ${guards.min_action_interval_seconds || 30})`, numInput('interval', f.interval, { step: '1', min: String(guards.min_action_interval_seconds || 30) }), 'Anti-wash: no action — and no side flip — inside this window.'));
		advGrid.appendChild(field(`Max volume share % (≤ ${guards.max_volume_pct_ceiling || 33})`, numInput('volume', f.volume, { step: 'any', min: '0.1', max: String(guards.max_volume_pct_ceiling || 33) }), 'Anti-manipulation: one action can’t exceed this share of live volume.'));
		adv.appendChild(advGrid);
		form.appendChild(adv);

		// helpers to read inputs
		function numInput(key, val, attrs = {}) {
			return el('input', { class: 'lc-input', type: 'number', inputmode: 'decimal', value: val === '' ? '' : String(val), 'data-k': key, ...attrs });
		}
		function field(labelText, input, help) {
			return el('div', { class: 'lc-field' }, [
				el('label', { class: 'lc-label', text: labelText }),
				input,
				help ? el('span', { class: 'lc-help', text: help }) : null,
			]);
		}

		// disclosure + actions
		form.appendChild(buildDisclosure());
		if (state.error) form.appendChild(el('div', { class: 'lc-inline-error', role: 'alert', text: state.error }));
		const actions = el('div', { class: 'lc-form__actions' });
		const submitBtn = el('button', { type: 'submit', class: 'lc-btn lc-btn--primary', 'aria-busy': state.busy ? 'true' : 'false' }, p ? 'Save changes' : 'Arm market-maker');
		actions.appendChild(submitBtn);
		if (p) actions.appendChild(el('button', { type: 'button', class: 'lc-btn lc-btn--ghost', onclick: () => { state.editing = false; render(); } }, 'Cancel'));
		form.appendChild(actions);

		function read(key) {
			const node = form.querySelector(`[data-k="${key}"]`);
			return node ? node.value : '';
		}
		function submit() {
			const floor = Number(read('floor'));
			if (!Number.isFinite(floor) || floor < 0) { state.error = 'Enter a valid floor price (SOL per token).'; render(); return; }
			const payload = {
				preset: f.preset, mode: f.mode, enabled: true,
				floor_price_sol: floor,
				dip_buy_budget_sol: Number(read('dip')) || 0,
				daily_budget_sol: Number(read('daily')) || 0,
				seed_sol: Number(read('seed')) || 0,
				graduation_action: f.grad,
				floor_band_pct: Number(read('floorBand')),
				take_profit_band_pct: Number(read('takeBand')),
				recycle_pct: Number(read('recycle')),
				max_inventory_tokens: Number(read('maxInv')) || 0,
				slippage_bps: Math.round(Number(read('slippage'))),
				max_price_impact_pct: Number(read('impact')),
				min_action_interval_seconds: Math.round(Number(read('interval'))),
				max_volume_pct: Number(read('volume')),
			};
			post(null, payload);
		}

		return form;
	}

	// ── dashboard ─────────────────────────────────────────────────────────────────
	function buildDashboard() {
		const wrap = el('div', { class: 'lc-dash' });
		const engineNotice = buildEngineNotice();
		if (engineNotice) wrap.appendChild(engineNotice);
		wrap.appendChild(buildStats());
		wrap.appendChild(buildBudgets());
		wrap.appendChild(buildControls());
		wrap.appendChild(buildActionLog());
		wrap.appendChild(buildDisclosure());
		return wrap;
	}

	// The policy is only half the machine: the other half is a market-maker worker
	// sweeping it. When no worker has checked in, an armed policy would otherwise
	// render as a maker that is working, so say plainly that nothing will execute.
	function buildEngineNotice() {
		const engine = state.data.engine;
		const p = state.data.policy;
		if (!engine || engine.live) return null;
		if (!p || !p.enabled || p.status === 'killed' || p.status === 'graduated') return null;
		const last = engine.last_beat_at
			? `The engine last checked in ${timeAgo(engine.last_beat_at)}.`
			: 'No engine has ever checked in for this network.';
		return el('div', { class: 'lc-notice', role: 'status' }, [
			el('span', { class: 'lc-notice__icon', 'aria-hidden': 'true', text: '◍' }),
			el('div', {}, [
				el('p', { class: 'lc-notice__title', text: 'Market-maker engine is not running' }),
				el('p', { class: 'lc-muted', text: `${last} Your policy, floor and budgets are saved and untouched, but no action will execute until it is back.` }),
			]),
		]);
	}

	function buildStats() {
		const p = state.data.policy;
		const r = p.realized || {};
		const total = (r.pnl_sol ?? 0) + (r.inventory_value_sol ?? 0);
		const grid = el('div', { class: 'lc-stats', id: 'lc-stats' });
		const stat = (label, value, cls = '') => el('div', { class: `lc-stat ${cls}` }, [
			el('span', { class: 'lc-stat__v', text: value }),
			el('span', { class: 'lc-stat__l', text: label }),
		]);
		const pnlCls = (r.pnl_sol ?? 0) >= 0 ? 'is-up' : 'is-down';
		grid.appendChild(stat('Net realized SOL', `${(r.pnl_sol ?? 0) >= 0 ? '+' : ''}${fmtSol(r.pnl_sol)}`, pnlCls));
		grid.appendChild(stat('Inventory value', `${fmtSol(r.inventory_value_sol)} ◎`));
		grid.appendChild(stat('Total (realized + inv.)', `${total >= 0 ? '+' : ''}${fmtSol(total)} ◎`, total >= 0 ? 'is-up' : 'is-down'));
		grid.appendChild(stat('SOL deployed', `${fmtSol(r.sol_deployed)} ◎`));
		grid.appendChild(stat('Last price', `${fmtPrice(r.last_price_sol)} ◎`));
		grid.appendChild(stat('Inventory', r.inventory_tokens != null ? `${fmtSol(r.inventory_tokens, 2)}` : '—'));
		return grid;
	}
	function renderStats() {
		const old = host.querySelector('#lc-stats');
		if (old) old.replaceWith(buildStats());
	}

	function buildBudgets() {
		const b = state.data.budget || {};
		const p = state.data.policy;
		const wrap = el('div', { class: 'lc-budgets' });
		const bar = (label, spent, total) => {
			if (total == null || !(total > 0)) return null;
			const pct = Math.min(100, Math.round((Number(spent || 0) / total) * 100));
			return el('div', { class: 'lc-budget' }, [
				el('div', { class: 'lc-budget__top' }, [
					el('span', { text: label }),
					el('span', { class: 'lc-muted', text: `${fmtSol(spent, 3)} / ${fmtSol(total, 3)} ◎` }),
				]),
				el('div', { class: 'lc-budget__track' }, [el('div', { class: 'lc-budget__fill', style: `width:${pct}%` })]),
			]);
		};
		const daily = bar('Daily budget', b.daily_spent_sol, p.budgets?.daily_sol);
		const dip = bar('Dip-buy budget', b.dip_spent_sol, p.budgets?.dip_buy_sol);
		if (daily) wrap.appendChild(daily);
		if (dip) wrap.appendChild(dip);
		return wrap.childNodes.length ? wrap : el('div');
	}

	function buildControls() {
		const p = state.data.policy;
		const row = el('div', { class: 'lc-controls' });
		if (!state.owned) return el('div');
		const busy = state.busy;
		if (p.status === 'killed') {
			row.appendChild(el('button', { class: 'lc-btn lc-btn--primary', disabled: busy, onclick: () => post('resume') }, 'Re-arm'));
		} else if (p.enabled) {
			row.appendChild(el('button', { class: 'lc-btn', disabled: busy, onclick: () => post('pause') }, 'Pause'));
		} else if (p.status !== 'graduated') {
			row.appendChild(el('button', { class: 'lc-btn lc-btn--primary', disabled: busy, onclick: () => post('resume') }, 'Resume'));
		}
		row.appendChild(el('button', { class: 'lc-btn lc-btn--ghost', disabled: busy, onclick: () => { state.editing = true; render(); } }, 'Edit policy'));
		if (p.status !== 'killed' && p.status !== 'graduated') {
			row.appendChild(el('button', { class: 'lc-btn lc-btn--danger', disabled: busy, onclick: () => { if (confirm('Kill the market-maker now? It halts immediately. You can withdraw funds from the agent wallet.')) post('kill'); } }, 'Kill'));
		}
		row.appendChild(el('button', { class: 'lc-btn lc-btn--ghost', disabled: busy, onclick: () => post('withdraw') }, 'Withdraw funds'));
		if (state.error) row.appendChild(el('span', { class: 'lc-inline-error', role: 'alert', text: state.error }));
		return row;
	}

	function buildActionLog() {
		const wrap = el('div', { class: 'lc-log', id: 'lc-log' });
		wrap.appendChild(el('div', { class: 'lc-log__head' }, [
			el('span', { class: 'lc-label', text: 'Live action log' }),
			el('span', { class: 'lc-log-live', id: 'lc-log-live', html: liveDot(state.es ? 'live' : 'connecting') }),
		]));
		wrap.appendChild(buildActionList());
		return wrap;
	}
	function buildActionList() {
		const list = el('ul', { class: 'lc-actions', id: 'lc-actions', role: 'log', 'aria-live': 'polite' });
		const actions = state.data.actions || [];
		if (!actions.length) {
			list.appendChild(el('li', { class: 'lc-actions__empty lc-muted', text: 'No actions yet — the maker is monitoring the market and will act when its rules trigger.' }));
			return list;
		}
		actions.slice(0, 60).forEach((a) => list.appendChild(actionRow(a)));
		return list;
	}
	function renderActions() {
		const old = host.querySelector('#lc-actions');
		if (old) old.replaceWith(buildActionList());
	}
	function actionRow(a) {
		const isSell = a.side === 'sell';
		const statusCls = a.status === 'executed' ? 'ok' : a.status === 'simulated' ? 'sim' : a.status === 'blocked' ? 'blk' : a.status === 'failed' ? 'err' : 'skip';
		const right = a.sol != null
			? el('span', { class: `lc-act__amt ${isSell ? 'is-up' : 'is-down'}`, text: `${isSell ? '+' : '−'}${fmtSol(a.sol, 4)} ◎` })
			: el('span', { class: 'lc-act__amt lc-muted', text: '—' });
		return el('li', { class: `lc-act lc-act--${statusCls}` }, [
			el('span', { class: `lc-act__kind lc-act__kind--${a.kind}`, text: KIND_LABELS[a.kind] || a.kind }),
			el('span', { class: 'lc-act__detail', text: a.detail || a.trigger_reason || '' }),
			right,
			a.signature
				? el('a', { class: 'lc-act__sig', href: `https://solscan.io/tx/${a.signature}`, target: '_blank', rel: 'noopener', 'aria-label': 'view transaction', text: '↗' })
				: el('span', { class: 'lc-act__time lc-muted', text: timeAgo(a.created_at) }),
		]);
	}

	function buildDisclosure() {
		const g = state.data?.guards || {};
		const txt = g.statement || (state.data?.policy?.disclosure) ||
			'This market-maker is rules-based and non-manipulative: it cannot wash-trade, cannot dominate volume, discloses its full policy, and runs from the launch’s own audited wallet. You can pause, kill, or withdraw at any time.';
		return el('div', { class: 'lc-disclosure' }, [
			el('span', { class: 'lc-disclosure__icon', 'aria-hidden': 'true', text: '🛡' }),
			el('p', { text: txt }),
		]);
	}

	load();
	return {
		destroy() {
			state.destroyed = true;
			try { state.es?.close(); } catch {}
			host.innerHTML = '';
		},
	};
}

export default mountLaunchCopilot;
