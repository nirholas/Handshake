/**
 * Presence panel — the legible, ownable face of the net-worth-reactive avatar.
 *
 * Shows how an agent's REAL wallet drives its 3D look: the presence tier (from
 * real portfolio USD), the reputation regalia (each backed by a real number and
 * deep-linked to the wallet hub), and — for the owner only — the reactivity dial
 * (off ↔ expressive) plus per-signal opt-outs, persisted on the agent record so a
 * visitor sees the agent exactly as the owner configured it.
 *
 * Pairs with src/shared/wallet-aura.js: that controller renders the live 3D aura
 * on the model; this panel renders the same real data as UI and lets the owner
 * tune it. The owner's reactivity dial here drives that aura in lockstep (see
 * mountPresence), and one fetch (agent-networth.js → the canonical server look)
 * feeds both, so the panel and the glow can never disagree.
 */

import { fetchNetWorth, saveNetWorthPrefs, normalizePrefs, fmtUsd, fmtAmount, REACTIVITY_LEVELS } from './agent-networth.js';

const STYLE_ID = 'tws-networth-presence-styles';

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const REACTIVITY_COPY = {
	off: 'No reactions — a still presence.',
	subtle: 'A quiet aura that tracks your wallet.',
	balanced: 'Aura plus a brief react when funds land.',
	expressive: 'Full-body celebration on every real win.',
};

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const s = document.createElement('style');
	s.id = STYLE_ID;
	s.textContent = `
.nwp{--nw-accent:var(--wallet-accent-strong,#a78bfa);--nw-accent-ink:var(--wallet-accent,#c4b5fd);
	--nw-accent-soft:var(--wallet-accent-soft,rgba(139,92,246,.12));--nw-accent-line:var(--wallet-accent-fill,rgba(139,92,246,.28));
	font-family:var(--font-body,Inter,system-ui,sans-serif);color:var(--ink,#e7e7ea);
	background:var(--surface-1,rgba(255,255,255,.03));border:1px solid var(--stroke,rgba(255,255,255,.08));
	border-radius:var(--radius-lg,16px);padding:var(--space-md,16px);display:flex;flex-direction:column;gap:14px;}
.nwp-head{display:flex;align-items:center;gap:12px;}
.nwp-ring{width:46px;height:46px;border-radius:50%;flex:none;display:grid;place-items:center;position:relative;
	background:radial-gradient(circle at 50% 50%,color-mix(in srgb,var(--nw-accent) 38%,transparent),transparent 70%);
	border:1.5px solid color-mix(in srgb,var(--nw-accent) 55%,transparent);}
.nwp-ring b{font:700 13px/1 var(--font-mono,JetBrains Mono,monospace);color:#fff;}
.nwp-head-main{min-width:0;flex:1;}
.nwp-tier{font:700 14px/1.2 var(--font-display,Space Grotesk,sans-serif);color:#fff;display:flex;align-items:center;gap:7px;}
.nwp-tierdot{width:8px;height:8px;border-radius:50%;background:var(--nw-accent);box-shadow:0 0 8px var(--nw-accent);}
.nwp-sub{font-size:12px;color:var(--ink-dim,#9a9aa3);margin-top:2px;}
.nwp-sub a{color:var(--nw-accent);text-decoration:none;}
.nwp-sub a:hover{text-decoration:underline;}
.nwp-next{height:5px;border-radius:999px;background:rgba(255,255,255,.07);overflow:hidden;}
.nwp-next i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--nw-accent),var(--nw-accent-ink));transition:width .6s var(--ease-standard,cubic-bezier(.4,0,.2,1));}
.nwp-flow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.nwp-flow-item{display:inline-flex;align-items:center;gap:4px;font:600 11px/1 var(--font-mono,JetBrains Mono,monospace);
	padding:3px 8px;border-radius:999px;background:var(--surface-2,rgba(255,255,255,.05));border:1px solid var(--stroke,rgba(255,255,255,.08));color:var(--ink-dim,#9a9aa3);}
.nwp-flow-item.is-up{color:var(--success,#4ade80);border-color:color-mix(in srgb,var(--success,#4ade80) 35%,transparent);}
.nwp-flow-item.is-down{color:var(--danger,#f87171);border-color:color-mix(in srgb,var(--danger,#f87171) 35%,transparent);}
.nwp-flow-item.is-stream{color:var(--nw-accent-ink);border-color:var(--nw-accent-line);}
.nwp-flow-item.is-tip{color:var(--nw-accent-ink);border-color:var(--nw-accent-line);background:var(--nw-accent-soft);}
.nwp-flow-cap{opacity:.6;font-weight:500;}
.nwp-marks{display:flex;flex-wrap:wrap;gap:6px;}
.nwp-mark{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:4px 9px;border-radius:999px;
	background:var(--nw-accent-soft);border:1px solid var(--nw-accent-line);color:var(--nw-accent-ink);text-decoration:none;
	transition:transform .12s ease,filter .15s ease,background .15s ease;}
a.nwp-mark:hover{transform:translateY(-1px);background:var(--nw-accent-line);}
a.nwp-mark:focus-visible{outline:2px solid var(--nw-accent);outline-offset:2px;}
.nwp-mark b{color:#fff;font-weight:700;}
.nwp-controls{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--stroke,rgba(255,255,255,.08));padding-top:12px;}
.nwp-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-dim,#9a9aa3);}
.nwp-seg{display:flex;background:rgba(255,255,255,.04);border:1px solid var(--stroke,rgba(255,255,255,.08));border-radius:999px;padding:2px;}
.nwp-seg button{flex:1;appearance:none;background:none;border:none;cursor:pointer;color:var(--ink-dim,#9a9aa3);
	font:600 11px/1 var(--font-body,Inter,sans-serif);padding:6px 4px;border-radius:999px;text-transform:capitalize;
	transition:background .15s ease,color .15s ease;}
.nwp-seg button:hover{color:#fff;}
.nwp-seg button[aria-pressed="true"]{background:var(--nw-accent);color:#0a0a0a;}
.nwp-seg button:focus-visible{outline:2px solid var(--nw-accent);outline-offset:2px;}
.nwp-hint{font-size:11px;color:var(--ink-dim,#9a9aa3);min-height:14px;}
.nwp-sigs{display:flex;flex-wrap:wrap;gap:8px;}
.nwp-sig{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink,#e7e7ea);cursor:pointer;user-select:none;}
.nwp-sig input{accent-color:var(--nw-accent);width:14px;height:14px;cursor:pointer;}
.nwp-sig.is-disabled{opacity:.4;pointer-events:none;}
.nwp-err{font-size:11px;color:var(--danger,#f87171);}
.nwp-foot{font-size:10px;color:var(--ink-faint,#6b6b73);display:flex;align-items:center;gap:5px;}
.nwp-skel{height:46px;border-radius:12px;background:linear-gradient(90deg,rgba(255,255,255,.04),rgba(255,255,255,.08),rgba(255,255,255,.04));
	background-size:200% 100%;animation:nwp-shimmer 1.4s ease-in-out infinite;}
@keyframes nwp-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
@media (prefers-reduced-motion: reduce){.nwp-skel{animation:none}.nwp-next i{transition:none}}
`;
	(document.head || document.documentElement).appendChild(s);
}

/**
 * Create a presence panel. Returns { el, update(data), setSaving, destroy }.
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {(prefs:object)=>void} [opts.onPrefsSaved]  fired after a successful save
 */
export function createPresencePanel({ agentId, onPrefsSaved } = {}) {
	ensureStyles();
	const el = document.createElement('div');
	el.className = 'nwp';
	el.innerHTML = `<div class="nwp-skel"></div>`;
	let data = null;
	let saving = false;

	function render() {
		if (!data) return;
		const isOwner = !!data.is_owner;
		const look = data.look || {};
		const tier = data.tier || look.tier || { label: '—', index: 0, accent: '#8b8b9a' };
		const accent = tier.accent || '#a78bfa';
		const usd = data.portfolio?.usd ?? 0;
		const hub = data.hub_url || (agentId ? `/agents/${agentId}/wallet` : null);
		el.style.setProperty('--nw-accent', accent);

		const next = tier.next;
		const nextPct = next && next.usd_to_next > 0
			? Math.max(4, Math.min(96, ((usd) / (usd + next.usd_to_next)) * 100))
			: 100;
		const provisioning = data.provisioning;

		const prefs = normalizePrefs(data.prefs);

		const marks = (data.marks || []).map((m) => {
			const inner = `${esc(m.label)}${m.value != null && m.value !== '' ? ` <b>${esc(m.value)}</b>` : ''}`;
			return m.href
				? `<a class="nwp-mark" href="${esc(m.href)}" title="${esc(m.detail || m.label)}">${inner}</a>`
				: `<span class="nwp-mark" title="${esc(m.detail || m.label)}">${inner}</span>`;
		}).join('');
		// The owner can hide the regalia entirely (signals.reputation off). The row
		// stays in the DOM so toggling it back on is instant — just visually hidden.
		const repHidden = prefs.signals.reputation === false;

		const subline = provisioning
			? 'Wallet provisioning — presence wakes once it is funded.'
			: `Portfolio <strong>${esc(fmtUsd(usd))}</strong>${hub ? ` · <a href="${esc(hub)}">wallet</a>` : ''}`;

		const controls = isOwner ? renderControls(prefs) : '';
		// The live "why": the real 24h flow behind the glow. Visitors see the honest
		// trend qualitatively (earning / cooling) + public stream/tip signals; the
		// owner additionally sees the exact dollar momentum and in/out breakdown.
		const flowRow = renderFlow(data.flow, isOwner);

		el.innerHTML = `
			<div class="nwp-head">
				<div class="nwp-ring" aria-hidden="true"><b>${esc(String(tier.index ?? 0))}</b></div>
				<div class="nwp-head-main">
					<div class="nwp-tier"><span class="nwp-tierdot"></span>${esc(tier.label)} presence</div>
					<div class="nwp-sub">${subline}</div>
				</div>
			</div>
			${next && next.usd_to_next > 0 ? `<div class="nwp-next" title="${esc(fmtUsd(next.usd_to_next))} to ${esc(next.label)}"><i style="width:${nextPct}%"></i></div>` : ''}
			${flowRow}
			${marks ? `<div class="nwp-marks" data-marks${repHidden ? ' hidden' : ''}>${marks}</div>` : ''}
			${controls}
			<div class="nwp-foot">◎ Driven by this agent's real on-chain wallet</div>
		`;
		if (isOwner) wireControls(prefs);
	}

	// Real-data flow chips. Returns '' for a flat, idle wallet (no clutter). Every
	// value is the server's custody-derived `flow` block — never invented.
	function renderFlow(flow, isOwner) {
		const f = flow || {};
		const m = Number(f.momentum_usd_24h) || 0;
		const streaming = Math.max(0, Number(f.streaming_now) || 0);
		const tipAt = f.last_tip_at ? Date.parse(f.last_tip_at) : NaN;
		const recentTip = Number.isFinite(tipAt) && Date.now() - tipAt >= 0 && Date.now() - tipAt < 120_000;
		const bits = [];
		if (m !== 0) {
			const up = m > 0;
			if (isOwner) {
				const a = Math.abs(m);
				const num = a < 1 ? a.toFixed(2) : a < 1000 ? String(Math.round(a)) : `${(a / 1000).toFixed(1)}k`;
				bits.push(`<span class="nwp-flow-item ${up ? 'is-up' : 'is-down'}">${up ? '▲' : '▼'} ${up ? '+' : '−'}$${num} <span class="nwp-flow-cap">24h</span></span>`);
			} else {
				bits.push(`<span class="nwp-flow-item ${up ? 'is-up' : 'is-down'}">${up ? '▲ earning' : '▼ cooling'} <span class="nwp-flow-cap">24h</span></span>`);
			}
		}
		if (streaming > 0) bits.push(`<span class="nwp-flow-item is-stream">⇆ streaming${streaming > 1 ? ` ×${streaming}` : ''}</span>`);
		if (recentTip) bits.push(`<span class="nwp-flow-item is-tip">◎ just tipped</span>`);
		if (!bits.length) return '';
		const title = isOwner
			? `Last 24h — in ${esc(fmtUsd(Number(f.inflow_usd_24h) || 0))}, out ${esc(fmtUsd(Number(f.outflow_usd_24h) || 0))}`
			: 'Real 24h wallet flow';
		return `<div class="nwp-flow" title="${esc(title)}">${bits.join('')}</div>`;
	}

	function renderControls(prefs) {
		const seg = REACTIVITY_LEVELS.map((lv) =>
			`<button type="button" data-rx="${lv}" aria-pressed="${prefs.reactivity === lv}">${lv}</button>`,
		).join('');
		const sig = (key, label) => {
			const disabled = prefs.reactivity === 'off';
			return `<label class="nwp-sig${disabled ? ' is-disabled' : ''}">
				<input type="checkbox" data-sig="${key}" ${prefs.signals[key] !== false ? 'checked' : ''} ${disabled ? 'disabled' : ''}/>${esc(label)}
			</label>`;
		};
		// Nameplate display: what the avatar's license-plate overlay shows. The name
		// is always shown; the owner chooses whether to reveal the public address and
		// the wealth-tier glyph. Independent of reactivity (it's identity, not motion).
		const np = (key, label) => `<label class="nwp-sig">
			<input type="checkbox" data-np="${key}" ${prefs.nameplate?.[key] !== false ? 'checked' : ''}/>${esc(label)}
		</label>`;
		return `
			<div class="nwp-controls">
				<div class="nwp-label">Reactivity</div>
				<div class="nwp-seg" role="group" aria-label="Avatar reactivity">${seg}</div>
				<div class="nwp-hint" data-hint>${esc(REACTIVITY_COPY[prefs.reactivity] || '')}</div>
				<div class="nwp-sigs">
					${sig('aura', 'Wealth aura')}
					${sig('events', 'Live reactions')}
					${sig('reputation', 'Reputation marks')}
				</div>
				<div class="nwp-label">Nameplate</div>
				<div class="nwp-sigs">
					${np('address', 'Show address')}
					${np('tier', 'Show tier glyph')}
				</div>
				<div class="nwp-err" data-err hidden></div>
			</div>`;
	}

	function wireControls(prefs) {
		const errEl = el.querySelector('[data-err]');
		const hintEl = el.querySelector('[data-hint]');
		const showErr = (msg) => { if (errEl) { errEl.textContent = msg || ''; errEl.hidden = !msg; } };

		async function commit(patch) {
			if (saving) return;
			saving = true;
			showErr('');
			const prevPrefs = { ...prefs, signals: { ...prefs.signals }, nameplate: { ...prefs.nameplate } };
			// optimistic
			Object.assign(prefs, patch);
			if (patch.signals) prefs.signals = { ...prefs.signals, ...patch.signals };
			if (patch.nameplate) prefs.nameplate = { ...prefs.nameplate, ...patch.nameplate };
			syncControlsUI();
			try {
				const saved = await saveNetWorthPrefs(agentId, prefs);
				Object.assign(prefs, normalizePrefs(saved));
				if (data) data.prefs = prefs;
				syncControlsUI();
				onPrefsSaved?.(prefs);
				// Broadcast so every wallet-reactive surface for this agent (the aura, the
				// living-avatar nameplate) applies the change instantly — no page wiring.
				try { window.dispatchEvent(new CustomEvent('tws:networth-prefs', { detail: { agentId, prefs: { ...prefs, signals: { ...prefs.signals }, nameplate: { ...prefs.nameplate } } } })); } catch { /* SSR */ }
			} catch (e) {
				Object.assign(prefs, prevPrefs);
				syncControlsUI();
				showErr(e?.status === 401 ? 'Sign in to change presence.' : (e?.message || 'Could not save — try again.'));
			} finally {
				saving = false;
			}
		}

		function syncControlsUI() {
			for (const b of el.querySelectorAll('[data-rx]')) b.setAttribute('aria-pressed', String(b.dataset.rx === prefs.reactivity));
			if (hintEl) hintEl.textContent = REACTIVITY_COPY[prefs.reactivity] || '';
			const off = prefs.reactivity === 'off';
			for (const c of el.querySelectorAll('[data-sig]')) {
				c.checked = prefs.signals[c.dataset.sig] !== false;
				c.disabled = off;
				c.closest('.nwp-sig')?.classList.toggle('is-disabled', off);
			}
			// Honour the reputation opt-out instantly: hide/show the regalia row in place.
			const marksRow = el.querySelector('[data-marks]');
			if (marksRow) marksRow.hidden = prefs.signals.reputation === false;
			for (const c of el.querySelectorAll('[data-np]')) c.checked = prefs.nameplate?.[c.dataset.np] !== false;
		}

		for (const b of el.querySelectorAll('[data-rx]')) {
			b.addEventListener('click', () => { if (b.dataset.rx !== prefs.reactivity) commit({ reactivity: b.dataset.rx }); });
		}
		for (const c of el.querySelectorAll('[data-sig]')) {
			c.addEventListener('change', () => commit({ signals: { [c.dataset.sig]: c.checked } }));
		}
		for (const c of el.querySelectorAll('[data-np]')) {
			c.addEventListener('change', () => commit({ nameplate: { [c.dataset.np]: c.checked } }));
		}
	}

	return {
		el,
		update(next) { data = next; render(); },
		destroy() { el.remove(); },
	};
}

/**
 * One-call mount: fetch the agent's REAL net-worth look (the canonical server
 * endpoint — tier, reputation marks, owner prefs), render the presence panel into
 * `container`, and keep the live 3D aura in lockstep with the owner's prefs. The
 * panel and the aura read from the same truth, so the dial the owner turns here
 * immediately changes the glow on the model — and a visitor sees that same look.
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {HTMLElement} opts.container          where to mount the panel
 * @param {{setPrefs?:(p:object)=>void}|null} [opts.aura]  the wallet-aura controller to keep in sync
 * @param {'append'|'prepend'} [opts.position='append']
 * @returns {Promise<{el:HTMLElement, update:Function, destroy:Function}|null>}
 *   the panel handle, or null when there is no presence to show (read failed).
 */
export async function mountPresence({ agentId, container, aura = null, position = 'append' } = {}) {
	if (!agentId || !container || typeof document === 'undefined') return null;
	const panel = createPresencePanel({
		agentId,
		onPrefsSaved: (prefs) => { try { aura?.setPrefs?.(prefs); } catch { /* aura gone */ } },
	});
	if (position === 'prepend' && container.firstChild) container.insertBefore(panel.el, container.firstChild);
	else container.appendChild(panel.el);

	let data = null;
	try { data = await fetchNetWorth(agentId); } catch { data = null; }
	if (!data) {
		// Read genuinely failed (not provisioning — that comes back 200). Don't leave
		// a stuck skeleton; remove the panel so the page degrades cleanly.
		panel.destroy();
		return null;
	}
	panel.update(data);
	try { aura?.setPrefs?.(data.prefs); } catch { /* aura gone */ }
	return panel;
}
