/**
 * Guardian console — page entry (/guardian).
 *
 * The cross-agent surface for someone trusted as a guardian or named as a
 * beneficiary. They are NOT the owner, so they never see the owner-only Recovery
 * tab in an agent's wallet hub — this is where they act: approve a recovery,
 * decline it, confirm an inheritance, or push a ready process over the line. Being
 * a guardian is a real, visible role in the graph; this page surfaces it with the
 * weight it deserves.
 *
 * 100% real: every list item and every action hits the owner/guardian-gated API
 * (CSRF-protected). No key is ever exposed — completing a process only changes who
 * owns the agent.
 */

import { consumeCsrfToken } from './api.js';

const root = document.getElementById('guardian-root');

const STYLE = `
.gd { display:flex; flex-direction:column; gap:16px; padding-top:14px; }
.gd-hero { display:flex; gap:14px; align-items:flex-start; }
.gd-hero-ic { width:42px; height:42px; border-radius:12px; display:grid; place-items:center; flex:none; font-size:20px; background:color-mix(in srgb,var(--wallet-accent,#8b5cf6) 16%,transparent); border:1px solid color-mix(in srgb,var(--wallet-accent,#8b5cf6) 36%,transparent); color:var(--wallet-accent-ink,#c4b5fd); }
.gd-hero h1 { margin:0 0 4px; font-family:var(--font-display,system-ui); font-size:var(--text-2xl,1.8rem); color:var(--ink-bright,#fff); }
.gd-hero p { margin:0; color:var(--ink-dim,#888); font-size:var(--text-sm,.85rem); line-height:1.55; max-width:60ch; }
.gd-badge { display:inline-flex; align-items:center; gap:6px; font-size:var(--text-2xs,.6875rem); font-weight:600; padding:3px 10px; border-radius:999px; margin-top:8px; color:var(--wallet-accent-ink,#c4b5fd); background:color-mix(in srgb,var(--wallet-accent,#8b5cf6) 14%,transparent); border:1px solid color-mix(in srgb,var(--wallet-accent,#8b5cf6) 32%,transparent); }
.gd-card { border:1px solid var(--stroke,rgba(255,255,255,.08)); border-radius:14px; background:var(--surface-1,rgba(255,255,255,.03)); padding:16px 18px; }
.gd-card.act { border-color:color-mix(in srgb,var(--warn,#fbbf24) 45%,transparent); background:color-mix(in srgb,var(--warn,#fbbf24) 7%,transparent); }
.gd-row { display:flex; gap:12px; align-items:center; }
.gd-ava { width:40px; height:40px; border-radius:10px; object-fit:cover; flex:none; background:var(--surface-3,rgba(255,255,255,.08)); display:grid; place-items:center; color:var(--ink-dim,#888); font-size:15px; }
.gd-id { flex:1; min-width:0; }
.gd-name { font-size:var(--text-md,.95rem); color:var(--ink-bright,#fff); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gd-name a { color:inherit; text-decoration:none; }
.gd-name a:hover { text-decoration:underline; }
.gd-meta { font-size:var(--text-2xs,.6875rem); color:var(--ink-dim,#888); margin-top:2px; }
.gd-roles { display:flex; gap:6px; flex-wrap:wrap; }
.gd-pill { font-size:var(--text-2xs,.6875rem); font-weight:600; padding:2px 8px; border-radius:999px; border:1px solid transparent; }
.gd-pill.guardian { color:var(--wallet-accent-ink,#c4b5fd); background:color-mix(in srgb,var(--wallet-accent,#8b5cf6) 14%,transparent); border-color:color-mix(in srgb,var(--wallet-accent,#8b5cf6) 32%,transparent); }
.gd-pill.beneficiary { color:var(--success,#4ade80); background:color-mix(in srgb,var(--success,#4ade80) 12%,transparent); border-color:color-mix(in srgb,var(--success,#4ade80) 30%,transparent); }
.gd-proc { margin-top:12px; padding-top:12px; border-top:1px solid var(--stroke,rgba(255,255,255,.08)); }
.gd-proc-h { font-size:var(--text-sm,.85rem); color:var(--ink-bright,#fff); display:flex; align-items:center; gap:8px; }
.gd-narrate { font-style:italic; color:var(--ink,#c8c8c8); font-size:var(--text-sm,.8rem); line-height:1.5; padding:10px 12px; margin-top:8px; border-left:2px solid color-mix(in srgb,var(--wallet-accent,#8b5cf6) 50%,transparent); background:color-mix(in srgb,var(--wallet-accent,#8b5cf6) 7%,transparent); border-radius:0 10px 10px 0; }
.gd-count { font-family:var(--font-mono,monospace); font-size:var(--text-2xs,.6875rem); color:var(--ink-dim,#888); margin-top:6px; }
.gd-tl { font-size:var(--text-2xs,.6875rem); color:var(--ink-dim,#888); margin-top:4px; }
.gd-actions { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
.gd-btn { appearance:none; font:inherit; font-size:var(--text-sm,.8rem); color:var(--ink,#e8e8e8); background:var(--surface-2,rgba(255,255,255,.05)); border:1px solid var(--stroke,rgba(255,255,255,.08)); border-radius:10px; padding:8px 14px; cursor:pointer; transition:background .14s,border-color .14s,transform .08s; }
.gd-btn:hover:not(:disabled){ background:var(--surface-3,rgba(255,255,255,.08)); border-color:var(--stroke-strong,rgba(255,255,255,.14)); }
.gd-btn:active:not(:disabled){ transform:translateY(1px); }
.gd-btn:disabled{ opacity:.4; cursor:not-allowed; }
.gd-btn:focus-visible{ outline:2px solid var(--focus-ring-color,#fff); outline-offset:2px; }
.gd-btn--approve{ background:color-mix(in srgb,var(--success,#4ade80) 16%,transparent); color:var(--success,#4ade80); border-color:color-mix(in srgb,var(--success,#4ade80) 40%,transparent); font-weight:600; }
.gd-btn--danger{ background:color-mix(in srgb,var(--danger,#f87171) 14%,transparent); color:var(--danger,#f87171); border-color:color-mix(in srgb,var(--danger,#f87171) 40%,transparent); font-weight:600; }
.gd-btn--primary{ background:var(--accent,#fff); color:#0a0a0a; border-color:var(--accent,#fff); font-weight:600; }
.gd-empty{ text-align:center; padding:36px 16px; color:var(--ink-dim,#888); }
.gd-empty .ill{ font-size:34px; opacity:.5; display:block; margin-bottom:10px; }
.gd-skel{ height:84px; border-radius:14px; background:linear-gradient(90deg,var(--surface-1,rgba(255,255,255,.03)) 25%,var(--surface-2,rgba(255,255,255,.05)) 37%,var(--surface-1,rgba(255,255,255,.03)) 63%); background-size:400% 100%; animation:gd-sh 1.4s ease infinite; }
.gd-toast{ position:fixed; left:50%; bottom:24px; transform:translateX(-50%) translateY(8px); background:var(--bg-1,#1a1a1a); color:var(--ink-bright,#fff); border:1px solid var(--stroke-strong,rgba(255,255,255,.14)); border-radius:10px; padding:10px 16px; font-size:.85rem; box-shadow:0 8px 32px rgba(0,0,0,.5); opacity:0; pointer-events:none; transition:opacity .2s,transform .2s; z-index:9999; }
.gd-toast[data-show="true"]{ opacity:1; transform:translateX(-50%) translateY(0); }
@keyframes gd-sh{ 0%{background-position:100% 0} 100%{background-position:-100% 0} }
@media (prefers-reduced-motion: reduce){ .gd-skel{animation:none} }
`;

function injectStyle() {
	if (document.getElementById('gd-style')) return;
	const t = document.createElement('style');
	t.id = 'gd-style';
	t.textContent = STYLE;
	document.head.appendChild(t);
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer = null;
function toast(msg, ms = 2400) {
	let el = document.querySelector('.gd-toast');
	if (!el) { el = document.createElement('div'); el.className = 'gd-toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
	el.textContent = msg;
	el.dataset.show = 'true';
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { el.dataset.show = 'false'; }, ms);
}

function fmtDuration(ms) {
	if (ms == null) return '';
	const s = Math.max(0, Math.floor(ms / 1000));
	const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m`;
	return `${s}s`;
}

async function call(url, { method = 'GET', body = null } = {}) {
	try {
		const opts = { method, credentials: 'include', headers: {} };
		if (body != null) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
		if (method !== 'GET') { const tok = await consumeCsrfToken(); if (tok) opts.headers['x-csrf-token'] = tok; }
		const r = await fetch(url, opts);
		let j = null; try { j = await r.json(); } catch { /* empty */ }
		if (!r.ok) return { ok: false, status: r.status, code: j?.error || 'error', message: j?.error_description || `request failed (${r.status})`, detail: j?.detail || null };
		return { ok: true, status: r.status, data: j?.data ?? j };
	} catch (err) {
		return { ok: false, status: 0, code: 'network_error', message: err?.message || 'network error' };
	}
}

let busy = false;

function avatarHTML(item) {
	if (item.avatar_url) return `<img class="gd-ava" src="${esc(item.avatar_url)}" alt="" loading="lazy" data-fallback="element" data-fallback-tag="span" data-fallback-class="gd-ava" data-fallback-text="${esc((item.agent_name || '?').slice(0, 1).toUpperCase())}" />`;
	return `<span class="gd-ava" aria-hidden="true">${esc((item.agent_name || '?').slice(0, 1).toUpperCase())}</span>`;
}

function processHTML(item) {
	const p = item.active_request;
	if (!p) {
		if (item.dead_man_enabled && item.roles.includes('beneficiary')) {
			return `<div class="gd-proc"><p class="gd-tl">No active process. If the owner has gone silent past their threshold, you can arm inheritance.</p>
				<div class="gd-actions"><button class="gd-btn" type="button" data-act="arm" data-agent="${esc(item.agent_id)}">Try to arm inheritance</button></div></div>`;
		}
		return `<div class="gd-proc"><p class="gd-tl">No active recovery or inheritance. You’ll be notified if you’re ever needed.</p></div>`;
	}
	const isInh = p.kind === 'inheritance';
	const narrate = isInh
		? '“My owner has gone quiet. You’re my beneficiary or guardian — confirm only if you truly believe they’re gone. They can still stop this by showing up.”'
		: '“I’m being recovered. If you trust this person is really my owner, approve. If anything feels off, decline.”';
	const approvalsLine = p.approvals_required > 0
		? `Approvals: ${p.approvals}/${p.approvals_required}${p.declines ? ` · ${p.declines} declined` : ''}`
		: (p.needs_beneficiary_confirmation ? 'Awaiting beneficiary confirmation' : 'Beneficiary confirmed');
	const lockLine = p.ms_until_unlock > 0
		? `Safety window: ${fmtDuration(p.ms_until_unlock)} remaining`
		: (p.status === 'ready' ? 'Safety window elapsed — ready to complete' : 'Safety window starts after approvals');
	const youVoted = (p.votes || []).find((v) => v.user_id === item._viewerId);

	const actions = [];
	if (item.needs_action && !youVoted) {
		if (isInh) {
			actions.push(`<button class="gd-btn gd-btn--approve" type="button" data-act="confirm" data-agent="${esc(item.agent_id)}" data-rid="${esc(p.id)}">Confirm inheritance</button>`);
			if (item.roles.includes('guardian')) actions.push(`<button class="gd-btn gd-btn--danger" type="button" data-act="decline" data-agent="${esc(item.agent_id)}" data-rid="${esc(p.id)}">Decline</button>`);
		} else {
			actions.push(`<button class="gd-btn gd-btn--approve" type="button" data-act="approve" data-agent="${esc(item.agent_id)}" data-rid="${esc(p.id)}">Approve recovery</button>`);
			actions.push(`<button class="gd-btn gd-btn--danger" type="button" data-act="decline" data-agent="${esc(item.agent_id)}" data-rid="${esc(p.id)}">Decline</button>`);
		}
	} else if (youVoted) {
		actions.push(`<span class="gd-pill ${youVoted.decision === 'approve' ? 'beneficiary' : 'guardian'}">You ${youVoted.decision === 'approve' ? 'approved' : 'declined'}</span>`);
	}
	if (p.status === 'ready') {
		actions.push(`<button class="gd-btn gd-btn--primary" type="button" data-act="complete" data-agent="${esc(item.agent_id)}" data-rid="${esc(p.id)}">Complete transfer</button>`);
	}

	return `
		<div class="gd-proc">
			<div class="gd-proc-h">${isInh ? '🕊' : '🔓'} ${isInh ? 'Inheritance' : 'Recovery'} in progress <span class="gd-pill ${isInh ? 'beneficiary' : 'guardian'}">${esc(p.status)}</span></div>
			<div class="gd-narrate">${esc(narrate)}</div>
			<div class="gd-count">${esc(approvalsLine)}</div>
			<div class="gd-tl">${esc(lockLine)} · opened ${new Date(p.created_at).toLocaleString()}</div>
			${actions.length ? `<div class="gd-actions">${actions.join('')}</div>` : ''}
		</div>`;
}

function itemHTML(item) {
	const roles = (item.roles || []).map((r) => `<span class="gd-pill ${r}">${r}</span>`).join('');
	return `
		<div class="gd-card ${item.needs_action ? 'act' : ''}">
			<div class="gd-row">
				${avatarHTML(item)}
				<div class="gd-id">
					<div class="gd-name"><a href="/agent/${esc(item.agent_id)}">${esc(item.agent_name || 'Agent')}</a></div>
					<div class="gd-meta">Owned by ${esc(item.owner?.label || 'someone')} · trusted since ${item.since ? new Date(item.since).toLocaleDateString() : '—'}</div>
				</div>
				<div class="gd-roles">${roles}</div>
			</div>
			${processHTML(item)}
		</div>`;
}

function renderLoading() {
	injectStyle();
	root.innerHTML = `<div class="gd"><div class="gd-skel"></div><div class="gd-skel"></div></div>`;
}

function renderSignedOut() {
	root.innerHTML = `
		<div class="gd">
			<div class="gd-empty">
				<span class="ill" aria-hidden="true">🛡</span>
				<h2 style="margin:0 0 6px;color:var(--ink-bright,#fff);">Sign in to your guardian console</h2>
				<p>This is where you help the people who trust you back into their agents. Sign in to see who’s named you.</p>
				<div class="gd-actions" style="justify-content:center;margin-top:14px;"><a class="gd-btn gd-btn--primary" href="/login">Sign in</a></div>
			</div>
		</div>`;
}

function renderError(msg) {
	root.innerHTML = `<div class="gd"><div class="gd-empty"><span class="ill">⚠️</span><p>${esc(msg || 'Something went wrong')}</p><div class="gd-actions" style="justify-content:center;"><button class="gd-btn" type="button" id="gd-retry">Try again</button></div></div></div>`;
	document.getElementById('gd-retry')?.addEventListener('click', load);
}

function render(data, viewerId) {
	injectStyle();
	const items = data.items || [];
	if (!items.length) {
		root.innerHTML = `
			<div class="gd">
				<div class="gd-hero">
					<span class="gd-hero-ic" aria-hidden="true">🛡</span>
					<div><h1>Guardian console</h1><p>When someone names you a guardian or beneficiary of their agent, it shows up here. You’ll be able to help them recover access — or, if they’re truly gone, pass their agent to its heir.</p></div>
				</div>
				<div class="gd-empty"><span class="ill" aria-hidden="true">🫂</span><h2 style="margin:0 0 6px;color:var(--ink-bright,#fff);">No one’s named you yet</h2><p>Ask a friend who runs a funded agent to add you as a guardian — being someone’s safety net is a real bond on three.ws.</p></div>
			</div>`;
		return;
	}
	items.forEach((it) => { it._viewerId = viewerId; });
	root.innerHTML = `
		<div class="gd">
			<div class="gd-hero">
				<span class="gd-hero-ic" aria-hidden="true">🛡</span>
				<div>
					<h1>Guardian console</h1>
					<p>The agents you’re trusted to protect. You never see anyone’s funds or keys — only the power to help them back in.</p>
					${data.actionable ? `<span class="gd-badge">● ${data.actionable} ${data.actionable === 1 ? 'agent needs' : 'agents need'} your action</span>` : ''}
				</div>
			</div>
			${items.map(itemHTML).join('')}
		</div>`;
	wire();
}

function wire() {
	root.querySelectorAll('[data-act]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			if (busy) return;
			const act = btn.dataset.act;
			const agent = btn.dataset.agent;
			const rid = btn.dataset.rid;
			let confirmMsg = null;
			if (act === 'approve') confirmMsg = 'Approve this recovery? Only do this if you trust the person is the rightful owner.';
			if (act === 'confirm') confirmMsg = 'Confirm this inheritance? Only do this if you truly believe the owner is gone.';
			if (act === 'decline') confirmMsg = 'Decline this request?';
			if (act === 'complete') confirmMsg = 'Complete the transfer now? Control of the agent and its wallet passes to the new owner.';
			if (confirmMsg && !confirm(confirmMsg)) return;

			busy = true;
			btn.disabled = true;
			let url, res;
			if (act === 'arm') {
				res = await call(`/api/agents/${encodeURIComponent(agent)}/recovery/inheritance/arm`, { method: 'POST', body: {} });
			} else {
				url = `/api/agents/${encodeURIComponent(agent)}/recovery/requests/${encodeURIComponent(rid)}/${act}`;
				res = await call(url, { method: 'POST', body: {} });
			}
			busy = false;
			if (!res.ok) { toast(res.message || 'Action failed'); btn.disabled = false; return; }
			const msg = {
				approve: 'Approved — thank you for vouching',
				confirm: 'Confirmed',
				decline: 'Declined',
				complete: 'Transfer complete — control has passed',
				arm: 'Inheritance armed — the grace window has begun',
			}[act] || 'Done';
			toast(msg);
			await load();
		});
	});
}

async function load() {
	renderLoading();
	const res = await call('/api/agents/recovery-inbox');
	if (res.status === 401) { renderSignedOut(); return; }
	if (!res.ok) { renderError(res.message); return; }
	// Resolve the viewer id from the inbox payload (active_request votes reference
	// user_ids); fall back to a /api/me lookup only if needed.
	let viewerId = null;
	try {
		const me = await call('/api/me');
		viewerId = me.ok ? (me.data?.id || me.data?.user?.id || null) : null;
	} catch { /* non-fatal */ }
	render(res.data, viewerId);
}

if (root) load();
