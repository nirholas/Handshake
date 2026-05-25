// dashboard-next — Overview / home page (foundation placeholder).
//
// Prompt #1 will replace this with the full hero strip (live 3D avatar
// previews via <threews-avatar>), KPI cards, recent activity rail, and
// quick-action grid. The placeholder below proves the shell works
// end-to-end and lets the user click through every sidebar item before
// any page has been built out.

import { mountShell } from '../shell.js';
import { requireUser, getMe } from '../api.js';
import { NAV, GROUPS, ICONS } from '../nav.js';

(async function boot() {
	const main = await mountShell();
	const me = await requireUser().catch(() => null);
	if (!me) return; // requireUser will have redirected

	main.innerHTML = `
		<h1 class="dn-h1">Welcome back${me?.display_name ? `, ${escape(me.display_name)}` : ''}.</h1>
		<p class="dn-h1-sub">Your creator dashboard, redesigned. Pick where to go next.</p>

		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">
			${GROUPS.map((group) => {
				const items = NAV.filter((r) => r.group === group);
				return `
					<div class="dn-panel">
						<div class="dn-panel-title">${group}</div>
						<div class="dn-panel-sub">${items.length} ${items.length === 1 ? 'section' : 'sections'}</div>
						<div style="display:flex;flex-direction:column;gap:6px">
							${items.map((r) => `
								<a href="${r.path}" style="
									display:flex;align-items:center;gap:10px;
									padding:8px 10px;border-radius:8px;
									color:var(--nxt-ink-dim);font-size:13px;
									transition:background 0.12s ease,color 0.12s ease;
								" onmouseover="this.style.background='rgba(255,255,255,0.04)';this.style.color='var(--nxt-ink)'"
								   onmouseout="this.style.background='transparent';this.style.color='var(--nxt-ink-dim)'">
									<span style="width:16px;height:16px;display:inline-grid;place-items:center;color:var(--nxt-ink-fade)">
										${ICONS[r.icon] || ''}
									</span>
									<span>${r.label}</span>
								</a>
							`).join('')}
						</div>
					</div>`;
			}).join('')}
		</div>

		<div class="dn-panel" style="margin-top:18px">
			<div class="dn-panel-title">Prototype build</div>
			<div class="dn-panel-sub">You're on <code>/dashboard-next</code> — the redesigned dashboard prototype. Each page is being built in parallel; tap a section above to see its current state.</div>
			<div style="display:flex;gap:8px;flex-wrap:wrap">
				<a class="dn-btn" href="/dashboard">← Production dashboard</a>
				<button class="dn-btn" onclick="window.dispatchEvent(new CustomEvent('dn:palette:open'))">Open command palette · ⌘K</button>
			</div>
		</div>
	`;
})();

function escape(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	})[c]);
}
