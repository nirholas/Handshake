/**
 * Agent Wallet hub — Recovery & Inheritance tab (owner-only).
 *
 * Custody you can actually trust: designate guardians + a beneficiary, set a
 * threshold, and arm a dead-man's switch — so "I lost access" or "the owner is
 * gone" never means the funded wallet dies with the key. Every irreversible step
 * is explained, time-locked, and cancellable until commit; the owner aborts a
 * looming inheritance just by being here. No key is ever exported — recovery
 * transfers WHO OWNS the agent, and the same server-held key keeps signing.
 *
 * All state changes hit the real owner-gated API (CSRF-protected); the panel only
 * ever renders real DB state. Guardians act from the standalone /guardian console.
 */

import { registerWalletTab } from '../registry.js';
import { consumeCsrfToken } from '../../api.js';

const STYLE_ID = 'awh-recovery-style';
const STYLE = `
.awh-rec { display: flex; flex-direction: column; gap: var(--space-3,12px); }
.awh-rec h2 { margin: 0 0 6px; font-size: var(--text-md,.8125rem); color: var(--ink-bright,#fff); font-family: var(--font-display, system-ui); font-weight:600; }
.awh-rec-lead { color: var(--ink-dim,#888); font-size: var(--text-sm,.764rem); line-height: 1.55; margin: 0 0 4px; max-width: 60ch; }
.awh-rec-shield { display:inline-grid; place-items:center; width:30px; height:30px; border-radius:var(--radius-md,10px); background: color-mix(in srgb, var(--wallet-accent,#8b5cf6) 16%, transparent); border:1px solid color-mix(in srgb, var(--wallet-accent,#8b5cf6) 36%, transparent); color: var(--wallet-accent-ink,#c4b5fd); font-size:15px; flex:none; }
.awh-rec-roster { list-style:none; margin:8px 0 0; padding:0; display:flex; flex-direction:column; gap:6px; }
.awh-rec-g { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--stroke,rgba(255,255,255,.08)); border-radius:var(--radius-md,10px); background:var(--surface-1,rgba(255,255,255,.03)); transition:border-color var(--duration-fast,140ms); }
.awh-rec-g:hover { border-color:var(--stroke-strong,rgba(255,255,255,.14)); }
.awh-rec-g img, .awh-rec-g .awh-rec-ava { width:26px; height:26px; border-radius:50%; object-fit:cover; background:var(--surface-3,rgba(255,255,255,.08)); flex:none; display:grid; place-items:center; font-size:11px; color:var(--ink-dim,#888); }
.awh-rec-g-main { display:flex; flex-direction:column; min-width:0; flex:1; }
.awh-rec-g-name { font-size:var(--text-sm,.764rem); color:var(--ink-bright,#fff); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.awh-rec-g-role { font-size:var(--text-2xs,.6875rem); color:var(--ink-dim,#888); text-transform:uppercase; letter-spacing:.05em; }
.awh-rec-pill { font-size:var(--text-2xs,.6875rem); font-weight:600; padding:2px 8px; border-radius:var(--radius-pill,999px); border:1px solid transparent; }
.awh-rec-pill.guardian { color:var(--wallet-accent-ink,#c4b5fd); background:color-mix(in srgb,var(--wallet-accent,#8b5cf6) 14%,transparent); border-color:color-mix(in srgb,var(--wallet-accent,#8b5cf6) 32%,transparent); }
.awh-rec-pill.beneficiary { color:var(--success,#4ade80); background:color-mix(in srgb,var(--success,#4ade80) 12%,transparent); border-color:color-mix(in srgb,var(--success,#4ade80) 30%,transparent); }
.awh-rec-x { appearance:none; background:transparent; border:none; color:var(--ink-dim,#888); cursor:pointer; font-size:15px; line-height:1; padding:4px; border-radius:var(--radius-sm,6px); }
.awh-rec-x:hover { color:var(--danger,#f87171); background:color-mix(in srgb,var(--danger,#f87171) 12%,transparent); }
.awh-rec-add { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; }
.awh-rec-add input, .awh-rec select, .awh-rec input[type="number"] { font:inherit; font-size:var(--text-sm,.764rem); color:var(--ink,#e8e8e8); background:var(--surface-2,rgba(255,255,255,.05)); border:1px solid var(--stroke,rgba(255,255,255,.08)); border-radius:var(--radius-md,10px); padding:8px 11px; }
.awh-rec-add input { flex:1; min-width:160px; }
.awh-rec-add input:focus-visible, .awh-rec select:focus-visible { outline:var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset:2px; }
.awh-rec-field { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:8px 0; }
.awh-rec-field label { font-size:var(--text-sm,.764rem); color:var(--ink,#c8c8c8); }
.awh-rec-field .hint { display:block; font-size:var(--text-2xs,.6875rem); color:var(--ink-faint,#666); margin-top:2px; }
.awh-rec-switch { display:inline-flex; align-items:center; gap:8px; }
.awh-rec-bar { height:6px; border-radius:999px; background:var(--surface-3,rgba(255,255,255,.08)); overflow:hidden; margin:8px 0 4px; }
.awh-rec-bar > i { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg,var(--success,#4ade80),var(--warn,#fbbf24)); transition:width var(--duration-base,220ms); }
.awh-rec-bar.danger > i { background:linear-gradient(90deg,var(--warn,#fbbf24),var(--danger,#f87171)); }
.awh-rec-narrate { font-style:italic; color:var(--ink,#c8c8c8); font-size:var(--text-sm,.764rem); line-height:1.5; padding:10px 12px; border-left:2px solid color-mix(in srgb,var(--wallet-accent,#8b5cf6) 50%,transparent); background:color-mix(in srgb,var(--wallet-accent,#8b5cf6) 7%,transparent); border-radius:0 var(--radius-md,10px) var(--radius-md,10px) 0; margin-top:6px; }
.awh-rec-proc { border-color:color-mix(in srgb,var(--warn,#fbbf24) 40%,transparent) !important; background:color-mix(in srgb,var(--warn,#fbbf24) 7%,transparent); }
.awh-rec-proc.danger { border-color:color-mix(in srgb,var(--danger,#f87171) 45%,transparent) !important; background:color-mix(in srgb,var(--danger,#f87171) 8%,transparent); }
.awh-rec-steps { list-style:none; margin:10px 0 0; padding:0; display:flex; flex-direction:column; gap:0; }
.awh-rec-step { display:flex; gap:10px; align-items:flex-start; position:relative; padding-bottom:14px; }
.awh-rec-step:not(:last-child)::before { content:''; position:absolute; left:8px; top:18px; bottom:0; width:2px; background:var(--stroke,rgba(255,255,255,.08)); }
.awh-rec-dot { width:18px; height:18px; border-radius:50%; flex:none; border:2px solid var(--stroke-strong,rgba(255,255,255,.14)); background:var(--bg-1,#1a1a1a); z-index:1; display:grid; place-items:center; font-size:10px; }
.awh-rec-step.done .awh-rec-dot { border-color:var(--success,#4ade80); color:var(--success,#4ade80); }
.awh-rec-step.active .awh-rec-dot { border-color:var(--warn,#fbbf24); box-shadow:0 0 0 3px color-mix(in srgb,var(--warn,#fbbf24) 22%,transparent); }
.awh-rec-step-c { display:flex; flex-direction:column; gap:1px; min-width:0; }
.awh-rec-step-t { font-size:var(--text-sm,.764rem); color:var(--ink-bright,#fff); }
.awh-rec-step-s { font-size:var(--text-2xs,.6875rem); color:var(--ink-dim,#888); }
.awh-rec-count { font-family:var(--font-mono,monospace); font-size:var(--text-2xs,.6875rem); color:var(--ink-dim,#888); }
.awh-rec-actions { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
.awh-rec-skel { height:64px; border-radius:var(--radius-lg,14px); background:linear-gradient(90deg,var(--surface-1,rgba(255,255,255,.03)) 25%,var(--surface-2,rgba(255,255,255,.05)) 37%,var(--surface-1,rgba(255,255,255,.03)) 63%); background-size:400% 100%; animation:awh-rec-shimmer 1.4s ease infinite; }
.awh-rec-empty-ill { font-size:26px; opacity:.5; margin-bottom:4px; }
@keyframes awh-rec-shimmer { 0%{background-position:100% 0} 100%{background-position:-100% 0} }
@media (prefers-reduced-motion: reduce){ .awh-rec-skel{animation:none} .awh-rec-step.active .awh-rec-dot{box-shadow:none} }
`;

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.textContent = STYLE;
	document.head.appendChild(tag);
}

async function call(url, { method = 'GET', body = null } = {}) {
	try {
		const opts = { method, credentials: 'include', headers: {} };
		if (body != null) {
			opts.headers['content-type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
		if (method !== 'GET') {
			const token = await consumeCsrfToken();
			if (token) opts.headers['x-csrf-token'] = token;
		}
		const r = await fetch(url, opts);
		let j = null;
		try { j = await r.json(); } catch { /* empty */ }
		if (!r.ok) return { ok: false, status: r.status, code: j?.error || 'error', message: j?.error_description || `request failed (${r.status})`, detail: j?.detail || null };
		return { ok: true, status: r.status, data: j?.data ?? j };
	} catch (err) {
		return { ok: false, status: 0, code: 'network_error', message: err?.message || 'network error' };
	}
}

function fmtDuration(ms) {
	if (ms == null) return '';
	const s = Math.max(0, Math.floor(ms / 1000));
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m`;
	return `${s}s`;
}

registerWalletTab({
	id: 'recovery',
	label: 'Recovery',
	order: 75,
	ownerOnly: true,
	mount({ panel, ctx }) {
		injectStyle();
		const { escapeHtml, agentId, toast } = ctx;
		let state = null;
		let pollTimer = null;
		let busy = false;

		function setBusy(b) {
			busy = b;
			panel.querySelectorAll('button, input, select').forEach((el) => {
				if (el.dataset.keepEnabled) return;
				el.disabled = b;
			});
		}

		async function load() {
			const res = await call(`/api/agents/${encodeURIComponent(agentId)}/recovery`);
			if (!res.ok) {
				render(null, res);
				return;
			}
			state = res.data;
			render(state, null);
		}

		function renderLoading() {
			panel.innerHTML = `
				<div class="awh-card"><div class="awh-rec-skel"></div></div>
				<div class="awh-card"><div class="awh-rec-skel"></div></div>`;
		}

		// ── render ──────────────────────────────────────────────────────────────
		function render(data, err) {
			if (err) {
				panel.innerHTML = `
					<div class="awh-card">
						<p class="awh-empty" role="alert">Couldn’t load recovery settings — ${escapeHtml(err.message || 'try again')}.
						<button class="awh-btn" type="button" data-act="retry">Try again</button></p>
					</div>`;
				panel.querySelector('[data-act="retry"]')?.addEventListener('click', () => { renderLoading(); load(); });
				return;
			}
			const cfg = data.config;
			const guardians = (data.guardians || []).filter((g) => g.role === 'guardian');
			const beneficiary = data.beneficiary;
			const dm = data.dead_man || {};
			const active = data.active_request;

			panel.innerHTML = `
				${active ? activeProcessHTML(active) : ''}
				${rosterCardHTML(guardians, beneficiary, cfg)}
				${deadManCardHTML(dm, cfg, !!beneficiary)}
			`;
			wire(data);
		}

		function rosterCardHTML(guardians, beneficiary, cfg) {
			const gItems = guardians.map((g) => guardianRowHTML(g, 'guardian')).join('');
			const thresholdOpts = [];
			for (let i = 1; i <= Math.max(1, guardians.length); i++) {
				thresholdOpts.push(`<option value="${i}" ${cfg.effective_threshold === i ? 'selected' : ''}>${i} of ${guardians.length || 1}</option>`);
			}
			return `
				<div class="awh-card">
					<div class="awh-rec">
						<div style="display:flex;gap:10px;align-items:flex-start;">
							<span class="awh-rec-shield" aria-hidden="true">🛡</span>
							<div>
								<h2>Your recovery circle</h2>
								<p class="awh-rec-lead">Guardians are real accounts you trust. If you ever lose access, ${cfg.effective_threshold || 1} of them approving — plus a 48-hour safety window only you can cancel — hands control of this agent and its wallet to you again. No private key is ever exported.</p>
							</div>
						</div>

						<ul class="awh-rec-roster">${gItems || `<li class="awh-empty" style="padding:10px 0;"><span class="awh-rec-empty-ill" aria-hidden="true">🫂</span><br>No guardians yet. Add 2–3 people you trust — they’ll never see your funds, only the power to help you back in.</li>`}</ul>

						<div class="awh-rec-add">
							<input type="text" data-add="guardian" placeholder="@username or email" aria-label="Add a guardian by username or email" autocomplete="off" />
							<button class="awh-btn" type="button" data-act="add-guardian">Add guardian</button>
						</div>

						${guardians.length > 1 ? `
						<div class="awh-rec-field" style="border-top:1px solid var(--stroke,rgba(255,255,255,.08));margin-top:10px;padding-top:12px;">
							<label for="awh-rec-threshold">Approvals required<span class="hint">How many guardians must agree before a recovery can complete.</span></label>
							<select id="awh-rec-threshold" data-field="threshold">${thresholdOpts.join('')}</select>
						</div>` : ''}

						<div class="awh-rec-field" style="border-top:1px solid var(--stroke,rgba(255,255,255,.08));margin-top:6px;padding-top:12px;">
							<div style="min-width:0;flex:1;">
								<label>Beneficiary<span class="hint">Inherits this agent if your dead-man’s switch ever fires.</span></label>
								${beneficiary ? `<div class="awh-rec-g" style="margin-top:8px;">
									${avatarHTML(beneficiary)}
									<div class="awh-rec-g-main"><span class="awh-rec-g-name">${escapeHtml(beneficiary.label)}</span><span class="awh-rec-g-role">beneficiary${beneficiary.is_you ? ' · you' : ''}</span></div>
									<span class="awh-rec-pill beneficiary">heir</span>
									<button class="awh-rec-x" type="button" data-act="remove-beneficiary" aria-label="Remove beneficiary" title="Remove beneficiary">✕</button>
								</div>` : ''}
							</div>
						</div>
						${!beneficiary ? `<div class="awh-rec-add">
							<input type="text" data-add="beneficiary" placeholder="@username or email" aria-label="Set a beneficiary by username or email" autocomplete="off" />
							<button class="awh-btn" type="button" data-act="set-beneficiary">Set beneficiary</button>
						</div>` : ''}
					</div>
				</div>`;
		}

		function avatarHTML(g) {
			if (g.avatar_url) return `<img src="${escapeHtml(g.avatar_url)}" alt="" loading="lazy" data-fallback="element" data-fallback-tag="span" data-fallback-class="awh-rec-ava" data-fallback-text="${escapeHtml((g.label || '?').slice(0, 1).toUpperCase())}" />`;
			return `<span class="awh-rec-ava" aria-hidden="true">${escapeHtml((g.label || '?').slice(0, 1).toUpperCase())}</span>`;
		}

		function guardianRowHTML(g) {
			return `
				<li class="awh-rec-g">
					${avatarHTML(g)}
					<div class="awh-rec-g-main">
						<span class="awh-rec-g-name">${escapeHtml(g.label)}${g.is_you ? ' (you)' : ''}</span>
						<span class="awh-rec-g-role">guardian · since ${g.since ? new Date(g.since).toLocaleDateString() : '—'}</span>
					</div>
					<span class="awh-rec-pill guardian">trusted</span>
					<button class="awh-rec-x" type="button" data-act="remove-guardian" data-uid="${escapeHtml(g.user_id)}" aria-label="Remove ${escapeHtml(g.label)}" title="Remove guardian">✕</button>
				</li>`;
		}

		function deadManCardHTML(dm, cfg, hasBeneficiary) {
			const enabled = !!dm.enabled;
			const inactiveDays = dm.inactive_days ?? 0;
			const inactivityDays = cfg.dead_man.inactivity_days;
			const pct = enabled && inactivityDays ? Math.min(100, Math.round((inactiveDays / inactivityDays) * 100)) : 0;
			const danger = pct >= 70;
			const armIn = dm.ms_until_arm;
			return `
				<div class="awh-card">
					<div class="awh-rec">
						<div style="display:flex;gap:10px;align-items:flex-start;">
							<span class="awh-rec-shield" aria-hidden="true">⏳</span>
							<div style="flex:1;">
								<h2>Dead-man’s switch</h2>
								<p class="awh-rec-lead">If you go silent for a long time, control passes to your beneficiary — but only after a generous grace window, an explicit confirmation, and every chance for you to cancel by simply showing up. It never fires on a surprise.</p>
							</div>
							<label class="awh-rec-switch">
								<input type="checkbox" data-field="dm-enabled" ${enabled ? 'checked' : ''} ${hasBeneficiary ? '' : 'disabled'} aria-label="Enable dead-man's switch" />
								<span>${enabled ? 'On' : 'Off'}</span>
							</label>
						</div>
						${!hasBeneficiary ? `<p class="awh-empty" style="padding:6px 0;">Set a beneficiary above to enable the dead-man’s switch.</p>` : ''}

						${enabled ? `
						<div class="awh-rec-bar ${danger ? 'danger' : ''}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Inactivity progress"><i style="width:${pct}%"></i></div>
						<p class="awh-rec-step-s">You’ve been quiet for <strong>${inactiveDays}d</strong> of the ${inactivityDays}d threshold. ${armIn > 0 ? `Inheritance would arm in <strong>${fmtDuration(armIn)}</strong> if you stay away.` : 'The inactivity threshold has been reached.'}</p>
						<div class="awh-rec-actions">
							<button class="awh-btn awh-btn--primary" type="button" data-act="checkin" data-keep-enabled="1">✋ I’m here — reset the clock</button>
						</div>
						` : ''}

						<div class="awh-rec-field" style="border-top:1px solid var(--stroke,rgba(255,255,255,.08));margin-top:10px;padding-top:12px;">
							<label for="awh-rec-inactivity">Trigger after no activity for<span class="hint">A login, trade, or check-in counts as activity.</span></label>
							<span class="awh-rec-switch">
								<input id="awh-rec-inactivity" type="number" min="7" max="365" step="1" value="${inactivityDays}" data-field="inactivity" style="width:80px;" /> days
							</span>
						</div>
						<div class="awh-rec-field">
							<label for="awh-rec-grace">Grace + confirmation window<span class="hint">After arming, control passes only once this elapses with confirmation.</span></label>
							<span class="awh-rec-switch">
								<input id="awh-rec-grace" type="number" min="1" max="90" step="1" value="${cfg.dead_man.grace_days}" data-field="grace" style="width:80px;" /> days
							</span>
						</div>
						<div class="awh-rec-actions">
							<button class="awh-btn" type="button" data-act="save-dm">Save switch settings</button>
						</div>
					</div>
				</div>`;
		}

		function activeProcessHTML(p) {
			const isInheritance = p.kind === 'inheritance';
			const title = isInheritance ? 'Inheritance in progress' : 'Recovery in progress';
			const danger = p.status === 'ready';
			const approvalsDone = p.approvals >= p.approvals_required && p.approvals_required > 0;
			const steps = [
				{ t: isInheritance ? 'Switch armed' : 'Recovery requested', s: `Opened ${new Date(p.created_at).toLocaleString()}`, done: true, active: false },
				{ t: p.approvals_required > 0 ? `Guardian approvals (${p.approvals}/${p.approvals_required})` : 'Beneficiary confirmation', s: approvalsDone || (p.approvals_required === 0 && !p.needs_beneficiary_confirmation) ? 'Threshold met' : 'Awaiting approvals', done: approvalsDone || (p.approvals_required === 0 && !p.needs_beneficiary_confirmation), active: !approvalsDone && p.status === 'pending_approvals' },
				{ t: isInheritance ? 'Grace window' : 'Safety time-lock', s: p.ms_until_unlock > 0 ? `${fmtDuration(p.ms_until_unlock)} remaining — you can still cancel` : (p.status === 'ready' ? 'Elapsed' : 'Starts after approvals'), done: p.ms_until_unlock <= 0 && (p.status === 'ready' || p.status === 'completed'), active: p.status === 'time_locked' },
				{ t: 'Control transfers', s: p.status === 'completed' ? 'Done' : 'Final step', done: p.status === 'completed', active: p.status === 'ready' },
			];
			// In-character narration of REAL state.
			const narrate = isInheritance
				? `“My owner has been quiet. Out of caution my guardians are confirming a hand-off to my beneficiary — but one sign of life from you stops everything.”`
				: `“Someone is trying to recover me. My guardians are weighing in, and a safety window is running. If this isn’t you, you have until it ends to shut it down.”`;
			return `
				<div class="awh-card awh-rec-proc ${danger ? 'danger' : ''}">
					<div class="awh-rec">
						<div style="display:flex;gap:10px;align-items:center;">
							<span class="awh-rec-shield" aria-hidden="true">${isInheritance ? '🕊' : '🔓'}</span>
							<div style="flex:1;"><h2 style="margin:0;">${escapeHtml(title)}</h2><span class="awh-rec-count">${escapeHtml(p.status)}</span></div>
						</div>
						<div class="awh-rec-narrate">${escapeHtml(narrate)}</div>
						<ul class="awh-rec-steps">
							${steps.map((s) => `
								<li class="awh-rec-step ${s.done ? 'done' : ''} ${s.active ? 'active' : ''}">
									<span class="awh-rec-dot">${s.done ? '✓' : ''}</span>
									<span class="awh-rec-step-c"><span class="awh-rec-step-t">${escapeHtml(s.t)}</span><span class="awh-rec-step-s">${s.s}</span></span>
								</li>`).join('')}
						</ul>
						<div class="awh-rec-actions">
							<button class="awh-btn awh-btn--danger" type="button" data-act="cancel-process" data-rid="${escapeHtml(p.id)}" data-keep-enabled="1">${isInheritance ? '✋ I’m here — cancel inheritance' : 'Stop this recovery — it’s not me'}</button>
						</div>
						${danger ? `<p class="awh-warn-irrev">This is the final step. The instant control transfers it can’t be undone — if this isn’t you, cancel now.</p>` : ''}
							<p class="awh-rec-step-s" style="margin-top:8px;">Cancelling is instant and reversible-proof: control stays with you and the wallet is unfrozen. This is logged in your custody trail.</p>
					</div>
				</div>`;
		}

		// ── wire actions ────────────────────────────────────────────────────────
		function wire(data) {
			const q = (sel) => panel.querySelector(sel);
			const guardians = (data.guardians || []).filter((g) => g.role === 'guardian');
			const beneficiary = data.beneficiary;

			// Build the full handle list from current roster (labels aren't handles,
			// so we re-send user_ids for existing members + the new handle).
			const guardianHandles = () => guardians.map((g) => g.user_id);
			const beneficiaryHandle = () => (beneficiary && !beneficiary.is_you ? beneficiary.user_id : null);

			async function saveConfig(patch, successMsg) {
				if (busy) return;
				setBusy(true);
				const res = await call(`/api/agents/${encodeURIComponent(agentId)}/recovery`, { method: 'PUT', body: patch });
				setBusy(false);
				if (!res.ok) { toast(res.message || 'Could not save'); return; }
				if (successMsg) toast(successMsg);
				await load();
			}

			q('[data-act="add-guardian"]')?.addEventListener('click', () => {
				const input = q('[data-add="guardian"]');
				const handle = (input?.value || '').trim();
				if (!handle) { input?.focus(); return; }
				saveConfig({ guardians: [...guardianHandles(), handle], beneficiary: beneficiaryHandle() }, 'Guardian added');
			});
			q('[data-add="guardian"]')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') q('[data-act="add-guardian"]')?.click(); });

			panel.querySelectorAll('[data-act="remove-guardian"]').forEach((btn) => {
				btn.addEventListener('click', () => {
					const uid = btn.dataset.uid;
					if (!confirm('Remove this guardian? They’ll no longer be able to help you recover this agent.')) return;
					saveConfig({ guardians: guardianHandles().filter((u) => u !== uid), beneficiary: beneficiaryHandle() }, 'Guardian removed');
				});
			});

			q('[data-act="set-beneficiary"]')?.addEventListener('click', () => {
				const input = q('[data-add="beneficiary"]');
				const handle = (input?.value || '').trim();
				if (!handle) { input?.focus(); return; }
				saveConfig({ guardians: guardianHandles(), beneficiary: handle }, 'Beneficiary set');
			});
			q('[data-add="beneficiary"]')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') q('[data-act="set-beneficiary"]')?.click(); });

			q('[data-act="remove-beneficiary"]')?.addEventListener('click', () => {
				if (!confirm('Remove the beneficiary? This also turns off the dead-man’s switch.')) return;
				saveConfig({ guardians: guardianHandles(), beneficiary: null, dead_man: { enabled: false } }, 'Beneficiary removed');
			});

			q('[data-field="threshold"]')?.addEventListener('change', (e) => {
				saveConfig({ guardians: guardianHandles(), beneficiary: beneficiaryHandle(), threshold: Number(e.target.value) }, 'Threshold updated');
			});

			q('[data-field="dm-enabled"]')?.addEventListener('change', (e) => {
				const enabled = e.target.checked;
				const inactivity = Number(q('[data-field="inactivity"]')?.value) || data.config.dead_man.inactivity_days;
				const grace = Number(q('[data-field="grace"]')?.value) || data.config.dead_man.grace_days;
				saveConfig({ guardians: guardianHandles(), beneficiary: beneficiaryHandle(), dead_man: { enabled, inactivity_days: inactivity, grace_days: grace } }, enabled ? 'Dead-man’s switch on' : 'Dead-man’s switch off');
			});

			q('[data-act="save-dm"]')?.addEventListener('click', () => {
				const enabled = !!q('[data-field="dm-enabled"]')?.checked;
				const inactivity = Number(q('[data-field="inactivity"]')?.value);
				const grace = Number(q('[data-field="grace"]')?.value);
				if (inactivity < 7 || inactivity > 365) { toast('Inactivity must be 7–365 days'); return; }
				if (grace < 1 || grace > 90) { toast('Grace must be 1–90 days'); return; }
				saveConfig({ guardians: guardianHandles(), beneficiary: beneficiaryHandle(), dead_man: { enabled, inactivity_days: inactivity, grace_days: grace } }, 'Switch settings saved');
			});

			q('[data-act="checkin"]')?.addEventListener('click', async () => {
				if (busy) return;
				setBusy(true);
				const res = await call(`/api/agents/${encodeURIComponent(agentId)}/recovery/checkin`, { method: 'POST', body: {} });
				setBusy(false);
				toast(res.ok ? 'Checked in — you’re marked active' : (res.message || 'Check-in failed'));
				await load();
			});

			q('[data-act="cancel-process"]')?.addEventListener('click', async (e) => {
				const rid = e.currentTarget.dataset.rid;
				if (!confirm('Cancel this process? Control stays with you and the wallet is unfrozen.')) return;
				if (busy) return;
				setBusy(true);
				const res = await call(`/api/agents/${encodeURIComponent(agentId)}/recovery/requests/${encodeURIComponent(rid)}/cancel`, { method: 'POST', body: {} });
				setBusy(false);
				toast(res.ok ? 'Cancelled — you’re still in control' : (res.message || 'Could not cancel'));
				await load();
			});
		}

		function startPoll() {
			stopPoll();
			// Poll only while a process is live so the countdown stays honest.
			pollTimer = setInterval(() => {
				if (document.hidden) return;
				if (state?.active_request) load();
			}, 15000);
		}
		function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

		return {
			onShow() { renderLoading(); load(); startPoll(); },
			onHide() { stopPoll(); },
			destroy() { stopPoll(); panel.innerHTML = ''; },
		};
	},
});
