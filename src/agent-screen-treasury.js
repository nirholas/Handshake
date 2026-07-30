// Treasury Autopilot cockpit — the agent that funds its own existence, on screen.
//
// Renders into the Agent Screen's "Treasury" panel: a live SOL/$THREE balance, a
// runway gauge, the plain-English policy rules the owner armed, and the hard spend
// caps that bound it. For the owner it is also a control surface — edit the policy
// in English (live-compiled to a preview), arm/disarm, flip the kill switch, and
// run one real cycle now. Every number is a real read: the balance is a live
// Solana RPC call (via computeRunway), the rules are the compiled policy, the
// buybacks/distributions are real on-chain txs with explorer links.
//
// Data path (source → transform → render):
//   GET  /api/agents/:id/autopilot   → { policy, runway, spend_limits }  (owner-only; 403 ⇒ viewer)
//   GET  /api/pump/autopilot         → owner's launched coins → per-coin buyback/distribute toggles
//   POST /api/agents/:id/autopilot/compile → English → structured rules (preview, never arms)
//   PUT  /api/agents/:id/autopilot   → save / arm / disarm / kill
//   POST /api/agents/:id/autopilot/run     → run one real cycle now
//   POST /api/agent-screen-push      → render the cockpit to a PNG so /agents-live shows it
//
// Live: the host (agent-screen.js) forwards each SSE activity line to observeLog();
// a treasury movement fires a toast + a soft balance re-read so the number drops in
// real time. A 15s heartbeat keeps the balance fresh even with no new activity.

import {
	fmtUsd,
	fmtSol,
	fmtCompact,
	runwayGauge,
	arcDash,
	policyLine,
	isTreasuryActivity,
	actionToast,
	previewLine,
} from './agent-screen-treasury-format.js';

const GAUGE_R = 52;
const GAUGE_C = 2 * Math.PI * GAUGE_R;
const POLL_MS = 15_000;     // live balance heartbeat (real RPC each tick)
const COMPILE_DEBOUNCE = 600;
const WALL_PUSH_MIN_GAP = 6_000;

// ── wall-frame typography + palette ─────────────────────────────────────────
// The offscreen cockpit render (drawCockpitCanvas) is the agent's on-screen
// "dashboard" that /agents-live and the viewer show. Draw it in the SAME brand
// families (Space Grotesk display, Inter body) and semantic colours as the rest
// of the site — mirrors public/tokens.css so the frame reads as one product.
// Fallbacks keep the first frame legible before the woff2 decodes; ensureWallFonts()
// force-loads the exact weights so the next push is fully on-brand.
const WALL_DISPLAY = "'Space Grotesk', 'Inter', system-ui, sans-serif";
const WALL_BODY = "'Inter', system-ui, sans-serif";
const WALL_INK = '#f4f4f5';
const WALL_DIM = 'rgba(255,255,255,0.5)';
const WALL_FAINT = 'rgba(255,255,255,0.38)';
const WALL_SUCCESS = '#4ade80'; // --success
const WALL_DANGER = '#f87171';  // --danger
const WALL_WARN = '#fbbf24';    // --warn

let wallFontsReady = false;
function ensureWallFonts() {
	if (wallFontsReady || typeof document === 'undefined' || !document.fonts?.load) return Promise.resolve();
	return Promise.all([
		document.fonts.load("800 92px 'Space Grotesk'"),
		document.fonts.load("700 34px 'Space Grotesk'"),
		document.fonts.load("600 22px 'Inter'"),
		document.fonts.load("500 30px 'Inter'"),
	]).then(() => { wallFontsReady = true; }).catch(() => {});
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Mount the treasury cockpit into a panel body.
 * @param {object} o
 * @param {string} o.agentId
 * @param {HTMLElement} o.bodyEl     the panel body to render into
 * @param {(msg:string)=>void} o.toast
 * @param {string} [o.network]
 * @returns {{ observeLog(entries:Array):void, refresh():void, destroy():void }}
 */
export function createTreasuryCockpit({ agentId, bodyEl, toast, network = 'mainnet' }) {
	let state = 'loading';     // loading | viewer | empty | populated | error
	let owner = false;
	let data = null;           // { policy, runway, spend_limits, coins }
	let errMsg = '';
	let csrf = null;
	let pollTimer = null;
	let compileTimer = null;
	let softTimer = null;
	let destroyed = false;
	let lastPush = 0;
	let busy = false;          // a write is in flight
	let runArmed = false;      // "Run one cycle" is one click from spending real funds
	let lastCompiled = null;   // { rules, buffer_sol, sweep_destination, warnings, contradictions, source_text }

	const auth = { credentials: 'include' };

	async function csrfToken() {
		if (csrf) return csrf;
		csrf = await fetch('/api/csrf-token', auth)
			.then((r) => r.json())
			.then((j) => j.data?.token || j.token || '')
			.catch(() => '');
		return csrf;
	}

	// ── data ────────────────────────────────────────────────────────────────
	async function fetchAll({ soft = false } = {}) {
		try {
			const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/autopilot?network=${network}`, auth);
			if (res.status === 401 || res.status === 403) {
				owner = false;
				if (!soft) { state = 'viewer'; render(); }
				return;
			}
			if (!res.ok) {
				if (!soft) { state = 'error'; errMsg = res.status === 429 ? 'Rate limited — retrying shortly.' : 'Couldn’t load the treasury.'; render(); }
				return;
			}
			const j = await res.json();
			owner = true;
			const next = j.data || j;
			data = { ...next, coins: data?.coins || [] };
			const hasPolicy = (next.policy?.rules?.length || 0) > 0 || !!next.policy?.source_text;
			if (soft && state === 'populated') {
				applyLiveNumbers();    // balance tick without nuking the controls/textarea
			} else {
				state = hasPolicy ? 'populated' : 'empty';
				render();
				pushWallFrame();       // keep the /agents-live card showing the cockpit
			}
			// per-coin buyback/distribute config (owner-scoped); never blocks the cockpit
			fetchCoins();
		} catch {
			if (!soft) { state = 'error'; errMsg = 'Network error reaching the treasury — retrying.'; render(); }
		}
	}

	async function fetchCoins() {
		try {
			const res = await fetch('/api/pump/autopilot', auth);
			if (!res.ok) return;
			const j = await res.json();
			const mine = (j.coins || []).filter((c) => c.agent_id === agentId);
			if (!data) return;
			data.coins = mine;
			const host = bodyEl.querySelector('#ast-coins');
			if (host) host.innerHTML = renderCoins(mine);
			const wrap = bodyEl.querySelector('#ast-coins-wrap');
			if (wrap) wrap.hidden = !mine.length;
			bindCoinToggles();
		} catch { /* non-fatal */ }
	}

	// ── live numbers (no full re-render) ──────────────────────────────────────
	function applyLiveNumbers() {
		const r = data?.runway;
		if (!r) return;
		const set = (id, v) => { const el = bodyEl.querySelector(id); if (el) el.textContent = v; };
		set('#ast-bal-sol', fmtSol(r.balance_sol));
		set('#ast-bal-usd', r.balance_usd != null ? fmtUsd(r.balance_usd) : '—');
		set('#ast-three', fmtCompact(r.three_accumulated));
		set('#ast-income', fmtUsd(r.income_usd, { compact: true }));
		set('#ast-burn', fmtUsd(r.cost_usd, { compact: true }));
		set('#ast-buybacks', `${r.buyback_count || 0}`);
		set('#ast-swept', fmtSol(r.swept_sol || 0));
		const net = bodyEl.querySelector('#ast-net');
		if (net) {
			net.textContent = `${r.net_usd >= 0 ? '+' : ''}${fmtUsd(r.net_usd, { compact: true })}`;
			net.classList.toggle('pos', r.net_usd >= 0);
			net.classList.toggle('neg', r.net_usd < 0);
		}
		updateGauge(r);
		const stale = bodyEl.querySelector('#ast-stale');
		if (stale) stale.hidden = r.balance_usd != null;
	}

	function updateGauge(r) {
		const g = runwayGauge(r);
		const arc = bodyEl.querySelector('#ast-gauge-arc');
		const lab = bodyEl.querySelector('#ast-gauge-label');
		const sub = bodyEl.querySelector('#ast-gauge-sub');
		const wrap = bodyEl.querySelector('#ast-gauge');
		if (arc) arc.setAttribute('stroke-dasharray', arcDash(g.fraction, GAUGE_C).dash);
		if (lab) lab.textContent = g.label;
		if (sub) sub.textContent = g.sublabel;
		if (wrap) wrap.dataset.tone = g.tone;
	}

	// ── render ────────────────────────────────────────────────────────────────
	function render() {
		if (destroyed) return;
		if (state === 'loading') { bodyEl.innerHTML = skeleton(); return; }
		if (state === 'error') { bodyEl.innerHTML = errorView(errMsg); bind(); return; }
		if (state === 'viewer') { bodyEl.innerHTML = viewerView(); return; }
		if (state === 'empty') { bodyEl.innerHTML = emptyView(); bind(); return; }
		bodyEl.innerHTML = cockpitView();
		applyLiveNumbers();
		bind();
	}

	function skeleton() {
		return `
		<div class="ast-cockpit ast-skel">
			<div class="ast-balance"><div class="ast-sk ast-sk-bal"></div><div class="ast-sk ast-sk-bal2"></div></div>
			<div class="ast-sk ast-sk-gauge"></div>
			<div class="ast-rules">
				<div class="ast-sk ast-sk-row"></div><div class="ast-sk ast-sk-row"></div><div class="ast-sk ast-sk-row"></div>
			</div>
		</div>`;
	}

	function errorView(msg) {
		return `
		<div class="ast-state ast-state-error">
			<div class="ast-state-icon">⚠</div>
			<p>${esc(msg || 'Something went wrong.')}</p>
			<button class="ast-btn ast-btn-ghost" data-act="retry">Retry</button>
		</div>`;
	}

	function viewerView() {
		return `
		<div class="ast-state ast-state-viewer">
			<div class="ast-state-icon">◎</div>
			<h4>Autonomous treasury</h4>
			<p>This agent runs its own treasury — paying its compute, dollar-cost-averaging into <b>$THREE</b>, and rewarding holders. Buybacks and distributions appear live on the screen as they execute on-chain.</p>
			<a class="ast-btn ast-btn-ghost" href="/agents/${esc(agentId)}">View agent →</a>
		</div>`;
	}

	function emptyView() {
		return `
		<div class="ast-state ast-state-empty">
			<div class="ast-state-icon">◎</div>
			<h4>Treasury is idle</h4>
			<p>Arm a policy to start autonomous <b>$THREE</b> buybacks, holder distributions, and self-funding — all under spend caps it can’t exceed.</p>
			${ownerEditor('', null)}
		</div>`;
	}

	function cockpitView() {
		const r = data.runway || {};
		const p = data.policy || {};
		const rules = Array.isArray(p.rules) ? p.rules : [];
		const armed = p.armed === true;
		const killed = p.kill_switch === true;

		const armBadge = killed
			? `<span class="ast-badge ast-badge-killed">Kill switch</span>`
			: armed
				? `<span class="ast-badge ast-badge-armed"><span class="ast-dot"></span>Armed</span>`
				: `<span class="ast-badge ast-badge-idle">Disarmed</span>`;

		return `
		<div class="ast-cockpit">
			<div class="ast-balance">
				<div class="ast-balance-main">
					<span class="ast-balance-sol" id="ast-bal-sol">${esc(fmtSol(r.balance_sol))}</span>
					<span class="ast-stale" id="ast-stale" hidden title="Live RPC read failed — showing last-known balance">stale</span>
				</div>
				<div class="ast-balance-sub">
					<span class="ast-balance-usd" id="ast-bal-usd">${r.balance_usd != null ? esc(fmtUsd(r.balance_usd)) : '—'}</span>
					<span class="ast-sep">·</span>
					<span>$THREE <b id="ast-three">${esc(fmtCompact(r.three_accumulated))}</b></span>
					${r.explorer_account ? `<a class="ast-explorer" href="${esc(r.explorer_account)}" target="_blank" rel="noopener">wallet ↗</a>` : ''}
				</div>
			</div>

			<div class="ast-gauge" id="ast-gauge" data-tone="unknown">
				<svg viewBox="0 0 120 120" aria-hidden="true">
					<circle class="ast-gauge-bg" cx="60" cy="60" r="${GAUGE_R}" />
					<circle class="ast-gauge-arc" id="ast-gauge-arc" cx="60" cy="60" r="${GAUGE_R}"
						stroke-dasharray="0 ${GAUGE_C.toFixed(1)}" stroke-dashoffset="0" />
				</svg>
				<div class="ast-gauge-center">
					<span class="ast-gauge-label" id="ast-gauge-label">—</span>
					<span class="ast-gauge-sub" id="ast-gauge-sub">Runway</span>
				</div>
			</div>

			<div class="ast-stats">
				<div class="ast-stat"><span class="ast-stat-k">Income 30d</span><span class="ast-stat-v" id="ast-income">—</span></div>
				<div class="ast-stat"><span class="ast-stat-k">Burn 30d</span><span class="ast-stat-v" id="ast-burn">—</span></div>
				<div class="ast-stat"><span class="ast-stat-k">Net</span><span class="ast-stat-v" id="ast-net">—</span></div>
				<div class="ast-stat"><span class="ast-stat-k">Buybacks</span><span class="ast-stat-v" id="ast-buybacks">0</span></div>
				<div class="ast-stat"><span class="ast-stat-k">Swept</span><span class="ast-stat-v" id="ast-swept">—</span></div>
			</div>

			<div class="ast-section">
				<div class="ast-section-head"><span>Policy rules</span>${armBadge}</div>
				<div class="ast-rules">${rules.length ? rules.map(ruleRow).join('') : `<div class="ast-rules-empty">No rules compiled yet.</div>`}</div>
			</div>

			${capsRow(data.spend_limits)}

			<div class="ast-section" id="ast-coins-wrap" ${owner && data.coins?.length ? '' : 'hidden'}>
				<div class="ast-section-head"><span>Coin economy</span></div>
				<div class="ast-coins" id="ast-coins">${renderCoins(data.coins || [])}</div>
			</div>

			${owner ? ownerEditor(p.source_text || '', p) : ''}
		</div>`;
	}

	function ruleRow(rule) {
		const l = policyLine(rule);
		const last = l.lastStatus
			? `<span class="ast-rule-last s-${esc(l.lastStatus)}" title="${esc(l.note || '')}">${esc(l.lastStatus)}</span>`
			: '';
		return `
		<div class="ast-rule" data-state="${esc(l.state)}">
			<span class="ast-rule-glyph">${esc(l.glyph)}</span>
			<span class="ast-rule-text">${esc(l.text)}</span>
			${last}
			<span class="ast-rule-state st-${esc(l.state)}">${esc(l.stateLabel)}</span>
		</div>`;
	}

	function capsRow(limits) {
		const daily = limits?.daily_usd != null ? fmtUsd(limits.daily_usd) : 'No cap';
		const perTx = limits?.per_tx_usd != null ? fmtUsd(limits.per_tx_usd) : 'No cap';
		const frozen = limits?.frozen === true;
		return `
		<div class="ast-caps" title="Hard spend ceiling — the autopilot can never exceed this">
			<div class="ast-cap"><span class="ast-cap-k">Daily cap</span><span class="ast-cap-v">${esc(daily)}</span></div>
			<div class="ast-cap"><span class="ast-cap-k">Per-tx cap</span><span class="ast-cap-v">${esc(perTx)}</span></div>
			${frozen ? `<div class="ast-cap ast-cap-frozen"><span class="ast-cap-k">Wallet</span><span class="ast-cap-v">Frozen</span></div>` : ''}
			${owner ? `<a class="ast-cap-link" href="/agents/${esc(agentId)}#limits">Limits & Safety →</a>` : ''}
		</div>`;
	}

	function renderCoins(coins) {
		if (!coins?.length) return '';
		return coins.map((c) => `
			<div class="ast-coin" data-mint="${esc(c.mint)}" data-network="${esc(c.network)}">
				<div class="ast-coin-id">
					<span class="ast-coin-name">${esc(c.symbol ? `$${c.symbol}` : c.name)}</span>
					${c.stats?.graduated ? `<span class="ast-coin-tag">graduated</span>` : ''}
				</div>
				<div class="ast-coin-toggles">
					<label class="ast-switch" title="Compound creator fees into buybacks">
						<input type="checkbox" data-coin-toggle="buyback_enabled" ${c.policy?.buyback_enabled ? 'checked' : ''} ${owner ? '' : 'disabled'}>
						<span>Buyback</span>
					</label>
					<label class="ast-switch" title="Distribute fees to holders">
						<input type="checkbox" data-coin-toggle="distribute_enabled" ${c.policy?.distribute_enabled ? 'checked' : ''} ${owner ? '' : 'disabled'}>
						<span>Distribute</span>
					</label>
				</div>
			</div>`).join('');
	}

	function ownerEditor(sourceText, policy) {
		const armed = policy?.armed === true;
		const killed = policy?.kill_switch === true;
		const sweep = policy?.sweep_destination || '';
		return `
		<div class="ast-editor">
			<label class="ast-editor-label" for="ast-policy">Treasury policy <span>plain English</span></label>
			<textarea id="ast-policy" class="ast-textarea" rows="3" spellcheck="false"
				placeholder="Pay your own compute, keep a 1 SOL buffer, put 10% of tips into $THREE, buy back your coin weekly, sweep over 3 SOL to me on Fridays.">${esc(sourceText)}</textarea>
			<input id="ast-sweep" class="ast-input" type="text" spellcheck="false" autocomplete="off"
				placeholder="Sweep destination wallet (optional)" value="${esc(sweep)}">
			<div class="ast-preview" id="ast-preview"></div>
			<div class="ast-actions">
				<button class="ast-btn ast-btn-primary" data-act="save">Save policy</button>
				<button class="ast-btn ${armed ? 'ast-btn-warn' : 'ast-btn-go'}" data-act="arm" ${killed ? 'disabled' : ''}>${armed ? 'Disarm' : 'Arm'}</button>
				<button class="ast-btn ast-btn-ghost" data-act="preview" ${!armed || killed ? 'disabled title="Arm a policy first"' : ''} title="Simulate a cycle; spends nothing">Preview cycle</button>
				<button class="ast-btn ast-btn-ghost" data-act="run" ${!armed || killed ? 'disabled title="Arm a policy first"' : ''} title="Run for real; moves funds from this agent's wallet">Run one cycle</button>
				<button class="ast-btn ast-btn-kill ${killed ? 'active' : ''}" data-act="kill" title="Halt all autonomous spending instantly">${killed ? 'Clear kill switch' : 'Kill switch'}</button>
			</div>
			<div class="ast-msg" id="ast-msg"></div>
		</div>`;
	}

	// ── events ────────────────────────────────────────────────────────────────
	function bind() {
		bodyEl.querySelector('[data-act="retry"]')?.addEventListener('click', () => { state = 'loading'; render(); fetchAll(); });
		const ta = bodyEl.querySelector('#ast-policy');
		if (ta) {
			ta.addEventListener('input', () => {
				disarmRun();   // editing the policy invalidates whatever was about to run
				clearTimeout(compileTimer);
				compileTimer = setTimeout(() => compilePreview(ta.value, bodyEl.querySelector('#ast-sweep')?.value || ''), COMPILE_DEBOUNCE);
			});
		}
		// Every control other than Run itself disarms the pending real run, so a
		// confirmation can never survive a change of intent.
		bodyEl.querySelector('[data-act="save"]')?.addEventListener('click', () => { disarmRun(); onSave(); });
		bodyEl.querySelector('[data-act="arm"]')?.addEventListener('click', () => { disarmRun(); onArm(); });
		bodyEl.querySelector('[data-act="preview"]')?.addEventListener('click', () => { disarmRun(); onPreview(); });
		bodyEl.querySelector('[data-act="run"]')?.addEventListener('click', onRun);
		bodyEl.querySelector('[data-act="kill"]')?.addEventListener('click', () => { disarmRun(); onKill(); });
		bindCoinToggles();
		// compile an initial preview if there's existing policy text to show structure
		const txt = ta?.value?.trim();
		if (txt) compilePreview(txt, bodyEl.querySelector('#ast-sweep')?.value || '');
	}

	function bindCoinToggles() {
		if (!owner) return;
		bodyEl.querySelectorAll('[data-coin-toggle]').forEach((input) => {
			input.addEventListener('change', () => onCoinToggle(input));
		});
	}

	function setMsg(text, kind = '') {
		const el = bodyEl.querySelector('#ast-msg');
		if (!el) return;
		el.textContent = text || '';
		el.className = `ast-msg${kind ? ` ${kind}` : ''}`;
	}

	async function compilePreview(text, sweepDest) {
		const host = bodyEl.querySelector('#ast-preview');
		if (!host) return;
		if (!text.trim()) { host.innerHTML = ''; lastCompiled = null; return; }
		host.innerHTML = `<div class="ast-preview-loading">Compiling…</div>`;
		try {
			const token = await csrfToken();
			const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/autopilot/compile`, {
				method: 'POST', ...auth,
				headers: { 'content-type': 'application/json', 'x-csrf-token': token },
				body: JSON.stringify({ text, sweep_destination: sweepDest || undefined }),
			});
			const j = await res.json().catch(() => ({}));
			if (!res.ok) { host.innerHTML = `<div class="ast-preview-err">${esc(j.message || 'Couldn’t compile that policy.')}</div>`; lastCompiled = null; return; }
			lastCompiled = j.data || j;
			host.innerHTML = previewHtml(lastCompiled);
		} catch {
			host.innerHTML = `<div class="ast-preview-err">Network error compiling policy.</div>`;
			lastCompiled = null;
		}
	}

	function previewHtml(c) {
		const rules = Array.isArray(c.rules) ? c.rules : [];
		const warns = Array.isArray(c.warnings) ? c.warnings : [];
		const contras = Array.isArray(c.contradictions) ? c.contradictions : [];
		return `
			<div class="ast-preview-head">Compiles to ${rules.length} rule${rules.length === 1 ? '' : 's'}${c.buffer_sol != null ? ` · ${esc(fmtSol(c.buffer_sol))} buffer` : ''}</div>
			${rules.map((r) => `<div class="ast-preview-rule"><span>${esc(policyLine(r).glyph)}</span><span>${esc(r.label)}</span></div>`).join('')}
			${warns.map((w) => `<div class="ast-preview-warn">⚠ ${esc(w)}</div>`).join('')}
			${contras.map((w) => `<div class="ast-preview-contra">⛔ ${esc(w)}</div>`).join('')}`;
	}

	async function put(patch, { reload = true } = {}) {
		const token = await csrfToken();
		const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/autopilot?network=${network}`, {
			method: 'PUT', ...auth,
			headers: { 'content-type': 'application/json', 'x-csrf-token': token },
			body: JSON.stringify(patch),
		});
		const j = await res.json().catch(() => ({}));
		if (!res.ok) throw Object.assign(new Error(j.message || j.error_description || 'Save failed'), { status: res.status });
		if (reload) await fetchAll();
		return j.data?.policy || j.policy;
	}

	async function onSave() {
		if (busy) return;
		const ta = bodyEl.querySelector('#ast-policy');
		const sweepEl = bodyEl.querySelector('#ast-sweep');
		const text = (ta?.value || '').trim();
		const sweep = (sweepEl?.value || '').trim();
		if (!text) { setMsg('Write a policy first.', 'err'); return; }
		// Ensure we have a fresh compile reflecting the latest text.
		if (!lastCompiled || lastCompiled.source_text !== text) {
			await compilePreview(text, sweep);
		}
		if (!lastCompiled) { setMsg('Couldn’t compile that policy — adjust the wording.', 'err'); return; }
		if (lastCompiled.contradictions?.length) { setMsg('Resolve the contradiction above before saving.', 'err'); return; }
		busy = true; setMsg('Saving…');
		try {
			await put({
				rules: lastCompiled.rules,
				buffer_sol: lastCompiled.buffer_sol,
				sweep_destination: sweep || null,
				source_text: text,
			});
			setMsg('Policy saved. Arm it to go live.', 'ok');
			toast?.('Treasury policy saved');
		} catch (e) {
			setMsg(e.status === 403 ? 'Only the owner can change this policy.' : (e.message || 'Save failed.'), 'err');
		} finally { busy = false; }
	}

	async function onArm() {
		if (busy) return;
		const armed = data?.policy?.armed === true;
		busy = true; setMsg(armed ? 'Disarming…' : 'Arming…');
		try {
			await put({ armed: !armed });
			setMsg(armed ? 'Autopilot disarmed.' : 'Autopilot armed — it now runs on schedule.', 'ok');
			toast?.(armed ? 'Treasury autopilot disarmed' : 'Treasury autopilot armed');
		} catch (e) {
			setMsg(e.status === 403 ? 'Only the owner can change this policy.' : (e.message || 'Couldn’t update.'), 'err');
		} finally { busy = false; }
	}

	async function onKill() {
		if (busy) return;
		const killed = data?.policy?.kill_switch === true;
		busy = true; setMsg(killed ? 'Clearing kill switch…' : 'Halting all autonomous spending…');
		try {
			await put({ kill_switch: !killed });
			setMsg(killed ? 'Kill switch cleared.' : 'Kill switch engaged — every autonomous spend is halted.', killed ? 'ok' : 'err');
			toast?.(killed ? 'Kill switch cleared' : 'Kill switch engaged — treasury halted');
		} catch (e) {
			setMsg(e.status === 403 ? 'Only the owner can change this.' : (e.message || 'Couldn’t update.'), 'err');
		} finally { busy = false; }
	}

	// One transport for both modes. `dry_run` is always sent explicitly: the server
	// now simulates when the flag is missing, so a real run has to ask for itself.
	async function postCycle({ dryRun }) {
		const token = await csrfToken();
		const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/autopilot/run?network=${network}`, {
			method: 'POST', ...auth,
			headers: { 'content-type': 'application/json', 'x-csrf-token': token },
			body: JSON.stringify({ dry_run: dryRun }),
		});
		const j = await res.json().catch(() => ({}));
		if (!res.ok) throw Object.assign(new Error(j.message || 'Run failed.'), { handled: true });
		return j.data || j;
	}

	async function onPreview() {
		if (busy) return;
		busy = true; setMsg('Simulating a cycle…');
		const btn = bodyEl.querySelector('[data-act="preview"]');
		btn?.classList.add('running');
		try {
			reportPreview(await postCycle({ dryRun: true }));
		} catch (e) {
			setMsg(e.handled ? e.message : 'Network error simulating the cycle.', 'err');
		} finally {
			busy = false;
			btn?.classList.remove('running');
		}
	}

	// Real spend, so it asks twice. First click arms the button and states what is
	// about to happen; second click executes. Any other action disarms it.
	async function onRun() {
		if (busy) return;
		const btn = bodyEl.querySelector('[data-act="run"]');
		if (!runArmed) {
			runArmed = true;
			if (btn) { btn.textContent = 'Confirm real run'; btn.classList.add('ast-btn-warn'); }
			setMsg('This moves real funds from the agent’s wallet. Click again to confirm, or preview first.', 'warn');
			return;
		}
		disarmRun();
		busy = true; setMsg('Running one cycle…');
		btn?.classList.add('running');
		try {
			const result = await postCycle({ dryRun: false });
			reportCycle(result);
			await fetchAll();        // real balance re-read so the number drops
			pushWallFrame();
		} catch (e) {
			setMsg(e.handled ? e.message : 'Network error running the cycle.', 'err');
		} finally {
			busy = false;
			btn?.classList.remove('running');
		}
	}

	function disarmRun() {
		runArmed = false;
		const btn = bodyEl.querySelector('[data-act="run"]');
		if (btn) { btn.textContent = 'Run one cycle'; btn.classList.remove('ast-btn-warn'); }
	}

	// A simulated cycle. Same shape as a real one, but every row comes back as
	// 'would_run' and nothing left the wallet, so it reports intent and never
	// re-reads the balance (there is nothing to re-read).
	function reportPreview(result) {
		if (!result?.ran) { reportCycle(result); return; }
		const would = (result.results || []).filter((r) => r.last_status === 'would_run');
		if (!would.length) {
			setMsg('Preview complete: no rule is due to spend this period. Nothing was moved.', 'ok');
			return;
		}
		const lines = would.map((r) => previewLine(r)).join(' · ');
		setMsg(`Preview: ${lines}. Nothing was moved; use Run one cycle to execute.`, 'ok');
	}

	function reportCycle(result) {
		if (!result?.ran) {
			const reasons = {
				disarmed: 'Arm a policy before running.',
				kill_switch: 'Kill switch is engaged — clear it to run.',
				no_rules: 'No rules to run yet.',
				wallet_frozen: 'Wallet is frozen under Limits & Safety.',
				price_feed_unavailable: 'SOL price feed is down — try again shortly.',
				no_wallet: 'This agent has no wallet yet.',
			};
			setMsg(reasons[result?.reason] || `Nothing ran (${esc(result?.reason || 'idle')}).`, 'err');
			return;
		}
		const acted = (result.results || []).filter((r) => ['ok', 'confirmed', 'alert', 'would_run'].includes(r.last_status));
		const moved = acted.filter((r) => r.signature || ['ok', 'confirmed'].includes(r.last_status) && r.kind !== 'buffer');
		if (moved.length) {
			moved.forEach((r) => toast?.(actionToast(r)));
			setMsg(`Cycle complete — ${moved.length} action${moved.length === 1 ? '' : 's'} executed.`, 'ok');
		} else {
			setMsg('Cycle ran — no rule was due to spend this period.', 'ok');
		}
	}

	async function onCoinToggle(input) {
		const coinEl = input.closest('.ast-coin');
		if (!coinEl) return;
		const mint = coinEl.dataset.mint;
		const netw = coinEl.dataset.network || network;
		const field = input.dataset.coinToggle;
		const value = input.checked;
		input.disabled = true;
		try {
			const token = await csrfToken();
			const res = await fetch('/api/pump/autopilot', {
				method: 'POST', ...auth,
				headers: { 'content-type': 'application/json', 'x-csrf-token': token },
				body: JSON.stringify({ mint, network: netw, [field]: value }),
			});
			if (!res.ok) { input.checked = !value; toast?.('Couldn’t update coin policy'); }
			else { toast?.(`${field === 'buyback_enabled' ? 'Buyback' : 'Distribution'} ${value ? 'on' : 'off'}`); }
		} catch {
			input.checked = !value;
			toast?.('Network error updating coin policy');
		} finally { input.disabled = false; }
	}

	// ── wall frame (offscreen render → push) ─────────────────────────────────
	function pushWallFrame() {
		if (!owner || !data?.runway || destroyed) return;
		const now = Date.now();
		if (now - lastPush < WALL_PUSH_MIN_GAP) return;
		lastPush = now;
		try {
			const canvas = drawCockpitCanvas(data);
			const url = canvas.toDataURL('image/png');
			if (!url || url.length > 780_000) return; // stay under the push DATA_MAX
			fetch('/api/agent-screen-push', {
				method: 'POST', ...auth,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agentId, frame: { data: url, activity: wallActivity(data), type: 'analysis' } }),
			}).catch(() => {});
		} catch { /* canvas unsupported — non-fatal */ }
	}

	function wallActivity(d) {
		const r = d.runway || {};
		const g = runwayGauge(r);
		return `Treasury: ${fmtSol(r.balance_sol)} · runway ${g.label} · ${r.buyback_count || 0} buybacks`;
	}

	function drawCockpitCanvas(d) {
		const W = 1280, H = 720, PAD = 72;
		const c = document.createElement('canvas');
		c.width = W; c.height = H;
		const x = c.getContext('2d');
		const r = d.runway || {};
		const p = d.policy || {};
		const rounded = (rx, ry, w, h, rad) => {
			if (typeof x.roundRect === 'function') { x.beginPath(); x.roundRect(rx, ry, w, h, rad); }
			else { x.beginPath(); x.rect(rx, ry, w, h); }
		};

		// backdrop — the same near-black glass gradient the site uses everywhere
		const bg = x.createLinearGradient(0, 0, W, H);
		bg.addColorStop(0, '#0d0e14'); bg.addColorStop(1, '#060607');
		x.fillStyle = bg; x.fillRect(0, 0, W, H);
		// faint top-centre glow, mirroring .asc-stage's radial highlight
		const glow = x.createRadialGradient(W / 2, -60, 40, W / 2, -60, W * 0.7);
		glow.addColorStop(0, 'rgba(255,255,255,0.05)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
		x.fillStyle = glow; x.fillRect(0, 0, W, 320);

		// ── header: eyebrow + status pill ──
		x.textBaseline = 'alphabetic';
		x.fillStyle = WALL_DIM;
		x.font = `600 22px ${WALL_BODY}`;
		if ('letterSpacing' in x) x.letterSpacing = '2px';
		x.fillText('TREASURY AUTOPILOT', PAD, 96);
		// measureText honours the active letterSpacing, so this width already
		// includes the tracking — don't add it a second time.
		const eyeW = x.measureText('TREASURY AUTOPILOT').width;
		if ('letterSpacing' in x) x.letterSpacing = '0px';
		const killed = p.kill_switch === true;
		const armed = p.armed === true;
		const pill = killed
			? { label: 'KILL SWITCH', fg: WALL_DANGER, bg: 'rgba(248,113,113,0.14)' }
			: armed
				? { label: 'ARMED', fg: WALL_INK, bg: 'rgba(255,255,255,0.14)' }
				: { label: 'DISARMED', fg: WALL_FAINT, bg: 'rgba(255,255,255,0.05)' };
		x.font = `700 15px ${WALL_BODY}`;
		if ('letterSpacing' in x) x.letterSpacing = '1px';
		const pw = x.measureText(pill.label).width + 26;
		const px = PAD + eyeW + 18, py = 80;
		x.fillStyle = pill.bg; rounded(px, py, pw, 24, 12); x.fill();
		x.fillStyle = pill.fg; x.fillText(pill.label, px + 13, py + 17);
		if ('letterSpacing' in x) x.letterSpacing = '0px';

		// ── runway gauge (top-right) ──
		const gx = W - PAD - 96, gy = 176, rad = 88;
		const g = runwayGauge(r);
		const arcTone = g.tone === 'critical' ? WALL_DANGER : g.tone === 'warn' ? WALL_WARN : g.tone === 'unknown' ? 'rgba(255,255,255,0.22)' : WALL_INK;
		x.lineWidth = 15; x.lineCap = 'round';
		x.strokeStyle = 'rgba(255,255,255,0.09)';
		x.beginPath(); x.arc(gx, gy, rad, 0, Math.PI * 2); x.stroke();
		if (g.fraction > 0) {
			x.strokeStyle = arcTone;
			x.beginPath(); x.arc(gx, gy, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * g.fraction); x.stroke();
		}
		x.textAlign = 'center';
		x.fillStyle = arcTone;
		x.font = `700 ${g.label.length > 2 ? 34 : 46}px ${WALL_DISPLAY}`;
		x.fillText(g.label, gx, gy + (g.label.length > 2 ? 8 : 12));
		x.fillStyle = WALL_DIM; x.font = `500 17px ${WALL_BODY}`;
		x.fillText(g.sublabel, gx, gy + 40);
		x.textAlign = 'left';

		// ── balance ──
		x.fillStyle = WALL_INK;
		x.font = `800 92px ${WALL_DISPLAY}`;
		x.fillText(fmtSol(r.balance_sol), PAD, 268);
		x.fillStyle = WALL_DIM;
		x.font = `500 30px ${WALL_BODY}`;
		const usd = r.balance_usd != null ? fmtUsd(r.balance_usd) : '';
		x.fillText(`${usd}${usd ? '   ·   ' : ''}$THREE ${fmtCompact(r.three_accumulated)}`, PAD, 316);

		// ── divider ──
		x.strokeStyle = 'rgba(255,255,255,0.08)'; x.lineWidth = 1;
		x.beginPath(); x.moveTo(PAD, 364); x.lineTo(W - PAD, 364); x.stroke();

		// ── stat strip (5 columns with hairline separators) ──
		const stats = [
			['Income 30d', fmtUsd(r.income_usd, { compact: true }), WALL_INK],
			['Burn 30d', fmtUsd(r.cost_usd, { compact: true }), WALL_INK],
			['Net', `${r.net_usd >= 0 ? '+' : ''}${fmtUsd(r.net_usd, { compact: true })}`, r.net_usd >= 0 ? WALL_SUCCESS : WALL_DANGER],
			['Buybacks', String(r.buyback_count || 0), WALL_INK],
			['Swept', fmtSol(r.swept_sol || 0), WALL_INK],
		];
		const colW = (W - 2 * PAD) / stats.length;
		const sy = 420;
		stats.forEach(([k, v, tone], i) => {
			const cx = PAD + colW * i;
			if (i > 0) {
				x.strokeStyle = 'rgba(255,255,255,0.06)'; x.lineWidth = 1;
				x.beginPath(); x.moveTo(cx - 18, sy - 22); x.lineTo(cx - 18, sy + 30); x.stroke();
			}
			x.fillStyle = WALL_FAINT; x.font = `600 17px ${WALL_BODY}`;
			if ('letterSpacing' in x) x.letterSpacing = '0.5px';
			x.fillText(k.toUpperCase(), cx, sy);
			if ('letterSpacing' in x) x.letterSpacing = '0px';
			x.fillStyle = tone; x.font = `700 34px ${WALL_DISPLAY}`;
			x.fillText(v, cx, sy + 42);
		});

		// ── policy rules ──
		x.fillStyle = WALL_FAINT; x.font = `600 17px ${WALL_BODY}`;
		if ('letterSpacing' in x) x.letterSpacing = '0.5px';
		x.fillText('POLICY RULES', PAD, 528);
		if ('letterSpacing' in x) x.letterSpacing = '0px';
		const rules = (p.rules || []).slice(0, 3);
		let ry = 566;
		for (const rule of rules) {
			const l = policyLine(rule);
			x.fillStyle = l.state === 'armed' ? 'rgba(255,255,255,0.9)' : WALL_FAINT;
			x.font = `500 25px ${WALL_BODY}`;
			const text = l.text.length > 74 ? `${l.text.slice(0, 73)}…` : l.text;
			x.fillText(`${l.glyph}  ${text}`, PAD, ry);
			ry += 40;
		}
		if (!rules.length) {
			x.fillStyle = 'rgba(255,255,255,0.3)'; x.font = `400 24px ${WALL_BODY}`;
			x.fillText('No rules armed — idle treasury.', PAD, ry);
		}

		// ── footer wordmark ──
		x.fillStyle = 'rgba(255,255,255,0.28)'; x.font = `600 19px ${WALL_BODY}`;
		x.fillText('three.ws', PAD, H - 40);
		x.fillStyle = 'rgba(255,255,255,0.16)';
		x.fillText(' · $THREE', PAD + x.measureText('three.ws').width, H - 40);
		return c;
	}

	// ── live forwarding from the host SSE ─────────────────────────────────────
	function observeLog(entries) {
		if (!Array.isArray(entries) || !entries.length) return;
		const hit = entries.some((e) => isTreasuryActivity(e?.activity) || e?.type === 'trade');
		if (!hit) return;
		// A treasury movement just landed — re-read the real balance so it ticks,
		// debounced so a burst of log lines triggers a single refresh.
		clearTimeout(softTimer);
		softTimer = setTimeout(() => fetchAll({ soft: true }), 800);
	}

	// ── lifecycle ─────────────────────────────────────────────────────────────
	function start() {
		render();              // skeleton
		fetchAll();
		// Once the brand fonts decode, re-push so the wall frame stops falling back
		// to system-ui — bypass the min-gap once for an immediate on-brand frame.
		ensureWallFonts().then(() => {
			if (destroyed || !owner || !data?.runway) return;
			lastPush = 0;
			pushWallFrame();
		});
		pollTimer = setInterval(() => {
			if (destroyed || document.hidden) return;
			if (owner && (state === 'populated')) fetchAll({ soft: true });
		}, POLL_MS);
	}

	function destroy() {
		destroyed = true;
		clearInterval(pollTimer);
		clearTimeout(compileTimer);
		clearTimeout(softTimer);
	}

	start();
	return { observeLog, refresh: () => fetchAll(), destroy };
}
