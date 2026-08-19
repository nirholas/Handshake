// Memory-grounded Autopilot — the control surface (Living Agents · Task 08).
//
// Self-contained module mounted in two places:
//   • the Autopilot tab of /agents/{id}/edit (mountAutopilotMind)
//   • the standalone /autopilot-activity receipts page (renderReceipt is reused)
//
// It is the legible face of explainable autonomy: the owner grants scoped
// capabilities, the agent proposes real actions grounded in memory (each showing
// its receipt), and every executed action links back to the memory that
// motivated it. Wallet actions move real SOL and are always confirmation-gated.
//
// Kept in its own module so it can evolve without touching the heavily-shared
// agent-edit.js. All API calls go through apiFetch (CSRF-safe).

import { apiFetch } from './api.js';
import { agentBus } from './agents/agent-bus.js';

const API = '/api/autopilot';

const KIND_META = {
	create_alert: { label: 'Alert', icon: '🔔', reversible: true, blurb: 'Watches a token and notifies you.' },
	briefing: { label: 'Briefing', icon: '📋', reversible: true, blurb: 'Authors a memory-grounded digest.' },
	wallet_transfer: { label: 'Transfer', icon: '💸', reversible: false, blurb: 'Sends SOL from the agent wallet. Never sells or sends $THREE.' },
};

const esc = (s) =>
	String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);

function timeAgo(iso) {
	const ms = Date.now() - new Date(iso).getTime();
	if (!Number.isFinite(ms)) return '';
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

let _stylesInjected = false;
function injectStyles() {
	if (_stylesInjected || typeof document === 'undefined') return;
	_stylesInjected = true;
	const css = `
	/* Tokens live on :root, not only on .apm, because the pieces this module
	   exports are mounted outside an .apm container too: receiptRow() renders
	   into the /autopilot-activity ledger and the chip toast is appended to
	   <body>. Scoped to .apm alone, every var() below resolved to nothing there
	   and the borders, backgrounds and accents silently vanished. */
	:root, .apm { --apm-line: var(--hairline, #1c1c1c); --apm-s1: var(--surface-1, #111); --apm-s2: var(--surface-2, #181818);
		--apm-txt: var(--text, #f6f6f6); --apm-t2: var(--text-2, #a8a8a8); --apm-t3: var(--text-3, #6a6a6a);
		--apm-accent: var(--mint, #78c88c); --apm-red: var(--red, #ef4444); --apm-amber: var(--amber, #f59e0b); }
	.apm { display: flex; flex-direction: column; gap: 1.25rem; }
	.apm-card { border: 1px solid var(--apm-line); border-radius: 12px; background: var(--apm-s1); padding: 1.1rem 1.15rem; }
	.apm-h { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.5rem; }
	.apm-h h3 { margin: 0; font-size: 0.95rem; letter-spacing: -0.01em; }
	.apm-sub { color: var(--apm-t2); font-size: 0.82rem; margin: 0.15rem 0 0; }
	.apm-trust { display: flex; align-items: center; gap: 0.85rem; }
	.apm-trust-meter { flex: 1; height: 7px; border-radius: 99px; background: var(--apm-s2); overflow: hidden; }
	.apm-trust-fill { height: 100%; background: linear-gradient(90deg, var(--apm-accent), #4f9dde); transition: width .5s ease; }
	.apm-badge { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.2rem 0.55rem; border-radius: 99px;
		font-size: 0.72rem; font-weight: 600; border: 1px solid var(--apm-line); color: var(--apm-t2); white-space: nowrap; }
	.apm-badge.sandbox { color: var(--apm-amber); border-color: color-mix(in srgb, var(--apm-amber) 40%, transparent); }
	.apm-badge.trusted { color: var(--apm-accent); border-color: color-mix(in srgb, var(--apm-accent) 40%, transparent); }
	.apm-badge.autonomous { color: #4f9dde; border-color: color-mix(in srgb, #4f9dde 40%, transparent); }
	.apm-scopes { display: flex; flex-direction: column; gap: 0.55rem; }
	.apm-scope { display: flex; align-items: flex-start; gap: 0.7rem; padding: 0.55rem 0; border-top: 1px solid var(--apm-line); }
	.apm-scope:first-of-type { border-top: none; }
	.apm-scope-body { flex: 1; min-width: 0; }
	.apm-scope-name { font-size: 0.86rem; font-weight: 600; }
	.apm-scope-desc { color: var(--apm-t3); font-size: 0.78rem; margin-top: 0.1rem; }
	.apm-scope-extra { margin-top: 0.5rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
	.apm-switch { position: relative; width: 38px; height: 22px; flex-shrink: 0; cursor: pointer; }
	.apm-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
	.apm-switch-track { position: absolute; inset: 0; border-radius: 99px; background: var(--apm-s2); border: 1px solid var(--apm-line); transition: background .15s; }
	.apm-switch-track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--apm-t2); transition: transform .15s, background .15s; }
	.apm-switch input:checked + .apm-switch-track { background: color-mix(in srgb, var(--apm-accent) 35%, transparent); }
	.apm-switch input:checked + .apm-switch-track::after { transform: translateX(16px); background: var(--apm-accent); }
	.apm-switch input:focus-visible + .apm-switch-track { outline: 2px solid var(--apm-accent); outline-offset: 2px; }
	.apm-switch input:disabled + .apm-switch-track { opacity: 0.45; cursor: not-allowed; }
	.apm-num { width: 110px; padding: 0.35rem 0.5rem; border-radius: 8px; border: 1px solid var(--apm-line); background: var(--apm-s2); color: var(--apm-txt); font: inherit; font-size: 0.82rem; }
	.apm-btn { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.4rem 0.7rem; border-radius: 8px; border: 1px solid var(--apm-line);
		background: var(--apm-s2); color: var(--apm-txt); font: inherit; font-size: 0.8rem; font-weight: 600; cursor: pointer; transition: border-color .12s, background .12s, transform .06s; }
	.apm-btn:hover { border-color: var(--apm-t3); }
	.apm-btn:active { transform: translateY(1px); }
	.apm-btn:focus-visible { outline: 2px solid var(--apm-accent); outline-offset: 2px; }
	.apm-btn.primary { background: var(--apm-accent); color: #07140c; border-color: var(--apm-accent); }
	.apm-btn.danger:hover { border-color: var(--apm-red); color: var(--apm-red); }
	.apm-btn[disabled] { opacity: 0.55; cursor: not-allowed; }
	.apm-props { display: flex; flex-direction: column; gap: 0.85rem; }
	.apm-prop { border: 1px solid var(--apm-line); border-radius: 11px; background: var(--apm-s1); padding: 0.9rem 1rem; transition: border-color .15s; }
	.apm-prop:hover { border-color: var(--apm-t3); }
	.apm-prop-top { display: flex; align-items: flex-start; gap: 0.6rem; }
	.apm-prop-kind { font-size: 1.05rem; line-height: 1.4; }
	.apm-prop-title { font-weight: 600; font-size: 0.9rem; flex: 1; min-width: 0; }
	.apm-prop-conf { font-size: 0.72rem; color: var(--apm-t3); white-space: nowrap; }
	.apm-prop-why { color: var(--apm-t2); font-size: 0.82rem; margin: 0.5rem 0; line-height: 1.5; }
	.apm-prop-why b { color: var(--apm-txt); font-weight: 600; }
	.apm-sources { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.5rem 0; }
	.apm-source { display: inline-flex; align-items: center; gap: 0.3rem; max-width: 100%; padding: 0.22rem 0.5rem; border-radius: 99px;
		background: var(--apm-s2); border: 1px solid var(--apm-line); font-size: 0.72rem; color: var(--apm-t2); text-decoration: none; }
	.apm-source:hover { border-color: var(--apm-accent); color: var(--apm-txt); }
	.apm-source:focus-visible { outline: 2px solid var(--apm-accent); outline-offset: 2px; }
	.apm-source .apm-source-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
	.apm-source.forgotten { opacity: 0.5; }
	.apm-prop-actions { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.7rem; }
	.apm-dryrun { margin-top: 0.65rem; border-top: 1px dashed var(--apm-line); padding-top: 0.6rem; font-size: 0.78rem; }
	.apm-check { display: flex; align-items: flex-start; gap: 0.45rem; padding: 0.18rem 0; color: var(--apm-t2); }
	.apm-check .ck { font-weight: 700; }
	.apm-check.ok .ck { color: var(--apm-accent); }
	.apm-check.no .ck { color: var(--apm-red); }
	.apm-willdo { color: var(--apm-txt); margin-bottom: 0.4rem; font-weight: 500; }
	.apm-empty { text-align: center; color: var(--apm-t3); padding: 1.5rem 0.5rem; }
	.apm-empty .em-ico { font-size: 1.6rem; opacity: 0.7; }
	.apm-empty p { margin: 0.5rem 0 0; font-size: 0.85rem; }
	.apm-status { font-size: 0.78rem; color: var(--apm-t3); min-height: 1.1em; }
	.apm-status.err { color: var(--apm-red); }
	.apm-status.ok { color: var(--apm-accent); }
	.apm-skel { height: 70px; border-radius: 11px; background: linear-gradient(90deg, var(--apm-s1) 0%, var(--apm-s2) 50%, var(--apm-s1) 100%);
		background-size: 200% 100%; animation: apm-shimmer 1.3s infinite; border: 1px solid var(--apm-line); }
	@keyframes apm-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
	@media (prefers-reduced-motion: reduce) { .apm-skel { animation: none; } .apm-trust-fill { transition: none; } }
	.apm-receipt { display: flex; gap: 0.6rem; align-items: flex-start; padding: 0.6rem 0; border-top: 1px solid var(--apm-line); }
	.apm-receipt:first-child { border-top: none; }
	.apm-receipt-ico { font-size: 1rem; }
	.apm-receipt-body { flex: 1; min-width: 0; }
	.apm-receipt-line { font-size: 0.83rem; }
	.apm-receipt-meta { font-size: 0.72rem; color: var(--apm-t3); margin-top: 0.2rem; display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
	.apm-signed { color: var(--apm-accent); }
	.apm-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 9000; padding: 1rem; }
	.apm-modal { background: var(--apm-s1); border: 1px solid var(--apm-line); border-radius: 14px; max-width: 420px; width: 100%; padding: 1.4rem; }
	.apm-modal h4 { margin: 0 0 0.5rem; font-size: 1rem; }
	.apm-modal p { color: var(--apm-t2); font-size: 0.85rem; line-height: 1.5; margin: 0 0 0.5rem; }
	.apm-modal-actions { display: flex; gap: 0.55rem; justify-content: flex-end; margin-top: 1rem; }
	.apm-chip-toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%) translateY(20px); opacity: 0;
		background: var(--apm-s2); border: 1px solid var(--apm-accent); color: var(--apm-txt); padding: 0.6rem 0.95rem; border-radius: 99px;
		font-size: 0.82rem; z-index: 9100; pointer-events: none; transition: opacity .25s, transform .25s; display: flex; align-items: center; gap: 0.45rem; max-width: 90vw; }
	.apm-chip-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
	@media (prefers-reduced-motion: reduce) { .apm-chip-toast { transition: opacity .1s; } }
	`;
	const style = document.createElement('style');
	style.id = 'apm-styles';
	style.textContent = css;
	document.head.appendChild(style);
}

// ── Receipt chip (the "I did X because Y" transparency cue) ───────────────────

let _chipTimer;
export function showReceiptChip(text, { icon = '✓' } = {}) {
	if (typeof document === 'undefined') return;
	injectStyles();
	let el = document.getElementById('apm-receipt-chip');
	if (!el) {
		el = document.createElement('div');
		el.id = 'apm-receipt-chip';
		el.className = 'apm-chip-toast';
		el.setAttribute('role', 'status');
		el.setAttribute('aria-live', 'polite');
		document.body.appendChild(el);
	}
	el.innerHTML = `<span>${esc(icon)}</span><span>${esc(text)}</span>`;
	requestAnimationFrame(() => el.classList.add('show'));
	clearTimeout(_chipTimer);
	_chipTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

// Surface a receipt chip whenever ANY surface emits action:taken on the bus —
// this is the cross-feature transparency cue the Companion (Task 02) also taps.
let _busWired = false;
function wireBusChip() {
	if (_busWired) return;
	_busWired = true;
	agentBus.on('action:taken', (p) => {
		if (p?.summary) showReceiptChip(p.summary, { icon: KIND_META[p.kind]?.icon || '✓' });
	});
}

// ── Source-memory chip (provenance, links into the Knowledge tab) ─────────────

function sourceChip(agentId, src) {
	if (src.forgotten) {
		return `<span class="apm-source forgotten" title="This memory was forgotten">🜸 <span class="apm-source-txt">memory ${esc(String(src.id).slice(0, 8))} (forgotten)</span></span>`;
	}
	const href = `/agents/${encodeURIComponent(agentId)}/edit?tab=knowledge#mem-${encodeURIComponent(src.id)}`;
	return `<a class="apm-source" href="${href}" title="${esc(src.content || '')}">🧠 <span class="apm-source-txt">${esc((src.content || 'memory').slice(0, 80))}</span></a>`;
}

// ── Main mount ────────────────────────────────────────────────────────────────

/**
 * Mount the full autopilot control surface into `container` for one agent.
 * Returns a teardown function.
 */
export function mountAutopilotMind(container, { agentId }) {
	if (!container || !agentId) return () => {};
	injectStyles();
	wireBusChip();

	const state = { config: null, trust: null, proposals: [], busy: false };

	container.innerHTML = `
		<div class="apm">
			<div class="apm-card" id="apm-trust-card">
				<div class="apm-h"><h3>Trust</h3><span class="apm-badge" id="apm-trust-badge">—</span></div>
				<p class="apm-sub" id="apm-trust-blurb">How much your agent has earned the right to act on its own.</p>
				<div class="apm-trust" style="margin-top:.7rem">
					<div class="apm-trust-meter"><div class="apm-trust-fill" id="apm-trust-fill" style="width:0%"></div></div>
					<span class="apm-prop-conf" id="apm-trust-stats"></span>
				</div>
			</div>

			<div class="apm-card">
				<div class="apm-h">
					<div><h3>What your agent may do</h3><p class="apm-sub">Grant only what you trust. Everything is enforced server-side; nothing fires without permission.</p></div>
					<label class="apm-switch" title="Master autopilot switch">
						<input type="checkbox" id="apm-enabled"><span class="apm-switch-track"></span>
					</label>
				</div>
				<div class="apm-scopes" id="apm-scopes"></div>
				<div class="apm-status" id="apm-config-status" aria-live="polite"></div>
			</div>

			<div class="apm-card">
				<div class="apm-h">
					<div><h3>Proposals</h3><p class="apm-sub">Grounded in your agent's memory and reflections. Each shows its receipt.</p></div>
					<button class="apm-btn primary" id="apm-generate">✨ Generate</button>
				</div>
				<div class="apm-status" id="apm-gen-status" aria-live="polite"></div>
				<div class="apm-props" id="apm-props"></div>
			</div>

			<div class="apm-card">
				<div class="apm-h"><h3>Recent activity</h3><a class="apm-btn" id="apm-activity-link" href="/autopilot-activity?agent=${encodeURIComponent(agentId)}">Full log →</a></div>
				<div id="apm-receipts"><div class="apm-skel"></div></div>
			</div>
		</div>`;

	const $ = (id) => container.querySelector('#' + id);

	// ── Scope controls ──────────────────────────────────────────────────────
	function renderScopes() {
		const c = state.config;
		$('apm-enabled').checked = c.enabled;
		const scopeDefs = [
			{ key: 'create_alert', name: '🔔 Create alerts', desc: 'Set up real price / graduation / whale alerts on $THREE and tokens it knows about.', auto: true },
			{ key: 'briefing', name: '📋 Author briefings', desc: 'Write memory-grounded briefings and deliver them to your inbox.', auto: true },
			{ key: 'wallet_transfer', name: '💸 Spend SOL', desc: 'Send SOL from the agent\'s custodial wallet. Always asks before each transfer. Never sells or sends $THREE.', auto: false },
		];
		$('apm-scopes').innerHTML = scopeDefs.map((s) => {
			const on = c.scopes[s.key];
			const autoOn = c.auto_execute?.[s.key];
			let extra = '';
			if (s.key === 'wallet_transfer') {
				extra = `<div class="apm-scope-extra"><label class="apm-prop-conf" for="apm-daily">Daily limit</label>
					<input class="apm-num" type="number" min="0" step="0.1" id="apm-daily" value="${esc(c.daily_spend_sol)}" ${on ? '' : 'disabled'}>
					<span class="apm-prop-conf">SOL / day</span></div>`;
			} else if (s.auto) {
				extra = `<div class="apm-scope-extra">
					<label class="apm-switch" title="Auto-run within scope (reversible only)"><input type="checkbox" data-auto="${s.key}" ${autoOn ? 'checked' : ''} ${on ? '' : 'disabled'}><span class="apm-switch-track"></span></label>
					<span class="apm-prop-conf">Auto-run without asking (you can undo)</span></div>`;
			}
			return `<div class="apm-scope">
				<div class="apm-scope-body">
					<div class="apm-scope-name">${s.name}</div>
					<div class="apm-scope-desc">${esc(s.desc)}</div>
					${extra}
				</div>
				<label class="apm-switch"><input type="checkbox" data-scope="${s.key}" ${on ? 'checked' : ''}><span class="apm-switch-track"></span></label>
			</div>`;
		}).join('');

		$('apm-scopes').querySelectorAll('[data-scope]').forEach((el) =>
			el.addEventListener('change', () => saveConfig({ scopes: { [el.dataset.scope]: el.checked } })));
		$('apm-scopes').querySelectorAll('[data-auto]').forEach((el) =>
			el.addEventListener('change', () => saveConfig({ auto_execute: { [el.dataset.auto]: el.checked } })));
		const daily = $('apm-daily');
		if (daily) {
			let t;
			daily.addEventListener('input', () => {
				clearTimeout(t);
				t = setTimeout(() => saveConfig({ daily_spend_sol: Number(daily.value) || 0 }), 500);
			});
		}
	}

	$('apm-enabled').addEventListener('change', (e) => saveConfig({ enabled: e.target.checked }));

	async function saveConfig(patch) {
		const status = $('apm-config-status');
		status.textContent = 'Saving…';
		status.className = 'apm-status';
		try {
			const r = await apiFetch(`${API}/config`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
				body: JSON.stringify({ agentId, ...patch }),
			});
			const j = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
			state.config = j.config;
			renderScopes();
			status.textContent = 'Saved.';
			status.className = 'apm-status ok';
			setTimeout(() => { if (status.textContent === 'Saved.') status.textContent = ''; }, 1800);
		} catch (err) {
			status.textContent = `Couldn't save: ${err.message}`;
			status.className = 'apm-status err';
		}
	}

	// ── Trust ────────────────────────────────────────────────────────────────
	function renderTrust() {
		const t = state.trust;
		if (!t) return;
		const badge = $('apm-trust-badge');
		badge.textContent = t.label;
		badge.className = `apm-badge ${t.level}`;
		$('apm-trust-blurb').textContent = t.blurb;
		const pct = t.next ? Math.min(100, Math.round((t.score / Math.max(1, t.next.at)) * 100)) : 100;
		$('apm-trust-fill').style.width = `${pct}%`;
		const s = t.stats || {};
		$('apm-trust-stats').textContent = t.next
			? `${s.executed || 0} done · ${t.next.remaining} to ${t.next.label}`
			: `${s.executed || 0} actions · ${s.reliability || 0}% kept`;
	}

	// ── Proposals ──────────────────────────────────────────────────────────────
	function renderProposals() {
		const wrap = $('apm-props');
		const pending = state.proposals.filter((p) => p.status === 'pending');
		if (!pending.length) {
			wrap.innerHTML = `<div class="apm-empty"><div class="em-ico">🧭</div><p>No proposals yet. Hit <b>Generate</b> — your agent reads its high-salience memories and recent reflections, then suggests real actions you can approve.</p></div>`;
			return;
		}
		wrap.innerHTML = pending.map((p) => proposalCard(p)).join('');
		pending.forEach((p) => wireProposal(p.id));
	}

	function proposalCard(p) {
		const km = KIND_META[p.kind] || { icon: '•', label: p.kind };
		const sources = (p.sources || []).map((s) => sourceChip(agentId, s)).join('');
		const conf = p.confidence != null ? `${Math.round(p.confidence * 100)}% sure` : '';
		return `
		<div class="apm-prop" data-id="${esc(p.id)}">
			<div class="apm-prop-top">
				<span class="apm-prop-kind" title="${esc(km.label)}">${km.icon}</span>
				<span class="apm-prop-title">${esc(p.title)}</span>
				<span class="apm-prop-conf">${esc(conf)}</span>
			</div>
			<p class="apm-prop-why"><b>Why:</b> ${esc(p.rationale)}${p.sourceReflectionId ? ' <span class="apm-prop-conf">(from a reflection)</span>' : ''}</p>
			${sources ? `<div class="apm-sources">${sources}</div>` : ''}
			<div class="apm-dryrun" data-dryrun hidden></div>
			<div class="apm-prop-actions">
				<button class="apm-btn primary" data-act="execute">${km.reversible ? 'Approve' : 'Approve & send'}</button>
				<button class="apm-btn" data-act="dryrun">Preview</button>
				<button class="apm-btn danger" data-act="dismiss">Dismiss</button>
			</div>
			<div class="apm-status" data-prop-status aria-live="polite"></div>
		</div>`;
	}

	function wireProposal(id) {
		const card = container.querySelector(`.apm-prop[data-id="${CSS.escape(id)}"]`);
		if (!card) return;
		const p = state.proposals.find((x) => x.id === id);
		const status = card.querySelector('[data-prop-status]');
		const setStatus = (msg, cls = '') => { status.textContent = msg || ''; status.className = `apm-status ${cls}`; };

		card.querySelector('[data-act="dryrun"]').addEventListener('click', async (e) => {
			const box = card.querySelector('[data-dryrun]');
			if (!box.hidden) { box.hidden = true; e.target.textContent = 'Preview'; return; }
			e.target.disabled = true;
			box.hidden = false;
			box.innerHTML = '<div class="apm-skel" style="height:48px"></div>';
			try {
				const preview = await act('dryrun', { proposalId: id });
				box.innerHTML = renderDryRun(preview.preview);
				e.target.textContent = 'Hide preview';
			} catch (err) {
				box.innerHTML = `<div class="apm-check no"><span class="ck">✕</span>${esc(err.message)}</div>`;
			} finally { e.target.disabled = false; }
		});

		card.querySelector('[data-act="dismiss"]').addEventListener('click', async () => {
			setStatus('Dismissing…');
			try {
				const j = await act('dismiss', { proposalId: id });
				applyResult(j);
				setStatus('');
			} catch (err) { setStatus(err.message, 'err'); }
		});

		card.querySelector('[data-act="execute"]').addEventListener('click', async () => {
			if (p.kind === 'wallet_transfer') {
				const ok = await confirmTransfer(p);
				if (!ok) return;
				return runExecute(id, setStatus, true);
			}
			return runExecute(id, setStatus, false);
		});
	}

	async function runExecute(id, setStatus, confirm) {
		setStatus('Working…');
		try {
			const j = await act('execute', { proposalId: id, confirm });
			applyResult(j);
			const p = j.proposal;
			// Emit the cross-surface event (also fires the receipt chip via the bus).
			agentBus.emit('action:taken', {
				agentId,
				actionId: j.action?.id != null ? String(j.action.id) : undefined,
				kind: p.kind,
				summary: j.receipt || 'Action taken.',
				motivatedBy: p.sourceMemoryIds || [],
				ts: j.action?.ts || new Date().toISOString(),
			});
			loadReceipts();
		} catch (err) {
			if (err.code === 'confirmation_required') {
				setStatus('Needs confirmation.', 'err');
			} else {
				setStatus(err.message, 'err');
			}
		}
	}

	function applyResult(j) {
		if (j.trust) { state.trust = j.trust; renderTrust(); }
		if (j.proposal) {
			const i = state.proposals.findIndex((x) => x.id === j.proposal.id);
			if (i >= 0) state.proposals[i] = { ...state.proposals[i], ...j.proposal };
		}
		renderProposals();
	}

	function renderDryRun(preview) {
		const checks = (preview.checks || []).map((c) =>
			`<div class="apm-check ${c.ok ? 'ok' : 'no'}"><span class="ck">${c.ok ? '✓' : '✕'}</span><span>${esc(c.label)} — <span class="apm-prop-conf">${esc(c.detail)}</span></span></div>`).join('');
		return `<div class="apm-willdo">${esc(preview.willDo)}</div>${checks}`;
	}

	// ── Confirm modal (irreversible SOL transfer) ──────────────────────────
	function confirmTransfer(p) {
		return new Promise((resolve) => {
			const back = document.createElement('div');
			back.className = 'apm-modal-backdrop';
			back.innerHTML = `
				<div class="apm-modal" role="dialog" aria-modal="true" aria-labelledby="apm-confirm-h">
					<h4 id="apm-confirm-h">Confirm SOL transfer</h4>
					<p>Your agent will send <b>${esc(p.params.amount_sol)} SOL</b> to <b>${esc(String(p.params.recipient).slice(0, 10))}…${esc(String(p.params.recipient).slice(-6))}</b>.</p>
					<p>This is real and <b>cannot be undone</b>. ${p.params.reason ? `Reason: ${esc(p.params.reason)}` : ''}</p>
					<div class="apm-modal-actions">
						<button class="apm-btn" data-c="cancel">Cancel</button>
						<button class="apm-btn primary" data-c="ok">Send ${esc(p.params.amount_sol)} SOL</button>
					</div>
				</div>`;
			document.body.appendChild(back);
			const close = (val) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
			const onKey = (e) => { if (e.key === 'Escape') close(false); };
			document.addEventListener('keydown', onKey);
			back.addEventListener('click', (e) => { if (e.target === back) close(false); });
			back.querySelector('[data-c="cancel"]').addEventListener('click', () => close(false));
			back.querySelector('[data-c="ok"]').addEventListener('click', () => close(true));
			back.querySelector('[data-c="ok"]').focus();
		});
	}

	// ── Generate ───────────────────────────────────────────────────────────────
	$('apm-generate').addEventListener('click', async () => {
		const btn = $('apm-generate');
		const status = $('apm-gen-status');
		btn.disabled = true;
		status.textContent = 'Reading memories & reflecting…';
		status.className = 'apm-status';
		try {
			// Kick a (debounced) reflection first so dream-sourced proposals are fresh,
			// then generate. Reflection failure is non-fatal — memory synthesis still runs.
			await apiFetch(`/api/agent/reflect`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
				body: JSON.stringify({ agentId }),
			}).catch(() => {});
			const j = await act('generate', {});
			if (j.trust) { state.trust = j.trust; renderTrust(); }
			// Surface anything the agent auto-ran (scoped, reversible) as live receipts.
			for (const a of j.autoRan || []) {
				agentBus.emit('action:taken', {
					agentId, actionId: a.actionId || undefined, kind: a.kind,
					summary: a.receipt || 'Action taken.', ts: a.ts || new Date().toISOString(),
				});
			}
			if (j.autoRan?.length) loadReceipts();
			if (j.created?.length) {
				// Prepend new proposals (auto-ran ones arrive already 'executed' and
				// drop out of the pending view).
				state.proposals = [...j.created, ...state.proposals.filter((p) => !j.created.some((c) => c.id === p.id))];
				renderProposals();
				const pendingCount = j.created.filter((c) => c.status === 'pending').length;
				const ranCount = j.autoRan?.length || 0;
				status.textContent = ranCount
					? `${ranCount} action${ranCount === 1 ? '' : 's'} taken automatically · ${pendingCount} awaiting you (${j.source}).`
					: `${j.created.length} new proposal${j.created.length === 1 ? '' : 's'} (${j.source}).`;
				status.className = 'apm-status ok';
			} else {
				status.textContent = `Nothing new to propose right now — your agent needs more high-salience memories to act on.`;
				status.className = 'apm-status';
			}
		} catch (err) {
			status.textContent = `Couldn't generate: ${err.message}`;
			status.className = 'apm-status err';
		} finally { btn.disabled = false; }
	});

	// ── Recent receipts ──────────────────────────────────────────────────────
	async function loadReceipts() {
		const box = $('apm-receipts');
		try {
			const r = await apiFetch(`${API}/activity?agentId=${agentId}&limit=5`, { credentials: 'include' });
			const j = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
			const receipts = j.receipts || [];
			if (!receipts.length) {
				box.innerHTML = `<div class="apm-empty"><p>No actions taken yet. Approve a proposal and its signed receipt shows up here.</p></div>`;
				return;
			}
			box.innerHTML = receipts.map((rc) => receiptRow(rc, agentId, { undo: true })).join('');
			wireReceiptUndo(box);
		} catch (err) {
			box.innerHTML = `<div class="apm-status err">Couldn't load activity: ${esc(err.message)}</div>`;
		}
	}

	function wireReceiptUndo(scope) {
		scope.querySelectorAll('[data-undo]').forEach((btn) =>
			btn.addEventListener('click', async () => {
				const pid = btn.dataset.undo;
				btn.disabled = true;
				btn.textContent = 'Undoing…';
				try {
					const j = await act('undo', { proposalId: pid });
					if (j.trust) { state.trust = j.trust; renderTrust(); }
					showReceiptChip('Undone — your agent will be more cautious.', { icon: '↩' });
					loadReceipts();
					// Reflect the boundary feedback into the memory bus.
					agentBus.emit('memory:added', { agentId, ts: new Date().toISOString(), source: 'autopilot_undo' });
				} catch (err) {
					btn.disabled = false;
					btn.textContent = 'Undo';
					showReceiptChip(err.message, { icon: '⚠' });
				}
			}));
	}

	// ── API helper ───────────────────────────────────────────────────────────
	async function act(action, body) {
		const r = await apiFetch(`${API}/proposals`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
			body: JSON.stringify({ agentId, action, ...body }),
		});
		const j = await r.json().catch(() => ({}));
		if (!r.ok) {
			const e = new Error(j.error_description || j.error || `HTTP ${r.status}`);
			e.code = j.error;
			throw e;
		}
		return j;
	}

	// ── Initial load ───────────────────────────────────────────────────────────
	(async function init() {
		try {
			const r = await apiFetch(`${API}/proposals?agentId=${agentId}`, { credentials: 'include' });
			const j = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
			state.config = j.config;
			state.trust = j.trust;
			state.proposals = j.proposals || [];
			renderScopes();
			renderTrust();
			renderProposals();
		} catch (err) {
			$('apm-props').innerHTML = `<div class="apm-status err">Couldn't load autopilot: ${esc(err.message)} <button class="apm-btn" id="apm-retry">Retry</button></div>`;
			container.querySelector('#apm-retry')?.addEventListener('click', () => mountAutopilotMind(container, { agentId }));
		}
		loadReceipts();
	})();

	return () => { /* nothing persistent to tear down beyond the DOM */ };
}

// ── Shared receipt row (used by the tab + the standalone Activity page) ───────

export function receiptRow(rc, agentId, { undo = false, showAgent = false } = {}) {
	// Surfaces that reuse the row without mounting the full panel (the
	// /autopilot-activity ledger) get the stylesheet from here.
	injectStyles();
	const km = KIND_META[rc.kind] || { icon: '•', label: rc.kind };
	const result = rc.result || {};
	let line = '';
	if (rc.kind === 'alert_created') line = `Created a <b>${esc(String(result.rule_kind || 'alert').replace('_', ' '))}</b> alert${result.target_mint ? ` on ${esc(result.target_mint === 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' ? '$THREE' : String(result.target_mint).slice(0, 6) + '…')}` : ''}.`;
	else if (rc.kind === 'briefing_authored') line = `Authored a briefing${result.body_preview ? `: "${esc(String(result.body_preview).slice(0, 90))}…"` : ''}.`;
	else if (rc.kind === 'wallet_transfer') line = `Sent <b>${esc(result.amount_sol)} SOL</b>${result.recipient ? ` to ${esc(String(result.recipient).slice(0, 8))}…` : ''}.`;
	else line = esc(rc.type);

	const sources = (rc.sources || []).slice(0, 3).map((s) => sourceChip(rc.agentId || agentId, s)).join('');
	const sig = rc.signed
		? `<span class="apm-signed" title="ERC-191 signed by ${esc(rc.signerAddress || '')}">🔏 signed</span>`
		: '';
	const sol = result.signature
		? `<a class="apm-source" href="https://solscan.io/tx/${esc(result.signature)}" target="_blank" rel="noopener">tx ↗</a>`
		: '';
	const undoBtn = undo && (rc.kind === 'alert_created' || rc.kind === 'briefing_authored') && rc.proposalId
		? `<button class="apm-btn" data-undo="${esc(rc.proposalId)}" style="padding:.2rem .5rem;font-size:.72rem">Undo</button>`
		: '';
	const who = showAgent && rc.agent ? `<span>${esc(rc.agent.name || 'Agent')}</span>` : '';

	return `
	<div class="apm-receipt" data-agent="${esc(rc.agentId || agentId || '')}">
		<span class="apm-receipt-ico">${km.icon}</span>
		<div class="apm-receipt-body">
			<div class="apm-receipt-line">${line}</div>
			${rc.rationale ? `<div class="apm-prop-why" style="margin:.35rem 0 0"><b>Why:</b> ${esc(rc.rationale)}</div>` : ''}
			${sources ? `<div class="apm-sources" style="margin:.4rem 0 0">${sources}</div>` : ''}
			<div class="apm-receipt-meta">${who}<span>${esc(timeAgo(rc.at))}</span>${sig}${sol}${undoBtn}</div>
		</div>
	</div>`;
}
